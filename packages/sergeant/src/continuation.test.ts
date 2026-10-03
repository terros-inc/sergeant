import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, ProposedAction, PullRequestFacts, RunRecord, RunSpec, SituationReport } from "@terros/sergeant-contracts";
import { workerBrief } from "@terros/sergeant-runner";
import { runLoop } from "./loop.ts";

// UNF-726: before this, a blocking review finding or a red required check stranded the task, since
// nothing sent the work back and a successor's brief knew nothing about either. This drives the loop
// over a fake world through both: a review blocks H1, a successor fixes it (H2) and CI fails there, a
// second successor fixes that (H3), and only a fresh review of H3 lets the merge through. Along the
// way: each successor's brief carries what it must fix, a second worker is never started beside a
// running one, and the stale review of H1 cannot carry a merge of a later head.

const [H1, H2, H3] = ["1", "2", "3"].map((c) => c.repeat(40)) as [string, string, string];
const repo = "o/canary";
const url = `https://github.com/${repo}/pull/7`;
const agent = { id: "agent-v2", name: "Sergeant" };
const prAt = (headSha: string, validate: "passed" | "failed"): PullRequestFacts => ({
  repo, number: 7, url, state: "open", draft: false, author: "sergeant-worker[bot]", headSha, mergedSha: null, baseRef: "main", body: "Fixes UNF-1", mergeable: true,
  checks: { sha: headSha, required: [{ name: "validate", state: validate }] },
  humanFeedback: [],
});
const workerRun = (runId: string, headSha: string, summary: string): RunRecord => ({
  runId, role: "worker", status: "succeeded", provider: "p", model: "m",
  report: {
    reportVersion: "s2-worker-report/1", outcome: "completed", summary, knownGaps: [], followups: [],
    pullRequests: [{ repo, number: 7, url, headSha, closesIssue: true, review: { required: true, reason: "logic changed" } }],
  },
});
const reviewRun = (runId: string, headSha: string, verdict: "approve" | "changes_requested"): RunRecord => ({
  runId, role: "reviewer", status: "succeeded", provider: "p", model: "m",
  report: {
    reportVersion: "s2-review-report/1", reviewed: [{ repo, number: 7, headSha }], verdict, summary: verdict,
    findings: verdict === "approve" ? [] : [{ id: "F1", severity: "blocking", description: "Pagination drops the last page.", location: "src/page.ts:12" }],
  },
});

