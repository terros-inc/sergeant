import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { QUESTION_HEADING } from "@terros/sergeant-contracts";
import { budgetStatus } from "./budget.ts";
import { cleanup, dir, human, saved, scenario, turnOf, worker, start } from "./budget-scenario.ts";
import { Slot } from "./slots.ts";

// TECH-6127: an answer's fresh window starts its wall time at the task's first turn or run after the
// answer, not at the answer. A task answered after it gave up its task slot queued for one, and its
// window ran out in the queue: it asked for budget again, having done nothing.

afterEach(cleanup);

const question = { id: "q1", createdAt: "2030-01-02T09:00:00.000Z", body: `${QUESTION_HEADING}\n\nExtend, or accept as-is?` };
const answeredAt = "2030-01-02T10:00:00.000Z";
const admittedAt = "2030-01-02T10:45:00.000Z";
const end = "2030-01-02T11:16:00.000Z";

/**
 * The loop over `clock`, one time per poll, stopped after its last. The service admits a task whose slot
 * was released (`released`) at `admittedAt`; a turn starts a worker that runs until canceled.
 */
async function loopOver(clock: string[], released: boolean, state?: Record<string, unknown>) {
  const slot = new Slot(() => {});
  slot.released = released;
  const started: string[] = [];
  const canceled = new Set<string>();
  const turnsAt: string[] = [];
  const run = await scenario({
    ...(state && { state }),
    conversation: { agentComments: [question], humanComments: [human("c1", answeredAt, "Extend.")] },
    runner: {
      start: async (spec) => void started.push(spec.runId),
      status: async (id) => ({ ...worker(canceled.has(id) ? "canceled" : "running"), runId: id }),
      cancel: async (id) => void canceled.add(id),
    },
    reasoner: async () => (turnsAt.push(new Date().toISOString()), turnOf([start])),
    loop: { slot, budget: { wallMinutes: 30, costUsd: 25 } },
    onPoll: async (poll, live) => {
      const at = clock[poll - 1];
      if (!at) await writeFile(join(dir, "STOP"), "");
      else vi.setSystemTime(at);
      if (at === admittedAt) slot.released = false;
      return live;
    },
  });
  return { ...run, started, canceled, turnsAt };
}

const answered = { startedAt: "2030-01-02T08:00:00.000Z", runIds: [], budget: { window: { wallMinutes: 30, costUsd: 25 } } };

test("a task queued for a slot after an extend answer gets its full window once admitted", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Queued past where a window from the answer would end, then admitted; its run goes on past 30 minutes.
  const clock = [answeredAt, "2030-01-02T10:20:00.000Z", "2030-01-02T10:31:00.000Z", admittedAt, "2030-01-02T10:50:00.000Z", end, end, end];
  const { posted, started, canceled, turnsAt } = await loopOver(clock, true, answered);

  // Not exhausted in the queue: it took its turn at admission.
  expect(turnsAt).toEqual([admittedAt]);
  expect(started).toHaveLength(1);
  // The window is still the answer's, so its budget question keeps its key; only its wall time moved.
  expect((await saved()).budget.since).toBe(answeredAt);
  // A runaway run still stops 30 minutes after the task started working, and is asked about once.
  expect(canceled.size).toBe(1);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatch(/budget is exhausted \(wall time exhausted at 2030-01-02T11:15:00\.000Z\)/);
});

test("a task answered while it holds its slot keeps the window from the answer", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const clock = [answeredAt, "2030-01-02T10:20:00.000Z", "2030-01-02T10:31:00.000Z", end, end];
  const { posted, canceled, turnsAt } = await loopOver(clock, false, answered);

  expect(turnsAt).toEqual([answeredAt]);
  expect((await saved()).budget.since).toBe(answeredAt);
  expect(canceled.size).toBe(1);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatch(/wall time exhausted at 2030-01-02T10:30:00\.000Z/);
});

test("a restart while queued for a slot changes nothing: the window starts when the task works", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const first = await loopOver([answeredAt, "2030-01-02T10:20:00.000Z"], true, answered);
  expect(first.turnsAt).toEqual([]);

  // The restarted service has no free slot either; it admits the task later.
  await rm(join(dir, "STOP"));
  const clock = ["2030-01-02T10:31:00.000Z", admittedAt, "2030-01-02T10:50:00.000Z", end, end, end];
  const { posted, canceled, turnsAt } = await loopOver(clock, true);

  expect(turnsAt).toEqual([admittedAt]);
  expect((await saved()).budget.since).toBe(answeredAt);
  expect(canceled.size).toBe(1);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatch(/wall time exhausted at 2030-01-02T11:15:00\.000Z/);
});

test("only an answer's window waits for work, never while a run goes, and never past the turns kept", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime("2030-01-02T12:00:00.000Z");
  const base = { window: { wallMinutes: 30, costUsd: 25 }, since: answeredAt, startedAt: answered.startedAt, turnCostUsd: 0, runs: [], unknownRuns: 0 };
  const deadline = (input: Partial<Parameters<typeof budgetStatus>[0]>) => budgetStatus({ ...base, ...input }).wallDeadline;

  // Nothing done since the answer: the deadline floats from now. A window a PR review or unblock opened does not.
  expect(deadline({ answers: [answeredAt] })).toBe("2030-01-02T12:30:00.000Z");
  expect(deadline({ answers: ["2030-01-02T09:00:00.000Z"] })).toBe("2030-01-02T10:30:00.000Z");
  // A run still going from before the answer holds the window to the answer.
  expect(deadline({ answers: [answeredAt], runs: [worker("running")] })).toBe("2030-01-02T10:30:00.000Z");
  // From the first turn after the answer, however many follow.
  const turns = ["2030-01-02T09:50:00.000Z", admittedAt, "2030-01-02T10:50:00.000Z"].map((at) => ({ at }));
  expect(deadline({ answers: [answeredAt], recentTurns: turns })).toBe("2030-01-02T11:15:00.000Z");
  // The first turn no longer kept, and no worker run's start to go by: from the answer, never later.
  const kept = Array.from({ length: 8 }, (_, i) => ({ at: new Date(Date.parse(admittedAt) + i * 60_000).toISOString() }));
  expect(deadline({ answers: [answeredAt], recentTurns: kept })).toBe("2030-01-02T10:30:00.000Z");
  expect(deadline({ answers: [answeredAt], recentTurns: kept, runs: [worker("running")], starts: { run_w: { kind: "start_worker", at: admittedAt } } })).toBe("2030-01-02T11:15:00.000Z");
});
