import { randomUUID } from "node:crypto";
import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { checkDelegation, STOP_STATE_TYPES, type ClosedPullRequest, type Conversation, type PullRequestFacts, type PullRequestRef, type RepoSlug, type RunId, type RunRecord, type TaskRef } from "@terros/sergeant-contracts";
import { exists, postFeedbackComment } from "./after-merge.ts";
import { intentFile, readIntent, writeIntent, type CancelIntent, type Handoff } from "./cancel-intent.ts";
import { handOff, handoffComment, stalledStopComment, stopComment } from "./cancel-linear.ts";
import type { Ports } from "./execute.ts";
import { feedbackComment, workerFeedback } from "./outcome.ts";
import { readTaskState, type TaskState } from "./loop.ts";
import type { ServiceDeps } from "./service.ts";

// A task's stop (11 §2, TECH-4989), as commands the API, the loop, and intake only call. A task either
// runs or is stopped, and every trigger takes this one path: the issue moved to Backlog, Canceled, or
// Done without Sergeant's merge, its delegation removed, or `sgt task cancel`. It is an ordered close
// that survives a stop or crash (07 §8): its intent is on disk before anything changes, then every
// recorded run not confirmed stopped is canceled through the runner, and only once each one is
// stopped, so nothing can push to them any more, the task's open PRs are closed, the stop is said once
// on the issue, and the task's `state.json` is set aside. The intent is removed only once all of that
// is done; until then the loop or `serve` drives it again, at every intake too, its startup included,
// whatever the issue's delegation or state is by then. A run whose status cannot be read is unknown
// and is canceled like a running one, never taken as stopped (04 §6). The stop waits through the
// existing grace, counted from the first failed read of its final report (TECH-5070, TECH-5107), then finishes with a visible warning if the report
// stays unreadable (TECH-5074). Nothing resumes a stopped task: the issue delegated and in Todo again
// starts a fresh one, with a new budget.
//
// A handoff (TECH-5179) is a stop because the task's owner no longer owns the issue: it was reassigned
// or unassigned, delegated again, or is a task from before TECH-5179 whose owner cannot be proven. It
// stops the runs the same way, so the owner's quota stops being spent, but keeps the PRs and branches.
// Once the runs are stopped it rereads the issue, moves it back to Todo and removes Sergeant's
// delegation, unless a newer delegation is in Linear by then, and says once who can pick the work up.
// Nothing resumes on its own: the new assignee's own delegation starts a fresh task on their accounts.

const SURFACE_STALLED_STOP_AFTER_MS = 15 * 60 * 1000;

/** The request cannot be carried out as asked; nothing was recorded. */
export class CancelConflict extends Error {}

export const taskDir = (stateDir: string, ref: string) => join(stateDir, "tasks", ref);

/** Every run the task recorded, its sampled audit included. */
export const runIdsOf = (state: TaskState | undefined): RunId[] =>
  state ? [...new Set([...state.runIds, ...(state.merged?.audit ? [state.merged.audit.runId] : [])])] : [];

/** Whether the task in `dir` has a stop recorded and not yet done. */
export const cancelPending = (dir: string) => stat(intentFile(dir)).then(() => true, () => false);

/** Tasks whose stop is recorded and not yet done. */
export async function pendingCancels(stateDir: string): Promise<string[]> {
  const refs = await readdir(join(stateDir, "tasks")).catch(() => []);
  // Only whether one is there: a stop that cannot be read fails its own drive, not the intake.
  const pending = await Promise.all(refs.map(async (ref) => ((await cancelPending(taskDir(stateDir, ref))) ? [ref] : [])));
  return pending.flat();
}

/** Why a task whose issue fails its live check (A1, A2) stops, for the PR and issue comments. */
export const stopReason = (issue: Conversation["issue"]) =>
  STOP_STATE_TYPES.includes(issue.stateType) ? `the Linear issue was canceled or moved to ${issue.state}` : "the Linear issue is no longer delegated to Sergeant";

