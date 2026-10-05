import {
  conversationRevision,
  type Conversation,
  type GitHubPort,
  type MergePr,
  type ProposedAction,
  type PullRequestFacts,
  type SituationReport,
} from "@terros/sergeant-contracts";
import type { Ports } from "./execute.ts";

// The live facts and fake ports the executor tests (execute.test.ts, execute-start.test.ts) run over.

export const head = "a".repeat(40);
export const conversation: Conversation = {
  issue: {
    id: "i1",
    identifier: "UNF-1",
    url: "https://linear.app/x/issue/UNF-1",
    title: "T",
    description: "D",
    state: "In Progress",
    stateType: "started",
    delegate: { id: "agent-v2", name: "Sergeant" }, assignee: { id: "user-ann", name: "Ann" },
    linkedPullRequests: [{ repo: "trevorallred/canary", number: 7 }],
  },
  humanComments: [],
  agentComments: [],
};
export const pr: PullRequestFacts = {
  repo: "trevorallred/canary",
  number: 7,
  url: "https://github.com/trevorallred/canary/pull/7",
  state: "open",
  draft: false,
  author: "sergeant-worker[bot]",
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true, mergeableState: "clean",
  checks: { sha: head, required: [{ name: "ci", state: "passed" }] },
  humanFeedback: [],
};
export const situation: SituationReport = {
  taskId: "tsk_1",
  generatedAt: "2026-10-02T06:00:00.000Z",
  conversationRevision: conversationRevision(conversation),
  conversation,
  enrolledRepositories: [pr.repo],
  pullRequests: [pr],
  runs: [
    {
      runId: "run_review",
      role: "reviewer",
      status: "succeeded",
      provider: "anthropic",
      model: "m",
      report: { reportVersion: "s2-review-report/1", reviewed: [{ repo: pr.repo, number: 7, headSha: head }], verdict: "approve", findings: [], summary: "" },
    },
    {
      runId: "run_worker",
      role: "worker",
      status: "succeeded",
      provider: "anthropic",
      model: "m",
      report: {
        reportVersion: "s2-worker-report/1",
        outcome: "completed",
        summary: "",
        pullRequests: [{ repo: pr.repo, number: 7, headSha: head, url: pr.url, closesIssue: true, review: { required: true, reason: "" } }],
        knownGaps: [],
        followups: [],
      },
    },
  ],
  followups: [],
  uploads: [],
  refusedMerges: [],
  budget: { window: { wallMinutes: 120, costUsd: 25 }, wallDeadline: "2999-01-01T00:00:00.000Z", spentUsd: 0, costLimitUsd: 25, unknownCostRuns: 0, taskStart: "2026-10-02T10:00:00.000Z", windowStart: "2026-10-02T10:00:00.000Z" },
  recentTurns: [],
};
export const merge: MergePr = { kind: "merge_pr", repo: pr.repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } };

export function ports(live: { pr?: Partial<PullRequestFacts>; conversation?: Conversation; moveFails?: boolean; taskOwner?: Ports["linear"]["readTaskOwner"] } = {}) {
  const handoffs: string[] = [];
  const merged: Parameters<GitHubPort["mergePullRequest"]>[0][] = [];
  const started: string[] = [];
  const sent: string[] = [];
  const moved: string[] = [];
  const filed: Parameters<Ports["linear"]["createFollowupIssue"]>[0][] = [];
  const p: Ports = {
    linear: {
      readConversation: async () => live.conversation ?? conversation,
      readTaskOwner: live.taskOwner ?? (async () => ({ owner: { id: "user-ann", name: "Ann" }, delegatedAt: "2026-10-04T00:00:00.000Z" })),
      moveIssueToStarted: async (id) => {
        moved.push(id);
        if (live.moveFails) throw new Error("Linear unavailable");
        return { moved: true as const, from: "Todo", to: "In Progress" };
      },
      postComment: async () => {},
      createFollowupIssue: async (req) => {
        filed.push(req);
        return { identifier: `UNF-${100 + filed.length}`, url: `https://linear.app/x/issue/UNF-${100 + filed.length}` };
      },
    },
    agentUserId: "agent-v2",
    workerLogin: "sergeant-worker[bot]",
    owner: { id: "user-ann", name: "Ann", admittedAt: "2026-10-04T00:00:00.000Z", delegatedAt: "2026-10-04T00:00:00.000Z" },
    handoff: async (reason) => void handoffs.push(reason),
    github: {
      readPullRequest: async () => ({ ...pr, ...live.pr }),
      closePullRequest: async () => {}, mergePullRequest: async (req) => (merged.push(req), { mergedSha: "c".repeat(40) }),
    },
    runner: {
      start: async (spec) => void started.push(spec.runId),
      status: async () => { throw new Error("unused"); },
      cancel: async () => {},
      send: async (runId) => void sent.push(runId),
    },
  };
  return { p, merged, started, sent, moved, filed, handoffs };
}

export const followup = (key: string): ProposedAction => ({ kind: "create_followup", key, title: `Do ${key}`, category: "concrete_bug", why: `${key} fails.`, description: `Why ${key}.`, relation: "related" });
