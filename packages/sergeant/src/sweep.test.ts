import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Conversation, PullRequestFacts, RunRecord } from "@terros/sergeant-contracts";
import { startService, type ServiceDeps } from "./service.ts";

// TECH-4997: a task whose issue was undelegated while no loop ran, or closed longer ago than intake
// looks back, is not listed by intake. `serve` checks each unmerged task's issue live at startup and
// stops the ones no longer Sergeant's to work on, closing their open worker PRs. A failed lookup
// stops nothing and does not hold up startup.

const agent = { id: "agent-v2", name: "Sergeant" };
const repo = "o/r";
const head = "a".repeat(40);
const pr = (number: number, state: PullRequestFacts["state"]): PullRequestFacts => ({
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  author: "sergeant-worker[bot]",
  state,
  draft: false,
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true,
  checks: { sha: head, required: [{ name: "validate", state: "pending" }] },
  humanFeedback: [],
});
const issue = (stateType: string, state: string, delegate: typeof agent | null = agent): Conversation => ({
  issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state, stateType, delegate, linkedPullRequests: [{ repo, number: 7 }] },
  humanComments: [],
  agentComments: [],
});

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

/**
 * Serves a state directory holding UNF-1's task, its worker run still running and its PR #7 open,
 * that intake does not list; `readConversation` is Linear's live answer for the issue.
 */
async function serveStranded(readConversation: () => Promise<Conversation>) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-sweep-test-"));
  const task = join(dir, "tasks", "UNF-1");
  await mkdir(task, { recursive: true });
  const state = { issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds: ["run_w1"], recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] } };
  await writeFile(join(task, "state.json"), JSON.stringify(state));
  const run: RunRecord = { runId: "run_w1", role: "worker", status: "running", provider: "p", model: "m", report: null };
  const seen = { intakes: 0, turns: 0, canceled: [] as string[], closed: [] as { number: number; comment: string }[], comments: [] as string[], logs: [] as string[] };
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => (seen.intakes++, []),
    linear: {
      readConversation,
      moveIssueToStarted: async () => ({ moved: false as const }),
      postComment: async ({ body }) => void seen.comments.push(body),
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
    },
    github: {
      readPullRequest: async (_repo, number) => pr(number, seen.closed.some((c) => c.number === number) ? "closed" : "open"),
      mergePullRequest: async () => Promise.reject(new Error("no merge")),
      closePullRequest: async ({ number, comment }) => void seen.closed.push({ number, comment }),
    },
    runner: {
      start: async () => Promise.reject(new Error("no start")),
      status: async () => run,
      cancel: async (id) => void (seen.canceled.push(id), (run.status = "canceled")),
    },
    reasoner: {
      async turn() {
        seen.turns++;
        return { output: { summary: "wait", actions: [] }, model: "m", promptVersion: "p" };
      },
    },
  };
  const service = await startService({ enrolledRepositories: [repo], stateDir: dir, intakeSeconds: 3600, pollSeconds: 0.01, port: 0, log: (l) => seen.logs.push(l) }, deps);
  return { service, seen, task };
}

test("an issue undelegated while serve was down has its task's runs canceled and open PR closed at startup", async () => {
  const { service, seen, task } = await serveStranded(async () => issue("started", "In Progress", null));
  try {
    await vi.waitFor(() => expect(seen.comments).toHaveLength(1), { timeout: 5_000 });
    expect(seen.canceled).toEqual(["run_w1"]);
    expect(seen.closed).toEqual([{ number: 7, comment: "Closed: the Linear issue is no longer delegated to Sergeant." }]);
    expect(seen.comments[0]).toContain(`because it is no longer delegated to Sergeant. Its runs are canceled. Closed [${repo}#7]`);
    expect(seen.turns).toBe(0);
    // Undelegated, the task is kept to resume if the issue is delegated again.
    expect(await readdir(task)).toContain("state.json");
  } finally {
    await service.stop();
  }
});

test.each([
  ["Canceled", "canceled"],
  ["Done", "completed"],
])("an issue moved to %s longer ago than intake looks back is stopped at startup", async (name, stateType) => {
  const { service, seen, task } = await serveStranded(async () => issue(stateType, name));
  try {
    await vi.waitFor(() => expect(seen.comments).toHaveLength(1), { timeout: 5_000 });
    expect(seen.canceled).toEqual(["run_w1"]);
    expect(seen.closed).toEqual([{ number: 7, comment: `Closed: the Linear issue was canceled or moved to ${name}.` }]);
    expect(seen.comments[0]).toContain(`because it was moved to ${name}.`);
    expect(seen.turns).toBe(0);
    const files = await readdir(task);
    expect(files).not.toContain("state.json");
    expect(files.filter((f) => f.startsWith("state.stopped-"))).toHaveLength(1);
  } finally {
    await service.stop();
  }
});

test.each([
  ["still delegated and active", async () => issue("started", "In Progress")],
  ["whose lookup fails", async () => Promise.reject(new Error("Linear API request failed (503)"))],
  ["that no longer exists", async () => Promise.reject(new Error("Linear issue not found: UNF-1"))],
])("a task %s is left alone, and serve starts", async (which, readConversation) => {
  const { service, seen, task } = await serveStranded(readConversation);
  try {
    // The startup check runs before the first intake, which then lists nothing for this issue.
    await vi.waitFor(() => expect(seen.intakes).toBe(1), { timeout: 5_000 });
    // Serve is up, and runs no loop for the task.
    const status = await fetch(`http://127.0.0.1:${service.port}/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ ok: true, tasks: [] });
    expect(seen).toMatchObject({ canceled: [], closed: [], comments: [], turns: 0 });
    expect(await readdir(task)).toEqual(["state.json"]);
  } finally {
    await service.stop();
  }
  if (which !== "still delegated and active") expect(seen.logs).toContainEqual(expect.stringMatching(/^UNF-1: startup check skipped: Linear/));
});
