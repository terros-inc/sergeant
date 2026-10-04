import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { NoModelAccount, RunId, type BudgetStatus, type Conversation, type LinearPort, type PullRequestFacts } from "@terros/sergeant-contracts";
import { drawAudit, finishReviews } from "./after-merge.ts";
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
    delegate: { id: "agent-v2", name: "Sergeant" }, assignee: { id: "user-ann", name: "Ann" },
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
  taskStart: "2026-10-03T00:00:00.000Z",
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

const posted: Parameters<LinearPort["postComment"]>[0][] = [];
const linear = {
  readConversation: async () => conversation,
  readTaskOwner: vi.fn<LinearPort["readTaskOwner"]>(),
  postComment: async (c: Parameters<LinearPort["postComment"]>[0]) => void posted.push(c),
};
/** Whether the task's start/cancel lock is held. */
let locked = false;
const deps = (readPullRequest: Ports["github"]["readPullRequest"], start: Ports["runner"]["start"]): Ports =>
  ({
    agentUserId: "agent-v2",
    workerLogin: "sergeant-worker[bot]",
    owner: { id: "user-ann", name: "Ann", admittedAt: "2026-10-04T00:00:00.000Z" },
    linear,
    github: { readPullRequest },
    runner: { start },
    exclusive: async <T>(step: () => Promise<T>) => {
      locked = true;
      try {
        return await step();
      } finally {
        locked = false;
      }
    },
  }) as unknown as Ports;

async function draw(readPullRequest: Ports["github"]["readPullRequest"], start: Ports["runner"]["start"], dir = "/unused", state = merged()) {
  const logs: string[] = [];
  const save = vi.fn(async () => {});
  const drawn = await drawAudit(
    state,
    [],
    { issueId: "TECH-5023", enrolledRepositories: [repo], dir, auditSampleRate: 1 },
    deps(readPullRequest, start),
    (line) => logs.push(line),
    save,
    () => budget,
  );
  return { state, logs, save, drawn };
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

test("a sampled audit the owner has no usable account for tells the owner, retried until Linear accepts it", async () => {
  posted.length = 0;
  const ann = { id: "user-ann", name: "Ann" };
  const start = vi.fn<Ports["runner"]["start"]>().mockRejectedValue(new NoModelAccount(ann, "none_usable", ["acct-1"], "every one of Ann's model accounts is spent"));
  const post = linear.postComment;
  linear.postComment = async () => Promise.reject(new Error("Linear unavailable"));
  const first = await draw(async () => pr, start);
  linear.postComment = post;
  // Not posted: the draw stays open, so the next pass starts it again and posts the refusal.
  expect(first.drawn).toBe(false);
  expect(first.state.auditDrawnAt).toBeUndefined();
  expect(first.state.audit).toBeUndefined();
  expect(posted).toHaveLength(0);
  const second = await draw(async () => pr, start, "/unused", first.state);
  expect(second.drawn).toBe(true);
  expect(second.state).toMatchObject({ auditDrawnAt: expect.any(String) });
  expect(second.state.audit).toBeUndefined();
  expect(posted).toHaveLength(1);
  expect(posted[0]?.body).toMatch(/register or fix another model account/);
});

test("a sampled audit is recorded under the task's start/cancel lock before it starts, and a stop recorded first starts none", async () => {
  const start = vi.fn<Ports["runner"]["start"]>(async () => {
    // A cancellation that takes the lock after this sees the audit in the saved state.
    expect(locked).toBe(true);
    expect(save).toHaveBeenLastCalledWith({ runId });
  });
  const save = vi.fn();
  const state = merged();
  const recording = async () => void save(state.audit && { ...state.audit });
  await drawAudit(state, [], { issueId: "TECH-5023", enrolledRepositories: [repo], dir: "/unused", auditSampleRate: 1 }, deps(async () => pr, start), () => {}, recording, () => budget);
  expect(start).toHaveBeenCalledOnce();
  expect(state.audit).toEqual({ runId });

  const dir = await mkdtemp(join(tmpdir(), "audit-stopping-"));
  await writeFile(join(dir, "cancel.json"), "{}");
  const stopped = vi.fn<Ports["runner"]["start"]>();
  const { state: none, logs: why } = await draw(async () => pr, stopped, dir);
  expect(stopped).not.toHaveBeenCalled();
  expect(none.audit).toBeUndefined();
  expect(why).toEqual([`audit review ${runId} not started: the task is stopping`]);
});

test("a sampled audit starts nothing once the issue is reassigned, and records the handoff stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-handoff-"));
  await writeFile(join(dir, "state.json"), "{}");
  linear.readConversation = async () => ({ ...conversation, issue: { ...conversation.issue, assignee: { id: "user-bob", name: "Bob" } } });
  const start = vi.fn<Ports["runner"]["start"]>();
  try {
    const { logs } = await draw(async () => pr, start, dir);
    expect(start).not.toHaveBeenCalled();
    expect(logs.join("\n")).toMatch(/not started: the Linear issue was reassigned from Ann to Bob/);
    expect(JSON.parse(await readFile(join(dir, "cancel.json"), "utf8"))).toMatchObject({ handoff: { merged: true } });
  } finally {
    linear.readConversation = async () => conversation;
  }
});

test("after the merge, the same assignee is the same owner: the audit starts without rereading Linear's history", async () => {
  linear.readTaskOwner.mockClear();
  const start = vi.fn<Ports["runner"]["start"]>(async () => {});
  await draw(async () => pr, start);
  expect(start).toHaveBeenCalledOnce();
  expect(linear.readTaskOwner).not.toHaveBeenCalled();
});

test("a review still running after the merge is canceled, and the task stopped, once the issue is reassigned away from its owner", async () => {
  const canceled: string[] = [];
  const reviewer = { runId: "run_rev", role: "reviewer" as const, status: "running" as const, provider: "p", model: "m", report: null };
  const reassignedTo = { ...conversation, issue: { ...conversation.issue, assignee: { id: "user-bob", name: "Bob" } } };
  const d = {
    ...deps(async () => pr, vi.fn()),
    linear: { readConversation: async () => reassignedTo },
    runner: { status: async () => reviewer, cancel: async (id: string) => void canceled.push(id) },
  } as unknown as Ports;
  const result = await finishReviews(merged(), { outcome: "done", detail: "merged" }, {
    runIds: [RunId.parse("run_rev")],
    recordReviews: async () => {},
    stop: "/nonexistent/stop",
    opts: { issueId: "TECH-5179", enrolledRepositories: [repo], dir: "/nonexistent", pollSeconds: 0.01 },
    deps: d,
    log: () => {},
  });
  expect(canceled).toEqual(["run_rev"]);
  expect(result).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("reassigned from Ann to Bob") });
});
