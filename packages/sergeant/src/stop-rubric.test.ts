import { expect, test } from "vitest";
import type { MergePolicy, PullRequestFacts, RunRecord } from "@terros/sergeant-contracts";
import { head, pr, situation } from "./execute-fixtures.ts";
import { budgetQuestion } from "./budget.ts";
import { stopCase } from "./stop-case.ts";
import { recommend, type WindowFacts } from "./stop-rubric.ts";

// TECH-6021: the stop rubric (docs/findings/tech-5922-wall-time-windows.md §6) decides what Sergeant
// recommends when a window runs out. A wrong "extend" invites a human to keep a stuck or unmergeable
// task running, so these pin the rules that must win: rule 1 over every extend, and rule 2 only for a
// merge Sergeant may actually do.

const worker = (runId: string, status: RunRecord["status"] = "succeeded", costUsd?: number): RunRecord => ({
  runId,
  role: "worker",
  status,
  provider: "p",
  model: "m",
  ...(costUsd !== undefined && { costUsd }),
  report:
    status === "succeeded"
      ? { reportVersion: "s2-worker-report/1", outcome: "completed", summary: "", pullRequests: [{ repo: pr.repo, number: 7, headSha: head, url: pr.url, closesIssue: true, review: { required: true, reason: "" } }], knownGaps: [], followups: [] }
      : null,
});
const reviewer = (runId: string, verdict: "approve" | "changes_requested", locations: string[] = [], costUsd?: number): RunRecord => ({
  runId,
  role: "reviewer",
  status: "succeeded",
  provider: "p",
  model: "m",
  ...(costUsd !== undefined && { costUsd }),
  report: {
    reportVersion: "s2-review-report/1",
    reviewed: [{ repo: pr.repo, number: 7, headSha: head }],
    verdict,
    findings: locations.map((location, i) => ({ id: `f${i + 1}`, severity: "blocking" as const, description: `Fix ${location}.`, location })),
    summary: "",
  },
});

function facts(runs: RunRecord[], opts: { pr?: Partial<PullRequestFacts>; policy?: MergePolicy; spentUsd?: number; steers?: Record<string, number> } = {}): WindowFacts {
  return {
    situation: { ...situation, runs, pullRequests: [{ ...pr, ...opts.pr }], budget: { ...situation.budget, spentUsd: opts.spentUsd ?? 5 } },
    runs,
    steers: opts.steers ?? {},
    retries: {},
    turns: 4,
    turnCostUsd: 0.4,
    mergePolicy: () => opts.policy ?? "sergeant",
  };
}

test("only a merge left: extend under rule 2 when Sergeant may merge, never when a human merges", () => {
  const runs = [worker("run_w", "succeeded", 3), reviewer("run_r", "approve", [], 0.5)];
  expect(recommend(facts(runs))).toEqual({ call: "extend", rule: "2", reason: expect.stringContaining("merge Sergeant may do"), estimate: "a merge, about 2 min and $1" });
  // mergePolicy human: the merge is a human's, so it is no obvious extend (rule 0 parks it once handed off).
  expect(recommend(facts(runs, { policy: "human" }))).toMatchObject({ rule: "3", call: "ask" });
  // Red CI is not a merge left.
  expect(recommend(facts(runs, { pr: { checks: { sha: head, required: [{ name: "ci", state: "failed" }] } } }))).toMatchObject({ rule: "3" });
});

test("rule 1 wins over an obvious extend: repeated fix cycles, a recurring finding, the cost cap", () => {
  const cycles = [worker("run_w1"), reviewer("run_r1", "changes_requested", ["a.ts:1"]), worker("run_w2"), reviewer("run_r2", "changes_requested", ["b.ts:2"]), worker("run_w3"), reviewer("run_r3", "changes_requested", ["c.ts:3"]), worker("run_w4"), reviewer("run_r4", "approve")];
  expect(recommend(facts(cycles))).toMatchObject({ call: "stop", rule: "1", reason: "3 fix cycles in this window" });

  const recurring = [worker("run_w1"), reviewer("run_r1", "changes_requested", ["a.ts:1"]), worker("run_w2"), reviewer("run_r2", "changes_requested", ["b.ts:2"]), worker("run_w3"), reviewer("run_r3", "changes_requested", ["a.ts:1"])];
  expect(recommend(facts(recurring))).toMatchObject({ call: "stop", rule: "1", reason: expect.stringContaining("(a.ts:1) came back after two fix cycles") });

  // At 80% of the cap, an approved mergeable PR is still an ask, not an extend; with no PR ready, a stop.
  expect(recommend(facts([worker("run_w"), reviewer("run_r", "approve")], { spentUsd: 20 }))).toMatchObject({ rule: "3" });
  const capped = facts([worker("run_w", "canceled")], { spentUsd: 20, pr: { draft: true } });
  expect(recommend(capped)).toMatchObject({ call: "stop", rule: "1", reason: expect.stringContaining("80%"), estimate: expect.stringContaining("mark the PR ready for review") });
  expect(stopCase(capped).standing.at(-1)).toContain("Left: mark the PR ready for review, then a review");

  // A worker steered twice that never reported.
  expect(recommend(facts([worker("run_w", "canceled")], { steers: { run_w: 2 } }))).toMatchObject({ call: "stop", rule: "1", reason: expect.stringContaining("steered 2 times without producing a report") });
});

