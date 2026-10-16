import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { QUESTION_HEADING } from "@terros/sergeant-contracts";
import { cleanup, dir, human, saved, scenario, turnOf, worker, start } from "./budget-scenario.ts";
import { Slot } from "./slots.ts";

// TECH-6127: an answer's fresh window must not run out while the task queues for a task slot. A task
// answered after it gave up its slot queued for one, and its window ran out in the queue: it asked for
// budget again, having done nothing. TECH-6165: the window counts only active time, so no queue counts.

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
  // The window is still the answer's, so its budget question keeps its key; the queue used none of it.
  expect((await saved()).budget.since).toBe(answeredAt);
  // A runaway run still stops 30 minutes after the task started working, and is asked about once.
  expect(canceled.size).toBe(1);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatch(/budget is exhausted \(active time exhausted \(30 minutes of work in this window\)\)/);
});

test("a task answered while it holds its slot keeps the window from the answer", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const clock = [answeredAt, "2030-01-02T10:20:00.000Z", "2030-01-02T10:31:00.000Z", end, end];
  const { posted, canceled, turnsAt } = await loopOver(clock, false, answered);

  expect(turnsAt).toEqual([answeredAt]);
  expect((await saved()).budget.since).toBe(answeredAt);
  expect(canceled.size).toBe(1);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatch(/active time exhausted \(30 minutes/);
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
  expect(posted[0]).toMatch(/active time exhausted \(30 minutes/);
});

