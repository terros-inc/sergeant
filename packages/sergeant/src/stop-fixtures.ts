import type { Conversation, PullRequestFacts, RunRecord } from "@terros/sergeant-contracts";
import type { ServiceDeps } from "./service.ts";

export const agent = { id: "agent-v2", name: "Sergeant" };
export const repo = "o/r";
export const head = "a".repeat(40);
export const pr = (number: number, author = "sergeant-worker[bot]"): PullRequestFacts => ({
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  author,
  state: "open",
  draft: false,
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true,
  checks: { sha: head, required: [{ name: "validate", state: "pending" }] },
  humanFeedback: [],
});
export const issue = (stateType: string, state: string): Conversation => ({
  issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state, stateType, delegate: agent, linkedPullRequests: [{ repo, number: 7 }] },
  humanComments: [],
  agentComments: [],
});
export const worker = (status: RunRecord["status"]): RunRecord => ({ runId: "run_w1", role: "worker", status, provider: "p", model: "m", report: null });

export function fakes(live: { conversation: Conversation }) {
  const runs = [worker("running")];
  const wrote = new Map<string, RunRecord["report"]>();
  const seen = { turns: 0, starts: 0, canceled: [] as string[], closed: [] as { number: number; comment: string }[], comments: [] as { key: string; body: string }[], commentAttempts: [] as string[] };
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [{ identifier: "UNF-1", priority: 0, createdAt: "2026-10-01T00:00:00.000Z", state: { name: live.conversation.issue.state, type: live.conversation.issue.stateType }, blockedBy: [] }],
    undelegate: async () => void (live.conversation.issue.delegate = null),
    linear: {
      readConversation: async () => structuredClone(live.conversation),
      moveIssueToStarted: async () => ({ moved: false as const }),
      postComment: async ({ key, body }) => {
        seen.commentAttempts.push(key);
        if (!seen.comments.some((comment) => comment.key === key)) seen.comments.push({ key, body });
      },
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
    },
    github: {
      readPullRequest: async (_repo, number) => {
        const closed = seen.closed.some((c) => c.number === number);
        return { ...pr(number, number === 8 ? "a-human" : undefined), state: closed ? "closed" : "open" };
      },
      mergePullRequest: async () => Promise.reject(new Error("no merge after a stop")),
      closePullRequest: async ({ number, comment }) => void seen.closed.push({ number, comment }),
    },
    runner: {
      start: async (spec) => (seen.starts++, void runs.push({ ...worker("running"), runId: spec.runId })),
      status: async (id) => runs.find((r) => r.runId === id) ?? Promise.reject(new Error(`no ${id}`)),
      cancel: async (id) => {
        seen.canceled.push(id);
        const run = runs.find((r) => r.runId === id);
        if (run) Object.assign(run, { status: "canceled", report: wrote.get(id) ?? null });
      },
    },
    reasoner: {
      async turn() {
        seen.turns++;
        return { output: { summary: "start a worker", actions: [{ kind: "start_worker", objective: "Do UNF-1.", repositories: [repo] }] }, model: "m", promptVersion: "p" };
      },
    },
  };
  return { deps, seen, wrote };
}

export const state = (runIds: string[]) =>
  JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds, recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] } });
