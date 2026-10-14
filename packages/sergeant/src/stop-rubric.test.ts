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
  expect(recommend(facts([worker("run_w", "canceled")], { spentUsd: 20, pr: { draft: true } }))).toMatchObject({ call: "stop", rule: "1", reason: expect.stringContaining("80%") });

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
});

test("a finished worker's PR awaiting its first review is rule 2; a worker that cannot get an input is rule 1's stop-or-answer", () => {
  expect(recommend(facts([worker("run_w", "succeeded", 3)]))).toMatchObject({ call: "extend", rule: "2", estimate: "a first review, about 5 min and a cost not yet known (no finished run of that role to go by)" });

  const blocked = worker("run_w");
  if (blocked.role === "worker" && blocked.report) blocked.report = { ...blocked.report, outcome: "blocked", unreadableInputs: ["https://example.com/spec.pdf"] };
  const r = recommend(facts([blocked]));
  expect(r).toMatchObject({ call: "stop", rule: "1", reason: "the work cannot finish without inputs it could not read: https://example.com/spec.pdf" });
});
