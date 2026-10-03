import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { BudgetStatus, Conversation } from "@terros/sergeant-contracts";
import { DEFAULT_BUDGET } from "./budget.ts";
import type { Ports } from "./execute.ts";
import { runLoop } from "./loop.ts";
import { checkHolds, type PollContext } from "./poll-checks.ts";
import { Slot } from "./slots.ts";
import type { TaskState } from "./task-state.ts";

// TECH-5015: an unreadable runner is a wait that starts the slot's grace, but never while a readable
// run is confirmed running: running work always holds its slot.

const now = new Date().toISOString();
const conversation = { issue: { id: "i-1", identifier: "T-1" }, humanComments: [], agentComments: [] } as unknown as Conversation;
const budget: BudgetStatus = { window: DEFAULT_BUDGET, taskStart: now, windowStart: now, wallDeadline: new Date(Date.now() + 3_600_000).toISOString(), spentUsd: 0, costLimitUsd: 25, unknownCostRuns: 1 };
const unknown = [{ unknown: "run_gone", error: "503" }];

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

async function holdOn(live: string[], slot = new Slot(() => {})): Promise<Slot> {
  const ctx = { opts: { slot }, deps: {} as Ports, state: { startedAt: now, budget: { window: DEFAULT_BUDGET } } as TaskState, log: () => {}, save: async () => {} } as unknown as PollContext;
  expect(await checkHolds({ conversation, live, unknown, budgetOf: () => budget }, DEFAULT_BUDGET, ctx)).toEqual({ hold: "unknown" });
  return slot;
}

test("an unreadable runner with nothing confirmed running starts the slot's grace", async () => {
  expect((await holdOn(["run_gone"])).waitingSince).toBeTypeOf("number");
});

test("an unreadable runner does not start the grace of a task with a run confirmed running", async () => {
  expect((await holdOn(["run_running", "run_gone"])).waitingSince).toBeUndefined();
});

test("a confirmed running status clears grace started while every run was unreadable", async () => {
  const slot = await holdOn(["run_gone"]);
  expect(slot.waitingSince).toBeTypeOf("number");

  await holdOn(["run_running", "run_gone"], slot);

  expect(slot.waitingSince).toBeUndefined();
  expect(slot.released).toBe(false);
});

test("a recorded run whose status rejects holds the loop as unknown", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-unknown-run-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "T-1", startedAt: now, turns: 0, runIds: ["run_gone"], recentTurns: [] }));
  const logs: string[] = [];
  let turns = 0;
  const live: Conversation = {
    issue: {
      id: "i-1",
      identifier: "T-1",
      url: "https://linear.app/x/issue/T-1",
      title: "T",
      description: "D",
      state: "In Progress",
      stateType: "started",
      delegate: { id: "agent-v2", name: "Sergeant" },
      linkedPullRequests: [],
    },
    humanComments: [],
    agentComments: [],
  };

  const result = await runLoop(
    { issueId: "T-1", enrolledRepositories: [], dir, pollSeconds: 0, log: (line) => logs.push(line) },
    {
      agentUserId: "agent-v2",
      workerLogin: "sergeant-worker[bot]",
      linear: {
        moveIssueToStarted: async () => ({ moved: false as const }),
        readConversation: async () => {
          await writeFile(join(dir, "STOP"), "");
          return live;
        },
        postComment: async () => {},
        createFollowupIssue: async () => { throw new Error("unused"); },
      },
      github: {
        readPullRequest: async () => { throw new Error("unused"); },
        closePullRequest: async () => {},
        mergePullRequest: async () => { throw new Error("unused"); },
      },
      runner: {
        start: async () => {},
        status: async () => { throw new Error("runner unreachable"); },
        cancel: async () => {},
      },
      reasoner: {
        turn: async () => {
          turns += 1;
          throw new Error("an unknown run must hold before reasoning");
        },
      },
    },
  );

  expect(result.outcome).toBe("stopped");
  expect(turns).toBe(0);
  expect(logs).toContain("waiting: status unavailable for run_gone (runner unreachable)");
});
