import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { Conversation, PullRequestFacts, RunRecord, RunSpec } from "@terros/sergeant-contracts";
import { mergedAuditPass, type MergedAuditDeps, type MergedAuditOptions } from "./merged-audits.ts";
import { auditDrawn, auditRunId } from "./review-quality.ts";

// TECH-6617: the daily merged-PR audit. What it must never do: start audits in a repository nobody turned
// on, or with nobody to pay for them; start a second audit of a PR a restart, a re-scan of the overlapping
// 72-hour window, or the task's own audit already started; or spend past its daily cap.

const repo = "o/r";
const now = new Date("2026-10-22T06:00:00.000Z");
const sha = (n: number) => n.toString(16).padStart(40, "0");
const merged = Array.from({ length: 6 }, (_, i) => ({ number: i + 1, title: i === 0 ? "UNF-9: speed up the sync" : `PR ${i + 1}`, headSha: sha(i + 1), mergedSha: sha(100 + i), mergedAt: "2026-10-21T00:00:00.000Z" }));
const facts = (number: number): PullRequestFacts => ({
  repo, number, url: `https://github.com/o/r/pull/${number}`, author: "ada", state: "merged", draft: false, headSha: sha(number), mergedSha: sha(99 + number),
  mergedAt: "2026-10-21T00:00:00.000Z", baseRef: "main", body: "", mergeable: null, mergeableState: "unknown", checks: { sha: sha(number), required: [] }, humanFeedback: [],
});

async function harness(over: Partial<MergedAuditOptions> = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), "sergeant-merged-audits-"));
  const listed: Date[] = [];
  const started: Extract<RunSpec, { role: "reviewer" }>[] = [];
  const runs = new Set<string>();
  const deps = {
    github: {
      mergedPullRequests: async (_: string, since: Date) => (listed.push(since), merged),
      readPullRequest: async (_: string, number: number) => facts(number),
      firstParent: async (_: string, mergedSha: string) => mergedSha.replace(/^0/, "f"),
      reviewEdits: async () => ({}),
    },
    linear: { readConversation: async (id: string) => ({ issue: { identifier: id } }) as Conversation },
    runner: {
      // Idempotent on the run id, as the real runner is.
      start: async (spec: RunSpec) => {
        if (spec.role !== "reviewer" || runs.has(spec.runId)) return;
        runs.add(spec.runId);
        started.push(spec);
      },
      status: async (runId: string) => ({ runId, status: "succeeded", costUsd: 1 }) as RunRecord,
    },
  } as unknown as MergedAuditDeps;
  const opts: MergedAuditOptions = { stateDir, enrolledRepositories: [repo], rateOf: () => 1, auditOwner: "owner-1", log: () => {}, now: () => now, ...over };
  return { stateDir, listed, started, deps, opts, pass: (o: Partial<MergedAuditOptions> = {}) => mergedAuditPass({ ...opts, ...o }, deps) };
}

test("a repository with no rate lists nothing, and with no audit owner nothing outside a task starts", async () => {
  const off = await harness({ rateOf: () => 0 });
  await off.pass();
  expect(off.listed).toEqual([]);
  expect(off.started).toEqual([]);

  const unpaid = await harness({ auditOwner: undefined });
  await unpaid.pass();
  expect(unpaid.started).toEqual([]);
});

