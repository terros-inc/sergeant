import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, MergePr, PullRequestFacts, RunRecord, RunSpec } from "@terros/sergeant-contracts";
import { runLoop } from "./loop.ts";
import { auditDrawn, resultingMutation, type ReviewFacts } from "./review-quality.ts";

// UNF-730: a merged head that skipped fresh review is sampled for an audit review that must never
// hold up the merge, and every review that finishes leaves a telemetry line, merged or not, that can
// tell review modes apart and says whether it led to a change. An audit's must-fix findings on merged
// code must not vanish.

const repo = "o/canary";
const [headA, headB, mergedSha] = ["a", "b", "c"].map((c) => c.repeat(40)) as [string, string, string];
const agent = { id: "agent-v2", name: "Sergeant" };
const pr = (headSha: string): PullRequestFacts => ({
  repo,
  number: 7,
  url: `https://github.com/${repo}/pull/7`,
  state: "open",
  draft: false,
  author: "sergeant-worker[bot]",
  headSha,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true,
  checks: { sha: headSha, required: [{ name: "validate", state: "passed" }] },
});
type Addressed = NonNullable<Extract<RunRecord, { role: "worker" }>["report"]>["addressedFindings"];
const worker = (headSha: string, review: { required: boolean; reason: string }, addressedFindings?: Addressed): RunRecord => ({
  runId: "run_worker",
  role: "worker",
  status: "succeeded",
  provider: "anthropic/claude-code",
  model: "opus",
  report: {
    reportVersion: "s2-worker-report/1",
    outcome: "completed",
    summary: "",
    pullRequests: [{ repo, number: 7, headSha, url: pr(headSha).url, closesIssue: true, review }],
    knownGaps: [],
    followups: [],
    addressedFindings,
  },
});
const reviewer = (runId: string, headSha: string, verdict: "approve" | "changes_requested", blocking: string[] = []): RunRecord => ({
  runId,
  role: "reviewer",
  status: "succeeded",
  provider: "anthropic/claude-code",
  model: "opus",
  report: {
    reportVersion: "s2-review-report/1",
    reviewed: [{ repo, number: 7, headSha }],
    verdict,
    findings: blocking.map((id) => ({ id, severity: "blocking", description: `${id} is wrong`, location: "src/x.ts:1" })),
    summary: verdict,
  },
});

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

/**
 * The loop over fakes, resuming with `runs` recorded and a reasoner that merges `head` on `standing`.
 * `audit` is how the audit run reports once started; a run in `pollsUntilDone` reports `running` for
 * that many polls first. `mergedOnGitHub`: a human already merged the PR. `delegated: false`: the
 * issue was taken back from Sergeant.
 */
async function scenario(opts: {
  runs: RunRecord[];
  head: string;
  standing: MergePr["reviewStanding"];
  rate: number;
  audit?: RunRecord;
  pollsUntilDone?: Record<string, number>;
  mergedOnGitHub?: boolean;
  delegated?: boolean;
}) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-audit-test-"));
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: opts.runs.map((r) => r.runId), recentTurns: [] }),
  );
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "Done", delegate: opts.delegated === false ? null : agent, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  const events: string[] = [];
  const started: RunSpec[] = [];
  const polls = new Map<string, number>();
  const run = () =>
    runLoop(
      { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, auditSampleRate: opts.rate, log: () => {} },
      {
        agentUserId: agent.id,
        workerLogin: "sergeant-worker[bot]",
        linear: {
          readConversation: async () => live,
      moveIssueToStarted: async () => ({ moved: false as const }),
          postComment: async () => void events.push("outcome comment"),
          createFollowupIssue: async () => {
            throw new Error("unused");
          },
        },
        github: {
          readPullRequest: async () => (opts.mergedOnGitHub ? { ...pr(opts.head), state: "merged", mergedSha } : pr(opts.head)),
          mergePullRequest: async () => {
            events.push("merge");
            return { mergedSha };
          },
        },
        runner: {
          start: async (spec) => {
            events.push(`start ${spec.runId}`);
            started.push(spec);
          },
          status: async (id) => {
            const run = [...opts.runs, ...(opts.audit ? [opts.audit] : [])].find((r) => r.runId === id);
            if (!run) throw new Error(`unknown run ${id}`);
            polls.set(id, (polls.get(id) ?? 0) + 1);
            return (polls.get(id) ?? 0) > (opts.pollsUntilDone?.[id] ?? 0) ? run : { ...run, status: "running", report: null };
          },
          cancel: async () => {},
        },
        reasoner: {
          turn: async () => ({
            output: { summary: "merge", actions: [{ kind: "merge_pr", repo, number: 7, expectedHeadSha: opts.head, reviewStanding: opts.standing }] },
            model: "m",
            promptVersion: "p",
          }),
        },
      },
    );
  const lines = async (file: string) =>
    (await readFile(join(dir, file), "utf8").catch(() => "")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const reviews = () => lines("reviews.jsonl") as Promise<ReviewFacts[]>;
  // A review's later lines restate it with what became known since; the last one holds.
  const latest = async () => [...new Map((await reviews()).map((f) => [f.runId, f])).values()];
  return { result: await run(), rerun: run, events, started, reviews, latest, followups: () => lines("audit-followups.jsonl") };
}

