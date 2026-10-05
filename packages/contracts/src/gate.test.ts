import { expect, test } from "vitest";
import { checkMayMerge, checkMerge, rereviewRequests, type MergeFacts, type MergePreflightFacts } from "./gate.ts";
import type { MergePr } from "./actions.ts";
import type { HumanPullRequestFeedback } from "./github.ts";
import type { RefusedMerge } from "./situation.ts";
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

const worker = (required: boolean, closesIssue = true, unreadableInputs?: string[]): RunRecord => ({
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
    ...(unreadableInputs && { unreadableInputs }),
  },
});

const merge: MergePr & { conversationRevision: string } = {
  kind: "merge_pr",
  ...pr,
  expectedHeadSha: head,
  reviewStanding: { kind: "reviewed", reviewRunId: "run_review" },
  conversationRevision: rev,
};

type Over = {
  pr?: Partial<MergeFacts["pr"]>;
  pullRequests?: MergeFacts["pullRequests"];
  runs?: RunRecord[];
  liveConversationRevision?: string;
  linked?: MergeFacts["linkedPullRequests"];
  refusedMerges?: RefusedMerge[];
  liveIssueRevision?: string;
  agentComments?: MergeFacts["agentComments"];
  issue?: Partial<MergePreflightFacts["issue"]>;
  budget?: Partial<MergePreflightFacts["budget"]>;
};
const now = new Date("2026-10-03T03:00:00.000Z");
const facts = (over: Over = {}): MergePreflightFacts => ({
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
    // What every PR waiting for Sergeant reads: only the merge's own approval satisfies the ruleset.
    mergeableState: "blocked",
    checks: { sha: head, required: [{ name: "ci", state: "passed" }] },
    humanFeedback: [],
    ...over.pr,
  },
  issueIdentifier: "UNF-1",
  pullRequests: over.pullRequests ?? [],
  liveConversationRevision: over.liveConversationRevision ?? rev,
  liveIssueRevision: over.liveIssueRevision ?? "issue-v1",
  agentComments: over.agentComments ?? [],
  linkedPullRequests: over.linked ?? [pr],
  workerLogin,
  enrolledRepositories: [pr.repo],
  runs: over.runs ?? [reviewer(), worker(true)],
  refusedMerges: over.refusedMerges ?? [],
  issue: {
    id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started",
    delegate: { id: "agent-v2", name: "Sergeant" }, linkedPullRequests: over.linked ?? [pr], ...over.issue,
  },
  agentUserId: "agent-v2",
  budget: {
    window: { wallMinutes: 120, costUsd: 25 }, taskStart: "2026-10-03T02:00:00.000Z", windowStart: "2026-10-03T02:00:00.000Z", wallDeadline: "2026-10-03T04:00:00.000Z",
    spentUsd: 1, costLimitUsd: 25, unknownCostRuns: 0, ...over.budget,
  },
  now,
});