test("each drawn PR's pre-merge head is audited once as of its merge, across re-scans, restarts, and the task's own audit", async () => {
  const t = await harness();
  // PR 2's head was already drawn by its task's 20% audit, under an id recorded before TECH-6616.
  await mkdir(join(t.stateDir, "tasks", "UNF-2"), { recursive: true });
  const task = { issueId: "UNF-2", startedAt: "2026-10-20T00:00:00.000Z", turns: 1, runIds: [], recentTurns: [], merged: { repo, number: 2, headSha: sha(2), mergedSha: sha(101), at: "2026-10-21T00:00:00.000Z", audit: { runId: `run_audit-${sha(2)}` } } };
  await writeFile(join(t.stateDir, "tasks", "UNF-2", "state.json"), JSON.stringify(task));

  await t.pass();
  expect(t.listed).toEqual([new Date(now.getTime() - 72 * 3_600_000)]);
  expect(t.started.map((s) => s.subject[0]?.number)).toEqual([1, 3, 4, 5, 6]);
  const first = t.started[0];
  expect(first).toMatchObject({
    runId: auditRunId(repo, 1, sha(1)),
    owner: { id: "owner-1" },
    conversation: { issue: { identifier: "UNF-9" } },
    subject: [{ repo, number: 1, headSha: sha(1), baseSha: sha(100).replace(/^0/, "f") }],
    feedbackCutoff: "2026-10-21T00:00:00.000Z",
  });
  expect(t.started[1]?.conversation).toBeUndefined();

  // Within the day nothing is listed again; the next day's pass re-scans the same window and starts nothing.
  await t.pass();
  expect(t.listed).toHaveLength(1);
  const tomorrow = new Date(now.getTime() + 25 * 3_600_000);
  await t.pass({ now: () => tomorrow });
  expect(t.listed).toHaveLength(2);
  expect(t.started).toHaveLength(5);

  // With the file lost, the runner's idempotent start still begins no second audit.
  await rm(join(t.stateDir, "merged-audits.json"));
  await t.pass({ now: () => tomorrow });
  expect(t.started).toHaveLength(5);
});

test("the daily cap starts an audit only if its reservation fits, counting each audit not finished yet", async () => {
  const t = await harness({ budgetUsdPerDay: 9 });
  await t.pass();
  // Each new audit counts $5 until its cost is known: one fits under $9, a second would make $10.
  expect(t.started).toHaveLength(1);
  // The next day the earlier one cost $1 and falls out of the last 24 hours: one more starts.
  await t.pass({ now: () => new Date(now.getTime() + 25 * 3_600_000) });
  expect(t.started).toHaveLength(2);

  // A reservation that exactly fills the cap still fits.
  const exact = await harness({ budgetUsdPerDay: 10 });
  await exact.pass();
  expect(exact.started).toHaveLength(2);
});

test("the merged-PR draw is salted apart from the skipped-review draw", () => {
  const heads = Array.from({ length: 2000 }, (_, i) => ({ repo, number: 7, headSha: sha(i) }));
  const merged = heads.filter((h) => auditDrawn(0.1, h, "merged-audit"));
  expect(merged.length).toBeGreaterThan(130);
  expect(merged.length).toBeLessThan(270);
  // Unsalted, every head drawn at 0.1 would also be drawn at 0.2; independent, about 80% are not.
  const alsoTask = merged.filter((h) => auditDrawn(0.2, h)).length;
  expect(alsoTask / merged.length).toBeLessThan(0.4);
});

test("a review edited after it was submitted carries its edit time into the audit, and with no way to read it nothing starts", async () => {
  const t = await harness();
  const review = (id: string) => ({ id, kind: "review", author: "ada", state: "APPROVED", body: "LGTM", path: null, line: null, commitId: sha(1), createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z", url: `https://github.com/o/r/pull/1#${id}` }) as const;
  const github = t.deps.github as unknown as Record<string, unknown>;
  github.readPullRequest = async (_: string, number: number) => ({ ...facts(number), humanFeedback: [review("review:1"), review("review:2")], botFeedback: [review("review:3")] });
  github.reviewEdits = async () => ({ "review:2": "2026-10-21T09:00:00.000Z", "review:3": "2026-10-21T10:00:00.000Z" });
  await t.pass();
  // The brief compares each with the merge time (brief-as-of-merge.test.ts); a submission time alone would pass review:2 and review:3 as unedited.
  expect(t.started[0]?.pullRequests[0]?.humanFeedback.map((f) => f.updatedAt)).toEqual(["2026-10-20T00:00:00.000Z", "2026-10-21T09:00:00.000Z"]);
  expect(t.started[0]?.pullRequests[0]?.botFeedback?.map((f) => f.updatedAt)).toEqual(["2026-10-21T10:00:00.000Z"]);

  const blind = await harness();
  delete (blind.deps.github as unknown as Record<string, unknown>).reviewEdits;
  await blind.pass();
  expect(blind.started).toEqual([]);
});
