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

// TECH-6553: a raise its author got wrong still meant "more sensitive than the map", so it never
// silently drops to the map's tier.
test("a worker's malformed tier raise reads as T3, never as no raise", () => {
  const raised = (raiseTier: unknown) => {
    const parsed = parseReport(report({ ...worker(undefined), pullRequests: [{ ...pr, review: undefined, raiseTier }] }), WorkerReport);
    return parsed.ok ? parsed.report.pullRequests[0]?.raiseTier : "unparsed";
  };
  expect(raised({ tier: "T4", reason: "edits the ruleset sync script" })).toEqual({ tier: "T4", reason: "edits the ruleset sync script" });
  expect(raised({ tier: "high", reason: "x" })).toMatchObject({ tier: "T3" });
  expect(raised({ tier: "T4" })).toEqual({ tier: "T4", reason: "no reason given" });
  expect(raised(undefined)).toBeUndefined();
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
    reviewed: [
      { repo: "o/r", number: 7, headSha: "a".repeat(40), raiseTier: { tier: "T3", reason: "edits an IAM trust policy" } },
      { repo: "o/r", number: 8, headSha: "a".repeat(40), raiseTier: null },
    ],
    verdict: "changes_requested",
    findings: [
      { id: "f1", severity: "blocking", category: "acceptance", description: "d", location: "x.ts:1" },
      { id: "f2", severity: "nit", category: null, description: "n", location: null },
    ],
    unreadableInputs: [{ input: "https://github.com/o/private-repo", reason: "not enrolled with Sergeant, so GH_READ_TOKEN cannot read it" }],
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
  expect(parsed.report.unreadableInputs).toEqual(structured.unreadableInputs);
  expect(parsed.report.reviewed.map((r) => r.raiseTier)).toEqual([{ tier: "T3", reason: "edits an IAM trust policy" }, undefined]);

  const props = REVIEW_REPORT_SCHEMA.properties;
  expect(props.reviewed.items.properties.raiseTier.anyOf[0].properties.tier.enum).toEqual(["T0", "T1", "T2", "T3", "T4"]);
  expect(props.reportVersion.enum).toEqual(["s2-review-report/1"]);
  expect(props.verdict.enum).toEqual(["approve", "changes_requested", "needs_human"]);
  expect(props.findings.items.properties.severity.enum).toEqual(["blocking", "non_blocking", "nit"]);
  expect(props.dependencies.items.properties.relation.enum).toEqual(["blocked_by", "blocks"]);
});

// TECH-6356: each unreadable input carries why it could not be read, so one without a reason, or a
// blank one, is malformed rather than read as an input with no explanation. Reports and run records
// written before that hold bare strings; they must still parse, and so must the record they parse to
// once it is stored again, or a stored record stops reading after a deploy.
test("an unreadable input needs a reason that is not blank, and a bare string still reads", () => {
  const base = { reportVersion: "s2-review-report/1", reviewed: [{ repo: "o/r", number: 7, headSha: "a".repeat(40) }], verdict: "needs_human", findings: [], dependencies: [], summary: "s" };
  const read = (unreadableInputs: unknown[]) => {
    const parsed = parseJsonReport(JSON.stringify({ ...base, unreadableInputs }), ReviewReport);
    return parsed.ok ? parsed.report.unreadableInputs : undefined;
  };
  const legacy = read(["https://example.com/spec.pdf", { input: "o/other", reason: "not found" }]);
  expect(legacy).toEqual([
    { input: "https://example.com/spec.pdf", reason: expect.stringMatching(/\S/) },
    { input: "o/other", reason: "not found" },
  ]);
  expect(read(legacy ?? [])).toEqual(legacy);

  const workerWith = (entry: unknown) => parseReport(report({ ...worker({ required: true, reason: "" }), unreadableInputs: [entry] }), WorkerReport).ok;
  expect(workerWith({ input: "o/other", reason: "not found" })).toBe(true);
  for (const entry of [{ input: "o/other" }, { input: "o/other", reason: "" }, { input: "o/other", reason: " \t\n" }]) {
    expect(read([entry]), JSON.stringify(entry)).toBeUndefined();
    expect(workerWith(entry), JSON.stringify(entry)).toBe(false);
  }

  // The Codex reviewer schema says the same with a pattern (strict mode has no minLength).
  const reasonPattern = new RegExp(REVIEW_REPORT_SCHEMA.properties.unreadableInputs.items.properties.reason.pattern);
  for (const reason of ["", " ", "\t\n"]) expect(reasonPattern.test(reason), JSON.stringify(reason)).toBe(false);
  expect(reasonPattern.test("not found")).toBe(true);
});

// TECH-5392: every value the schema admits must parse, so each ReviewReport value constraint has a schema
// keyword strict structured output supports, and the two agree at its boundary.
test("the Codex reviewer schema admits only values ReviewReport accepts", () => {
  const head = { repo: "o/r", number: 7, headSha: "a".repeat(40) };
  const base = { reportVersion: "s2-review-report/1", reviewed: [head], verdict: "approve", findings: [], unreadableInputs: [], dependencies: [], summary: "s" };
  const parses = (r: object) => parseJsonReport(JSON.stringify({ ...base, ...r }), ReviewReport).ok;
  const reviewed = REVIEW_REPORT_SCHEMA.properties.reviewed;
  const pr = reviewed.items.properties;

  // A non-empty reviewed list.
  expect(reviewed.minItems).toBe(1);
  expect(parses({ reviewed: [] })).toBe(false);

  // A positive PR number.
  expect(pr.number).toEqual({ type: "integer", minimum: 1 });
  for (const number of [0, -1]) expect(parses({ reviewed: [{ ...head, number }] })).toBe(false);
  expect(parses({ reviewed: [{ ...head, number: 1 }] })).toBe(true);

  // The repo slug: the schema's pattern and the contract agree on each spelling.
  const repoPattern = new RegExp(pr.repo.pattern);
  for (const repo of ["o/r", "my-org/my.repo_2", "", "o", "o/r/x", "o r/x", "/r", "o/"]) {
    expect(repoPattern.test(repo), repo).toBe(parses({ reviewed: [{ ...head, repo }] }));
  }

  // A finding id that is not blank (strict mode has no minLength, so a pattern says it).
  const idPattern = new RegExp(REVIEW_REPORT_SCHEMA.properties.findings.items.properties.id.pattern);
  for (const id of ["", " ", "\t"]) expect(idPattern.test(id), JSON.stringify(id)).toBe(false);
  expect(idPattern.test("f1")).toBe(true);
  const finding = { id: "f1", severity: "nit", category: null, description: "d", location: null };
  expect(parses({ findings: [finding] })).toBe(true);
});
