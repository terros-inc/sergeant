import { readdir } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  CancelRunRequest,
  CancelTaskRequest,
  checkBudget,
  RunId,
  TaskRef,
  WakeRequest,
  type ApiError,
  type CancelRunResponse,
  type CancelTaskResponse,
  type LoginConfig,
  type RepoSlug,
  type RunDetail,
  type RunList,
  type RunRecord,
  type RunSummary,
  type TaskDetail,
  type TaskList,
  type TaskStatus,
  type TaskSummary,
  type WakeResponse,
  type WhoAmI,
} from "@terros/sergeant-contracts";
import type { z } from "zod";
import type { AccountRegistry } from "./accounts.ts";
import { accountsRoute } from "./api-accounts.ts";
import { body, callerOf, notFound, ok, parse, Refusal, type Reply, send } from "./api-http.ts";
import { callerName, type Caller } from "./auth.ts";
import { budgetStatus } from "./budget.ts";
import { CancelConflict, cancelRun, runIdsOf, type CancelProgress } from "./cancel.ts";
import { readTaskState, type TaskState } from "./loop.ts";
import type { ServiceDeps } from "./service.ts";

// The client API on `serve` (11 §2, UNF-713): the slice the `sgt` CLI uses. Reads come from each
// task's `state.json` and the runner, live; the two actions reuse what serve already does. A wake ends
// the task loop's wait and owes it one turn, still behind every hold the loop keeps. The cancels are
// commands of their own (cancel.ts): a task cancel removes the delegation, which the loop already
// obeys, and cancels the task's runs until the runner confirms each stopped, re-driven across a
// restart; a run cancel is the runner's own confirmed cancel. Nothing here reasons, merges, or starts
// work.
//
// Every call but `GET /v1/auth/config` (what `sgt login` needs to start) names its caller (auth.ts)
// and fails closed without one: a Linear user's own access token as a bearer, checked against Linear
// on every call, or, only under `serve --trust-loopback`, an operator on this host: a loopback peer
// with no token, naming a loopback Host (so a DNS-rebound page cannot pass), and not relayed by a
// proxy (so the hosted proxy's callers cannot). Posts must be JSON, so a cross-site form cannot post.
// Approvers are told apart (`Caller.approver`); no action here is theirs alone yet.

export type ApiControl = {
  stateDir: string;
  enrolledRepositories: RepoSlug[];
  deps: ServiceDeps;
  log: (line: string) => void;
  /** The task's loop in this process: running, waiting for a slot, or how it last ended. */
  loop(ref: TaskRef): { status: TaskStatus; detail?: string } | undefined;
  /** Tasks this process knows without reading the state directory: running or delegated. */
  known(): string[];
  /** Owes the task a turn now: `not_delegated` when there is no loop to run it. */
  wake(ref: TaskRef): Promise<WakeResponse["woke"] | "not_delegated">;
  /** Records the task's cancel by `by` and drives it now (cancel.ts); throws `CancelConflict` when it is not Sergeant's. */
  cancelTask(ref: TaskRef, req: z.infer<typeof CancelTaskRequest>, by: string): Promise<CancelProgress>;
  /** Resolves a bearer token to its caller (auth.ts); absent when the installation configures no `humans`. */
  callerOf?: (accessToken: string) => Promise<Caller>;
  /** The Linear OAuth app's public client id, served to `sgt login`. */
  linearClientId?: string;
  /** A loopback caller with no token is an operator (`serve --trust-loopback`). */
  trustLoopback?: boolean;
  /** The model accounts runs may use, and people's own (TECH-5113, api-accounts.ts). */
  accounts?: AccountRegistry;
};

/** Handles `/v1/*`; anything else is a 404. */
export function apiHandler(ctl: ApiControl): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    route(req, ctl).then(
      (reply) => send(res, reply),
      (e: Error) => {
        const refusal = e instanceof Refusal ? e : new Refusal(503, "unavailable", e.message);
        send(res, { status: refusal.status, json: { error: { code: refusal.code, message: refusal.message } } satisfies ApiError });
      },
    );
  };
}