// M7 (08 §7, TECH-5013): each refusal names GitHub's mergeable_state, so reasoning can tell waiting
// from rebasing. TECH-4991: none is a policy refusal, so a later read that changes it retries.
test.each([
  ["clean", true, null],
  ["unstable", true, null],
  ["blocked", true, null],
  ["unknown", null, "still computing whether the PR is mergeable (GitHub's mergeable_state is unknown); wait"],
  ["unknown", true, "still computing whether the PR is mergeable (GitHub's mergeable_state is unknown); wait"],
  ["clean", null, "still computing whether the PR is mergeable (GitHub's mergeable_state is clean); wait"],
  ["dirty", false, "not mergeable (GitHub's mergeable_state is dirty: it conflicts with its base); a worker rebases it"],
  ["behind", true, "GitHub's mergeable_state is behind: the head is behind its base; a worker rebases it"],
  ["draft", true, "GitHub's mergeable_state is draft: the PR is a draft"],
  ["has_hooks", true, "GitHub's mergeable_state is has_hooks, not clean or unstable"],
] as const)("M7 with mergeable_state %s and mergeable %s", (mergeableState, mergeable, reason) => {
  const verdict = checkMerge(merge, facts({ pr: { mergeable, mergeableState } }));
  if (reason === null) expect(verdict).toEqual({ allowed: true });
  else expect(verdict).toEqual({ allowed: false, rule: "M7", reason: expect.stringContaining(reason) });
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

// TECH-4987: Sergeant proposed merging over the captain's "Request changes" twice. A human's requested
// changes outrank Sergeant's own approving reviewer at any head, until that human approves or the
// review is dismissed; another human's approval or the requester's later plain comment does not lift it.
test("refuses to merge while a human's latest review requests changes, at any head", () => {
  let n = 0;
  const reviewBy = (author: string, state: HumanPullRequestFeedback["state"], commitId = head): HumanPullRequestFeedback => {
    n += 1;
    const at = `2026-10-03T0${n}:00:00.000Z`;
    return { id: `review:${n}`, kind: "review", author, state, body: "", path: null, line: null, commitId, createdAt: at, updatedAt: at, url: `https://github.com/x/y/pull/7#r${n}` };
  };
  const withFeedback = (...humanFeedback: HumanPullRequestFeedback[]) => checkMerge(merge, facts({ pr: { humanFeedback } }));

  const requested = reviewBy("captain", "CHANGES_REQUESTED", moved);
  expect(withFeedback(requested)).toMatchObject({ allowed: false, rule: "M8", reason: expect.stringContaining("captain") });
  expect(withFeedback(requested, reviewBy("captain", "COMMENTED"))).toMatchObject({ rule: "M8" });
  expect(withFeedback(requested, reviewBy("someone-else", "APPROVED"))).toMatchObject({ rule: "M8" });
  expect(withFeedback(requested, reviewBy("captain", "APPROVED"))).toEqual({ allowed: true });
  // GitHub marks a dismissed review DISMISSED in place.
  expect(withFeedback({ ...requested, state: "DISMISSED" })).toEqual({ allowed: true });
});

// TECH-4987: on a repository whose policy needs a human to merge (code owners), GitHub refused the merge
// and Sergeant retried it with nothing changed. Only a changed conversation, human PR feedback
// included, lets the same head be tried again.
test("refuses to retry a merge GitHub refused by policy until something changes", () => {
  const refused: RefusedMerge = {
    ...pr,
    url: "https://github.com/trevorallred/canary/pull/7",
    headSha: head,
    conversationRevision: rev,
    reason: "Waiting on code owner review from @terros-inc/owners.",
    at: "2026-10-03T01:00:00.000Z",
  };
  expect(checkMerge(merge, facts({ refusedMerges: [refused] }))).toMatchObject({ allowed: false, rule: "M12" });
  const changed = "2".repeat(64);
  expect(checkMerge({ ...merge, conversationRevision: changed }, facts({ refusedMerges: [refused], liveConversationRevision: changed }))).toEqual({ allowed: true });
});

// TECH-5034: the issue was rewritten to require a bundled reference file while the task waited, and the
// work merged against the old text. A review or waiver given against an earlier title or description
// is no standing for the current acceptance criteria.
test("refuses a standing given against an earlier title or description of the issue", () => {
  const at = (run: RunRecord, issueRevision: string): RunRecord => ({ ...run, issueRevision });
  expect(checkMerge(merge, facts({ runs: [at(reviewer(), "issue-v1"), worker(true)] }))).toEqual({ allowed: true });
  expect(checkMerge(merge, facts({ runs: [at(reviewer(), "issue-v0"), worker(true)] }))).toMatchObject({ allowed: false, rule: "M13" });
  const skip = { ...merge, reviewStanding: { kind: "not_required", workerRunId: "run_worker" } } as const;
  expect(checkMerge(skip, facts({ runs: [at(worker(false), "issue-v0")] }))).toMatchObject({ allowed: false, rule: "M13" });
});

// TECH-5034: a worker could not read the Google Doc the issue depended on, said so only in its PR, and
// the work went ahead. An input a run could not read blocks the merge until Sergeant has asked about it.
test("refuses to merge past an input a run could not read until a question names it", () => {
  const doc = "https://docs.google.com/document/d/standard";
  const unread = worker(true, true, [doc]);
  expect(checkMerge(merge, facts({ runs: [reviewer(), unread] }))).toMatchObject({ allowed: false, rule: "M14", reason: expect.stringContaining(doc) });
  const asked = { id: "c1", createdAt: "2026-10-03T02:00:00.000Z", body: `**Question for you**\n\nThe worker could not read ${doc}. Can you share it?` };
  expect(checkMerge(merge, facts({ runs: [reviewer(), unread], agentComments: [asked] }))).toEqual({ allowed: true });
  const quoted = { ...asked, id: "c2", body: `Linked document: ${doc}` };
  expect(checkMerge(merge, facts({ runs: [reviewer(), unread], agentComments: [quoted] }))).toMatchObject({ allowed: false, rule: "M14" });
});

// TECH-4992, TECH-5051: Sergeant told a human "merging waits on your review" while the Gate went on to
// refuse on M13. It asks only when the real merge gate, M8 aside, would merge the head.
test("asks a human to re-review only when their requested changes are all that blocks the head", () => {
  const review = (state: HumanPullRequestFeedback["state"], commitId: string | null, hour: number): HumanPullRequestFeedback => {
    const at = `2026-10-03T0${hour}:00:00.000Z`;
    return { id: `review:${hour}`, kind: "review", author: "captain", state, body: "", path: null, line: null, commitId, createdAt: at, updatedAt: at, url: `https://github.com/x/y/pull/7#r${hour}` };
  };
  const requested = review("CHANGES_REQUESTED", moved, 1);
  const ask = (over: Over = {}) => rereviewRequests(facts({ ...over, pr: { humanFeedback: [requested], ...over.pr } }));

  expect(checkMerge(merge, facts({ pr: { humanFeedback: [requested] } }))).toMatchObject({ allowed: false, rule: "M8" });
  expect(ask()).toEqual(["captain"]);
  expect(ask({ runs: [worker(false)] })).toEqual(["captain"]);
  // A review whose commit GitHub no longer reports was not left on this head.
  expect(ask({ pr: { humanFeedback: [{ ...requested, commitId: null }] } })).toEqual(["captain"]);

  // M8 plus any other rule: the merge waits on more than the human, so no one is asked.
  const activeRun: Over = { runs: [reviewer(), worker(true), { ...worker(true), runId: "run_worker_2", status: "running", report: null }] };
  expect(checkMerge(merge, facts(activeRun))).toMatchObject({ allowed: false, rule: "M11" });
  expect(ask(activeRun)).toEqual([]); // M8 plus M11
  expect(ask({ runs: [{ ...reviewer(), issueRevision: "issue-v0" }, worker(true)] })).toEqual([]); // M13
  expect(ask({ runs: [reviewer(), worker(true, true, ["https://docs.google.com/document/d/x"])] })).toEqual([]); // M14
  expect(ask({ pr: { checks: { sha: head, required: [{ name: "ci", state: "pending" }] } } })).toEqual([]); // M5
  // Not blocked by M8 at all: approved since, or requested on this very head, so nothing has addressed it yet.
  expect(ask({ pr: { humanFeedback: [requested, review("APPROVED", head, 2)] } })).toEqual([]);
  expect(ask({ pr: { humanFeedback: [review("CHANGES_REQUESTED", head, 1)] } })).toEqual([]);
});

// TECH-5065: the merge itself also waits on the budget (B1) and the live issue (A1, A2), so with M8 the
// only rule checkMerge refuses, Sergeant still must not tell a human the merge waits on their review.
test("asks no one to re-review while the budget is exhausted or the live issue stops the merge", () => {
  const requested: HumanPullRequestFeedback = {
    id: "review:1", kind: "review", author: "captain", state: "CHANGES_REQUESTED", body: "", path: null, line: null, commitId: moved,
    createdAt: "2026-10-03T01:00:00.000Z", updatedAt: "2026-10-03T01:00:00.000Z", url: "https://github.com/x/y/pull/7#r1",
  };
  const ask = (over: Over = {}) => rereviewRequests(facts({ ...over, pr: { humanFeedback: [requested] } }));
  expect(checkMerge(merge, facts({ pr: { humanFeedback: [requested] } }))).toMatchObject({ allowed: false, rule: "M8" });
  expect(ask()).toEqual(["captain"]);

  const blocked: [string, Over][] = [
    ["B1", { budget: { spentUsd: 25 } }],
    ["B1", { budget: { wallDeadline: now.toISOString() } }],
    ["A1", { issue: { delegate: null } }],
    ["A1", { issue: { delegate: { id: "agent-v1", name: "Sergeant V1" } } }],
    ["A2", { issue: { state: "Done", stateType: "completed" } }],
  ];
  for (const [rule, over] of blocked) {
    // The same preflight the merge applies refuses it on that rule; so no one is asked.
    expect(checkMayMerge(merge, facts(over))).toMatchObject({ allowed: false, rule });
    expect(ask(over)).toEqual([]);
  }
  expect(checkMayMerge(merge, facts())).toEqual({ allowed: true });
});
