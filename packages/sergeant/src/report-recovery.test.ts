import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { conversationRevision, type Conversation, type ProposedAction, type PullRequestFacts, type RunRecord, type RunSpec, type SituationReport } from "@terros/sergeant-contracts";
import { ports, situation } from "./execute-fixtures.ts";
import { runLoop } from "./loop.ts";
import { recoverReports } from "./report-recovery.ts";

// TECH-5259: a worker that wrote no report, or a reviewer whose report did not parse, left its head
// with no review standing until the budget ran out. This drives the loop over a fake world where the
// first worker writes no report and two reviews in a row are malformed: each such run is retried at
// once, without a reasoning turn, and with a brief that says why; a retry that fails again is left to
// reasoning, so it cannot loop; and every one is counted in `report-recoveries.jsonl`.

const H = "1".repeat(40);
const repo = "o/canary";
const url = `https://github.com/${repo}/pull/7`;
const agent = { id: "agent-v2", name: "Sergeant" };
const pr: PullRequestFacts = {
  repo, number: 7, url, state: "open", draft: false, author: "sergeant-worker[bot]", headSha: H, mergedSha: null, baseRef: "main", body: "Fixes UNF-1", mergeable: true, mergeableState: "clean",
  checks: { sha: H, required: [{ name: "validate", state: "passed" }] },
  humanFeedback: [],
};
const base = { status: "succeeded", provider: "p", model: "m", report: null } as const;
const missing = (runId: string): RunRecord => ({ ...base, runId, role: "worker", status: "failed", reportProblem: "missing", reportError: "no report written; agent exited 1" });
const malformed = (runId: string): RunRecord => ({ ...base, runId, role: "reviewer", reportProblem: "malformed", reportError: "✖ Invalid input → at verdict" });
const reported = (runId: string): RunRecord => ({
  ...base, runId, role: "worker",
  report: { reportVersion: "s2-worker-report/1", outcome: "completed", summary: "Paginated.", knownGaps: [], followups: [], pullRequests: [{ repo, number: 7, url, headSha: H, closesIssue: true, review: { required: true, reason: "logic" } }] },
});
const approved = (runId: string): RunRecord => ({
  ...base, runId, role: "reviewer",
  report: { reportVersion: "s2-review-report/1", reviewed: [{ repo, number: 7, headSha: H }], verdict: "approve", findings: [], summary: "ok" },
});

