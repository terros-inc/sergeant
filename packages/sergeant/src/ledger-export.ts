import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { checkBudget, SituationReport } from "@terros/sergeant-contracts";
import { z } from "zod";
import { awaitedHumanPrAction } from "./pr-wait.ts";
import { openQuestion } from "./question.ts";

// TECH-5922 (read-only). Sergeant keeps no billing ledger or events table (docs/design/02 describes an
// aspirational SQLite ledger that was never built). The real durable store is per-task JSON on the
// daemon's data volume: `<stateDir>/tasks/<ISSUE-ID>/{state.json,turns.jsonl,...}` and
// `<stateDir>/runs/<runId>/{run.json,record.json}`. This assembles those files into one JSON Lines
// stream for offline analysis (budget-analysis.ts). It opens nothing but files, reads no live service,
// and changes no runtime behaviour. Times are copied through verbatim: ISO-8601, UTC (trailing `Z`)
// for Sergeant-stamped fields, with an offset for Linear-sourced ones (e.g. comment times). All
// durations the analysis derives are in seconds and all costs in USD.

/** One window's allowance, copied from the snapshot. */
const Window = z.object({ wallMinutes: z.number(), costUsd: z.number() });

/** A task row: its identity and budget accounting. One per task that had a turn in range. */
export const TaskExport = z.object({
  type: z.literal("task"),
  issueId: z.string(),
  /** First window start (task admission). */
  startedAt: z.string(),
  /** The window stored now; earlier windows are reconstructed from each turn's own snapshot. */
  window: Window,
  /** Current window start if reopened after admission (a human answer, TECH-5059). */
  since: z.string().optional(),
  priorRuns: z.array(z.string()),
  /** The start of every fresh window an unblock opened (TECH-5803). */
  unblockedAt: z.array(z.string()),
  turns: z.number(),
  turnCostUsd: z.number(),
  runIds: z.array(z.string()),
  repositories: z.array(z.string()),
  blockedBy: z.array(z.string()).optional(),
  merged: z.object({ at: z.string(), repo: z.string(), number: z.number(), headSha: z.string(), mergedSha: z.string(), completedAt: z.string().optional() }).optional(),
  accepted: z.object({ at: z.string(), close: z.string().optional() }).optional(),
  stopped: z.object({ at: z.string(), reason: z.string() }).optional(),
  canceled: z.object({ at: z.string(), reason: z.string() }).optional(),
});
export type TaskExport = z.infer<typeof TaskExport>;

/** A run as seen inside a turn's snapshot: role and status only (RunRecord carries no timestamps). */
const RunInTurn = z.object({ runId: z.string(), role: z.string().optional(), status: z.string().optional() });

/** One reasoning turn, projected from a `turns.jsonl` line, with the budget and waits it saw. */
export const TurnExport = z.object({
  type: z.literal("turn"),
  issueId: z.string(),
  /** Turn completion time (`turns.jsonl` `at`). The loop records no turn start, so turn compute time is not recoverable here. */
  at: z.string(),
  window: Window,
  /** The snapshot's window start; turns sharing one belong to the same budget window. */
  windowStart: z.string(),
  wallDeadline: z.string(),
  spentUsd: z.number(),
  costLimitUsd: z.number(),
  unknownCostRuns: z.number(),
  /** `checkBudget` at `at`: whether the window was already over wall time or spend. */
  exhausted: z.boolean(),
  exhaustedReason: z.string().optional(),
  runs: z.array(RunInTurn),
  runningCount: z.number(),
  /** An unanswered Sergeant question was open (question.ts `openQuestion`). */
  waitingOnHumanQuestion: z.boolean(),
  /** A required human PR action was awaited (pr-wait.ts `awaitedHumanPrAction`), or null. */
  waitingOnHumanPr: z.string().nullable(),
  /** Some open PR had a required check still `pending` or `missing`. */
  waitingOnCi: z.boolean(),
  /** Some run in the snapshot had ended with `failureReason: quota` (a rate-limit stop). */
  runQuotaFailure: z.boolean(),
  /** Action kinds this turn performed (e.g. start_worker, ask_human, merge_pr). */
  actions: z.array(z.string()),
  turnCostUsd: z.number().nullable(),
  turnSummary: z.string(),
  /** Whether the human-wait signals were computed (the snapshot parsed) or left false because it did not. */
  signalsComputed: z.boolean(),
});
export type TurnExport = z.infer<typeof TurnExport>;

/** A run row from `runs/<id>/{run.json,record.json}`: the only authoritative run start time. */
export const RunExport = z.object({
  type: z.literal("run"),
  runId: z.string(),
  issueId: z.string(),
  role: z.string().nullable(),
  status: z.string().nullable(),
  /** RunMeta.startedAt (run.json): when the runner was asked to start it. */
  startedAt: z.string().optional(),
  /** record.json mtime: the nearest available proxy for when the run ended (no `endedAt` is stored). */
  recordWrittenAt: z.string().optional(),
  costUsd: z.number().optional(),
  costBasis: z.string().optional(),
  failureReason: z.string().optional(),
  reportProblem: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  /** This run belongs to an earlier window (listed in the task's priorRuns). */
  prior: z.boolean(),
});
export type RunExport = z.infer<typeof RunExport>;

