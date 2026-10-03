import { expect, test } from "vitest";
import { issueRevision, type PullRequestFacts, type RunRecord } from "@terros/sergeant-contracts";
import { outcomeComment } from "./outcome.ts";

// TECH-5034: the issue was rewritten to require a bundled reference file while the task waited, a human
// merged the work done against the old text, and the outcome comment's known gaps never said so.

const head = "a".repeat(40);
const pr: PullRequestFacts = {
  repo: "o/r",
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "merged",
  draft: false,
  author: "sergeant-worker[bot]",
  headSha: head,
  mergedSha: "c".repeat(40),
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: null,
  checks: { sha: head, required: [{ name: "ci", state: "passed" }] },
  humanFeedback: [],
};
const before = { title: "Add the skill", description: "Link the standard." };
const now = { title: "Add the skill", description: "Bundle references/documentation-standard.md." };
const worker = (issue: typeof before): RunRecord => ({
  runId: "run_w",
  role: "worker",
  status: "succeeded",
  provider: "p",
  model: "m",
  issueRevision: issueRevision(issue),
  report: {
    reportVersion: "s2-worker-report/1",
    outcome: "completed",
    summary: "",
    pullRequests: [{ repo: "o/r", number: 7, headSha: head, url: pr.url, closesIssue: true, review: { required: true, reason: "" } }],
    knownGaps: ["the doc link needs access"],
    followups: [],
  },
});
const review = (issue: typeof before, blocking: string[]): RunRecord => ({
  runId: "run_r",
  role: "reviewer",
  status: "succeeded",
  provider: "p",
  model: "m",
  issueRevision: issueRevision(issue),
  report: {
    reportVersion: "s2-review-report/1",
    reviewed: [{ repo: "o/r", number: 7, headSha: head }],
    verdict: blocking.length > 0 ? "changes_requested" : "approve",
    findings: blocking.map((description, i) => ({ id: `f${i}`, severity: "blocking" as const, description })),
    summary: "",
  },
});
const gaps = (runs: RunRecord[]) => outcomeComment(pr, pr.mergedSha ?? "", runs, [], now).split("\n").find((l) => l.startsWith("- Known gaps"));

test("a human merge of work checked only against an earlier description lists that as a known gap", () => {
  expect(gaps([worker(before), review(before, [])])).toBe(
    "- Known gaps: the doc link needs access; this head was checked only against an earlier title or description of the issue, not its current acceptance criteria.",
  );
  expect(gaps([worker(before), review(now, [])])).toBe("- Known gaps: the doc link needs access.");
});

test("a human merge over a current review's unmet requirements lists each as a known gap", () => {
  expect(gaps([worker(now), review(now, ["references/documentation-standard.md is not bundled\nDetails follow."])])).toBe(
    "- Known gaps: the doc link needs access; unmet per review: references/documentation-standard.md is not bundled.",
  );
});
