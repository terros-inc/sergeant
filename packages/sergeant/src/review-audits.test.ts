import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { type GitHubPort, type ReadinessPullRequestFacts, ReviewReport, type RunRecord } from "@terros/sergeant-contracts";
import { call, fakes } from "./api-fixtures.ts";
import { reviewFacts } from "./review-quality.ts";
import { reviewAudits } from "./review-audits.ts";
import { startService, type Service } from "./service.ts";

// TECH-6619: audit yield and FAIL rate are evidence for widening auto-merge, so each audit must count
// once (its last line), unknown Found must stay out of the yield's denominator, the split must follow
// the classifier on the audited head only, and a Found: YES must carry every finding, not only must-fix.

let dir = "";
let service: Service | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await rm(dir, { recursive: true, force: true });
});

const app = "example-org/example-app";
const other = "example-org/other-app";
const [h1, h2, m] = ["a".repeat(40), "b".repeat(40), "d".repeat(40)];
const revision = "c".repeat(64);
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const state = (extra: object) => JSON.stringify({ issueId: "i", startedAt: ago(300), turns: 1, runIds: [], recentTurns: [], ...extra });
const refused = (number: number, headSha: string, readinessCommentId: number) => ({
  repo: app, number, url: `https://github.com/${app}/pull/${number}`, headSha, conversationRevision: revision, reason: "the repository's merge policy is human", at: ago(2), readinessCommentId,
});

type Head = { repo: string; number: number; headSha: string };
function audit(runId: string, head: Head, report: object | null, extra: { reviewed?: Head[] } = {}): RunRecord {
  const parsed = report && ReviewReport.parse({ reviewed: extra.reviewed ?? [head], summary: "", ...report });
  return { runId, role: "reviewer", status: parsed ? "succeeded" : "failed", provider: "p", model: "m", report: parsed } as RunRecord;
}
const line = (run: RunRecord, head: Head, at = ago(1)) => {
  if (run.role !== "reviewer") throw new Error("reviewer only");
  return `${JSON.stringify({ ...reviewFacts(run, { trigger: "audit", issue: "UNF-1", runs: [run], merged: { ...head, mergedSha: m } }), at })}\n`;
};

/** GitHub now for each declaration comment: merged at its declared head by `mergedBy`. */
function github(outcomes: Record<number, { headSha: string; mergedBy: { login: string; type: "User" | "Bot" } }>) {
  const asked: number[] = [];
  const port: Pick<GitHubPort, "readReadiness"> = {
    readReadiness: async ({ commentId }) => {
      asked.push(commentId);
      const o = outcomes[commentId];
      if (!o) throw new Error(`unexpected read of comment ${commentId}`);
      const at = ago(2);
      const declaration = { id: String(commentId), body: `READY TO MERGE | SHA: ${o.headSha}\n\nReason: Reviewed and green on this head`, author: { login: "sergeant[bot]", type: "Bot" as const }, performedViaGitHubAppId: 42, sergeantAppId: 42, createdAt: at };
      const facts: ReadinessPullRequestFacts = { state: "merged", headSha: o.headSha, mergedAt: ago(1.5), mergedBy: o.mergedBy, closedAt: ago(1.5), reviews: [], mergedViaMergeQueue: false, addedToMergeQueueActor: null };
      return { declaration, facts };
    },
  };
  return { port, asked };
}

