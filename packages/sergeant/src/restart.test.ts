import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, type Conversation, type RunRecord } from "@terros/sergeant-contracts";
import { runLoop } from "./loop.ts";

// TECH-4999: any human stop resets the task's budget clock. Found live: a task undelegated five
// minutes into a 30-minute window and delegated again later still ran out of wall time 30 minutes
// after its first start, having done almost nothing in the restarted attempt.

const repo = "o/r";
const agent = { id: "agent-v2", name: "Sergeant" };
const issue = { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, linkedPullRequests: [] };
const run = (runId: string, status: RunRecord["status"], costUsd?: number): RunRecord => ({ runId, role: "worker", status, provider: "p", model: "m", ...(costUsd !== undefined && { costUsd }), report: null });

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

/**
 * A task on 30-minute, $10 windows, extended once 40 minutes ago, that spent $3 on turns and $20 on a
 * finished worker: under the old clock it is out of both wall time and money.
 */
async function spentTask() {
  dir = await mkdtemp(join(tmpdir(), "sergeant-restart-test-"));
  const state = {
    issueId: "UNF-1",
    startedAt: new Date(Date.now() - 65 * 60_000).toISOString(),
    turns: 4,
    runIds: ["run_old"],
    recentTurns: [],
    turnCostUsd: 3,
    budget: { window: { wallMinutes: 30, costUsd: 10 }, grants: [{ commentId: "c1", at: new Date(Date.now() - 40 * 60_000).toISOString() }] },
  };
  await writeFile(join(dir, "state.json"), JSON.stringify(state));
}

/** One loop over fakes with Linear showing `live`, ended by STOP after a few polls. */
async function loop(live: Conversation["issue"]) {
  const runs = new Map([["run_old", run("run_old", "succeeded", 20)]]);
  const starts: string[] = [];
  const posted: string[] = [];
  let conversation: Conversation = { issue: live, humanComments: [], agentComments: [] };
  let polls = 0;
  const result = await runLoop(
    // The installation's budget now differs from the window the task first started with.
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, idleMinutes: 60, budget: { wallMinutes: 45, costUsd: 15 }, log: () => {} },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: {
        async readConversation() {
          if (++polls > 3) await writeFile(join(dir, "STOP"), "");
          return conversation;
        },
        moveIssueToStarted: async () => ({ moved: false as const }),
        async postComment({ key, body }) {
          posted.push(key);
          conversation = { ...conversation, agentComments: [...conversation.agentComments, { id: commentIdFor(key), createdAt: new Date().toISOString(), body }] };
        },
        createFollowupIssue: async () => Promise.reject(new Error("unused")),
      },
      github: { readPullRequest: async () => Promise.reject(new Error("no PRs")), closePullRequest: async () => {}, mergePullRequest: async () => Promise.reject(new Error("unused")) },
      runner: {
        start: async (spec) => (starts.push(spec.runId), void runs.set(spec.runId, run(spec.runId, "running"))),
        status: async (id) => runs.get(id) ?? Promise.reject(new Error(`no ${id}`)),
        cancel: async () => {},
      },
      reasoner: {
        turn: async () => ({ output: { summary: "s", actions: [{ kind: "start_worker" as const, objective: "Do UNF-1.", repositories: [repo] }] }, model: "m", promptVersion: "p" }),
      },
    },
  );
  // A stop by state sets `state.json` aside (TECH-4989).
  const raw = await readFile(join(dir, "state.json"), "utf8").catch(() => "{}");
  const saved = JSON.parse(raw) as { startedAt: string; turnCostUsd: number; budget: { window: unknown; grants: unknown[] } };
  await rm(join(dir, "STOP"), { force: true });
  return { result, starts, posted, saved };
}

test.each([
  ["undelegated, then delegated again", { ...issue, delegate: null }, issue],
  ["moved to Backlog, then back to Todo", { ...issue, state: "Backlog", stateType: "backlog" }, { ...issue, state: "Todo", stateType: "unstarted" }],
])("a task %s gets a fresh window from the moment it restarts", async (_name, stopped, eligible) => {
  await spentTask();
  expect((await loop(stopped)).result.outcome).toBe("stopped");

  const before = Date.now();
  const { starts, posted, saved } = await loop(eligible);

  // The old clock would refuse every start (wall time and spend both exhausted); the new attempt starts
  // its worker, on a window from its restart, with zero spend, the budget configured now, and no grants.
  expect(starts).toHaveLength(1);
  expect(posted.filter((k) => k.startsWith("budget-question:"))).toEqual([]);
  expect(Date.parse(saved.startedAt)).toBeGreaterThanOrEqual(before);
  expect(saved).toMatchObject({ turnCostUsd: 0, budget: { window: { wallMinutes: 45, costUsd: 15 }, grants: [] } });
});

test("a task never stopped keeps its window, grants and spend across a loop restart", async () => {
  await spentTask();
  const { starts, posted, saved } = await loop(issue);

  expect(starts).toEqual([]);
  expect(posted).toEqual(["budget-question:i1:1"]);
  expect(saved).toMatchObject({ turnCostUsd: 3, budget: { window: { wallMinutes: 30, costUsd: 10 }, grants: [{ commentId: "c1" }] } });
});
