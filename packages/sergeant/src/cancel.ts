import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ClosedPullRequest, PullRequestRef, RepoSlug, RunId, STOP_STATE_TYPES, type Conversation, type PullRequestFacts, type RunRecord, type TaskRef } from "@terros/sergeant-contracts";
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
// is done. A run whose status cannot be read is unknown and is canceled like a running one, never
// taken as stopped (04 §6), and the stop goes on only once its status, with any PR its worker
// reported, reads after the cancel (TECH-5070). A confirmed cancel is retried with a backoff; after
// three unreadable status attempts its intent remains durable but is deferred, so a Todo issue can
// start a fresh task while intake retries the old stop every five minutes (TECH-5074).

const CancelIntent = z.object({
  /** Why the task stopped, as the end of a sentence: "the issue was moved to Backlog". */
  reason: z.string(),
  requestId: z.string(),
  at: z.iso.datetime(),
  /** The task's runs when the stop was first driven: set once, before any is canceled. */
  runIds: z.array(RunId).optional(),
  /** Those of `runIds` whose start the runner never confirmed (loop.ts), set with them. */
  unconfirmedStarts: z.array(RunId).optional(),
  /** Runs whose cancellation the runner confirmed, but whose final status may still be unreadable. */
  confirmedCanceled: z.array(RunId).default([]),
  /** Consecutive attempts on which every remaining run was confirmed canceled but unreadable. */
  unreadableAttempts: z.number().int().nonnegative().default(0),
  /** The unresolved runs and earliest time another drive should contact the runner. */
  stopping: z.array(RunId).default([]),
  retryAt: z.iso.datetime().optional(),
  /** Issue-linked PRs from before this stop was deferred; later links may belong to a fresh task. */
  linkedPullRequests: z.array(PullRequestRef).optional(),
  /** The PRs this stop closed, for the issue comment and the API's answer. */
  closed: z.array(ClosedPullRequest).default([]),
  /** Completed GitHub close effects, keyed per PR and exact head so a re-drive skips them. */
  prCloseKeys: z.array(z.string()).default([]),
});
type CancelIntent = z.infer<typeof CancelIntent>;

/** The request cannot be carried out as asked; nothing was recorded. */
export class CancelConflict extends Error {}

export const taskDir = (stateDir: string, ref: string) => join(stateDir, "tasks", ref);
const intentFile = (dir: string) => join(dir, "cancel.json");
const deferredIntentPrefix = "cancel.pending-";
const FAST_STATUS_ATTEMPTS = 3;
const FAST_RETRY_MS = 30_000;
const DEFERRED_RETRY_MS = 5 * 60_000;

/** Every run the task recorded, its sampled audit included. */
export const runIdsOf = (state: TaskState | undefined): RunId[] =>
  state ? [...new Set([...state.runIds, ...(state.merged?.audit ? [state.merged.audit.runId] : [])])] : [];

/** Whether the task in `dir` has a stop recorded and not yet done. */
export const cancelPending = (dir: string) => stat(intentFile(dir)).then(() => true, () => false);

/** Tasks whose stop is recorded and not yet done. */
export async function pendingCancels(stateDir: string): Promise<string[]> {
  const refs = await readdir(join(stateDir, "tasks")).catch(() => []);
  // Only whether one is there: a stop that cannot be read fails its own drive, not the intake.
  const pending = await Promise.all(refs.map(async (ref) => ((await intentFiles(taskDir(stateDir, ref))).length > 0 ? [ref] : [])));
  return pending.flat();
}

async function intentFiles(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).filter((name) => name === "cancel.json" || (name.startsWith(deferredIntentPrefix) && name.endsWith(".json"))).sort();
}

async function readIntent(file: string): Promise<CancelIntent | undefined> {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  return raw === undefined ? undefined : CancelIntent.parse(JSON.parse(raw));
}

async function writeIntent(file: string, intent: CancelIntent): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(intent, null, 2));
}

