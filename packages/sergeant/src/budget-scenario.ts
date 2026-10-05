import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
  commentIdFor,
  type Conversation,
  type HumanComment,
  type MergePr,
  type ProposedAction,
  type PullRequestFacts,
  type RunRecord,
  type RunnerPort,
} from "@terros/sergeant-contracts";
import type { Reasoner } from "@terros/sergeant-reasoning";
import { runLoop, type LoopOptions } from "./loop.ts";

// The fakes the budget, undelegation, and answered-question tests (budget.test.ts, undelegation.test.ts,
// answered.test.ts) run the loop over.

export const head = "a".repeat(40);
export const repo = "o/canary";
export const agent = { id: "agent-v2", name: "Sergeant" };
export const pr: PullRequestFacts = {
  repo,
  number: 7,
  url: `https://github.com/${repo}/pull/7`,
  author: "sergeant-worker[bot]",
  state: "open",
  draft: false,
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true,
  checks: { sha: head, required: [{ name: "validate", state: "passed" }] },
  humanFeedback: [],
};
export const worker = (status: RunRecord["status"], costUsd?: number): RunRecord => ({
  runId: "run_w",
  role: "worker",
  status,
  provider: "p",
  model: "m",
  ...(costUsd !== undefined && { costUsd }),
  report: null,
});
export const review: RunRecord = {
  runId: "run_review",
  role: "reviewer",
  status: "succeeded",
  provider: "p",
  model: "m",
  costUsd: 10,
  report: { reportVersion: "s2-review-report/1", reviewed: [{ repo, number: 7, headSha: head }], verdict: "approve", findings: [], summary: "" },
};
export const merge: MergePr = { kind: "merge_pr", repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } };
export const start: ProposedAction = { kind: "start_worker", objective: "finish", repositories: [repo] };
export const human = (id: string, at: string, body: string): HumanComment => ({ id, author: { id: "u1", name: "Human" }, createdAt: at, updatedAt: at, body });

export const issue = { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [{ repo, number: 7 }] };
export const turnOf = (actions: ProposedAction[], costUsd?: number) => ({ output: { summary: "s", actions }, model: "m", promptVersion: "p", ...(costUsd !== undefined && { costUsd }) });

export let dir = "";
export async function cleanup() {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
  dir = "";
}

/**
 * A loop over fakes: Linear keeps one comment per key, as it does; `onPoll` acts as the human or
 * operator. `state` seeds `state.json`; omitted, the task is new (or continues an earlier `scenario`).
 */
export async function scenario(opts: {
  state?: Record<string, unknown>;
  conversation?: Partial<Conversation>;
  runner: RunnerPort;
  reasoner: Reasoner["turn"];
  onPoll: (poll: number, live: Conversation) => Promise<Conversation> | Conversation;
  loop?: Partial<LoopOptions>;
  /** Runs before a thread is resolved; throw to simulate a crash that loses the resolve (TECH-5057). */
  beforeResolve?: (id: string) => Promise<void> | void;
  /** Runs before a comment is posted; throw to fail the post. */
  beforePost?: (req: { key: string; parentId?: string }) => void;
  /** The PR GitHub shows now; `pr` when omitted. */
  pullRequest?: () => PullRequestFacts;
}) {
  dir ||= await mkdtemp(join(tmpdir(), "sergeant-budget-test-"));
  if (opts.state) await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", turns: 1, recentTurns: [], ...opts.state }));
  let live: Conversation = { issue, humanComments: [], agentComments: [], ...opts.conversation };
  const posted: string[] = [];
  const replies: { body: string; parentId: string }[] = [];
  const resolved: string[] = [];
  const merged: unknown[] = [];
  let polls = 0;
  const result = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, idleMinutes: 0, budget: { wallMinutes: 120, costUsd: 25 }, log: () => {}, ...opts.loop },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: {
        readConversation: async () => (live = await opts.onPoll(++polls, live)),
      readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
      moveIssueToStarted: async () => ({ moved: false as const }),
        async postComment({ key, body, parentId }) {
          opts.beforePost?.({ key, ...(parentId && { parentId }) });
          posted.push(body);
          if (parentId) replies.push({ body, parentId });
          const id = commentIdFor(key);
          if (live.agentComments.some((c) => c.id === id)) return;
          live = { ...live, agentComments: [...live.agentComments, { id, createdAt: new Date().toISOString(), body, ...(parentId && { parentId }) }] };
        },
        resolveThread: async (id) => (await opts.beforeResolve?.(id), resolved.push(id), "resolved" as const),
        createFollowupIssue: async () => { throw new Error("unused"); },
      },
      github: { readPullRequest: async () => opts.pullRequest?.() ?? pr, closePullRequest: async () => {}, mergePullRequest: async (req) => (merged.push(req), { mergedSha: "c".repeat(40) }) },
      runner: opts.runner,
      reasoner: { turn: opts.reasoner },
    },
  );
  return { result, posted, replies, resolved, merged, live };
}

export type Saved = { runIds: string[]; budget: { window: unknown; since?: string; priorRuns: string[] }; recentTurns: { outcomes: string[] }[] };
export const saved = async () => JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as Saved;
export const stopAfter = (n: number) => async (poll: number, live: Conversation) => {
  if (poll >= n) await writeFile(join(dir, "STOP"), "");
  return live;
};
