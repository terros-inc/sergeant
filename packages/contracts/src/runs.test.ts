import { expect, test } from "vitest";
import { parseReport, ReviewReport, WorkerReport } from "./runs.ts";

// Worker and reviewer reports are untrusted external text. A lenient parse here could turn a
// malformed or unjustified "skip review" into a merge standing (L1), so these boundaries are tested.

const report = (json: unknown) => `# Report\n\nProse first.\n\n\`\`\`sergeant-report\n${JSON.stringify(json)}\n\`\`\`\n`;
const pr = { repo: "trevorallred/canary", number: 7, url: "https://github.com/trevorallred/canary/pull/7", headSha: "a".repeat(40), closesIssue: true };
const worker = (review: unknown) => ({ reportVersion: "s2-worker-report/1", outcome: "completed", summary: "s", pullRequests: [{ ...pr, review }] });

test("a review skip without a reason, or an unparseable recommendation, fails toward review", () => {
  for (const review of [{ required: false }, { required: false, reason: "  " }, { required: "no" }, undefined]) {
    const parsed = parseReport(report(worker(review)), WorkerReport);
    expect(parsed.ok && parsed.report.pullRequests[0]?.review.required).toBe(true);
  }
  const justified = parseReport(report(worker({ required: false, reason: "typo in a comment" })), WorkerReport);
  expect(justified.ok && justified.report.pullRequests[0]?.review.required).toBe(false);
});

test("addressed findings are read by review run and finding id, and a malformed list reads as absent", () => {
  const answered = [{ reviewRunId: "run_r1", findingId: "f1", resolution: "fixed", reason: "guarded" }];
  const parsed = parseReport(report({ ...worker(undefined), addressedFindings: answered }), WorkerReport);
  expect(parsed.ok && parsed.report.addressedFindings).toEqual(answered);
  const malformed = parseReport(report({ ...worker(undefined), addressedFindings: [{ findingId: "f1", resolution: "maybe" }] }), WorkerReport);
  expect(malformed.ok && malformed.report.addressedFindings).toBeUndefined();
});

test("feedback is kept on the record for a later retro, and a malformed list never fails the report", () => {
  const parsed = parseReport(report({ ...worker(undefined), feedback: ["CI took 20 minutes to start"] }), WorkerReport);
  expect(parsed.ok && parsed.report.feedback).toEqual(["CI took 20 minutes to start"]);
  const malformed = parseReport(report({ ...worker(undefined), feedback: "one string" }), WorkerReport);
  expect(malformed.ok && malformed.report.feedback).toBeUndefined();
});

test("a PR without closesIssue rejects the report rather than reading it as Part of", () => {
  const { closesIssue: _, ...unsaid } = pr;
  const ok = worker({ required: true, reason: "" });
  expect(parseReport(report({ ...ok, pullRequests: [{ ...unsaid, review: { required: true, reason: "" } }] }), WorkerReport).ok).toBe(false);
  const closing = parseReport(report(ok), WorkerReport);
  expect(closing.ok && closing.report.pullRequests[0]?.closesIssue).toBe(true);
});

test("rejects a report without exactly one well-formed block", () => {
  const ok = worker({ required: true, reason: "" });
  expect(parseReport("no block at all", WorkerReport).ok).toBe(false);
  expect(parseReport(report(ok) + report(ok), WorkerReport).ok).toBe(false);
  expect(parseReport("```sergeant-report\n{ not json\n```\n", WorkerReport).ok).toBe(false);
  expect(parseReport(report({ ...ok, reportVersion: "s2-worker-report/2" }), WorkerReport).ok).toBe(false);
});

test("rejects a review report that does not say which head it reviewed or what it concluded", () => {
  const review = { reportVersion: "s2-review-report/1", reviewed: [pr], verdict: "approve", summary: "s" };
  expect(parseReport(report(review), ReviewReport).ok).toBe(true);
  expect(parseReport(report({ ...review, reviewed: [] }), ReviewReport).ok).toBe(false);
  expect(parseReport(report({ ...review, verdict: "lgtm" }), ReviewReport).ok).toBe(false);
});

test("marks acceptance findings explicitly while ordinary defects omit the category", () => {
  const base = { reportVersion: "s2-review-report/1", reviewed: [pr], verdict: "changes_requested", summary: "s" };
  const findings = [
    { id: "f1", severity: "blocking", category: "acceptance", description: "A required output is missing." },
    { id: "f2", severity: "blocking", description: "The retry loop can overflow." },
  ];
  const parsed = parseReport(report({ ...base, findings }), ReviewReport);
  expect(parsed.ok && parsed.report.findings).toEqual(findings);
});
