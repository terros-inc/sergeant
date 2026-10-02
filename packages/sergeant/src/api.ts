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
// No client authentication exists yet (UNF-718), so `/v1` answers only a caller on this host: a
// loopback peer, naming a loopback Host (so a DNS-rebound page cannot reach it), not relayed by a
// proxy, and posting JSON (so a cross-site form cannot). Anything else is refused, whatever interface
// `serve` listens on or whatever a proxy in front of it forwards.

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
  /** Records the task's cancel and drives it now (cancel.ts); throws `CancelConflict` when it is not Sergeant's. */
  cancelTask(ref: TaskRef, req: z.infer<typeof CancelTaskRequest>): Promise<CancelProgress>;
};

type Reply = { status: number; json?: unknown; markdown?: string };

class Refusal extends Error {
  readonly status: number;
  readonly code: ApiError["error"]["code"];
  constructor(status: number, code: ApiError["error"]["code"], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const LOOPBACK_PEER = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

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

function send(res: ServerResponse, reply: Reply): void {
  if (reply.markdown !== undefined) {
    res.writeHead(reply.status, { "Content-Type": "text/markdown; charset=utf-8" }).end(reply.markdown);
  } else if (reply.json !== undefined) {
    res.writeHead(reply.status, { "Content-Type": "application/json" }).end(JSON.stringify(reply.json));
  } else {
    res.writeHead(reply.status).end();
  }
}

async function route(req: IncomingMessage, ctl: ApiControl): Promise<Reply> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.split("/").slice(1);
  if (path[0] !== "v1") return { status: 404 };
  const forwarded = req.headers.forwarded !== undefined || req.headers["x-forwarded-for"] !== undefined;
  if (!LOOPBACK_PEER.has(req.socket.remoteAddress ?? "") || !LOOPBACK_HOST.test(req.headers.host ?? "") || forwarded) {
    throw new Refusal(403, "forbidden", "the Sergeant API answers only callers on its own host until client authentication exists (UNF-718)");
  }
  const get = req.method === "GET";
  const post = req.method === "POST";
  const [, noun, id, verb] = path;
  if (path.length > 4 || (!get && !post)) throw notFound(url.pathname);

  if (noun === "whoami" && get && id === undefined) {
    return ok({ user: null, auth: "loopback", enrolledRepositories: ctl.enrolledRepositories } satisfies WhoAmI);
  }
  if (noun === "tasks") {
    if (id === undefined && get) return ok(await listTasks(ctl));
    if (id === undefined) throw notFound(url.pathname);
    const ref = parse(TaskRef, id);
    if (verb === undefined && get) return ok(await showTask(ctl, ref));
    if (verb === "wake" && post) return ok(await wakeTask(ctl, ref, parse(WakeRequest, await body(req))));
    if (verb === "cancel" && post) return ok(await cancelTask(ctl, ref, parse(CancelTaskRequest, await body(req))));
  }
  if (noun === "runs") {
    if (id === undefined && get) return ok(await listRuns(ctl, url.searchParams.get("task")));
    if (id === undefined) throw notFound(url.pathname);
    const runId = parse(RunId, id);
    if (verb === undefined && get) return ok(await showRun(ctl, runId));
    if (verb === "report" && get) return { status: 200, markdown: await runReport(ctl, runId) };
    if (verb === "cancel" && post) return ok(await cancelRunOf(ctl, runId, parse(CancelRunRequest, await body(req))));
  }
  throw notFound(url.pathname);
}

const ok = (json: unknown): Reply => ({ status: 200, json });
const notFound = (what: string) => new Refusal(404, "not_found", `no ${what}`);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Refusal(400, "bad_request", parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
    throw new Refusal(400, "bad_request", "send the request body as application/json");
  }
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 64_000) throw new Refusal(400, "bad_request", "request body too large");
  }
  try {
    return raw === "" ? {} : JSON.parse(raw);
  } catch {
    throw new Refusal(400, "bad_request", "request body is not JSON");
  }
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

async function wakeTask(ctl: ApiControl, ref: TaskRef, req: z.infer<typeof WakeRequest>): Promise<WakeResponse> {
  const woke = await ctl.wake(ref);
  if (woke === "not_delegated") throw new Refusal(409, "conflict", `${ref} is not delegated to Sergeant's agent, so it has no loop to wake`);
  ctl.log(`${ref}: woken through the API (${woke})${req.reason ? `: ${req.reason}` : ""}`);
  return { ref, woke };
}

/**
 * The human's cancel (cancel.ts): recorded before anything changes, then driven now. A cancel whose
 * runs the runner has not yet confirmed stopped answers with them, and `serve` keeps driving it.
 */
async function cancelTask(ctl: ApiControl, ref: TaskRef, req: z.infer<typeof CancelTaskRequest>): Promise<CancelTaskResponse> {
  await findTask(ctl, ref);
  const progress = await ctl.cancelTask(ref, req).catch((e: Error) => {
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
  return { runId, task, role: r.role, status: r.status, model: r.model, costUsd: r.costUsd, summary };
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
async function cancelRunOf(ctl: ApiControl, runId: RunId, req: z.infer<typeof CancelRunRequest>): Promise<CancelRunResponse> {
  const task = await ownerOf(ctl, runId);
  const run = await cancelRun(task, runId, req.reason, ctl.deps, ctl.log).catch((e: Error) => {
    throw new Refusal(503, "unavailable", `cancel of ${runId} not confirmed, retry: ${e.message}`);
  });
  return { runId, task, status: run.status };
}
