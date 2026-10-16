import { expect, test } from "vitest";
import { commentIdFor, type Conversation, type PullRequestFacts, type RunRecord } from "@terros/sergeant-contracts";
import { postAdoptions } from "./adopted.ts";

// TECH-6164: the issue names the PR a worker took over from a human or another agent, once, even though
// Sergeant never reviews such a PR and so never posts a progress comment on it.

const repo = "o/canary";
const workerLogin = "sergeant-worker[bot]";
const head = "a".repeat(40);
const pr = (number: number, author: string): PullRequestFacts => ({
  repo, number, url: `https://github.com/${repo}/pull/${number}`, state: "open", draft: false, author, headSha: head, mergedSha: null, baseRef: "main",
  body: "", mergeable: true, mergeableState: "clean", checks: { sha: head, required: [] }, humanFeedback: [],
});
const worker = (numbers: number[]): RunRecord => ({
  runId: "run_worker", role: "worker", status: "succeeded", provider: "anthropic/claude-code", model: "m",
  report: {
    reportVersion: "s2-worker-report/1", outcome: "completed", knownGaps: [], followups: [], summary: "s",
    pullRequests: numbers.map((number) => ({ repo, number, headSha: head, url: `https://github.com/${repo}/pull/${number}`, closesIssue: true, review: { required: true, reason: "" } })),
  },
});

test("a PR another agent opened that the worker pushed to is named on the issue once; the worker's own and untouched ones are not", async () => {
  const conversation: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: null, assignee: null, linkedPullRequests: [] },
    humanComments: [],
    agentComments: [],
  };
  // #3 is another agent's the worker took over; #4 the worker's own; #5 a human's the worker never touched.
  const situation = { conversation, runs: [worker([3, 4])], pullRequests: [pr(3, "grok[bot]"), pr(4, workerLogin), pr(5, "someone")] };
  const posted: { key: string; body: string }[] = [];
  const linear = {
    postComment: async (c: { issueId: string; key: string; body: string }) => {
      posted.push(c);
      conversation.agentComments.push({ id: commentIdFor(c.key), createdAt: "2026-10-16T00:00:00.000Z", body: c.body });
    },
  };
  await postAdoptions(situation, workerLogin, linear, () => {});
  await postAdoptions(situation, workerLogin, linear, () => {});
  expect(posted.map((p) => p.key)).toEqual([`adopted:i1:${repo}#3`]);
  expect(posted[0]?.body).toContain(`[${repo}#3](https://github.com/${repo}/pull/3), which grok[bot] opened`);
});