async function route(req: IncomingMessage, ctl: ApiControl): Promise<Reply> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.split("/").slice(1);
  if (path[0] !== "v1") return { status: 404 };
  const get = req.method === "GET";
  const post = req.method === "POST";
  const [, noun, id, verb] = path;
  if (path.length > 4 || (!get && !post)) throw notFound(url.pathname);

  if (noun === "auth" && id === "config" && verb === undefined && get) {
    if (!ctl.linearClientId) throw new Refusal(404, "not_found", "this Sergeant has no Linear login configured (installation config `humans`)");
    return ok({ linear: { clientId: ctl.linearClientId } } satisfies LoginConfig);
  }
  const caller = await callerOf(req, ctl);
  if (noun === "whoami" && get && id === undefined) {
    const user = caller.kind === "linear" ? caller.user : null;
    return ok({ auth: caller.kind, user, approver: caller.approver, enrolledRepositories: ctl.enrolledRepositories } satisfies WhoAmI);
  }
  if (noun === "tasks") {
    if (id === undefined && get) return ok(await listTasks(ctl));
    if (id === undefined) throw notFound(url.pathname);
    const ref = parse(TaskRef, id);
    if (verb === undefined && get) return ok(await showTask(ctl, ref));
    if (verb === "wake" && post) return ok(await wakeTask(ctl, ref, parse(WakeRequest, await body(req)), caller));
    if (verb === "cancel" && post) return ok(await cancelTask(ctl, ref, parse(CancelTaskRequest, await body(req)), caller));
  }
  if (noun === "runs") {
    if (id === undefined && get) return ok(await listRuns(ctl, url.searchParams.get("task")));
    if (id === undefined) throw notFound(url.pathname);
    const runId = parse(RunId, id);
    if (verb === undefined && get) return ok(await showRun(ctl, runId));
    if (verb === "report" && get) return { status: 200, markdown: await runReport(ctl, runId) };
    if (verb === "cancel" && post) return ok(await cancelRunOf(ctl, runId, parse(CancelRunRequest, await body(req)), caller));
  }
  if (noun === "accounts") return accountsRoute(ctl.accounts, caller, req, { id, verb, pathname: url.pathname }, () => allRuns(ctl));
  throw notFound(url.pathname);
}

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
  };
}

async function listTasks(ctl: ApiControl): Promise<TaskList> {
  return { tasks: (await allTasks(ctl)).map((t) => summarize(ctl, t)) };
}

async function showTask(ctl: ApiControl, ref: TaskRef): Promise<TaskDetail> {
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

async function wakeTask(ctl: ApiControl, ref: TaskRef, req: z.infer<typeof WakeRequest>, caller: Caller): Promise<WakeResponse> {
  const woke = await ctl.wake(ref);
  if (woke === "not_delegated") throw new Refusal(409, "conflict", `${ref} has no loop to wake: it is not delegated to Sergeant's agent, or it waits in Triage or Backlog until it moves to Todo, or on a Linear blocker until that is completed or canceled`);
  ctl.log(`${ref}: woken through the API by ${callerName(caller)} (${woke})${req.reason ? `: ${req.reason}` : ""}`);
  return { ref, woke };
}

/**
 * The human's cancel (cancel.ts): recorded before anything changes, then driven now. A cancel whose
 * runs the runner has not yet confirmed stopped answers with them, and `serve` keeps driving it.
 */
async function cancelTask(ctl: ApiControl, ref: TaskRef, req: z.infer<typeof CancelTaskRequest>, caller: Caller): Promise<CancelTaskResponse> {
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
async function allRuns(ctl: ApiControl): Promise<RunRecord[]> {
  const runs = await Promise.all((await allTasks(ctl)).map((t) => readRuns(ctl, runIdsOf(t.state))));
  return runs.flat().flatMap((r) => (r.record ? [r.record] : []));
}

async function listRuns(ctl: ApiControl, taskFilter: string | null): Promise<RunList> {
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

async function showRun(ctl: ApiControl, runId: RunId): Promise<RunDetail> {
  const task = await ownerOf(ctl, runId);
  return { task, run: await ctl.deps.runner.status(runId) };
}

async function runReport(ctl: ApiControl, runId: RunId): Promise<string> {
  await ownerOf(ctl, runId);
  const markdown = await ctl.deps.runner.report?.(runId);
  if (markdown === undefined) throw new Refusal(404, "not_found", `${runId} has no report: it is running, or ended without writing one`);
  return markdown;
}

/** The runner's confirmed cancel, noted on the issue (cancel.ts). */
async function cancelRunOf(ctl: ApiControl, runId: RunId, req: z.infer<typeof CancelRunRequest>, caller: Caller): Promise<CancelRunResponse> {
  const task = await ownerOf(ctl, runId);
  const run = await cancelRun(task, runId, { reason: req.reason, by: callerName(caller) }, ctl.deps, ctl.log).catch((e: Error) => {
    throw new Refusal(503, "unavailable", `cancel of ${runId} not confirmed, retry: ${e.message}`);
  });
  return { runId, task, status: run.status };
}
