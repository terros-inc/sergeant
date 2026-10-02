import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RunId, type RunRecord, type TaskRef } from "@terros/sergeant-contracts";
import { z } from "zod";
import { readTaskState, type TaskState } from "./loop.ts";
import type { ServiceDeps } from "./service.ts";

// The human's cancels through the client API (11 §2), as commands the API only calls. A task cancel
// is an ordered close that survives a stop or crash (07 §8): its intent is on disk before anything
// changes, then the V2 agent's delegation is removed and the cancel said on the issue, then every
// recorded run not confirmed stopped is canceled through the runner. Delegation goes first so that no
// run starts after the runs to stop are listed. The intent is removed only once the runner confirms
// each stopped; until then `serve` drives it again at every intake, its startup included, whatever
// the issue's delegation is by then. A run whose status cannot be read is unknown and is canceled
// like a running one, never taken as stopped (04 §6).

const CancelIntent = z.object({
  reason: z.string(),
  requestId: z.string(),
  /** Who asked (auth.ts `callerName`); absent on a cancel recorded before callers were named. */
  by: z.string().optional(),
  at: z.iso.datetime(),
  /** The task's runs when its delegation was gone: set once the Linear step is done. */
  runIds: z.array(RunId).optional(),
});
type CancelIntent = z.infer<typeof CancelIntent>;

/** The request cannot be carried out as asked; nothing was recorded. */
export class CancelConflict extends Error {}

const taskDir = (stateDir: string, ref: string) => join(stateDir, "tasks", ref);
const intentFile = (stateDir: string, ref: string) => join(taskDir(stateDir, ref), "cancel.json");

/** Every run the task recorded, its sampled audit included. */
export const runIdsOf = (state: TaskState | undefined): RunId[] =>
  state ? [...new Set([...state.runIds, ...(state.merged?.audit ? [state.merged.audit.runId] : [])])] : [];

/** Tasks whose cancel is recorded and not yet confirmed. */
export async function pendingCancels(stateDir: string): Promise<string[]> {
  const refs = await readdir(join(stateDir, "tasks")).catch(() => []);
  // Only whether one is there: a cancel that cannot be read fails its own drive, not the intake.
  const pending = await Promise.all(refs.map(async (ref) => ((await stat(intentFile(stateDir, ref)).catch(() => undefined)) ? [ref] : [])));
  return pending.flat();
}

async function readIntent(stateDir: string, ref: string): Promise<CancelIntent | undefined> {
  const raw = await readFile(intentFile(stateDir, ref), "utf8").catch(() => undefined);
  return raw === undefined ? undefined : CancelIntent.parse(JSON.parse(raw));
}

/**
 * Records the cancel of a task: refused for an issue delegated to someone else, and kept as it was
 * when one is already recorded, so a repeat posts nothing more. The caller then drives it.
 */
export async function recordCancel(stateDir: string, ref: TaskRef, req: { reason: string; requestId?: string | undefined; by: string }, deps: ServiceDeps): Promise<void> {
  if (!deps.undelegate) throw new Error("this Sergeant cannot remove a delegation");
  if (await readIntent(stateDir, ref)) return;
  const { issue } = await deps.linear.readConversation(ref);
  if (issue.delegate && issue.delegate.id !== deps.agentUserId) {
    throw new CancelConflict(`${ref} is delegated to ${issue.delegate.name}, not Sergeant's agent`);
  }
  const intent: CancelIntent = { reason: req.reason, requestId: req.requestId ?? randomUUID(), by: req.by, at: new Date().toISOString() };
  await mkdir(taskDir(stateDir, ref), { recursive: true });
  await writeFile(intentFile(stateDir, ref), JSON.stringify(intent, null, 2));
}

export type CancelProgress = {
  /** This drive removed the V2 agent's delegation. */
  undelegated: boolean;
  /** Runs the runner has not yet confirmed stopped; empty once the cancel is done. */
  stopping: RunId[];
};

/**
 * Drives a recorded cancel as far as it goes now. Throws when a step fails before the runs are
 * reached; the intent stays, so the next intake drives it again.
 */
export async function driveCancel(stateDir: string, ref: string, deps: ServiceDeps, log: (line: string) => void): Promise<CancelProgress> {
  const intent = await readIntent(stateDir, ref);
  if (!intent) return { undelegated: false, stopping: [] };
  let undelegated = false;
  if (!intent.runIds) {
    const { issue } = await deps.linear.readConversation(ref);
    if (issue.delegate?.id === deps.agentUserId) {
      if (!deps.undelegate) throw new Error("this Sergeant cannot remove a delegation");
      await deps.undelegate(issue.id);
      await deps.linear.postComment({
        issueId: issue.id,
        key: `cancel:${issue.id}:${intent.requestId}`,
        body: `Sergeant stopped working on this issue at the request of ${intent.by ?? "an operator"}: ${intent.reason}\n\nIts delegation is removed and any running work is canceled. Delegate the issue to Sergeant again to resume.`,
      });
      undelegated = true;
      log(`${ref}: canceled through the API by ${intent.by ?? "an operator"}: ${intent.reason}`);
    }
    // Undelegated, the task's loop starts nothing more (the executor re-checks before each start), and
    // a start already past that check finished under the task's lock (service.ts) before this drive
    // began, so these are all the runs the cancel must stop. A later delegation's new runs are not this cancel's.
    intent.runIds = runIdsOf(await readTaskState(join(taskDir(stateDir, ref), "state.json")));
    await writeFile(intentFile(stateDir, ref), JSON.stringify(intent, null, 2));
  }
  const stopping: RunId[] = [];
  for (const runId of intent.runIds) {
    const status = await deps.runner.status(runId).then((r: RunRecord) => r.status, () => "unknown" as const);
    if (status !== "running" && status !== "unknown") continue;
    await deps.runner.cancel(runId).then(
      () => log(`${ref}: canceled ${runId}`),
      (e: Error) => (stopping.push(runId), log(`${ref}: cancel ${runId} not confirmed, retrying next intake: ${e.message}`)),
    );
  }
  if (stopping.length === 0) await rm(intentFile(stateDir, ref), { force: true });
  return { undelegated, stopping };
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
