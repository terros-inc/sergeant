import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RepoSlug, RunId, type PullRequestFacts, type PullRequestRef, type RunRecord, type TaskRef } from "@terros/sergeant-contracts";
import { z } from "zod";
import type { Ports } from "./execute.ts";
import { readTaskState, type TaskState } from "./loop.ts";
import type { ServiceDeps } from "./service.ts";

// A task's cancel (11 §2, TECH-4989), as commands the API and the loop only call. It is an ordered
// close that survives a stop or crash (07 §8): its intent is on disk before anything changes, then (for
// a human's cancel through the API) the V2 agent's delegation is removed, then every recorded run not
// confirmed stopped is canceled through the runner, and only once each one is stopped, so nothing can
// push to them any more, the task's open PRs are closed and the stop said once on the issue.
// Delegation goes first so that no run starts after the runs to stop are listed. The intent is
// removed only once all of that is done; until then the loop or `serve` drives it again, at every
// intake too, its startup included, whatever the issue's delegation or state is by then. A run whose
// status cannot be read is unknown and is canceled like a running one, never taken as stopped (04 §6).
// The loop records its own cancel when the issue is undelegated or moved to Backlog, Canceled, or Done
// without Sergeant's merge; a stop by state also sets the task's `state.json` aside, so the issue
// moved back to Todo is a fresh task.

const ClosedPr = z.object({ repo: RepoSlug, number: z.number().int().positive(), url: z.url() });
type ClosedPr = z.infer<typeof ClosedPr>;

const CancelIntent = z.object({
  reason: z.string(),
  requestId: z.string(),
  /** Who asked (auth.ts `callerName`); absent on a cancel recorded before callers were named. */
  by: z.string().optional(),
  at: z.iso.datetime(),
  /**
   * What stops the task: a human's cancel through the API (`api`, which removes the delegation), the
   * issue undelegated, or moved to a stop state (`state`, the state's name in `reason`). Absent on a
   * cancel recorded before TECH-4989, which was the API's.
   */
  cause: z.enum(["api", "undelegated", "state"]).default("api"),
  /** The task's runs when its delegation was gone: set once the Linear step is done. */
  runIds: z.array(RunId).optional(),
  /** Set once this cancel removed the delegation, canceled a run, or closed a PR. */
  acted: z.boolean().default(false),
  /** The PRs this cancel closed, for the issue comment. */
  closed: z.array(ClosedPr).default([]),
});
type CancelIntent = z.infer<typeof CancelIntent>;

/** The request cannot be carried out as asked; nothing was recorded. */
export class CancelConflict extends Error {}

export const taskDir = (stateDir: string, ref: string) => join(stateDir, "tasks", ref);
const intentFile = (dir: string) => join(dir, "cancel.json");

/** Every run the task recorded, its sampled audit included. */
export const runIdsOf = (state: TaskState | undefined): RunId[] =>
  state ? [...new Set([...state.runIds, ...(state.merged?.audit ? [state.merged.audit.runId] : [])])] : [];

/** Whether the task in `dir` has a cancel recorded and not yet done. */
export const cancelPending = (dir: string) => stat(intentFile(dir)).then(() => true, () => false);

/** Tasks whose cancel is recorded and not yet confirmed. */
export async function pendingCancels(stateDir: string): Promise<string[]> {
  const refs = await readdir(join(stateDir, "tasks")).catch(() => []);
  // Only whether one is there: a cancel that cannot be read fails its own drive, not the intake.
  const pending = await Promise.all(refs.map(async (ref) => ((await cancelPending(taskDir(stateDir, ref))) ? [ref] : [])));
  return pending.flat();
}

async function readIntent(dir: string): Promise<CancelIntent | undefined> {
  const raw = await readFile(intentFile(dir), "utf8").catch(() => undefined);
  return raw === undefined ? undefined : CancelIntent.parse(JSON.parse(raw));
}

async function writeIntent(dir: string, intent: CancelIntent): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(intentFile(dir), JSON.stringify(intent, null, 2));
}

/**
 * Records the cancel of a task: refused for an issue delegated to someone else, and kept as it was
 * when one is already recorded, so a repeat posts nothing more. The caller then drives it.
 */
export async function recordCancel(stateDir: string, ref: TaskRef, req: { reason: string; requestId?: string | undefined; by: string }, deps: ServiceDeps): Promise<void> {
  if (!deps.undelegate) throw new Error("this Sergeant cannot remove a delegation");
  const dir = taskDir(stateDir, ref);
  if (await readIntent(dir)) return;
  const { issue } = await deps.linear.readConversation(ref);
  if (issue.delegate && issue.delegate.id !== deps.agentUserId) {
    throw new CancelConflict(`${ref} is delegated to ${issue.delegate.name}, not Sergeant's agent`);
  }
  await writeIntent(dir, CancelIntent.parse({ reason: req.reason, requestId: req.requestId ?? randomUUID(), by: req.by, at: new Date().toISOString() }));
}

/**
 * The loop's own cancel of the task in `dir`: the issue undelegated, or moved to the stop state `state`.
 * One already recorded is kept as it is.
 */
