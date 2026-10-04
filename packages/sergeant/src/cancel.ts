import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClosedPullRequest, RepoSlug, RunId, STOP_STATE_TYPES, type Conversation, type PullRequestFacts, type PullRequestRef, type RunRecord, type TaskRef } from "@terros/sergeant-contracts";
import { z } from "zod";
import { exists } from "./after-merge.ts";
import type { Ports } from "./execute.ts";
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

const CancelIntent = z.object({
  /** Why the task stopped, as the end of a sentence: "the issue was moved to Backlog". */
  reason: z.string(),
  requestId: z.string(),
  at: z.iso.datetime(),
  /** The task's runs when the stop was first driven: set once, before any is canceled. */
  runIds: z.array(RunId).optional(),
  /** Those of `runIds` whose start the runner never confirmed (loop.ts), set with them; one leaves once its status reads. */
  unconfirmedStarts: z.array(RunId).optional(),
  /**
   * A handoff (TECH-5179): PRs and branches are kept and the issue goes back to Todo, undelegated.
   * `delegatedAt` is when the stopped task's owner delegated it, so a newer delegation is left alone;
   * `merged`, a task whose work already merged: only its audit stops, and the issue is left as it is.
   */
  handoff: z.object({ delegatedAt: z.string().optional(), merged: z.boolean().optional() }).optional(),
  /** The PRs this stop closed, for the issue comment and the API's answer. */
  closed: z.array(ClosedPullRequest).default([]),
  /** Completed GitHub close effects, keyed per PR and exact head so a re-drive skips them. */
  prCloseKeys: z.array(z.string()).default([]),
  /**
   * Whether the durable, idempotent warning about a stalled stop was posted. Despite its name it is
   * about cancels the runner never confirmed, not unreadable statuses; renaming it would change the record.
   */
  unreadableStatusSurfaced: z.boolean().default(false),
  /** When each canceled run's status was first read unreadable: its grace counts from then, not from `at`. */
  unreadableSince: z.record(z.string(), z.iso.datetime()).default({}),
});
type CancelIntent = z.infer<typeof CancelIntent>;

const SURFACE_STALLED_STOP_AFTER_MS = 15 * 60 * 1000;

/** The request cannot be carried out as asked; nothing was recorded. */
export class CancelConflict extends Error {}

export const taskDir = (stateDir: string, ref: string) => join(stateDir, "tasks", ref);
const intentFile = (dir: string) => join(dir, "cancel.json");

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

async function readIntent(dir: string): Promise<CancelIntent | undefined> {
  const raw = await readFile(intentFile(dir), "utf8").catch(() => undefined);
  return raw === undefined ? undefined : CancelIntent.parse(JSON.parse(raw));
}

async function writeIntent(dir: string, intent: z.input<typeof CancelIntent>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(intentFile(dir), JSON.stringify(intent, null, 2));
}

/** Why a task whose issue fails its live check (A1, A2) stops, for the PR and issue comments. */
export const stopReason = (issue: Conversation["issue"]) =>
  STOP_STATE_TYPES.includes(issue.stateType) ? `the Linear issue was canceled or moved to ${issue.state}` : "the Linear issue is no longer delegated to Sergeant";

/** A handoff's record of the stopped owner's delegation (TECH-5179). */
export type Handoff = NonNullable<CancelIntent["handoff"]>;

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
    if (run && intent.unconfirmedStarts.includes(runId)) {
      // The runner knows it, so it started: kept in the intent, so a later drive's failed read holds the stop.
      intent.unconfirmedStarts = intent.unconfirmedStarts.filter((id) => id !== runId);
      await writeIntent(dir, intent);
    }
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
      // A later unreadable spell counts its grace from its own first failed read, not this one's.
      if (intent.unreadableSince[runId]) {
        delete intent.unreadableSince[runId];
        await writeIntent(dir, intent);
      }
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
          body: stalledStopComment(uncanceled, stalledForMinutes),
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
  const open = await openPullRequests(issue.linkedPullRequests, runs, enrolled, deps);
  if (intent.handoff) {
    const done = await handOff(issue, intent.handoff, deps, log);
    await deps.linear.postComment({ issueId: issue.id, key: `cancel:${issue.id}:${intent.requestId}`, body: handoffComment(intent.reason, issue, open, done, unreadablePastGrace) });
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
  await rename(join(dir, "state.json"), join(dir, `state.stopped-${intent.at.replace(/[:.]/g, "-")}.json`)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
  });
  await rm(intentFile(dir), { force: true });
  return { stopping: [], closedPullRequests: intent.closed };
}

/** One durable close effect per PR head: a retry may close a later head, never the same one twice. */
const prCloseKey = (pr: Pick<PullRequestFacts, "repo" | "number" | "headSha">) => `close-pr:${pr.repo}#${pr.number}:${pr.headSha}`;

/**
 * The task's PRs still open: those Linear links to the issue or its workers reported, in enrolled
 * repositories. Only those the worker App opened are Sergeant's to close; a human's never is.
 */
