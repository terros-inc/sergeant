import { expect, test } from "vitest";
import { analyzeWindows, parseExport, report } from "./budget-analysis.ts";
import type { RunExport, TaskExport, TurnExport } from "./ledger-export.ts";

// TECH-5922: the analysis on a small synthetic export. One exhausted window spent entirely on an
// active run that was still in flight at the deadline and later extended; one exhausted window spent
// entirely waiting on a human; plus non-exhausted windows opened by a human reply, an unblock, and
// admission. It checks the window split, the exhaustion/in-flight accounting, and the triggers.

const WIN = { wallMinutes: 30, costUsd: 25 };

function turn(over: Partial<TurnExport> & Pick<TurnExport, "issueId" | "at" | "windowStart" | "wallDeadline">): TurnExport {
  return {
    type: "turn",
    window: WIN,
    spentUsd: 0,
    costLimitUsd: 25,
    unknownCostRuns: 0,
    exhausted: false,
    runs: [],
    runningCount: 0,
    waitingOnHumanQuestion: false,
    waitingOnHumanPr: null,
    waitingOnCi: false,
    runQuotaFailure: false,
    actions: [],
    turnCostUsd: 0.1,
    turnSummary: "",
    signalsComputed: true,
    ...over,
  };
}

function task(over: Partial<TaskExport> & Pick<TaskExport, "issueId" | "startedAt">): TaskExport {
  return { type: "task", window: WIN, priorRuns: [], unblockedAt: [], turns: 1, turnCostUsd: 0, runIds: [], repositories: [], ...over };
}

function run(over: Partial<RunExport> & Pick<RunExport, "runId" | "issueId" | "role" | "status">): RunExport {
  return { type: "run", prior: false, ...over };
}

const records = [
  // TECH-1: window 1 (admission) runs out of wall time with the worker still running, then a human reply
  // opens window 2 (a reviewer that finishes).
  task({ issueId: "TECH-1", startedAt: "2026-10-01T00:00:00.000Z", since: "2026-10-01T00:40:00.000Z", priorRuns: ["run_w1"], runIds: ["run_w1", "run_r1"] }),
  turn({ issueId: "TECH-1", at: "2026-10-01T00:05:00.000Z", windowStart: "2026-10-01T00:00:00.000Z", wallDeadline: "2026-10-01T00:30:00.000Z", runs: [{ runId: "run_w1", role: "worker", status: "running" }], runningCount: 1 }),
  turn({ issueId: "TECH-1", at: "2026-10-01T00:31:00.000Z", windowStart: "2026-10-01T00:00:00.000Z", wallDeadline: "2026-10-01T00:30:00.000Z", runs: [{ runId: "run_w1", role: "worker", status: "running" }], runningCount: 1, exhausted: true, exhaustedReason: "wall time exhausted at 2026-10-01T00:30:00.000Z" }),
  turn({ issueId: "TECH-1", at: "2026-10-01T00:45:00.000Z", windowStart: "2026-10-01T00:40:00.000Z", wallDeadline: "2026-10-01T01:10:00.000Z", runs: [{ runId: "run_r1", role: "reviewer", status: "running" }], runningCount: 1 }),
  turn({ issueId: "TECH-1", at: "2026-10-01T00:50:00.000Z", windowStart: "2026-10-01T00:40:00.000Z", wallDeadline: "2026-10-01T01:10:00.000Z", runs: [{ runId: "run_r1", role: "reviewer", status: "succeeded" }], waitingOnCi: true }),
  run({ runId: "run_w1", issueId: "TECH-1", role: "worker", status: "canceled", startedAt: "2026-10-01T00:01:00.000Z", recordWrittenAt: "2026-10-01T00:31:30.000Z", prior: true }),
  run({ runId: "run_r1", issueId: "TECH-1", role: "reviewer", status: "succeeded", startedAt: "2026-10-01T00:44:00.000Z", recordWrittenAt: "2026-10-01T00:49:30.000Z" }),

  // TECH-2: a window opened by an unblock (TECH-5803) that runs out of wall time while waiting on a human.
  task({ issueId: "TECH-2", startedAt: "2026-10-02T00:00:00.000Z", unblockedAt: ["2026-10-02T00:20:00.000Z"] }),
  turn({ issueId: "TECH-2", at: "2026-10-02T00:25:00.000Z", windowStart: "2026-10-02T00:20:00.000Z", wallDeadline: "2026-10-02T00:50:00.000Z", waitingOnHumanQuestion: true }),
  turn({ issueId: "TECH-2", at: "2026-10-02T00:51:00.000Z", windowStart: "2026-10-02T00:20:00.000Z", wallDeadline: "2026-10-02T00:50:00.000Z", waitingOnHumanQuestion: true, exhausted: true, exhaustedReason: "wall time exhausted at 2026-10-02T00:50:00.000Z" }),

  // TECH-3: an admission window that is still well inside its budget (not exhausted), waiting on CI.
  task({ issueId: "TECH-3", startedAt: "2026-10-03T00:00:00.000Z" }),
  turn({ issueId: "TECH-3", at: "2026-10-03T00:05:00.000Z", windowStart: "2026-10-03T00:00:00.000Z", wallDeadline: "2026-10-03T00:30:00.000Z", waitingOnCi: true }),
  turn({ issueId: "TECH-3", at: "2026-10-03T00:10:00.000Z", windowStart: "2026-10-03T00:00:00.000Z", wallDeadline: "2026-10-03T00:30:00.000Z" }),
];

