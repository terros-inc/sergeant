import { expect, test, vi } from "vitest";
import type { BudgetStatus, Conversation, PullRequestFacts } from "@terros/sergeant-contracts";
import { drawAudit } from "./after-merge.ts";
import type { Ports } from "./execute.ts";
import type { TaskState } from "./task-state.ts";

// TECH-5023: a sampled audit whose merged PR cannot be read must still be recorded as drawn, without
// leaving an audit run on record. Keep its log distinct from a runner that rejects an actual start.

const repo = "o/canary";
const headSha = "a".repeat(40);
const mergedSha = "b".repeat(40);
const runId = `run_audit-${headSha}`;
const conversation: Conversation = {
  issue: {
    id: "issue-1",
    identifier: "TECH-5023",
    url: "https://linear.app/terros/issue/TECH-5023",
    title: "Test the audit reviewer path when the PR read fails",
    description: "",
    state: "Done",
    stateType: "completed",
    delegate: { id: "agent-v2", name: "Sergeant" },
    linkedPullRequests: [{ repo, number: 7 }],
  },
  humanComments: [],
  agentComments: [],
};
const pr: PullRequestFacts = {
  repo,
  number: 7,
  url: `https://github.com/${repo}/pull/7`,
  state: "merged",
  draft: false,
  author: "sergeant-worker[bot]",
  headSha,
  mergedSha,
  baseRef: "main",
  body: "Fixes TECH-5023",
  mergeable: null,
  checks: { sha: headSha, required: [] },
  humanFeedback: [],
};
const budget: BudgetStatus = {
  window: { wallMinutes: 120, costUsd: 25 },
  windowStart: "2026-10-03T00:00:00.000Z",
  wallDeadline: "2999-10-03T02:00:00.000Z",
  spentUsd: 0,
  costLimitUsd: 25,
  unknownCostRuns: 0,
};

const merged = (): NonNullable<TaskState["merged"]> => ({
  repo,
  number: 7,
  headSha,
  mergedSha,
  at: "2026-10-03T00:01:00.000Z",
});

const deps = (readPullRequest: Ports["github"]["readPullRequest"], start: Ports["runner"]["start"]): Ports =>
  ({
    agentUserId: "agent-v2",
    workerLogin: "sergeant-worker[bot]",
    linear: { readConversation: async () => conversation },
    github: { readPullRequest },
    runner: { start },
  }) as unknown as Ports;

async function draw(readPullRequest: Ports["github"]["readPullRequest"], start: Ports["runner"]["start"]) {
  const state = merged();
  const logs: string[] = [];
  const save = vi.fn(async () => {});
  await drawAudit(
    state,
    [],
    { issueId: "TECH-5023", enrolledRepositories: [repo], dir: "/unused", auditSampleRate: 1 },
    deps(readPullRequest, start),
    (line) => logs.push(line),
    save,
    () => budget,
  );
  return { state, logs, save };
}

test("a failed audit PR read logs the read failure and records the draw without starting a run", async () => {
  const start = vi.fn<Ports["runner"]["start"]>();
  const { state, logs, save } = await draw(async () => Promise.reject(new Error("GitHub unavailable")), start);

  expect(start).not.toHaveBeenCalled();
  expect(state.audit).toBeUndefined();
  expect(state.auditDrawnAt).toBeTypeOf("string");
  expect(save).toHaveBeenCalledOnce();
  expect(logs).toEqual([`audit review ${runId} failed to read ${repo}#7: GitHub unavailable`]);
});

test("a failed audit runner start is logged as a start failure", async () => {
  const start = vi.fn<Ports["runner"]["start"]>().mockRejectedValue(new Error("runner unavailable"));
  const { state, logs } = await draw(async () => pr, start);

  expect(start).toHaveBeenCalledOnce();
  expect(state.audit).toBeUndefined();
  expect(state.auditDrawnAt).toBeTypeOf("string");
  expect(logs).toEqual([`audit review ${runId} failed to start: runner unavailable`]);
});