/** Why a task whose issue fails its live check (A1, A2) stops, for the PR and issue comments. */
export const stopReason = (issue: Conversation["issue"]) =>
  STOP_STATE_TYPES.includes(issue.stateType) ? `the Linear issue was canceled or moved to ${issue.state}` : "the Linear issue is no longer delegated to Sergeant";

/**
 * Records the stop of the task in `dir`, if it has one under way (a `state.json`). A stop already
 * recorded is kept as it is, so a repeat posts nothing more. The caller then drives it.
 */
export async function recordStop(dir: string, reason: string, requestId: string = randomUUID()): Promise<void> {
  const file = intentFile(dir);
  if ((await readIntent(file)) || !(await exists(join(dir, "state.json")))) return;
  await writeIntent(file, { reason, requestId, at: new Date().toISOString(), closed: [], prCloseKeys: [], confirmedCanceled: [], unreadableAttempts: 0, stopping: [] });
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
  await recordStop(taskDir(stateDir, ref), `the task was canceled by ${req.by}: ${req.reason}`, req.requestId);
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
  return driveIntent(intentFile(dir), dir, ref, deps, enrolled, log, true);
}

/** Drives every current or deferred stop for `ref`; deferred ones never act on a fresh task's state. */
export async function drivePendingCancels(dir: string, ref: string, deps: Ports, enrolled: RepoSlug[], log: (line: string) => void): Promise<StopProgress> {
  const progress: StopProgress = { stopping: [], closedPullRequests: [] };
  for (const name of await intentFiles(dir)) {
    const next = await driveIntent(join(dir, name), dir, ref, deps, enrolled, log, name === "cancel.json");
    progress.stopping.push(...next.stopping);
    progress.closedPullRequests.push(...next.closedPullRequests);
  }
  progress.stopping = [...new Set(progress.stopping)];
  return progress;
}