/** What reasoning would decide, reduced to the rules the prompt states. */
function decide(s: SituationReport): ProposedAction[] {
  const pr = s.pullRequests[0];
  if (!pr) return [];
  const reviews = s.runs.filter((r) => r.role === "reviewer" && r.report?.reviewed.some((h) => h.headSha === pr.headSha));
  const fixWorker: ProposedAction = { kind: "start_worker", objective: "Fix the PR.", repositories: [repo] };
  if (reviews.some((r) => r.role === "reviewer" && r.report?.verdict === "changes_requested")) return [fixWorker, fixWorker];
  if (pr.checks.required.some((c) => c.state === "failed")) return [fixWorker];
  const approved = reviews.find((r) => r.role === "reviewer" && r.report?.verdict === "approve");
  if (approved) return [{ kind: "merge_pr", repo, number: 7, expectedHeadSha: pr.headSha, reviewStanding: { kind: "reviewed", reviewRunId: approved.runId } }];
  return [
    // The H1 review is stale for this head; the Gate must refuse it.
    { kind: "merge_pr", repo, number: 7, expectedHeadSha: pr.headSha, reviewStanding: { kind: "reviewed", reviewRunId: "run_r1" } },
    { kind: "start_reviewer", subject: [{ repo, number: 7, headSha: pr.headSha }] },
  ];
}

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test("a blocking finding and then a red check each get a pushed fix on the same PR, and the new head a fresh review", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-continuation-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds: ["run_w1", "run_r1"], recentTurns: [] }));

  let live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "Paginate", description: "D", state: "In Progress", stateType: "started", delegate: agent, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  let pr = prAt(H1, "passed");
  const records = new Map<string, RunRecord>([["run_w1", workerRun("run_w1", H1, "Added pagination.")], ["run_r1", reviewRun("run_r1", H1, "changes_requested")]]);
  // What each started run does when it finishes, in start order: push a head, or review one.
  const script = [
    (id: string) => ((pr = prAt(H2, "failed")), workerRun(id, H2, "Fixed F1.")),
    (id: string) => ((pr = prAt(H3, "passed")), workerRun(id, H3, "Fixed the validate failure.")),
    (id: string) => reviewRun(id, H3, "approve"),
  ];
  const started: RunSpec[] = [];
  const pending = new Map<string, { finish: (id: string) => RunRecord; polls: number }>();
  const outcomes: string[][] = [];
  const merged: unknown[] = [];

  const result = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, log: () => {} },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: { readConversation: async () => live, postComment: async () => {}, createFollowupIssue: async () => { throw new Error("unused"); }, moveIssueToStarted: async () => ({ moved: false as const }) },
      github: {
        readPullRequest: async () => pr,
        closePullRequest: async () => {}, mergePullRequest: async (req) => {
          merged.push(req);
          pr = { ...pr, state: "merged", mergedSha: "c".repeat(40) };
          live = { ...live, issue: { ...live.issue, state: "Done", stateType: "completed" } };
          return { mergedSha: "c".repeat(40) };
        },
      },
      runner: {
        async start(spec) {
          if (spec.role === "worker" && [...pending.keys()].some((id) => started.find((s) => s.runId === id)?.role === "worker")) {
            throw new Error("a second primary worker was started while one is running");
          }
          const finish = script[started.length];
          if (!finish) throw new Error(`unexpected run ${spec.role}`);
          started.push(spec);
          pending.set(spec.runId, { finish, polls: 0 });
        },
        async status(runId) {
          const run = pending.get(runId);
          const role = started.find((s) => s.runId === runId)?.role ?? "worker";
          if (run && run.polls++ < 1) return { runId, role, status: "running", provider: "p", model: "m", report: null } as RunRecord;
          if (run) {
            records.set(runId, run.finish(runId));
            pending.delete(runId);
          }
          return records.get(runId) ?? Promise.reject(new Error(`unknown ${runId}`));
        },
        cancel: async () => {},
      },
      reasoner: {
        async turn(situation) {
          if (outcomes.length > 0) outcomes[outcomes.length - 1] = situation.recentTurns.at(-1)?.outcomes ?? [];
          outcomes.push([]);
          return { output: { summary: "decided", actions: decide(situation) }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  expect(result.outcome).toBe("done");
  expect(started.map((s) => s.role)).toEqual(["worker", "worker", "reviewer"]);
  // The first turn started one worker; its second start was refused.
  expect(outcomes[0]).toEqual([expect.stringMatching(/^start_worker: done/), expect.stringMatching(/^start_worker: denied by R4/)]);

  // Each successor's brief carries what it must fix, whatever the objective said.
  const [first, second, reviewer] = started;
  const firstBrief = workerBrief(first as Extract<RunSpec, { role: "worker" }>, []);
  expect(firstBrief).toContain("Pagination drops the last page.");
  expect(firstBrief).toContain(`${url} — open, head \`${H1}\``);
  const secondBrief = workerBrief(second as Extract<RunSpec, { role: "worker" }>, []);
  expect(secondBrief).toContain(`head \`${H2}\``);
  expect(secondBrief).toContain("Required checks on that head: validate failed");

  // The H1 review could not carry H3; only the fresh review of H3 did.
  expect(outcomes[2]).toEqual([expect.stringMatching(/denied by M6 .*did not review head/), expect.stringMatching(/^start_reviewer: done/)]);
  expect(reviewer).toMatchObject({ role: "reviewer", subject: [{ repo, number: 7, headSha: H3 }] });
  expect(merged).toEqual([{ kind: "merge_pr", repo, number: 7, expectedHeadSha: H3, reviewStanding: { kind: "reviewed", reviewRunId: reviewer?.runId } }]);
});
