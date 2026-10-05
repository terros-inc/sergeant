import type { PullRequestFacts, RunRecord } from "@terros/sergeant-contracts";

// The fakes loop.test.ts and loop-merge.test.ts share: one closing PR from the worker, the worker run
// that reports it, the fresh review that approved its head, and Sergeant's V2 agent.

export const head = "a".repeat(40);
export const repo = "o/canary";
export const pr: PullRequestFacts = {
  repo,
  number: 7,
  url: `https://github.com/${repo}/pull/7`,
  state: "open",
  draft: false,
  author: "sergeant-worker[bot]",
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true, mergeableState: "clean",
  checks: { sha: head, required: [{ name: "validate", state: "passed" }] },
  humanFeedback: [],
};
export const review: RunRecord = {
  runId: "run_review",
  role: "reviewer",
  status: "succeeded",
  provider: "p",
  model: "m",
  report: {
    reportVersion: "s2-review-report/1",
    reviewed: [{ repo, number: 7, headSha: head }],
    verdict: "approve",
    findings: [{ id: "f1", severity: "non_blocking", description: "Retries have no jitter." }],
    summary: "",
  },
};
export const worker: RunRecord = {
  runId: "run_worker",
  role: "worker",
  status: "succeeded",
  provider: "p",
  model: "m",
  report: {
    reportVersion: "s2-worker-report/1",
    outcome: "completed",
    summary: "",
    pullRequests: [{ repo, number: 7, headSha: head, url: pr.url, closesIssue: true, review: { required: true, reason: "" } }],
    knownGaps: ["No live check yet."],
    followups: [],
  },
};

export const agent = { id: "agent-v2", name: "Sergeant" };