async function openPullRequests(linked: PullRequestRef[], runs: RunRecord[], enrolled: RepoSlug[], deps: Ports): Promise<PullRequestFacts[]> {
  const reported = runs.flatMap((run) => (run.role === "worker" ? (run.report?.pullRequests ?? []) : []));
  const refs = new Map(
    [...linked, ...reported].filter((p) => enrolled.includes(p.repo)).map((p) => [`${p.repo}#${p.number}`, { repo: p.repo, number: p.number }]),
  );
  const prs = await Promise.all([...refs.values()].map((r) => deps.github.readPullRequest(r.repo, r.number)));
  return prs.filter((p) => p.state === "open");
}

/**
 * A handoff's Linear effects, decided on the issue as it is now, reread once the runs are stopped, so a
 * stop driven late never undoes a newer human action. A completed issue, or a task whose work already
 * merged, keeps its status and its delegation. Otherwise Sergeant's delegation is removed unless Linear shows a newer valid delegation
 * than the stopped owner's (the new assignee already delegated it: that is the next task), and an issue
 * in progress goes back to Todo; one a human moved anywhere else stays there. Safe to repeat.
 */
async function handOff(issue: Conversation["issue"], handoff: Handoff, deps: Ports, log: (line: string) => void): Promise<{ completed: boolean; undelegated: boolean; newer: boolean; todo: boolean }> {
  if (handoff.merged || issue.stateType === "completed") return { completed: true, undelegated: false, newer: false, todo: false };
  let undelegated = false;
  let newer = false;
  if (issue.delegate?.id === deps.agentUserId) {
    const check = await deps.linear.readTaskOwner(issue.id, deps.agentUserId);
    newer = "owner" in check && check.delegatedAt !== handoff.delegatedAt;
    if (!newer) {
      if (!deps.linear.undelegate) throw new Error("this Sergeant cannot remove a delegation");
      await deps.linear.undelegate(issue.id);
      undelegated = true;
      log(`${issue.identifier}: handoff: Sergeant's delegation removed`);
    }
  }
  if (!deps.linear.moveIssueToTodo) throw new Error("this Sergeant cannot move an issue back to Todo");
  const moved = await deps.linear.moveIssueToTodo(issue.id);
  if (moved.moved) log(`${issue.identifier}: handoff: moved from ${moved.from} to ${moved.to}`);
  return { completed: false, undelegated, newer, todo: moved.moved || issue.stateType === "unstarted" };
}

function handoffComment(
  reason: string,
  issue: Conversation["issue"],
  open: PullRequestFacts[],
  done: { completed: boolean; undelegated: boolean; newer: boolean; todo: boolean },
  unreadable: RunId[],
): string {
  const kept = open.length > 0 ? `Its PRs and branches are kept: ${open.map((p) => `[${p.repo}#${p.number}](${p.url})`).join(", ")}.` : "Its branches are kept; it has no open PR.";
  const missing = unreadable.length > 0 ? ` The final report for ${unreadable.map((id) => `run \`${id}\``).join(", ")} could not be read.` : "";
  const stopped = `Sergeant stopped working on this issue: ${reason}. Its runs are canceled, so they spend no more of the previous owner's model quota.${missing}`;
  if (done.completed) return `${stopped} Its work is already merged, so the issue is left as it is.`;
  const linear = [done.todo && "back in Todo", done.undelegated && "no longer delegated to Sergeant"].filter(Boolean).join(" and ");
  const who = issue.assignee?.name ?? "Whoever is assigned next";
  const next = done.newer
    ? `A newer delegation to Sergeant is in place, so it starts a fresh task on its delegator's own model accounts, with this work available.`
    : `${who} can continue it personally, or delegate it to Sergeant, which then starts a fresh task paid only by their own model accounts, with this work available.`;
  return `${stopped} ${kept}${linear ? ` The issue is ${linear}.` : ""}\n\n${next}`;
}

function stopComment(intent: CancelIntent, unreadable: RunId[]): string {
  const closed = intent.closed.length > 0 ? `Closed ${intent.closed.map((p) => `[${p.repo}#${p.number}](${p.url})`).join(", ")}.` : "No open PR to close.";
  const missing = unreadable.length > 0
    ? ` The final report for ${unreadable.map((id) => `run \`${id}\``).join(", ")} could not be read; a human may need to close any PR Sergeant could not see.`
    : "";
  return `Sergeant stopped working on this issue: ${intent.reason}. Its runs are canceled.${missing} ${closed}\n\nTo start again, delegate it to Sergeant and move it to Todo: it starts as a fresh task.`;
}

function stalledStopComment(runIds: RunId[], stalledForMinutes: number): string {
  return `Sergeant has been trying to stop this task for over ${stalledForMinutes} minutes, but the runner has not confirmed the cancellation of ${runIds.map((id) => `run \`${id}\``).join(", ")}. Its PRs stay open and the stop remains pending until every run is confirmed stopped, so none can push to a PR after Sergeant closes it, and Sergeant will not restart this issue while it is pending. To clear it, make sure the runner can cancel those runs; Sergeant will keep retrying automatically.`;
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
