import { expect, test } from "vitest";
import { parseJsonReport, parseReport, REVIEW_REPORT_SCHEMA, ReviewReport, WorkerReport } from "./runs.ts";

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

test("TECH-5259: a review report's unambiguous slips are read, never toward a merge", () => {
  const review = { reviewed: [{ ...pr, number: "7" }], verdict: " Changes requested", summary: "s" };
  const findings = [
    { severity: "Non-Blocking", description: "No jitter.", location: 12 },
    { id: 2, severity: "major", category: "acceptance: the README is not updated", description: "README." },
    { id: "f9", severity: "nit", category: "style", description: "Naming." },
  ];
  const parsed = parseReport(report({ ...review, findings }), ReviewReport);
  expect(parsed.ok && parsed.report).toMatchObject({
    reportVersion: "s2-review-report/1",
    reviewed: [{ number: 7 }],
    verdict: "changes_requested",
    findings: [
      { id: "f1", severity: "non_blocking", description: "No jitter." },
      // An unknown severity is blocking.
      { id: "2", severity: "blocking", category: "acceptance" },
      { id: "f9", severity: "nit", category: undefined },
    ],
  });
  // A positional id never repeats an explicit one, which addressedFindings would then name ambiguously.
  const clash = parseReport(report({ ...review, findings: [{ severity: "nit", description: "a" }, { id: "f1", severity: "nit", description: "b" }] }), ReviewReport);
  expect(clash.ok && clash.report.findings.map((f) => f.id)).toEqual(["f2", "f1"]);
  const approved = parseReport(report({ ...review, verdict: "APPROVED", summary: undefined }), ReviewReport);
  expect(approved.ok && [approved.report.verdict, approved.report.summary]).toEqual(["approve", ""]);
  // What a merge rests on is still exact: an unknown verdict, or no reviewed head, rejects the report.
  expect(parseReport(report({ ...review, verdict: "looks good" }), ReviewReport).ok).toBe(false);
  expect(parseReport(report({ ...review, reviewed: undefined }), ReviewReport).ok).toBe(false);
});

// TECH-5392: a Codex reviewer is launched against REVIEW_REPORT_SCHEMA, so its structured result is a
// valid s2-review-report/1 by construction. The schema and the parser must stay in step: the canonical
// shape it constrains Codex to (every field present, optionals as null) must parse, and its enums must
// be the contract's own canonical values so no spelling can slip through.
test("the Codex reviewer schema is in step with ReviewReport", () => {
  const structured = {
    reportVersion: "s2-review-report/1",
    reviewed: [{ repo: "o/r", number: 7, headSha: "a".repeat(40) }],
    verdict: "changes_requested",
    findings: [
      { id: "f1", severity: "blocking", category: "acceptance", description: "d", location: "x.ts:1" },
      { id: "f2", severity: "nit", category: null, description: "n", location: null },
    ],
    unreadableInputs: [],
    dependencies: [],
    summary: "s",
  };
  const parsed = parseJsonReport(JSON.stringify(structured), ReviewReport);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.report.verdict).toBe("changes_requested");
  expect(parsed.report.findings[0]).toMatchObject({ id: "f1", severity: "blocking", category: "acceptance", location: "x.ts:1" });
  // A null optional reads as absent, never a value.
  expect(parsed.report.findings[1]?.category).toBeUndefined();
  expect(parsed.report.findings[1]?.location).toBeUndefined();

  const props = REVIEW_REPORT_SCHEMA.properties;
  expect(props.reportVersion.enum).toEqual(["s2-review-report/1"]);
  expect(props.verdict.enum).toEqual(["approve", "changes_requested", "needs_human"]);
  expect(props.findings.items.properties.severity.enum).toEqual(["blocking", "non_blocking", "nit"]);
  expect(props.dependencies.items.properties.relation.enum).toEqual(["blocked_by", "blocks"]);
});