/**
 * Records the stop of the task in `dir`, if it has one under way (a `state.json`). A stop already
 * recorded is kept as it is, so a repeat posts nothing more. The caller then drives it.
 */
export async function recordStop(dir: string, reason: string, opts: { requestId?: string | undefined; handoff?: Handoff } = {}): Promise<void> {
  if ((await readIntent(dir)) || !(await exists(join(dir, "state.json")))) return;
  await writeIntent(dir, { reason, requestId: opts.requestId ?? randomUUID(), at: new Date().toISOString(), closed: [], ...(opts.handoff && { handoff: opts.handoff }) });
}

/**
 * A human's `sgt task cancel`: refused for an issue delegated to someone else. It removes the V2
 * agent's delegation, so no start that waited on the task's lock gets past its delegation check (A1),
 * then records the task's stop. Called under the task's lock; the caller then drives the stop.
 */
export async function recordCancel(stateDir: string, ref: TaskRef, req: { reason: string; requestId?: string | undefined; by: string }, deps: ServiceDeps): Promise<boolean> {
  const { issue } = await deps.linear.readConversation(ref);
  if (issue.delegate && issue.delegate.id !== deps.agentUserId) {
    throw new CancelConflict(`${ref} is delegated to ${issue.delegate.name}, not Sergeant's agent`);
  }
  let undelegated = false;
  if (issue.delegate) {
    if (!deps.undelegate) throw new Error("this Sergeant cannot remove a delegation");
    await deps.undelegate(issue.id);
    undelegated = true;
  }
  await recordStop(taskDir(stateDir, ref), `the task was canceled by ${req.by}: ${req.reason}`, { requestId: req.requestId });
  return undelegated;
}

/** How far a drive of a task's stop got. */
export type StopProgress = {
  /** Runs not yet confirmed stopped, or whose status cannot be read since: empty once the stop is done, or when none is recorded. */
  stopping: RunId[];
  /** The PRs the stop closed, across every drive of it so far. */
  closedPullRequests: ClosedPullRequest[];
};

/**
 * Drives the recorded stop of the task `ref` in `dir` as far as it goes now. Throws when a step fails
 * before it is done; the intent stays, so the next poll or intake drives it again.
 */