export async function recordStop(dir: string, stop: { cause: "undelegated" } | { cause: "state"; state: string }): Promise<void> {
  if (await readIntent(dir)) return;
  const reason = stop.cause === "state" ? stop.state : "the issue is no longer delegated to Sergeant";
  await writeIntent(dir, CancelIntent.parse({ reason, requestId: randomUUID(), cause: stop.cause, at: new Date().toISOString() }));
}

export type CancelProgress = {
  /** This drive removed the V2 agent's delegation. */
  undelegated: boolean;
  /** Runs the runner has not yet confirmed stopped; empty once the cancel is done. */
  stopping: RunId[];
};

/** What a drive needs: the task's ports, and `undelegate` for a human's cancel through the API. */
export type CancelDeps = Ports & { undelegate?: ServiceDeps["undelegate"] };

/**
 * Drives the recorded cancel of the task `ref` in `dir` as far as it goes now. Throws when a step
 * fails before it is done; the intent stays, so the next poll or intake drives it again.
 */
export async function driveCancel(dir: string, ref: string, deps: CancelDeps, enrolled: RepoSlug[], log: (line: string) => void): Promise<CancelProgress> {
  const intent = await readIntent(dir);
  if (!intent) return { undelegated: false, stopping: [] };
  let undelegated = false;
  if (!intent.runIds) {
    const { issue } = await deps.linear.readConversation(ref);
    if (intent.cause === "api" && issue.delegate?.id === deps.agentUserId) {
      if (!deps.undelegate) throw new Error("this Sergeant cannot remove a delegation");
      await deps.undelegate(issue.id);
      undelegated = intent.acted = true;
      log(`${ref}: canceled through the API by ${intent.by ?? "an operator"}: ${intent.reason}`);
    }
    // Undelegated or stopped, the task's loop starts nothing more (the executor re-checks before each
    // start), and a start already past that check finished under the task's lock (service.ts) before
    // this drive began, so these are all the runs the cancel must stop. A later task's runs are not this cancel's.
    intent.runIds = runIdsOf(await readTaskState(join(dir, "state.json")));
    await writeIntent(dir, intent);
  }
  const stopping: RunId[] = [];
  const runs: RunRecord[] = [];
  for (const runId of intent.runIds) {
    const run = await deps.runner.status(runId).catch(() => undefined);
    if (run) runs.push(run);
    if (run && run.status !== "running") continue;
    await deps.runner.cancel(runId).then(
      () => ((intent.acted = true), log(`${ref}: canceled ${runId}`)),
      (e: Error) => (stopping.push(runId), log(`${ref}: cancel ${runId} not confirmed, retrying: ${e.message}`)),
    );
  }
  if (stopping.length > 0) {
    await writeIntent(dir, intent);
    return { undelegated, stopping };
  }
  // Every run is stopped, so nothing pushes to the task's PRs any more: close those still open.
  const { issue } = await deps.linear.readConversation(ref);
  for (const pr of await openPullRequests(issue.linkedPullRequests, runs, enrolled, deps)) {
    await deps.github.closePullRequest({ repo: pr.repo, number: pr.number, comment: prComment(intent) });
    intent.closed.push({ repo: pr.repo, number: pr.number, url: pr.url });
    intent.acted = true;
    await writeIntent(dir, intent);
    log(`${ref}: closed ${pr.url}`);
  }
  // Once per cancel, under its key. A stop by state always says so; a cancel that found nothing to
  // stop (an undelegated idle task, a repeated API cancel) says nothing.
  if (intent.cause === "state" || intent.acted) {
    await deps.linear.postComment({ issueId: issue.id, key: `cancel:${issue.id}:${intent.requestId}`, body: stopComment(intent) });
  }
  if (intent.cause === "state") {
    await rename(join(dir, "state.json"), join(dir, `state.stopped-${intent.at.replace(/[:.]/g, "-")}.json`)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }
  await rm(intentFile(dir), { force: true });
  return { undelegated, stopping };
}

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

const prComment = (intent: CancelIntent) =>
  intent.cause === "state"
    ? `Closed: the Linear issue was canceled or moved to ${intent.reason}.`
    : intent.cause === "undelegated"
      ? "Closed: the Linear issue is no longer delegated to Sergeant."
      : `Closed: Sergeant's task was canceled by ${intent.by ?? "an operator"}: ${intent.reason}`;

function stopComment(intent: CancelIntent): string {
  const why =
    intent.cause === "state"
      ? `because it was moved to ${intent.reason}`
      : intent.cause === "undelegated"
        ? "because it is no longer delegated to Sergeant"
        : `at the request of ${intent.by ?? "an operator"}: ${intent.reason}`;
  const closed = intent.closed.length > 0 ? `Closed ${intent.closed.map((p) => `[${p.repo}#${p.number}](${p.url})`).join(", ")}.` : "No open PR to close.";
  const next =
    intent.cause === "state"
      ? "Move the issue to Todo to start again as a fresh task."
      : intent.cause === "undelegated"
        ? "Delegate the issue to Sergeant again to resume."
        : "Its delegation is removed. Delegate the issue to Sergeant again to resume.";
  return `Sergeant stopped working on this issue ${why}. Its runs are canceled. ${closed}\n\n${next}`;
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
