import { MAX_CI_RERUNS, type CiRerun, type CiRerunRequest, type PullRequestFacts, type RunRecord, type WorkflowRunFacts } from "@terros/sergeant-contracts";
import type { Ports } from "./execute-types.ts";
import type { TaskState } from "./task-state.ts";

// TECH-5839: a worker asks in its report for GitHub's "re-run failed jobs" on a failed workflow run of
// its task's PR, instead of pushing an empty commit. Sergeant handles each request once, as the run
// ends: it checks the request against the task's own PRs and the run GitHub reports, reruns it with the
// rerun App only the control plane holds, and records who asked, the PR, the run, and the outcome.

const short = (sha: string) => sha.slice(0, 12);

/** Why a request for one of the task's PRs is refused before its workflow run is read, if it is. */
export function refuseTarget(pr: PullRequestFacts, allowed: string[], workerLogin: string): string | undefined {
  const name = `${pr.repo}#${pr.number}`;
  if (pr.author !== workerLogin) return `${name} was not opened by Sergeant's worker App`;
  if (pr.state !== "open") return `${name} is ${pr.state}`;
  if (allowed.length === 0) return `${pr.repo} allows no CI reruns (no ciRerunWorkflows configured)`;
  return undefined;
}

/**
 * Why GitHub's account of the workflow run refuses the rerun, if it does: it must be in the PR's
 * repository, on the PR's current head, from an allowed workflow, failed, and rerun fewer than
 * `MAX_CI_RERUNS` times. `rerunsDone` is what this task recorded; GitHub's attempt count covers reruns
 * by anyone, and the larger of the two counts.
 */
export function refuseRun(run: WorkflowRunFacts, pr: PullRequestFacts, allowed: string[], rerunsDone: number): string | undefined {
  if (run.repo !== pr.repo) return `workflow run ${run.id} is in ${run.repo}, not ${pr.repo}`;
  if (run.headSha !== pr.headSha) return `stale: workflow run ${run.id} ran on ${short(run.headSha)}, but the PR's head is ${short(pr.headSha)}`;
  if (!allowed.includes(run.path)) return `${run.path} is not a workflow ${pr.repo} allows reruns of`;
  if (run.status !== "completed" || run.conclusion !== "failure") return `workflow run ${run.id} has not failed (${run.status}${run.conclusion ? `, ${run.conclusion}` : ""})`;
  const done = Math.max(run.attempt - 1, rerunsDone);
  if (done >= MAX_CI_RERUNS) return `workflow run ${run.id} was already rerun ${done} times, the most allowed`;
  return undefined;
}

async function handle(
  requestedBy: string,
  req: CiRerunRequest,
  pullRequests: PullRequestFacts[],
  recorded: CiRerun[],
  deps: Pick<Ports, "ciRerun" | "workerLogin">,
): Promise<CiRerun> {
  const at = new Date().toISOString();
  const base = { requestedBy, repo: req.repo, number: req.number, workflowRunId: req.workflowRunId, at };
  // The task's PRs as this pass read them live: the repo and PR always come from the task, never the request alone.
  const pr = pullRequests.find((p) => p.repo === req.repo && p.number === req.number);
  if (!pr) return { ...base, outcome: "rejected", reason: `${req.repo}#${req.number} is not a pull request of this task` };
  const port = deps.ciRerun;
  if (!port) return { ...base, outcome: "rejected", reason: "this Sergeant has no CI rerun App configured" };
  const allowed = port.allowedWorkflows(req.repo);
  const target = refuseTarget(pr, allowed, deps.workerLogin);
  if (target) return { ...base, outcome: "rejected", reason: target };
  const checked = { ...base, headSha: pr.headSha };
  let run: WorkflowRunFacts;
  try {
    run = await port.readWorkflowRun(req.repo, req.workflowRunId);
  } catch (e) {
    return { ...checked, outcome: "failed", reason: `reading the workflow run failed: ${(e as Error).message}` };
  }
  const read = { ...checked, workflow: run.path, attempt: run.attempt };
  const done = recorded.filter((r) => r.outcome === "rerun" && r.repo === req.repo && r.workflowRunId === req.workflowRunId).length;
  const refused = refuseRun(run, pr, allowed, done);
  if (refused) return { ...read, outcome: "rejected", reason: refused };
  try {
    await port.rerunFailedJobs(req.repo, req.workflowRunId);
  } catch (e) {
    return { ...read, outcome: "failed", reason: `the rerun failed: ${(e as Error).message}` };
  }
  return { ...read, outcome: "rerun", reason: `reran the failed jobs of attempt ${run.attempt}: ${run.url}` };
}

/**
 * Handles every rerun request in an ended worker's report that the task has not handled yet, each
 * once: its record is saved whatever the outcome, so a refused or failed request is not tried again.
 * Returns how many GitHub reran, so the caller rereads the PRs before a turn.
 */
export async function performCiReruns(
  runs: RunRecord[],
  pullRequests: PullRequestFacts[],
  state: Pick<TaskState, "ciReruns">,
  deps: Pick<Ports, "ciRerun" | "workerLogin">,
  log: (line: string) => void,
  save: () => Promise<void>,
): Promise<number> {
  let reran = 0;
  for (const run of runs) {
    if (run.role !== "worker" || run.status === "running") continue;
    for (const req of run.report?.rerunFailedCI ?? []) {
      const handled = state.ciReruns.some((r) => r.requestedBy === run.runId && r.repo === req.repo && r.workflowRunId === req.workflowRunId);
      if (handled) continue;
      const record = await handle(run.runId, req, pullRequests, state.ciReruns, deps);
      state.ciReruns.push(record);
      await save();
      log(`CI rerun of ${req.repo} workflow run ${req.workflowRunId} for #${req.number}, asked by ${run.runId}: ${record.outcome} (${record.reason})`);
      if (record.outcome === "rerun") reran++;
    }
  }
  return reran;
}
