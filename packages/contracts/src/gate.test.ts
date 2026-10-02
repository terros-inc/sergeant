import { expect, test } from "vitest";
import { checkMerge, type MergeFacts } from "./gate.ts";
import type { MergePr } from "./actions.ts";
import type { ReviewReport, RunRecord } from "./runs.ts";

// The merge gate is the one place an unreviewed, red, wrong-head, or stale-conversation merge is
// stopped (L1, L4). Each case is a way a real merge could go wrong if a check regressed.

const head = "a".repeat(40);
const moved = "b".repeat(40);
const rev = "1".repeat(64);
const pr = { repo: "trevorallred/canary", number: 7 };
const workerLogin = "sergeant-worker[bot]";

const reviewer = (over: Partial<ReviewReport> = {}): RunRecord => ({
  runId: "run_review",
  role: "reviewer",
  status: "succeeded",
  provider: "anthropic",
  model: "m",
  report: {
    reportVersion: "s2-review-report/1",
    reviewed: [{ ...pr, headSha: head }],
    verdict: "approve",
    findings: [],
    summary: "",
    ...over,
  },
});

const worker = (required: boolean, closesIssue = true): RunRecord => ({
  runId: "run_worker",
  role: "worker",
  status: "succeeded",
  provider: "anthropic",
  model: "m",
  report: {
    reportVersion: "s2-worker-report/1",
    outcome: "completed",
    summary: "",
    pullRequests: [{ ...pr, headSha: head, url: "https://github.com/x/y/pull/7", closesIssue, review: { required, reason: "typo" } }],
    knownGaps: [],
    followups: [],
  },
});

const merge: MergePr & { conversationRevision: string } = {
  kind: "merge_pr",
  ...pr,
  expectedHeadSha: head,
  reviewStanding: { kind: "reviewed", reviewRunId: "run_review" },
  conversationRevision: rev,
};

type Over = { pr?: Partial<MergeFacts["pr"]>; pullRequests?: MergeFacts["pullRequests"]; runs?: RunRecord[]; liveConversationRevision?: string; linked?: MergeFacts["linkedPullRequests"] };
const facts = (over: Over = {}): MergeFacts => ({
  pr: {
    ...pr,
    url: "https://github.com/trevorallred/canary/pull/7",
    author: workerLogin,
    state: "open",
    draft: false,
    headSha: head,
    mergedSha: null,
    baseRef: "main",
    body: "Fixes UNF-1",
    mergeable: true,
    checks: { sha: head, required: [{ name: "ci", state: "passed" }] },
    ...over.pr,
  },
  issueIdentifier: "UNF-1",
  pullRequests: over.pullRequests ?? [],
  liveConversationRevision: over.liveConversationRevision ?? rev,
  linkedPullRequests: over.linked ?? [pr],
  workerLogin,
  enrolledRepositories: [pr.repo],
  runs: over.runs ?? [reviewer(), worker(true)],
});

test("a reviewed, green, exact-head merge against an unchanged conversation is allowed", () => {
  expect(checkMerge(merge, facts())).toEqual({ allowed: true });
  const skip = { ...merge, reviewStanding: { kind: "not_required", workerRunId: "run_worker" } } as const;
  expect(checkMerge(skip, facts({ runs: [worker(false)] }))).toEqual({ allowed: true });
});

test.each([
  // An unrelated PR in an enrolled repo, green and reviewed, that a confused turn named instead of the task's #8.
  ["the PR is not linked to this issue", facts({ linked: [{ repo: pr.repo, number: 8 }] }), "M2"],
  // Linked only because its branch, title, or body names the issue, but Sergeant's worker App did not open it.
  ["the linked PR was opened by someone else", facts({ pr: { author: "someone" } }), "M2"],
  ["the head moved", facts({ pr: { headSha: moved } }), "M4"],
  ["a required check failed", facts({ pr: { checks: { sha: head, required: [{ name: "ci", state: "failed" }] } } }), "M5"],
  ["a required check is still pending", facts({ pr: { checks: { sha: head, required: [{ name: "ci", state: "pending" }] } } }), "M5"],
  ["checks are green only on another commit", facts({ pr: { checks: { sha: moved, required: [{ name: "ci", state: "passed" }] } } }), "M5"],
  ["the branch has no required checks", facts({ pr: { checks: { sha: head, required: [] } } }), "M5"],
  ["no review run exists", facts({ runs: [] }), "M6"],
  ["the review covered an earlier head", facts({ runs: [reviewer({ reviewed: [{ ...pr, headSha: moved }] })] }), "M6"],
  ["the reviewer requested changes", facts({ runs: [reviewer({ verdict: "changes_requested" })] }), "M6"],
  ["an approval still carries a blocking finding", facts({ runs: [reviewer({ findings: [{ id: "f1", severity: "blocking", description: "" }] })] }), "M6"],
  // M9: the body must agree with the worker's closesIssue, and the closing PR merges last.
  ["the body lacks the closing reference the worker reported", facts({ pr: { body: "Part of UNF-1" } }), "M9"],
  ["a Part of PR's body carries a closing reference", facts({ runs: [reviewer(), worker(true, false)] }), "M9"],
  ["no worker report says whether the PR closes the issue", facts({ runs: [reviewer()] }), "M9"],
  ["another of the task's PRs is still open", facts({ pullRequests: [{ ...facts().pr, number: 8, body: "Part of UNF-1" }] }), "M9"],
  ["the Linear conversation changed", facts({ liveConversationRevision: "2".repeat(64) }), "M10"],
])("refuses when %s", (_, f, rule) => {
  expect(checkMerge(merge, f)).toMatchObject({ allowed: false, rule });
});

test("refuses a not-required standing unless the worker skipped review for this exact head", () => {
  const skip = { ...merge, reviewStanding: { kind: "not_required", workerRunId: "run_worker" } } as const;
  expect(checkMerge(skip, facts({ runs: [worker(true)] }))).toMatchObject({ rule: "M6" });
  // A reviewer run cannot be passed off as the worker's skip, nor the worker's run as a review.
  expect(checkMerge(skip, facts({ runs: [reviewer()] }))).toMatchObject({ rule: "M6" });
  const asReview = { ...merge, reviewStanding: { kind: "reviewed", reviewRunId: "run_worker" } } as const;
  expect(checkMerge(asReview, facts({ runs: [worker(false)] }))).toMatchObject({ rule: "M6" });
});