test("a first fix cycle cut off by the deadline recommends extend under rule 3, with its cost from this task's runs", () => {
  const runs = [worker("run_w1", "succeeded", 4), reviewer("run_r1", "changes_requested", ["a.ts:1", "b.ts:2"], 1), worker("run_w2", "canceled")];
  const w = facts(runs);
  expect(recommend(w)).toEqual({ call: "extend", rule: "3", reason: "a first fix cycle after a reviewer's change request", estimate: "one fix, a re-review and merge, about 29 min and $5" });

  const question = budgetQuestion(w.situation, "wall time exhausted", stopCase(w)).question;
  expect(question).toContain("**What happened in this window:** Worker finished (trevorallred/canary#7); reviewer requested changes (2 blocking); fix worker was canceled at the deadline. 4 Sergeant turns, 1 fix cycle.");
  expect(question).toContain("Left: fix 2 blocking findings, then a re-review, then Sergeant's merge.");
  expect(question).toContain("**Sergeant recommends extend** (rubric rule 3: a first fix cycle after a reviewer's change request). Remaining: one fix, a re-review and merge, about 29 min and $5.");
  // TECH-6225: the PR is one Markdown link; a bare URL before its colon rendered as the link twice in Linear.
  expect(question).toContain(`- [${pr.repo}#7](${pr.url}): CI `);
  expect(question.split(pr.url).length - 1).toBe(1);
});

test("a role with earlier runs that reported a cost is estimated, even when another role has none to go by", () => {
  // TECH-6225: the worker's earlier runs (one from an earlier window, so only in the situation) price
  // the fix; only the reviewer, whose run reported no cost, is left unknown, and named.
  const runs = [worker("run_w1", "succeeded", 4), reviewer("run_r1", "changes_requested", ["a.ts:1"]), worker("run_w2", "canceled")];
  const w = facts(runs);
  w.situation = { ...w.situation, runs: [worker("run_w0", "succeeded", 6), ...runs] };
  const question = budgetQuestion(w.situation, "active time exhausted", stopCase(w)).question;
  expect(question).toContain("Remaining: one fix, a re-review and merge, about 29 min and $5 plus the reviewer's cost, not yet known (no reviewer run of this task has reported a cost yet).");
});

test("a long stop case keeps the recommendation, estimate and question tail", () => {
  const w = facts([worker("run_w", "succeeded", 3)]);
  const stop = stopCase(w);
  stop.happened = "A".repeat(5_000);
  stop.standing = ["B".repeat(5_000)];
  stop.recommendation.reason = `the current head needs a first review ${"C".repeat(5_000)}`;
  const action = budgetQuestion(w.situation, "wall time exhausted", stop);
  const question = action.question;
  expect(question.length).toBeLessThanOrEqual(4_000);
  expect(question).toContain("**Sergeant recommends extend** (rubric rule 2: the current head needs a first review");
  expect(question).toContain("Remaining: a first review, about 5 min and a cost not yet known");
  expect(question).toMatch(/Continue\?$/);
  expect(action.options).toEqual([expect.stringMatching(/^Extend:/), expect.stringMatching(/^Accept as-is:/)]);
});

test("a finished worker's PR awaiting its first review is rule 2; a worker that cannot get an input is rule 1's stop-or-answer", () => {
  expect(recommend(facts([worker("run_w", "succeeded", 3)]))).toMatchObject({ call: "extend", rule: "2", estimate: "a first review, about 5 min and a cost not yet known (no reviewer run of this task has reported a cost yet)" });

  const blocked = worker("run_w");
  if (blocked.role === "worker" && blocked.report) blocked.report = { ...blocked.report, outcome: "blocked", unreadableInputs: ["https://example.com/spec.pdf"] };
  const r = recommend(facts([blocked]));
  expect(r).toMatchObject({ call: "stop", rule: "1", reason: "the work cannot finish without inputs it could not read: https://example.com/spec.pdf" });
});

test("first review is classified only from worker and review records for the current head", () => {
  const staleHead = "b".repeat(40);
  const staleWorker = worker("run_w", "succeeded", 3);
  if (staleWorker.role === "worker" && staleWorker.report) staleWorker.report.pullRequests[0]!.headSha = staleHead;
  expect(recommend(facts([staleWorker]))).toMatchObject({ rule: "3", call: "ask" });

  const staleReview = reviewer("run_r", "approve");
  if (staleReview.role === "reviewer" && staleReview.report) staleReview.report.reviewed[0]!.headSha = staleHead;
  expect(recommend(facts([worker("run_w", "succeeded", 3), staleReview]))).toMatchObject({ rule: "2", call: "extend" });
});

test("rule 3's undecided fallback still estimates every remaining step", () => {
  const r = recommend(facts([worker("run_w", "canceled")]));
  expect(r).toEqual({
    call: "ask",
    rule: "3",
    reason: "no rubric rule settles it; the case above is for you to judge",
    estimate: "a review, then Sergeant's merge, about 7 min and a cost not yet known (no reviewer run of this task has reported a cost yet)",
  });
});
