import { expect, test } from "vitest";
import type { BudgetStatus, Conversation } from "@terros/sergeant-contracts";
import { DEFAULT_BUDGET } from "./budget.ts";
import type { Ports } from "./execute.ts";
import { checkHolds, type PollContext } from "./poll-checks.ts";
import { Slot } from "./slots.ts";
import type { TaskState } from "./task-state.ts";

// TECH-5015: an unreadable runner is a wait that starts the slot's grace, but never while a readable
// run is confirmed running: running work always holds its slot.

const now = new Date().toISOString();
const conversation = { issue: { id: "i-1", identifier: "T-1" }, humanComments: [], agentComments: [] } as unknown as Conversation;
const budget: BudgetStatus = { window: DEFAULT_BUDGET, windowStart: now, wallDeadline: new Date(Date.now() + 3_600_000).toISOString(), spentUsd: 0, costLimitUsd: 25, unknownCostRuns: 1 };
const unknown = [{ unknown: "r-gone", error: "503" }];

async function holdOn(live: string[]): Promise<Slot> {
  const slot = new Slot(() => {});
  const ctx = { opts: { slot }, deps: {} as Ports, state: { startedAt: now, budget: { window: DEFAULT_BUDGET } } as TaskState, log: () => {}, save: async () => {} } as unknown as PollContext;
  expect(await checkHolds({ conversation, live, unknown, budgetOf: () => budget }, DEFAULT_BUDGET, ctx)).toEqual({ hold: "unknown" });
  return slot;
}

test("an unreadable runner with nothing confirmed running starts the slot's grace", async () => {
  expect((await holdOn(["r-gone"])).waitingSince).toBeTypeOf("number");
});

test("an unreadable runner does not start the grace of a task with a run confirmed running", async () => {
  expect((await holdOn(["r-running", "r-gone"])).waitingSince).toBeUndefined();
});