export const ExportRecord = z.discriminatedUnion("type", [TaskExport, TurnExport, RunExport]);
export type ExportRecord = z.infer<typeof ExportRecord>;

export type DateRange = { sinceMs: number; untilMs: number };

/** `--since`/`--until` are calendar dates (UTC); `until` is inclusive of its whole day. */
export function parseRange(since: string, until: string): DateRange {
  const sinceMs = Date.parse(`${since}T00:00:00.000Z`);
  const untilMs = Date.parse(`${until}T00:00:00.000Z`) + 24 * 3_600_000;
  if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) throw new Error(`bad date range ${since}..${until} (expected YYYY-MM-DD)`);
  return { sinceMs, untilMs };
}

const inRange = (at: string | undefined, r: DateRange): boolean => {
  if (!at) return false;
  const t = Date.parse(at);
  return !Number.isNaN(t) && t >= r.sinceMs && t < r.untilMs;
};

/** A required check still blocking (GitHub has it `pending` or no run yet). */
const pendingChecks = (pr: { state?: string; checks?: { required?: { state?: string }[] } }) =>
  pr.state === "open" && (pr.checks?.required ?? []).some((c) => c.state === "pending" || c.state === "missing");

/** Signals the analysis needs about a turn, from its situation snapshot. Best-effort: unknowns read false. */
function turnSignals(situation: unknown): { waitingOnHumanQuestion: boolean; waitingOnHumanPr: string | null; waitingOnCi: boolean; runQuotaFailure: boolean; signalsComputed: boolean } {
  const parsed = SituationReport.safeParse(situation);
  if (!parsed.success) {
    // An older or newer snapshot shape: fall back to the few fields we can read raw.
    const s = situation as { pullRequests?: { state?: string; checks?: { required?: { state?: string }[] } }[]; runs?: { failureReason?: string }[] };
    return {
      waitingOnHumanQuestion: false,
      waitingOnHumanPr: null,
      waitingOnCi: (s.pullRequests ?? []).some(pendingChecks),
      runQuotaFailure: (s.runs ?? []).some((rec) => rec.failureReason === "quota"),
      signalsComputed: false,
    };
  }
  const s = parsed.data;
  return {
    waitingOnHumanQuestion: openQuestion(s.conversation) !== undefined,
    waitingOnHumanPr: awaitedHumanPrAction(s) ?? null,
    waitingOnCi: s.pullRequests.some(pendingChecks),
    runQuotaFailure: s.runs.some((rec) => rec.failureReason === "quota"),
    signalsComputed: true,
  };
}

type RawTurnLine = { at?: string; situation?: { budget?: unknown; runs?: { runId?: string; role?: string; status?: string }[] }; turn?: { costUsd?: number; output?: { summary?: string } }; outcomes?: { action?: { kind?: string } }[] };

function turnRecord(issueId: string, line: RawTurnLine): TurnExport | undefined {
  const at = line.at;
  const budget = line.situation?.budget as { window?: { wallMinutes?: number; costUsd?: number }; windowStart?: string; wallDeadline?: string; spentUsd?: number; costLimitUsd?: number; unknownCostRuns?: number } | undefined;
  if (!at || !budget?.windowStart || !budget.wallDeadline || !budget.window) return undefined;
  const verdict = checkBudget(budget as Parameters<typeof checkBudget>[0], new Date(at));
  const runs = (line.situation?.runs ?? []).map((rec) => ({ runId: rec.runId ?? "", role: rec.role, status: rec.status }));
  const signals = turnSignals(line.situation);
  return {
    type: "turn",
    issueId,
    at,
    window: { wallMinutes: budget.window.wallMinutes ?? 0, costUsd: budget.window.costUsd ?? 0 },
    windowStart: budget.windowStart,
    wallDeadline: budget.wallDeadline,
    spentUsd: budget.spentUsd ?? 0,
    costLimitUsd: budget.costLimitUsd ?? 0,
    unknownCostRuns: budget.unknownCostRuns ?? 0,
    exhausted: !verdict.allowed,
    ...(!verdict.allowed && verdict.reason ? { exhaustedReason: verdict.reason } : {}),
    runs,
    runningCount: runs.filter((r) => r.status === "running").length,
    ...signals,
    actions: (line.outcomes ?? []).flatMap((o) => (o.action?.kind ? [o.action.kind] : [])),
    turnCostUsd: line.turn?.costUsd ?? null,
    turnSummary: line.turn?.output?.summary ?? "",
  };
}

