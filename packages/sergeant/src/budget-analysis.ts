import { ExportRecord, type RunExport, type TaskExport, type TurnExport } from "./ledger-export.ts";

// TECH-5922: offline analysis of a ledger export (ledger-export.ts). It answers Trevor's question —
// "whether 30 minutes is truly too short" — by reconstructing each budget window from the per-turn
// snapshots and splitting the window's elapsed wall time into where it went. It reads only the export;
// it needs no access to anything. All durations are seconds, all costs USD.
//
// Known limits, by construction (see docs/ledger-export.md):
//   - The loop records no turn start, only each turn's completion `at`, so Sergeant's own reasoning
//     (turn) time cannot be separated out; it is folded into the segment that precedes each turn.
//     We report the turn count instead.
//   - A window's elapsed time is observed only at turn boundaries, so each segment is attributed to the
//     state the snapshot at its start showed. Sub-turn transitions are not visible.
//   - A run carries no end time; its duration uses record.json's mtime as the end proxy.

/** The time buckets a window's elapsed wall time is split into (Sergeant turn time is not measurable; see above). */
export type Category = "active_run" | "waiting_human" | "waiting_ci" | "waiting_rate_limit" | "idle_other";
const CATEGORIES: Category[] = ["active_run", "waiting_human", "waiting_ci", "waiting_rate_limit", "idle_other"];

export type Trigger = "admission" | "unblock" | "human";

export type WindowAnalysis = {
  issueId: string;
  windowStart: string;
  wallMinutes: number;
  trigger: Trigger;
  /** Elapsed wall time from the window's start to its last observed turn. */
  spanSeconds: number;
  /** checkBudget failed on the last turn: the window ran out of wall time (or spend) while still active. */
  endedExhausted: boolean;
  exhaustedReason?: string;
  /** A worker/reviewer run was still running at the last turn of an exhausted window (so it was canceled). */
  runInFlightAtEnd: boolean;
  runIdsInFlightAtEnd: string[];
  /** A later window opened for the same task (a human replied "Extend", TECH-5059). */
  extended: boolean;
  seconds: Record<Category, number>;
  turnCount: number;
};

const parse = (iso: string) => Date.parse(iso);

function classify(turn: TurnExport): Category {
  if (turn.runningCount > 0) return "active_run";
  if (turn.waitingOnHumanQuestion || turn.waitingOnHumanPr !== null) return "waiting_human";
  if (turn.waitingOnCi) return "waiting_ci";
  if (turn.runQuotaFailure) return "waiting_rate_limit";
  return "idle_other";
}

/** Split one window's elapsed time across the buckets, attributing each inter-turn gap to the snapshot that opened it. */
function attribute(windowStart: string, turns: TurnExport[]): { seconds: Record<Category, number>; spanSeconds: number } {
  const seconds: Record<Category, number> = { active_run: 0, waiting_human: 0, waiting_ci: 0, waiting_rate_limit: 0, idle_other: 0 };
  const sorted = [...turns].sort((a, b) => parse(a.at) - parse(b.at));
  let cursor = parse(windowStart);
  for (let i = 0; i < sorted.length; i += 1) {
    const turn = sorted[i];
    if (!turn) continue;
    const end = parse(turn.at);
    const gap = Math.max(0, (end - cursor) / 1000);
    // The first gap (window start → first turn) has no earlier snapshot, so it takes the first turn's;
    // every later gap takes the snapshot of the turn that opened it.
    const basis = sorted[i === 0 ? 0 : i - 1] ?? turn;
    seconds[classify(basis)] += gap;
    cursor = end;
  }
  const spanSeconds = Math.max(0, (cursor - parse(windowStart)) / 1000);
  return { seconds, spanSeconds };
}

function triggerOf(task: TaskExport | undefined, windowStart: string): Trigger {
  if (task && windowStart === task.startedAt) return "admission";
  if (task && task.unblockedAt.includes(windowStart)) return "unblock";
  return "human";
}

/** Reconstruct and analyse every budget window across the export. */
export function analyzeWindows(records: ExportRecord[]): WindowAnalysis[] {
  const tasks = new Map<string, TaskExport>();
  const runs = new Map<string, RunExport>();
  const turnsByWindow = new Map<string, TurnExport[]>();
  const windowStartsByTask = new Map<string, Set<string>>();
  for (const rec of records) {
    if (rec.type === "task") tasks.set(rec.issueId, rec);
    else if (rec.type === "run") runs.set(rec.runId, rec);
    else {
      const key = `${rec.issueId}\u0000${rec.windowStart}`;
      (turnsByWindow.get(key) ?? turnsByWindow.set(key, []).get(key)!).push(rec);
      (windowStartsByTask.get(rec.issueId) ?? windowStartsByTask.set(rec.issueId, new Set()).get(rec.issueId)!).add(rec.windowStart);
    }
  }

  const out: WindowAnalysis[] = [];
  for (const [key, turns] of turnsByWindow) {
    const parts = key.split("\u0000");
    const issueId = parts[0] ?? "";
    const windowStart = parts[1] ?? "";
    const sorted = [...turns].sort((a, b) => parse(a.at) - parse(b.at));
    const last = sorted[sorted.length - 1];
    if (!last) continue;
    const { seconds, spanSeconds } = attribute(windowStart, sorted);
    const endedExhausted = last.exhausted;
    const inFlight = endedExhausted ? last.runs.filter((r) => r.status === "running") : [];
    const laterWindows = [...(windowStartsByTask.get(issueId) ?? [])].some((ws) => parse(ws) > parse(windowStart));
    out.push({
      issueId,
      windowStart,
      wallMinutes: last.window.wallMinutes,
      trigger: triggerOf(tasks.get(issueId), windowStart),
      spanSeconds,
      endedExhausted,
      ...(endedExhausted && last.exhaustedReason ? { exhaustedReason: last.exhaustedReason } : {}),
      runInFlightAtEnd: inFlight.length > 0,
      runIdsInFlightAtEnd: inFlight.map((r) => r.runId),
      extended: laterWindows,
      seconds,
      turnCount: sorted.length,
    });
  }
  return out.sort((a, b) => a.issueId.localeCompare(b.issueId) || parse(a.windowStart) - parse(b.windowStart));
}