test("yield over known Found, FAIL over completed, each audit once; split by the audited head's declaration; Found: YES with every finding", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-audits-"));
  const heads = { p1: { repo: app, number: 1, headSha: h1 }, p2: { repo: app, number: 2, headSha: h2 }, p3: { repo: app, number: 3, headSha: h1 }, p4: { repo: other, number: 4, headSha: h1 }, p5: { repo: app, number: 5, headSha: h2 }, p6: { repo: app, number: 6, headSha: h1 } };
  const findings = [
    { id: "f1", severity: "blocking", category: "acceptance", description: "The export skips archived rows the issue requires.", location: "src/export.ts:12" },
    { id: "f2", severity: "nit", description: "Rename `tmp`." },
  ];
  const runs = [
    audit("run_audit-1", heads.p1, { verdict: "changes_requested", findings, summary: "One requirement is unmet." }),
    audit("run_audit-2", heads.p2, { verdict: "approve", reviewed: [{ ...heads.p2, found: false }] }),
    // Two PRs, no per-PR found: unknown, so in no yield denominator.
    audit("run_audit-3", heads.p3, { verdict: "approve", findings: [{ id: "f1", severity: "nit", description: "x" }] }, { reviewed: [heads.p3, heads.p1] }),
    audit("run_audit-4", heads.p4, { verdict: "needs_human", findings: [{ id: "f1", severity: "non_blocking", description: "A retry never backs off." }] }),
    audit("run_audit-5", heads.p5, null),
    audit("run_audit-6", heads.p6, { verdict: "approve", reviewed: [{ ...heads.p6, found: false }] }),
  ];
  const required = { ...JSON.parse(line(runs[1] as RunRecord, heads.p2)), trigger: "required", runId: "run_required-1" };
  await writeFile(
    join(dir, "reviews.jsonl"),
    // run_audit-1 has two lines (a later fact rewrote it): it counts once.
    [line(runs[0] as RunRecord, heads.p1), line(runs[0] as RunRecord, heads.p1), line(runs[1] as RunRecord, heads.p2), line(runs[2] as RunRecord, heads.p3), line(runs[3] as RunRecord, heads.p4, ago(200)), line(runs[4] as RunRecord, heads.p5), line(runs[5] as RunRecord, heads.p6), `${JSON.stringify(required)}\n`, '{"torn": '].join(""),
  );
  const task = join(dir, "tasks", "UNF-1");
  await mkdir(task, { recursive: true });
  // 201: a human merged PR 1 at its declared head (AGREED). 202: Sergeant merged PR 2 itself. 203 is on
  // PR 3 but not the audited head, so it is never read and PR 3 stays "other". Another bot merged
  // PR 6, so its declaration does not make that merge Sergeant's.
  await writeFile(join(task, "state.json"), state({ refusedMerges: [refused(1, h1, 201), refused(3, h2, 203), refused(6, h1, 206)], merged: { repo: app, number: 2, headSha: h2, mergedSha: m, readinessCommentId: 202, at: ago(2) } }));
  const gh = github({ 201: { headSha: h1, mergedBy: { login: "example-owner", type: "User" } }, 202: { headSha: h2, mergedBy: { login: "sergeant[bot]", type: "Bot" } }, 206: { headSha: h1, mergedBy: { login: "another-app[bot]", type: "Bot" } } });

  const f = fakes(runs);
  service = await startService({ enrolledRepositories: [app], stateDir: dir, intakeSeconds: 3600, pollSeconds: 3600, port: 0, log: () => {}, trustLoopback: true }, { ...f.deps, github: { ...f.deps.github, ...gh.port } });
  const port = service.port ?? 0;

  const all = await call(port, "GET", "/v1/review-audits");
  expect(all.status).toBe(200);
  expect(all.json).toMatchObject({ completed: 5, found: 2, foundKnown: 4, foundUnknown: 1, fail: 2, incomplete: 1 });
  expect(all.json.bySergeant).toEqual({
    agreed: { completed: 1, found: 1, foundKnown: 1, foundUnknown: 0, fail: 1 },
    sergeant_merged: { completed: 1, found: 0, foundKnown: 1, foundUnknown: 0, fail: 0 },
    other: { completed: 3, found: 1, foundKnown: 2, foundUnknown: 1, fail: 1 },
  });
  expect(all.json.byRepo).toEqual([
    { repo: app, completed: 4, found: 1, foundKnown: 3, foundUnknown: 1, fail: 1 },
    { repo: other, completed: 1, found: 1, foundKnown: 1, foundUnknown: 0, fail: 1 },
  ]);
  expect(gh.asked.toSorted()).toEqual([201, 202, 206]);
  const yes = all.json.audits.filter((a: { found?: boolean }) => a.found === true);
  expect(yes.map((a: { runId: string }) => a.runId)).toEqual(["run_audit-4", "run_audit-1"]);
  expect(yes[1]).toMatchObject({ url: `https://github.com/${app}/pull/1`, headSha: h1, verdict: "changes_requested", group: "agreed", summary: "One requirement is unmet." });
  // Every finding, the nit and the acceptance one too, from the run's record.
  expect(yes[1].findings).toEqual(findings);
  expect(all.json.audits.find((a: { runId: string }) => a.runId === "run_audit-2").findings).toBeUndefined();

  gh.asked.length = 0;
  const narrowed = await call(port, "GET", `/v1/review-audits?since=90d&repo=${app}`);
  expect(narrowed.json).toMatchObject({ repo: app, completed: 4, found: 1, foundKnown: 3, foundUnknown: 1, fail: 1, incomplete: 1 });
  expect(narrowed.json.audits.map((a: { runId: string }) => a.runId).toSorted()).toEqual(["run_audit-1", "run_audit-2", "run_audit-3", "run_audit-5", "run_audit-6"]);

  expect(await call(port, "GET", "/v1/review-audits?since=a-month")).toMatchObject({ status: 400, json: { error: { code: "bad_request" } } });
}, 30_000);

test.each([
  ["a non-reviewer record", { runId: "run_bad", role: "worker", status: "succeeded", provider: "p", model: "m", report: null } as RunRecord],
  ["a reviewer record without a report", { runId: "run_bad", role: "reviewer", status: "failed", provider: "p", model: "m", report: null } as RunRecord],
])("Found: YES fails when its run has %s", async (_case, returned) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-audits-"));
  const head = { repo: app, number: 1, headSha: h1 };
  const source = audit("run_bad", head, { verdict: "changes_requested", findings: [{ id: "f1", severity: "blocking", description: "Broken." }] });
  await writeFile(join(dir, "reviews.jsonl"), line(source, head));

  await expect(reviewAudits(dir, { github: { readReadiness: async () => Promise.reject(new Error("unused")) }, runner: { status: async () => returned } }, {})).rejects.toThrow(
    "audit run run_bad for example-org/example-app#1 has no readable reviewer report",
  );
});