export async function driveCancel(dir: string, ref: string, deps: Ports, enrolled: RepoSlug[], log: (line: string) => void): Promise<StopProgress> {
  const intent = await readIntent(dir);
  if (!intent) return { stopping: [], closedPullRequests: [] };
  if (!intent.runIds || !intent.unconfirmedStarts) {
    // The task's loop takes no turn once a stop is recorded, and a start already past its live check
    // finished under the task's lock before this drive began, so these are all the runs to stop. They
    // are kept in the intent, since `state.json` is set aside before the intent is removed.
    const state = await readTaskState(join(dir, "state.json")).catch(() => undefined);
    if (!intent.runIds) log(`${ref}: stopping: ${intent.reason}`);
    intent.runIds ??= runIdsOf(state);
    // An intent written before `unconfirmedStarts` existed whose `state.json` is already set aside was
    // past its PR close and comment when it crashed: which starts went unconfirmed is lost, so any of its
    // runs may have never started, and one the runner still does not know does not hold the stop.
    intent.unconfirmedStarts = state ? (state.unconfirmedStarts ?? []) : intent.runIds;
    await writeIntent(dir, intent);
  }
  const stopping: RunId[] = [];
  const uncanceled: RunId[] = [];
  const unreadablePastGrace: RunId[] = [];
  const runs: RunRecord[] = [];
  for (const runId of intent.runIds) {
    let run = await deps.runner.status(runId).catch(() => undefined);
    // Recorded before the cancel, so a failed cancel or reread after it does not lose this read (TECH-5170).
    if (run) await statusRead(dir, intent, runId);
    if (!run || run.status === "running") {
      const canceled = await deps.runner.cancel(runId).then(
        () => (log(`${ref}: canceled ${runId}`), true),
        (e: Error) => (log(`${ref}: cancel ${runId} not confirmed, retrying: ${e.message}`), false),
      );
      if (!canceled) {
        stopping.push(runId);
        uncanceled.push(runId);
        continue;
      }
      // Read every canceled run again, now it is stopped: it may have reported a PR Linear has not
      // linked yet, so the stop stays pending until its final record reads, or that PR is missed.
      run = await deps.runner.status(runId).catch(() => undefined);
      // A start never confirmed that the runner still does not know never started (loop.ts): no report.
      if (!run && intent.unconfirmedStarts.includes(runId)) continue;
    }
    if (run) {
      runs.push(run);
      await statusRead(dir, intent, runId);
    } else {
      stopping.push(runId);
      log(`${ref}: status of ${runId} unreadable after its cancel, retrying`);
      // The grace counts from the run's first unreadable read, not from `at`, so a cancel that kept
      // failing past it still gets its report's reread (TECH-5070) on later drives before the stop
      // finishes without it.
      const since = intent.unreadableSince[runId];
      if (!since) {
        intent.unreadableSince[runId] = new Date().toISOString();
        await writeIntent(dir, intent);
      } else if (Date.now() - Date.parse(since) >= SURFACE_STALLED_STOP_AFTER_MS) unreadablePastGrace.push(runId);
    }
  }
  const stillStopping = stopping.filter((runId) => !unreadablePastGrace.includes(runId));
  // An unreadable run within its grace is not stalled: it finishes with its own note once that passes.
  if (uncanceled.length > 0 && !intent.unreadableStatusSurfaced) {
    const stalledForMs = Date.now() - Date.parse(intent.at);
    if (stalledForMs >= SURFACE_STALLED_STOP_AFTER_MS) {
      const stalledForMinutes = Math.floor(stalledForMs / 60_000);
      try {
        const { issue } = await deps.linear.readConversation(ref);
        await deps.linear.postComment({
          issueId: issue.id,
          key: `cancel-stalled:${issue.id}:${intent.requestId}`,
          body: stalledStopComment(uncanceled, stalledForMinutes, intent.handoff !== undefined),
        });
        intent.unreadableStatusSurfaced = true;
        await writeIntent(dir, intent);
        log(`${ref}: surfaced stop stalled for over ${stalledForMinutes} minutes`);
      } catch (e) {
        // Warning delivery must not make an API cancel fail. Its stable key makes a retry safe even
        // if Linear accepted the comment before this process lost the response or crashed.
        log(`${ref}: could not surface stalled stop, retrying: ${(e as Error).message}`);
      }
    }
  }
  if (stillStopping.length > 0) return { stopping: stillStopping, closedPullRequests: intent.closed };
  // Every run is stopped, so nothing pushes to the task's PRs any more: close those still open, unless
  // this is a handoff, which keeps them for whoever continues the work.
  const { issue } = await deps.linear.readConversation(ref);
  const prs = await taskPullRequests(issue.linkedPullRequests, runs, enrolled, deps);
  const open = prs.filter((p) => p.state === "open");
  if (intent.handoff) {
    const done = await handOff(issue, intent.handoff, deps, log);
    await deps.linear.postComment({ issueId: issue.id, key: `cancel:${issue.id}:${intent.requestId}`, body: handoffComment(intent.reason, issue, prs, done, unreadablePastGrace) });
  }
  for (const pr of intent.handoff ? [] : open.filter((p) => p.author === deps.workerLogin)) {
    const key = prCloseKey(pr);
    if (intent.prCloseKeys.includes(key)) continue;
    await deps.github.closePullRequest({ repo: pr.repo, number: pr.number, comment: `Closed: ${intent.reason}.` });
    intent.prCloseKeys.push(key);
    if (!intent.closed.some((closed) => closed.repo === pr.repo && closed.number === pr.number)) {
      intent.closed.push({ repo: pr.repo, number: pr.number, url: pr.url });
    }
    await writeIntent(dir, intent);
    log(`${ref}: closed ${pr.url}`);
  }
  if (!intent.handoff) await deps.linear.postComment({ issueId: issue.id, key: `cancel:${issue.id}:${intent.requestId}`, body: stopComment(intent, unreadablePastGrace) });
  // TECH-5186: an issue completed in Linear, still Sergeant's, without a recognized closing merge gets
  // its feedback like a merged one, once under the stop's key. A failed comment or label throws before
  // `state.json` is set aside and the intent removed, so the next drive retries it.
  const feedback = issue.stateType === "completed" && checkDelegation(issue, deps.agentUserId).allowed ? feedbackComment(workerFeedback(runs)) : undefined;
  if (feedback) await postFeedbackComment(issue, feedback, `feedback:${issue.id}:stop:${intent.requestId}`, deps, log);
  await rename(join(dir, "state.json"), join(dir, `state.stopped-${intent.at.replace(/[:.]/g, "-")}.json`)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
  await rm(intentFile(dir), { force: true });
  return { stopping: [], closedPullRequests: intent.closed };
}

/**
 * Records that a run's status read in a drive. The runner knows it, so it started: kept in the intent,
 * so a later drive's failed read holds the stop. And a later unreadable spell counts its grace from its
 * own first failed read, not an earlier spell's.
 */
async function statusRead(dir: string, intent: CancelIntent, runId: RunId): Promise<void> {
  if (!intent.unconfirmedStarts?.includes(runId) && !intent.unreadableSince[runId]) return;
  intent.unconfirmedStarts = intent.unconfirmedStarts?.filter((id) => id !== runId);
  delete intent.unreadableSince[runId];
  await writeIntent(dir, intent);
}

/** One durable close effect per PR head: a retry may close a later head, never the same one twice. */
const prCloseKey = (pr: Pick<PullRequestFacts, "repo" | "number" | "headSha">) => `close-pr:${pr.repo}#${pr.number}:${pr.headSha}`;

/**
 * The task's PRs in any state: those Linear links to the issue or its workers reported, in enrolled
 * repositories. Of those still open, only those the worker App opened are Sergeant's to close; a
 * human's never is. A handoff links them all.
 */
async function taskPullRequests(linked: PullRequestRef[], runs: RunRecord[], enrolled: RepoSlug[], deps: Ports): Promise<PullRequestFacts[]> {
  const reported = runs.flatMap((run) => (run.role === "worker" ? (run.report?.pullRequests ?? []) : []));
  const refs = new Map(
    [...linked, ...reported].filter((p) => enrolled.includes(p.repo)).map((p) => [`${p.repo}#${p.number}`, { repo: p.repo, number: p.number }]),
  );
  const prs = await Promise.all([...refs.values()].map((r) => deps.github.readPullRequest(r.repo, r.number)));
  return prs;
}

/**
 * The runner's own cancel, which returns only once the run is stopped. A note on the issue first says
 * who canceled it, so the task's next turn knows not to simply start it again; it is posted once
 * per run, so a retry after an unconfirmed cancel adds nothing.
 */
export async function cancelRun(
  task: TaskRef,
  runId: RunId,
  { reason, by }: { reason: string | undefined; by: string },
  deps: ServiceDeps,
  log: (line: string) => void,
): Promise<RunRecord> {
  const before = await deps.runner.status(runId);
  if (before.status !== "running") return before;
  const { issue } = await deps.linear.readConversation(task);
  await deps.linear.postComment({
    issueId: issue.id,
    key: `cancel-run:${runId}`,
    body: `Sergeant's ${before.role} run \`${runId}\` was canceled by ${by}${reason ? `: ${reason}` : "."}`,
  });
  await deps.runner.cancel(runId);
  log(`${task}: run ${runId} canceled through the API by ${by}${reason ? `: ${reason}` : ""}`);
  return deps.runner.status(runId);
}

/** What a task cancel through the API did: whether it removed the delegation, and how far its stop got. */
export type CancelProgress = StopProgress & { undelegated: boolean };
