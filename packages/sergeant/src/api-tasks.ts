import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  checkBudget,
  RunId,
  TaskRef,
  type CancelRunRequest,
  type CancelRunResponse,
  type CancelTaskRequest,
  type CancelTaskResponse,
  type RunDetail,
  type RunList,
  type RunRecord,
  type RunSummary,
  type TaskDetail,
  type TaskList,
  type TaskSummary,
  type WakeRequest,
  type WakeResponse,
} from "@terros/sergeant-contracts";
import type { z } from "zod";
import type { ApiControl } from "./api.ts";
import { parse, Refusal } from "./api-http.ts";
import { callerName, type Caller } from "./auth.ts";
import { budgetStatus } from "./budget.ts";
import { CancelConflict, cancelRun, runIdsOf } from "./cancel.ts";
import { readTaskState, type TaskState } from "./loop.ts";

// `/v1/tasks` and `/v1/runs` (11 §2, UNF-713): what api.ts routes there. Reads come from each task's
// `state.json` and the runner, live; a wake and the cancels go through `ApiControl` and cancel.ts.

// --- tasks

type Task = { ref: TaskRef; state: TaskState | undefined };

const stateFile = (ctl: ApiControl, ref: string) => join(ctl.stateDir, "tasks", ref, "state.json");

/** Every task with a directory, a running loop, or a delegation seen at the last intake. */
async function allTasks(ctl: ApiControl): Promise<Task[]> {
  const dirs = await readdir(join(ctl.stateDir, "tasks")).catch(() => []);
  const refs = [...new Set([...dirs, ...ctl.known()])].filter((r) => TaskRef.safeParse(r).success).sort(byRef);
  return Promise.all(refs.map(async (ref) => ({ ref, state: await readTaskState(stateFile(ctl, ref)) })));
}

async function findTask(ctl: ApiControl, ref: TaskRef): Promise<Task> {
  const state = await readTaskState(stateFile(ctl, ref));
  if (!state && !ctl.known().includes(ref)) throw new Refusal(404, "not_found", `Sergeant has no task for ${ref}`);
  return { ref, state };
}

const byRef = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

function summarize(ctl: ApiControl, { ref, state }: Task): TaskSummary {
  const loop = ctl.loop(ref);
  const merged = state?.merged;
  return {
    ref,
    status: loop?.status ?? (merged ? "merged" : "inactive"),
    statusDetail: loop?.detail,
    startedAt: state?.startedAt,
    turns: state?.turns ?? 0,
    lastTurnAt: state?.lastTurnAt,
    lastSummary: state?.recentTurns.at(-1)?.summary,
    runs: runIdsOf(state).length,
    merged: merged && { repo: merged.repo, number: merged.number, mergedSha: merged.mergedSha, at: merged.at },
    // TECH-5164: a task stuck finishing its accepted ending (a resolve that keeps failing, say) says so.
    acceptedEnding: state?.accepted && { since: state.accepted.at },
  };
}

export async function listTasks(ctl: ApiControl): Promise<TaskList> {
  return { tasks: (await allTasks(ctl)).map((t) => summarize(ctl, t)) };
}

export async function showTask(ctl: ApiControl, ref: TaskRef): Promise<TaskDetail> {
  const task = await findTask(ctl, ref);
  const [records, issue] = await Promise.all([
    readRuns(ctl, runIdsOf(task.state)),
    ctl.deps.linear.readConversation(ref).then(
      ({ issue: i }) => ({
        title: i.title,
        state: i.state,
        url: i.url,
        delegatedToSergeant: i.delegate?.id === ctl.deps.agentUserId,
        delegate: i.delegate?.name ?? null,
      }),
      (e: Error) => ({ error: e.message }),
    ),
  ]);
  const known = records.flatMap((r) => (r.record ? [r.record] : []));
  const state = task.state;
  const budget = state && budgetStatus({ ...state.budget, startedAt: state.startedAt, turnCostUsd: state.turnCostUsd, runs: known, unknownRuns: records.length - known.length });
  const verdict = budget && checkBudget(budget, new Date());
  return {
    task: summarize(ctl, task),
    issue,
    budget: budget && { ...budget, exhausted: verdict && !verdict.allowed ? verdict.reason : undefined },
    runs: records.map((r) => runSummary(ref, r)),
    recentTurns: state?.recentTurns.slice(-5) ?? [],
    followups: state?.followups ?? [],
  };
}