/** What reasoning would decide: merge an approved head, else review it, else start the work. */
function decide(s: SituationReport): ProposedAction[] {
  const approval = s.runs.find((r) => r.role === "reviewer" && r.report?.verdict === "approve");
  if (approval) return [{ kind: "merge_pr", repo, number: 7, expectedHeadSha: H, reviewStanding: { kind: "reviewed", reviewRunId: approval.runId } }];
  if (s.pullRequests.length) return [{ kind: "start_reviewer", subject: [{ repo, number: 7, headSha: H }], focus: "Check pagination." }];
  return [{ kind: "start_worker", objective: "Paginate the list.", repositories: [repo] }];
}

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test("a run with no usable report is retried at once and says why; a failed retry goes to reasoning; each is counted", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-report-recovery-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: [], recentTurns: [] }));
  let live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "Paginate", description: "D", state: "In Progress", stateType: "started", delegate: agent, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [] },
    humanComments: [],
    agentComments: [],
  };
  // How each started run ends, in start order.
  const script = [missing, (id: string) => ((live = { ...live, issue: { ...live.issue, linkedPullRequests: [{ repo, number: 7 }] } }), reported(id)), malformed, malformed, approved];
  const started: RunSpec[] = [];
  const records = new Map<string, RunRecord>();
  const polls = new Map<string, number>();
  const turns: SituationReport[] = [];

  const result = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, progressComments: false, log: () => {} },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: { readConversation: async () => live, postComment: async () => {}, createFollowupIssue: async () => { throw new Error("unused"); }, moveIssueToStarted: async () => ({ moved: false as const }), readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }) },
      github: {
        readPullRequest: async () => pr,
        closePullRequest: async () => {}, mergePolicy: () => "sergeant", mergePullRequest: async () => {
          live = { ...live, issue: { ...live.issue, state: "Done", stateType: "completed" } };
          return { mergedSha: "c".repeat(40) };
        },
      },
      runner: {
        async start(spec) {
          if (!script[started.length]) throw new Error(`unexpected run ${spec.role}`);
          started.push(spec);
        },
        async status(runId) {
          const i = started.findIndex((s) => s.runId === runId);
          const spec = started[i];
          if (!spec) throw new Error(`unknown ${runId}`);
          const n = polls.get(runId) ?? 0;
          polls.set(runId, n + 1);
          if (n < 1) return { ...base, runId, role: spec.role, status: "running" };
          if (!records.has(runId)) records.set(runId, script[i]!(runId));
          return records.get(runId)!;
        },
        cancel: async () => {},
      },
      reasoner: {
        async turn(situation) {
          turns.push(situation);
          return { output: { summary: "decided", actions: decide(situation) }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  expect(result.outcome).toBe("done");
  const [w1, w2, r1, r2, r3] = started as [Extract<RunSpec, { role: "worker" }>, Extract<RunSpec, { role: "worker" }>, ...Extract<RunSpec, { role: "reviewer" }>[]];
  expect(started.map((s) => s.role)).toEqual(["worker", "worker", "reviewer", "reviewer", "reviewer"]);
  // The two retries started with no turn of their own: four turns for five runs and the merge.
  expect(turns).toHaveLength(4);
  // The worker's retry continues its objective and is told why and to write its report.
  expect(w2.objective).toContain(`previous worker run ${w1.runId} ended with no usable report (missing: no report written; agent exited 1)`);
  expect(w2.objective).toContain("Paginate the list.");
  expect(w2.objective).toContain("/workspace/sergeant-report.md");
  // The reviewer's retry reviews the same head, told why, its original focus kept.
  expect(r2).toMatchObject({ subject: r1?.subject });
  expect(r2?.focus).toContain(`previous reviewer run ${r1?.runId} ended with no usable report (malformed`);
  expect(r2?.focus).toContain("Check pagination.");
  // The next turn is told what Sergeant did, and the failed retry was the reasoner's to decide.
  expect(turns[1]?.recentTurns.map((t) => t.summary)).toContain(`Sergeant retried worker run ${w1.runId} at once, before this turn, because it ended with no usable report (missing).`);
  expect(turns[2]?.runs.map((r) => r.runId)).toEqual([w1.runId, w2.runId, r1?.runId, r2?.runId]);
  expect(r3?.focus).toBe("Check pagination.");

  const lines = (await readFile(join(dir, "report-recoveries.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toEqual([
    expect.objectContaining({ issue: "UNF-1", runId: w1.runId, role: "worker", problem: "missing", recovery: "retried", retryRunId: w2.runId }),
    expect.objectContaining({ runId: r1?.runId, role: "reviewer", problem: "malformed", recovery: "retried", retryRunId: r2?.runId }),
    expect.objectContaining({ runId: r2?.runId, role: "reviewer", problem: "malformed", recovery: "none", reason: "it was itself a retry, and Sergeant retries a run once" }),
  ]);
});

test("a review whose head moved, or a run that failed on its account, is counted but left to reasoning", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-report-recovery-test-"));
  const seen = { revision: conversationRevision(situation.conversation), issue: "unused" };
  const state = { seen, starts: { run_r1: { kind: "start_reviewer", subject: [{ repo: situation.pullRequests[0]!.repo, number: 7, headSha: "9".repeat(40) }] } }, reportRecoveries: {}, recentTurns: [], unconfirmedStarts: [] };
  const runs: RunRecord[] = [{ ...missing("run_w1"), failureReason: "quota" }, malformed("run_r1")];
  const { p, started } = ports();
  const retried = await recoverReports({ ...situation, runs }, state as never, p, { issueId: "UNF-1", dir, log: () => {}, save: async () => {} });

  expect(retried).toEqual({ retried: false });
  expect(started).toEqual([]);
  const lines = (await readFile(join(dir, "report-recoveries.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => [l.runId, l.recovery, l.reason])).toEqual([
    ["run_w1", "none", "it failed on quota; its account is set aside and reasoning decides"],
    ["run_r1", "none", "a head it was to review has moved or is gone"],
  ]);
});
