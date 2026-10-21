import { expect, test } from "vitest";
import type { ReviewStanding } from "./actions.ts";
import type { HumanPullRequestFeedback, PullRequestFacts } from "./github.ts";
import type { ReviewTier } from "./review-tiers.ts";
import type { RunRecord } from "./runs.ts";
import { effectiveTier, tierRefusal } from "./tier-gate.ts";

// TECH-6553: the tier gate (M16). Each case is a way Sergeant could merge a head with fewer reviews
// than its tier requires, or approve and merge a T3 or T4 head, if a check regressed.

const head = "a".repeat(40);
const earlier = "b".repeat(40);
const pr = (tier: ReviewTier, over: Partial<PullRequestFacts> = {}) => ({
  repo: "o/r",
  number: 7,
  headSha: head,
  author: "sergeant-worker[bot]",
  changedFiles: ["src/a.ts"],
  humanFeedback: [] as HumanPullRequestFeedback[],
  reviewTier: { tier, rule: "a test rule" },
  ...over,
});
const base = { provider: "anthropic", model: "m", status: "succeeded" } as const;
const reviewer = (runId: string, sha = head, raiseTier?: { tier: ReviewTier; reason: string }): RunRecord => ({
  ...base,
  runId,
  role: "reviewer",
  report: { reportVersion: "s2-review-report/1", reviewed: [{ repo: "o/r", number: 7, headSha: sha, ...(raiseTier && { raiseTier }) }], verdict: "approve", findings: [], summary: "" },
});
const worker = (sha: string, raiseTier?: { tier: ReviewTier; reason: string }): RunRecord => ({
  ...base,
  runId: "run_worker",
  role: "worker",
  report: {
    reportVersion: "s2-worker-report/1",
    outcome: "completed",
    summary: "",
    pullRequests: [{ repo: "o/r", number: 7, headSha: sha, url: "https://github.com/o/r/pull/7", closesIssue: true, review: { required: false, reason: "docs" }, ...(raiseTier && { raiseTier }) }],
    knownGaps: [],
    followups: [],
  },
});
const approval = (over: Partial<HumanPullRequestFeedback> = {}): HumanPullRequestFeedback => ({
  id: "review:1",
  kind: "review",
  author: "maintainer",
  state: "APPROVED",
  body: "",
  path: null,
  line: null,
  commitId: head,
  createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z",
  url: "https://github.com/o/r/pull/7#pullrequestreview-1",
  association: "MEMBER",
  ...over,
});
const reviewed: ReviewStanding = { kind: "reviewed", reviewRunId: "run_r1" };
const skipped: ReviewStanding = { kind: "not_required", workerRunId: "run_worker" };
const merge = { handToHuman: false };
const handoff = { handToHuman: true };

test("a raised tier sticks for later heads, and a raise never lowers the map's tier", () => {
  // The worker raised it on an earlier head; the map still says T1 at the new head.
  expect(effectiveTier(pr("T1"), [worker(earlier, { tier: "T3", reason: "edits an IAM trust policy" })])).toMatchObject({
    tier: "T3",
    rule: "raised to T3 by worker run_worker: edits an IAM trust policy",
  });
  expect(effectiveTier(pr("T1"), [reviewer("run_r1", head, { tier: "T4", reason: "deletes production data" })])).toMatchObject({ tier: "T4" });
  expect(effectiveTier(pr("T3"), [worker(head, { tier: "T0", reason: "only docs" })])).toMatchObject({ tier: "T3", rule: "a test rule" });
  // A raise for another PR is not this one's.
  expect(effectiveTier({ ...pr("T1"), number: 8 }, [worker(head, { tier: "T3", reason: "x" })])).toMatchObject({ tier: "T1" });
  // A head whose tier no source read is T3, and protected CI at least T3, whatever the source said.
  expect(effectiveTier({ ...pr("T1"), reviewTier: undefined }, [])).toMatchObject({ tier: "T3" });
  expect(effectiveTier(pr("T0", { changedFiles: [".github/workflows/ci.yml"] }), [])).toMatchObject({ tier: "T3" });
});

test("only T0 accepts the worker's not_required; T1 needs a reviewer run's approval", () => {
  expect(tierRefusal({ tier: "T0", rule: "r" }, skipped, pr("T0"), [worker(head)], merge)).toBeNull();
  for (const tier of ["T1", "T2", "T3", "T4"] as const) {
    expect(tierRefusal({ tier, rule: "r" }, skipped, pr(tier), [worker(head)], handoff)).toContain("not_required covers only T0");
  }
  expect(tierRefusal({ tier: "T1", rule: "r" }, reviewed, pr("T1"), [reviewer("run_r1")], merge)).toBeNull();
});

test("T2 needs two independent approving reviews of the exact head, or a human's approval of it", () => {
  const t2 = { tier: "T2", rule: "r" } as const;
  expect(tierRefusal(t2, reviewed, pr("T2"), [reviewer("run_r1")], merge)).toContain("has 1 approving review and no human approval");
  // The second review approved an earlier head, or started from an earlier issue text: still one.
  expect(tierRefusal(t2, reviewed, pr("T2"), [reviewer("run_r1"), reviewer("run_r2", earlier)], merge)).not.toBeNull();
  expect(tierRefusal(t2, reviewed, pr("T2"), [reviewer("run_r1"), { ...reviewer("run_r2"), issueRevision: "v0" }], { ...merge, issueRevision: "v1" })).not.toBeNull();
  expect(tierRefusal(t2, reviewed, pr("T2"), [reviewer("run_r1"), reviewer("run_r2")], merge)).toBeNull();
  expect(tierRefusal(t2, reviewed, pr("T2", { humanFeedback: [approval()] }), [reviewer("run_r1")], merge)).toBeNull();
  // An approval that does not count: of another head, by the PR's author, or by someone with no role in a public repository.
  for (const a of [approval({ commitId: earlier }), approval({ author: "sergeant-worker[bot]" }), approval({ association: "NONE" }), approval({ association: undefined })]) {
    expect(tierRefusal(t2, reviewed, pr("T2", { humanFeedback: [a] }), [reviewer("run_r1")], merge)).not.toBeNull();
  }
  // Handed to a human, the human who merges gives the rest.
  expect(tierRefusal(t2, reviewed, pr("T2"), [reviewer("run_r1")], handoff)).toBeNull();
});

test("Sergeant never merges a T3 or T4 head, however reviewed; it hands it to a human after an independent review", () => {
  for (const tier of ["T3", "T4"] as const) {
    const facts = pr(tier, { humanFeedback: [approval(), approval({ id: "review:2", author: "second" })] });
    expect(tierRefusal({ tier, rule: "r" }, reviewed, facts, [reviewer("run_r1"), reviewer("run_r2")], merge)).toContain("a human approves and merges it, never Sergeant");
    expect(tierRefusal({ tier, rule: "r" }, reviewed, facts, [reviewer("run_r1")], handoff)).toBeNull();
  }
});
