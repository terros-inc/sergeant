import { expect, test } from "vitest";
import { ReviewReport, RunRecord, WorkerReport, type RunSpec } from "@terros/sergeant-contracts";
import { workerBrief } from "./brief.ts";
import { EARLIER_RUNS_BOUND } from "./brief-worker.ts";
import { spec } from "./runner-fixtures.ts";

// TECH-6462: every earlier run's report used to be in the brief whole, so a task with many runs
// outgrew a Fargate run's 64 KiB secret and could start no worker. The newest reports stay whole.

const base = { status: "succeeded", provider: "anthropic", model: "sonnet" } as const;
const worker = (n: number) =>
  RunRecord.parse({ ...base, runId: `run_w${n}`, role: "worker", report: WorkerReport.parse({ reportVersion: "s2-worker-report/1", outcome: "completed", summary: `Pushed fix ${n}. ${"Details. ".repeat(250)}` }) });
const review = (n: number) =>
  RunRecord.parse({
    ...base,
    runId: `run_r${n}`,
    role: "reviewer",
    report: ReviewReport.parse({ reviewed: [{ repo: "o/canary", number: 1, headSha: "a".repeat(40) }], verdict: "changes_requested", summary: "Not yet.", findings: [{ id: `f${n}`, severity: "blocking", description: `Finding of review ${n}.` }] }),
  });
const brief = (runs: RunRecord[]) => workerBrief({ ...(spec as Extract<RunSpec, { role: "worker" }>), context: { pullRequests: [], runs } }, []);

test("a task with many runs keeps the newest reports whole and only a heading line for each older one", () => {
  const runs = Array.from({ length: 40 }, (_, i) => (i % 2 ? review(i) : worker(i)));
  const text = brief(runs);
  const earlier = text.slice(text.indexOf("### Earlier runs"), text.indexOf("\n## Environment"));

  expect(earlier.length).toBeLessThan(EARLIER_RUNS_BOUND + 40 * 100);
  // The last review's blocking finding and the last worker's report reach the successor whole.
  expect(earlier).toContain("- [blocking] f39: Finding of review 39.");
  expect(earlier).toContain(`#### run_w38 (worker, succeeded): outcome completed\n\nPushed fix 38.`);
  // Every older run is still named, in order, with its outcome or verdict.
  expect(earlier).toMatch(/left out[^\n]*\n\n- run_w0 \(worker, succeeded\): outcome completed\n- run_r1 \(reviewer, succeeded\): verdict changes_requested\n/);
  expect(earlier).not.toContain("Pushed fix 0.");
});

test("a few runs render whole, as before", () => {
  const text = brief([worker(0), review(1)]);
  expect(text).not.toContain("left out");
  expect(text).toContain("Pushed fix 0.");
  expect(text).toContain("- [blocking] f1: Finding of review 1.");
});

test("the newest report stays whole even when it alone is over the bound", () => {
  const big = RunRecord.parse({ ...worker(1), report: { ...worker(1).report, summary: "x".repeat(EARLIER_RUNS_BOUND + 1) } });
  const text = brief([worker(0), big]);
  expect(text).toContain("x".repeat(EARLIER_RUNS_BOUND + 1));
  expect(text).toContain("- run_w0 (worker, succeeded): outcome completed");
});