export async function wakeTask(ctl: ApiControl, ref: TaskRef, req: z.infer<typeof WakeRequest>, caller: Caller): Promise<WakeResponse> {
  const woke = await ctl.wake(ref);
  if (woke === "not_delegated") throw new Refusal(409, "conflict", `${ref} has no loop to wake: it is not delegated to Sergeant's agent, or it waits in Triage or Backlog until it moves to Todo, or on a Linear blocker until that is completed or canceled`);
  ctl.log(`${ref}: woken through the API by ${callerName(caller)} (${woke})${req.reason ? `: ${req.reason}` : ""}`);
  return { ref, woke };
}

/**
 * The human's cancel (cancel.ts): recorded before anything changes, then driven now. A cancel whose
 * runs the runner has not yet confirmed stopped answers with them, and `serve` keeps driving it.
 */
export async function cancelTask(ctl: ApiControl, ref: TaskRef, req: z.infer<typeof CancelTaskRequest>, caller: Caller): Promise<CancelTaskResponse> {
  await findTask(ctl, ref);
  const progress = await ctl.cancelTask(ref, req, callerName(caller)).catch((e: Error) => {
    if (e instanceof CancelConflict) throw new Refusal(409, "conflict", e.message);
    throw new Refusal(503, "unavailable", `the cancel of ${ref} is not done; once recorded, Sergeant keeps retrying it: ${e.message}`);
  });
  return { ref, ...progress };
}

// --- runs

type ReadRun = { runId: RunId; record?: RunRecord; error?: string };

/** A run whose status cannot be read is unknown, never stopped (04 §6). */
const readRuns = (ctl: ApiControl, runIds: RunId[]): Promise<ReadRun[]> =>
  Promise.all(
    runIds.map((runId) =>
      ctl.deps.runner.status(runId).then(
        (record) => ({ runId, record }),
        (e: Error) => ({ runId, error: e.message }),
      ),
    ),
  );

function runSummary(task: TaskRef, { runId, record: r, error }: ReadRun): RunSummary {
  if (!r) return { runId, task, status: "unknown", error };
  const summary = r.report ? (r.role === "reviewer" ? `${r.report.verdict}: ${r.report.summary}` : r.report.summary) : r.reportError;
  return { runId, task, role: r.role, status: r.status, model: r.model, costUsd: r.costUsd, account: r.account?.holder, summary };
}

/** Every readable run of every task Sergeant knows: what each model account paid for. */
export async function allRuns(ctl: ApiControl): Promise<RunRecord[]> {
  const runs = await Promise.all((await allTasks(ctl)).map((t) => readRuns(ctl, runIdsOf(t.state))));
  return runs.flat().flatMap((r) => (r.record ? [r.record] : []));
}

export async function listRuns(ctl: ApiControl, taskFilter: string | null): Promise<RunList> {
  const tasks = taskFilter === null ? await allTasks(ctl) : [await findTask(ctl, parse(TaskRef, taskFilter))];
  const runs = await Promise.all(tasks.map(async (t) => (await readRuns(ctl, runIdsOf(t.state))).map((r) => runSummary(t.ref, r))));
  return { runs: runs.flat() };
}

/** The task whose `state.json` lists the run: the API serves only Sergeant's own tasks' runs. */
async function ownerOf(ctl: ApiControl, runId: RunId): Promise<TaskRef> {
  const owner = (await allTasks(ctl)).find((t) => runIdsOf(t.state).includes(runId));
  if (!owner) throw new Refusal(404, "not_found", `no task has run ${runId}`);
  return owner.ref;
}

export async function showRun(ctl: ApiControl, runId: RunId): Promise<RunDetail> {
  const task = await ownerOf(ctl, runId);
  return { task, run: await ctl.deps.runner.status(runId) };
}

export async function runReport(ctl: ApiControl, runId: RunId): Promise<string> {
  await ownerOf(ctl, runId);
  const markdown = await ctl.deps.runner.report?.(runId);
  if (markdown === undefined) throw new Refusal(404, "not_found", `${runId} has no report: it is running, or ended without writing one`);
  return markdown;
}

/** The runner's confirmed cancel, noted on the issue (cancel.ts). */
export async function cancelRunOf(ctl: ApiControl, runId: RunId, req: z.infer<typeof CancelRunRequest>, caller: Caller): Promise<CancelRunResponse> {
  const task = await ownerOf(ctl, runId);
  const run = await cancelRun(task, runId, { reason: req.reason, by: callerName(caller) }, ctl.deps, ctl.log).catch((e: Error) => {
    throw new Refusal(503, "unavailable", `cancel of ${runId} not confirmed, retry: ${e.message}`);
  });
  return { runId, task, status: run.status };
}