async function runRecord(stateDir: string, runId: string, issueId: string, prior: boolean): Promise<RunExport> {
  const dir = join(stateDir, "runs", runId);
  const meta = await readJson<{ role?: string; startedAt?: string; provider?: string; model?: string }>(join(dir, "run.json"));
  const record = await readJson<{ status?: string; costUsd?: number; costBasis?: string; failureReason?: string; reportProblem?: string; provider?: string; model?: string }>(join(dir, "record.json"));
  const writtenAt = await stat(join(dir, "record.json")).then((s) => s.mtime.toISOString(), () => undefined);
  return {
    type: "run",
    runId,
    issueId,
    role: meta?.role ?? null,
    status: record?.status ?? null,
    ...(meta?.startedAt ? { startedAt: meta.startedAt } : {}),
    ...(writtenAt ? { recordWrittenAt: writtenAt } : {}),
    ...(record?.costUsd !== undefined ? { costUsd: record.costUsd } : {}),
    ...(record?.costBasis ? { costBasis: record.costBasis } : {}),
    ...(record?.failureReason ? { failureReason: record.failureReason } : {}),
    ...(record?.reportProblem ? { reportProblem: record.reportProblem } : {}),
    ...(meta?.provider ?? record?.provider ? { provider: meta?.provider ?? record?.provider } : {}),
    ...(meta?.model ?? record?.model ? { model: meta?.model ?? record?.model } : {}),
    prior,
  };
}

async function readJson<T>(file: string): Promise<T | undefined> {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

type TaskStateRaw = {
  issueId?: string;
  startedAt?: string;
  budget?: { window?: { wallMinutes?: number; costUsd?: number }; since?: string; priorRuns?: string[] };
  unblockedAt?: string[];
  turns?: number;
  turnCostUsd?: number;
  runIds?: string[];
  repositories?: string[];
  blockedBy?: string[];
  merged?: { at?: string; repo?: string; number?: number; headSha?: string; mergedSha?: string; completedAt?: string };
  accepted?: { at?: string; close?: string };
};

/** Every record for one task directory, or an empty list when it has no in-range turn. */
export async function exportTask(stateDir: string, issueId: string, range: DateRange): Promise<ExportRecord[]> {
  const dir = join(stateDir, "tasks", issueId);
  const state = await readJson<TaskStateRaw>(join(dir, "state.json"));
  if (!state) return [];

  const lines = (await readFile(join(dir, "turns.jsonl"), "utf8").catch(() => "")).split("\n").filter((l) => l.trim() !== "");
  const turns: TurnExport[] = [];
  for (const line of lines) {
    let parsed: RawTurnLine;
    try {
      parsed = JSON.parse(line) as RawTurnLine;
    } catch {
      continue;
    }
    if (!inRange(parsed.at, range)) continue;
    const rec = turnRecord(issueId, parsed);
    if (rec) turns.push(rec);
  }
  if (turns.length === 0) return [];

  const task: TaskExport = {
    type: "task",
    issueId,
    startedAt: state.startedAt ?? "",
    window: { wallMinutes: state.budget?.window?.wallMinutes ?? 0, costUsd: state.budget?.window?.costUsd ?? 0 },
    ...(state.budget?.since ? { since: state.budget.since } : {}),
    priorRuns: state.budget?.priorRuns ?? [],
    unblockedAt: state.unblockedAt ?? [],
    turns: state.turns ?? turns.length,
    turnCostUsd: state.turnCostUsd ?? 0,
    runIds: state.runIds ?? [],
    repositories: state.repositories ?? [],
    ...(state.blockedBy ? { blockedBy: state.blockedBy } : {}),
    ...(state.merged?.at && state.merged.repo && state.merged.number !== undefined && state.merged.headSha && state.merged.mergedSha
      ? { merged: { at: state.merged.at, repo: state.merged.repo, number: state.merged.number, headSha: state.merged.headSha, mergedSha: state.merged.mergedSha, ...(state.merged.completedAt ? { completedAt: state.merged.completedAt } : {}) } }
      : {}),
    ...(state.accepted?.at ? { accepted: { at: state.accepted.at, ...(state.accepted.close ? { close: state.accepted.close } : {}) } } : {}),
  };
  const stop = await readJson<{ at?: string; reason?: string }>(join(dir, "stopped.json"));
  if (stop?.at) task.stopped = { at: stop.at, reason: stop.reason ?? "" };
  const cancel = await readJson<{ at?: string; reason?: string }>(join(dir, "cancel.json"));
  if (cancel?.at) task.canceled = { at: cancel.at, reason: cancel.reason ?? "" };

  // Runs referenced by the task or seen in an in-range turn; dedup, flag earlier-window ones.
  const prior = new Set(task.priorRuns);
  const runIds = new Set<string>([...task.runIds, ...turns.flatMap((t) => t.runs.map((r) => r.runId))].filter(Boolean));
  const runs = await Promise.all([...runIds].map((id) => runRecord(stateDir, id, issueId, prior.has(id))));

  return [task, ...turns, ...runs];
}

/** Every in-range record across all task directories under `stateDir`. */
export async function* exportLedger(stateDir: string, range: DateRange): AsyncGenerator<ExportRecord> {
  const tasksDir = join(stateDir, "tasks");
  const entries = await readdir(tasksDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const rec of await exportTask(stateDir, entry.name, range)) yield rec;
  }
}