test("a sampled skipped review is audited only after the merge, and its must-fix findings are logged as follow-up", async () => {
  const auditRunId = `run_audit-${headA}`;
  const { result, rerun, events, started, reviews, followups } = await scenario({
    runs: [worker(headA, { required: false, reason: "docs-only change" })],
    head: headA,
    standing: { kind: "not_required", workerRunId: "run_worker" },
    rate: 1,
    audit: reviewer(auditRunId, headA, "changes_requested", ["f1"]),
    pollsUntilDone: { [auditRunId]: 2 },
  });

  // The merge and its outcome come first; the audit starts after them and is waited for only then.
  expect(events).toEqual(["merge", "outcome comment", `start ${auditRunId}`]);
  expect(started[0]).toMatchObject({ role: "reviewer", subject: [{ repo, number: 7, headSha: headA }] });
  expect(started[0]?.role === "reviewer" && started[0].focus).toContain("docs-only change");
  expect(result).toMatchObject({ outcome: "done", detail: expect.stringContaining("follow-up logged") });

  expect(await reviews()).toEqual([
    expect.objectContaining({
      runId: auditRunId,
      trigger: "audit",
      vendor: "same",
      implementer: { provider: "anthropic/claude-code", model: "opus" },
      findings: { blocking: 1, nonBlocking: 0, nits: 0 },
      mustFix: [expect.objectContaining({ id: "f1" })],
      merged: { repo, number: 7, headSha: headA, mergedSha },
      resultingMutation: "unknown",
      followUp: true,
    }),
  ]);
  expect(await followups()).toEqual([expect.objectContaining({ auditRunId, mustFix: [expect.objectContaining({ id: "f1" })] })]);

  // Running the command again starts no second audit and records nothing twice.
  expect((await rerun()).outcome).toBe("done");
  expect(started).toHaveLength(1);
  expect(await reviews()).toHaveLength(1);
  expect(await followups()).toHaveLength(1);
});

test("a reviewed merge is not audited, and a review led to a change only when a worker reports its finding fixed", async () => {
  const { started, reviews, latest, followups } = await scenario({
    runs: [
      reviewer("run_r1", headA, "changes_requested", ["f1"]),
      worker(headB, { required: true, reason: "fix" }, [{ reviewRunId: "run_r1", findingId: "f1", resolution: "fixed", reason: "guarded" }]),
      reviewer("run_r2", headB, "approve"),
    ],
    head: headB,
    standing: { kind: "reviewed", reviewRunId: "run_r2" },
    rate: 1,
  });

  expect(started).toEqual([]);
  // Each review is recorded when the loop first sees it finished, before any merge, then restated once
  // the merge is known.
  expect((await reviews()).map((f) => [f.runId, f.merged?.mergedSha ?? null])).toEqual([
    ["run_r1", null],
    ["run_r2", null],
    ["run_r1", mergedSha],
    ["run_r2", mergedSha],
  ]);
  expect((await latest()).map((f) => [f.runId, f.trigger, f.findings.blocking, f.resultingMutation])).toEqual([
    ["run_r1", "required", 1, true],
    ["run_r2", "required", 0, false],
  ]);
  expect(await followups()).toEqual([]);
});

test("a head that changed after a review is not counted as a change the review caused", () => {
  const r1 = reviewer("run_r1", headA, "changes_requested", ["f1"]);
  if (r1.role !== "reviewer") throw new Error("reviewer fixture");
  const after = (addressed?: Addressed) => [r1, worker(headB, { required: false, reason: "unrelated" }, addressed)];
  expect(resultingMutation(r1, after())).toBe("unknown");
  expect(resultingMutation(r1, after([{ reviewRunId: "run_r1", findingId: "f1", resolution: "disputed", reason: "wrong" }]))).toBe(false);
  // The same finding id from a different review is not this review's.
  expect(resultingMutation(r1, after([{ reviewRunId: "run_r0", findingId: "f1", resolution: "fixed", reason: "" }]))).toBe("unknown");
});

test("a finished review is recorded even when the task never merges", async () => {
  const { result, events, latest } = await scenario({
    runs: [worker(headA, { required: true, reason: "risky" }), reviewer("run_r1", headA, "changes_requested", ["f1"])],
    head: headA,
    standing: { kind: "reviewed", reviewRunId: "run_r1" },
    rate: 1,
    delegated: false,
  });

  expect(result.outcome).toBe("stopped");
  expect(events).toEqual([]);
  expect(await latest()).toEqual([
    expect.objectContaining({ runId: "run_r1", trigger: "required", merged: null, mustFix: [expect.objectContaining({ id: "f1" })] }),
  ]);
});

test("a review still running when the PR merged is recorded when it finishes", async () => {
  const { result, latest } = await scenario({
    runs: [worker(headA, { required: true, reason: "risky" }), reviewer("run_r1", headA, "changes_requested", ["f1"])],
    head: headA,
    standing: { kind: "reviewed", reviewRunId: "run_r1" },
    rate: 0,
    mergedOnGitHub: true,
    pollsUntilDone: { run_r1: 2 },
  });

  expect(result.outcome).toBe("done");
  expect(await latest()).toEqual([
    expect.objectContaining({
      runId: "run_r1",
      status: "succeeded",
      verdict: "changes_requested",
      mustFix: [expect.objectContaining({ id: "f1" })],
      merged: { repo, number: 7, headSha: headA, mergedSha },
    }),
  ]);
});

test("the audit draw is stable per head and tracks the configured rate", () => {
  const heads = Array.from({ length: 2000 }, (_, i) => ({ repo, number: 7, headSha: i.toString(16).padStart(40, "0") }));
  const sampled = heads.filter((h) => auditDrawn(0.2, h)).length;
  expect(sampled).toBeGreaterThan(300);
  expect(sampled).toBeLessThan(500);
  expect(heads.filter((h) => auditDrawn(0.2, h)).length).toBe(sampled);
  expect(heads.some((h) => auditDrawn(0, h))).toBe(false);
  expect(heads.every((h) => auditDrawn(1, h))).toBe(true);
});