async function driveIntent(file: string, dir: string, ref: string, deps: Ports, enrolled: RepoSlug[], log: (line: string) => void, current: boolean): Promise<StopProgress> {
  const intent = await readIntent(file);
  if (!intent) return { stopping: [], closedPullRequests: [] };
  if (intent.retryAt && Date.parse(intent.retryAt) > Date.now()) return { stopping: intent.stopping, closedPullRequests: intent.closed };
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
    await writeIntent(file, intent);
  }
  const stopping: RunId[] = [];
  const runs: RunRecord[] = [];
  for (const runId of intent.runIds) {
    let run = await deps.runner.status(runId).catch(() => undefined);
    const confirmed = intent.confirmedCanceled.includes(runId);
    if (run?.status === "running" || (!run && !confirmed)) {
      const canceled = await deps.runner.cancel(runId).then(
        () => (log(`${ref}: canceled ${runId}`), true),
        (e: Error) => (log(`${ref}: cancel ${runId} not confirmed, retrying: ${e.message}`), false),
      );
      if (!canceled) {
        stopping.push(runId);
        continue;
      }
      if (!confirmed) intent.confirmedCanceled.push(runId);
      await writeIntent(file, intent);
      // Read after a confirmed cancel: the final record may contain a PR Linear has not linked yet.
      run = await deps.runner.status(runId).catch(() => undefined);
    }
    // A start never confirmed that the runner still does not know never started (loop.ts): no report.
    if (!run && intent.unconfirmedStarts.includes(runId)) continue;
    if (run) runs.push(run);
    else {
      stopping.push(runId);
      log(`${ref}: status of ${runId} unreadable after its cancel, retrying`);
    }
  }
  if (stopping.length > 0) {
    const allCanceled = stopping.every((runId) => intent.confirmedCanceled.includes(runId));
    intent.unreadableAttempts = allCanceled ? intent.unreadableAttempts + 1 : 0;
    intent.stopping = stopping;
    const defer = current && allCanceled && intent.unreadableAttempts >= FAST_STATUS_ATTEMPTS;
    if (allCanceled) intent.retryAt = new Date(Date.now() + (defer || !current ? DEFERRED_RETRY_MS : FAST_RETRY_MS)).toISOString();
    else delete intent.retryAt;
    if (allCanceled && !intent.linkedPullRequests) {
      try {
        intent.linkedPullRequests = (await deps.linear.readConversation(ref)).issue.linkedPullRequests;
      } catch (error) {
        await writeIntent(file, intent);
        throw error;
      }
    }
    await writeIntent(file, intent);
    if (defer) {
      await rename(join(dir, "state.json"), join(dir, `state.stopped-${intent.at.replace(/[:.]/g, "-")}.json`)).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
      await rename(file, join(dir, `${deferredIntentPrefix}${randomUUID()}.json`));
      log(`${ref}: canceled runs stayed unreadable after ${intent.unreadableAttempts} attempts; the issue may restart while its stop retries every 5 minutes`);
    }
    return { stopping, closedPullRequests: intent.closed };
  }
  // Every run is stopped, so nothing pushes to the task's PRs any more: close those still open.
  const { issue } = await deps.linear.readConversation(ref);
  for (const pr of await openPullRequests(intent.linkedPullRequests ?? issue.linkedPullRequests, runs, enrolled, deps)) {
    const key = prCloseKey(pr);
    if (intent.prCloseKeys.includes(key)) continue;
    await deps.github.closePullRequest({ repo: pr.repo, number: pr.number, comment: `Closed: ${intent.reason}.` });
    intent.prCloseKeys.push(key);
    if (!intent.closed.some((closed) => closed.repo === pr.repo && closed.number === pr.number)) {
      intent.closed.push({ repo: pr.repo, number: pr.number, url: pr.url });
    }
    await writeIntent(file, intent);
    log(`${ref}: closed ${pr.url}`);
  }
  await deps.linear.postComment({ issueId: issue.id, key: `cancel:${issue.id}:${intent.requestId}`, body: stopComment(intent) });
  if (current) {
    await rename(join(dir, "state.json"), join(dir, `state.stopped-${intent.at.replace(/[:.]/g, "-")}.json`)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  await rm(file, { force: true });
  return { stopping: [], closedPullRequests: intent.closed };
}

/** One durable close effect per PR head: a retry may close a later head, never the same one twice. */
const prCloseKey = (pr: Pick<PullRequestFacts, "repo" | "number" | "headSha">) => `close-pr:${pr.repo}#${pr.number}:${pr.headSha}`;

/**
 * The task's PRs still open: those Linear links to the issue or its workers reported, in enrolled
 * repositories, and opened by the worker App. A human's PR is never Sergeant's to close.
 */
async function openPullRequests(linked: PullRequestRef[], runs: RunRecord[], enrolled: RepoSlug[], deps: Ports): Promise<PullRequestFacts[]> {
  const reported = runs.flatMap((run) => (run.role === "worker" ? (run.report?.pullRequests ?? []) : []));
  const refs = new Map(
    [...linked, ...reported].filter((p) => enrolled.includes(p.repo)).map((p) => [`${p.repo}#${p.number}`, { repo: p.repo, number: p.number }]),
  );
  const prs = await Promise.all([...refs.values()].map((r) => deps.github.readPullRequest(r.repo, r.number)));
  return prs.filter((p) => p.state === "open" && p.author === deps.workerLogin);
}

function stopComment(intent: CancelIntent): string {
  const closed = intent.closed.length > 0 ? `Closed ${intent.closed.map((p) => `[${p.repo}#${p.number}](${p.url})`).join(", ")}.` : "No open PR to close.";
  return `Sergeant stopped working on this issue: ${intent.reason}. Its runs are canceled. ${closed}\n\nTo start again, delegate it to Sergeant and move it to Todo: it starts as a fresh task.`;
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