const median = (xs: number[]) => percentile(xs, 50);
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const stat = (xs: number[]) => ({ total: round(sum(xs)), median: round(median(xs)), p90: round(percentile(xs, 90)) });
const round = (n: number) => Math.round(n * 100) / 100;

export type Report = {
  windowsTotal: number;
  windowsExhausted: number;
  triggers: Record<Trigger, number>;
  exhausted: {
    spanSeconds: ReturnType<typeof stat>;
    byCategorySeconds: Record<Category, ReturnType<typeof stat>>;
    endedWithRunInFlight: number;
    runsCutOff: number;
    runsCutOffCanceled: number;
    extended: number;
    terminal: number;
  };
  runs: { count: number; withDuration: number; durationSeconds: ReturnType<typeof stat>; ranFullWindow: number };
  chains: { tasksWithWorkerAndReviewer: number; runsPerTask: ReturnType<typeof stat> };
  notes: string[];
};

/** Totals and distributions for the whole export, focused on windows that ended exhausted. */
export function report(records: ExportRecord[]): Report {
  const windows = analyzeWindows(records);
  const exhausted = windows.filter((w) => w.endedExhausted);
  const runs = records.flatMap((r) => (r.type === "run" ? [r] : []));
  const tasks = records.flatMap((r) => (r.type === "task" ? [r] : []));

  const durations = runs.flatMap((r) => (r.startedAt && r.recordWrittenAt ? [(parse(r.recordWrittenAt) - parse(r.startedAt)) / 1000] : []));
  const windowSecondsByTask = new Map(tasks.map((t) => [t.issueId, t.window.wallMinutes * 60]));
  const ranFullWindow = runs.filter((r) => {
    if (!r.startedAt || !r.recordWrittenAt) return false;
    const limit = windowSecondsByTask.get(r.issueId) ?? Infinity;
    return (parse(r.recordWrittenAt) - parse(r.startedAt)) / 1000 >= limit;
  }).length;

  const runsByTask = new Map<string, RunExport[]>();
  for (const r of runs) (runsByTask.get(r.issueId) ?? runsByTask.set(r.issueId, []).get(r.issueId)!).push(r);
  const runsPerTask = [...runsByTask.values()].map((rs) => rs.length);
  const tasksWithWorkerAndReviewer = [...runsByTask.values()].filter((rs) => rs.some((r) => r.role === "worker") && rs.some((r) => r.role === "reviewer")).length;

  const cutOffIds = exhausted.flatMap((w) => w.runIdsInFlightAtEnd);
  const runsCutOffCanceled = cutOffIds.filter((id) => runs.find((r) => r.runId === id)?.status === "canceled").length;

  const triggers: Record<Trigger, number> = { admission: 0, unblock: 0, human: 0 };
  for (const w of windows) triggers[w.trigger] += 1;

  return {
    windowsTotal: windows.length,
    windowsExhausted: exhausted.length,
    triggers,
    exhausted: {
      spanSeconds: stat(exhausted.map((w) => w.spanSeconds)),
      byCategorySeconds: Object.fromEntries(CATEGORIES.map((c) => [c, stat(exhausted.map((w) => w.seconds[c]))])) as Record<Category, ReturnType<typeof stat>>,
      endedWithRunInFlight: exhausted.filter((w) => w.runInFlightAtEnd).length,
      runsCutOff: cutOffIds.length,
      runsCutOffCanceled,
      extended: exhausted.filter((w) => w.extended).length,
      terminal: exhausted.filter((w) => !w.extended).length,
    },
    runs: { count: runs.length, withDuration: durations.length, durationSeconds: stat(durations), ranFullWindow },
    chains: { tasksWithWorkerAndReviewer, runsPerTask: stat(runsPerTask) },
    notes: [
      "Sergeant turn (reasoning) time is not separately measurable: the loop records only each turn's completion time, so it is folded into the preceding segment. turnCount is reported instead.",
      "Window time is observed only at turn boundaries; each gap is attributed to the snapshot that opened it.",
      "Run durations use record.json mtime as the end time (no endedAt is stored); runsCutOff counts runs still running at an exhausted window's last turn, runsCutOffCanceled those whose final status is canceled.",
      "'extended' windows were followed by another window for the same task (a human reply opened a fresh one, TECH-5059); the human wait itself is not counted against the window.",
    ],
  };
}

/** Parse a JSON Lines export into validated records (invalid lines are skipped). */
export function parseExport(text: string): ExportRecord[] {
  const out: ExportRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = ExportRecord.safeParse(JSON.parse(line));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