test("parseExport validates and round-trips every record", () => {
  const text = records.map((r) => JSON.stringify(r)).join("\n");
  expect(parseExport(text)).toHaveLength(records.length);
});

test("windows are reconstructed with their trigger, span, and exhaustion", () => {
  const windows = analyzeWindows(records);
  expect(windows.map((w) => `${w.issueId}@${w.windowStart} ${w.trigger} exhausted=${w.endedExhausted}`)).toEqual([
    "TECH-1@2026-10-01T00:00:00.000Z admission exhausted=true",
    "TECH-1@2026-10-01T00:40:00.000Z human exhausted=false",
    "TECH-2@2026-10-02T00:20:00.000Z unblock exhausted=true",
    "TECH-3@2026-10-03T00:00:00.000Z admission exhausted=false",
  ]);

  const win1 = windows[0]!;
  expect(win1.spanSeconds).toBe(1860); // 00:00 → 00:31
  expect(win1.seconds.active_run).toBe(1860); // the whole window was an active worker run
  expect(win1.runInFlightAtEnd).toBe(true);
  expect(win1.runIdsInFlightAtEnd).toEqual(["run_w1"]);
  expect(win1.extended).toBe(true); // window 2 opened later for the same task

  const win2 = windows[2]!;
  expect(win2.seconds.waiting_human).toBe(1860);
  expect(win2.runInFlightAtEnd).toBe(false);
  expect(win2.extended).toBe(false);
});

test("report totals, distributions, triggers, and run accounting", () => {
  const r = report(records);
  expect(r.windowsTotal).toBe(4);
  expect(r.windowsExhausted).toBe(2);
  expect(r.triggers).toEqual({ admission: 2, unblock: 1, human: 1 });

  expect(r.exhausted.spanSeconds.total).toBe(3720);
  expect(r.exhausted.byCategorySeconds.active_run.total).toBe(1860);
  expect(r.exhausted.byCategorySeconds.waiting_human.total).toBe(1860);
  expect(r.exhausted.byCategorySeconds.waiting_ci.total).toBe(0);
  expect(r.exhausted.endedWithRunInFlight).toBe(1);
  expect(r.exhausted.runsCutOff).toBe(1);
  expect(r.exhausted.runsCutOffCanceled).toBe(1);
  expect(r.exhausted.extended).toBe(1);
  expect(r.exhausted.terminal).toBe(1);

  expect(r.runs.count).toBe(2);
  expect(r.runs.withDuration).toBe(2);
  expect(r.runs.durationSeconds.total).toBe(2160); // 1830 + 330
  expect(r.runs.ranFullWindow).toBe(1); // only the worker ran the full 30-minute window
  expect(r.chains.tasksWithWorkerAndReviewer).toBe(1);
  expect(r.chains.runsPerTask.total).toBe(2);
});
