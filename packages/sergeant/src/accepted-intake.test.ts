import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { commentIdFor, QUESTION_HEADING, type Conversation } from "@terros/sergeant-contracts";
import { budgetQuestionKey } from "./budget.ts";
import { human, worker } from "./budget-scenario.ts";
import { startService, type ServiceDeps } from "./service.ts";

// TECH-5118: a task accepted as it is stays ended even while its issue, still delegated, sits in Todo,
// where intake starts new work. Before, the next intake started it afresh and asked the budget question
// again. A human moving the issue out of Todo and back still starts a fresh task, as after a stop.

const agent = { id: "agent-v2", name: "Sergeant" };
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test("a task accepted while its issue is in Todo is not started again until a human moves the issue", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-accepted-test-"));
  const task = join(dir, "tasks", "UNF-1");
  await mkdir(task, { recursive: true });
  // Its first window ran out, Sergeant asked the budget question, and the human answered "2".
  const startedAt = ago(240);
  await writeFile(join(task, "state.json"), JSON.stringify({ issueId: "UNF-1", turns: 1, recentTurns: [], startedAt, runIds: ["run_w"], turnCostUsd: 0 }));
  const conversation: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "Todo", stateType: "unstarted", delegate: agent, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [] },
    agentComments: [{ id: commentIdFor(budgetQuestionKey("i1", startedAt)), createdAt: ago(60), body: `${QUESTION_HEADING}\n\nIts budget is exhausted. Continue?` }],
    humanComments: [human("c1", ago(1), "2")],
  };
  let state = { name: "Todo", type: "unstarted" };
  const turns: string[] = [];
  const posted: string[] = [];
  const started: string[] = [];
  const logs: string[] = [];
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [{ identifier: "UNF-1", priority: 0, createdAt: ago(300), state, blockedBy: [] }],
    linear: {
      readConversation: async () => conversation,
      readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
      moveIssueToStarted: async () => ({ moved: false as const }),
      postComment: async ({ body }) => void posted.push(body),
      resolveThread: async () => "resolved" as const,
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
    },
    github: { readPullRequest: async () => Promise.reject(new Error("no PRs")), closePullRequest: async () => {}, mergePullRequest: async () => Promise.reject(new Error("no PRs")) },
    runner: { start: async (spec) => void started.push(spec.runId), status: async () => worker("succeeded", 30), cancel: async () => {} },
    reasoner: {
      async turn() {
        turns.push(turns.length === 0 ? "accept" : "fresh");
        return { output: { summary: "s", actions: turns.length === 1 ? [{ kind: "accept_as_is" }] : [] }, model: "m", promptVersion: "p" };
      },
    },
  };
  const service = await startService(
    { enrolledRepositories: ["o/r"], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 0, idleMinutes: 60, budget: { wallMinutes: 120, costUsd: 25 }, log: (l) => logs.push(l) },
    deps,
  );
  try {
    await vi.waitFor(() => expect(logs).toContainEqual("UNF-1: loop ended accepted: a human accepted the work as it is"), { timeout: 5_000 });
    // Many intakes later, the issue still delegated and in Todo: no new task, turn, run, or question,
    // and only the one acknowledgment of the acceptance (TECH-5120).
    await sleep(200);
    expect(turns).toEqual(["accept"]);
    expect(started).toEqual([]);
    expect(posted).toEqual(["Sergeant has stopped: the work was accepted as it is. This issue is yours to merge or close."]);
    expect(await readdir(task)).not.toContain("state.json");

    // A human moves the issue out of Todo and back: a deliberate re-trigger starts a fresh task.
    state = { name: "Backlog", type: "backlog" };
    await vi.waitFor(() => expect(logs).toContainEqual(expect.stringContaining("UNF-1: accepted as it is earlier; the issue moved to Backlog")), { timeout: 5_000 });
    state = { name: "Todo", type: "unstarted" };
    await vi.waitFor(() => expect(turns).toEqual(["accept", "fresh"]), { timeout: 5_000 });
  } finally {
    await service.stop();
  }
});
