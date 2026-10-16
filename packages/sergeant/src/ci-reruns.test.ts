import type { CiRerun, CiRerunPort, CiRerunRequest, PullRequestFacts, RunRecord, WorkflowRunFacts } from "@terros/sergeant-contracts";
import { expect, test } from "vitest";
import { performCiReruns } from "./ci-reruns.ts";

// TECH-5839: the rerun App holds Actions write, so these checks are all that stands between a worker's
// report and a rerun. Each case is a request that must never reach GitHub's rerun endpoint (another
// PR's or repository's run, a stale head, a run that did not fail, a deployment workflow, a third
// rerun), or one that must reach it exactly once, with an audit record either way.

const repo = "o/canary";
const head = "a".repeat(40);
const CI = ".github/workflows/ci.yml";
const worker = "sergeant-worker[bot]";

const pr = (over: Partial<PullRequestFacts> = {}): PullRequestFacts => ({
  repo, number: 7, url: `https://github.com/${repo}/pull/7`, state: "open", draft: false, author: worker, headSha: head, mergedSha: null,
  baseRef: "main", body: "Fixes UNF-1", changedFiles: [], mergeable: true, mergeableState: "unstable",
  checks: { sha: head, required: [{ name: "ci", state: "failed" }] }, humanFeedback: [],
  ...over,
});

const workerRun = (requests: CiRerunRequest[], runId = "run_w1"): RunRecord => ({
  runId, role: "worker", status: "succeeded", provider: "p", model: "m",
  report: { reportVersion: "s2-worker-report/1", outcome: "completed", summary: "flaky", knownGaps: [], followups: [], pullRequests: [], rerunFailedCI: requests },
});

const ask = (workflowRunId = 101, number = 7, r = repo): CiRerunRequest => ({ repo: r, number, workflowRunId });

const failedRun = (over: Partial<WorkflowRunFacts> = {}): WorkflowRunFacts => ({
  id: 101, repo, headSha: head, path: CI, status: "completed", conclusion: "failure", attempt: 1, url: `https://github.com/${repo}/actions/runs/101`, ...over,
});

function fakePort(run: WorkflowRunFacts | Error = failedRun(), allowed = [CI]) {
  const reran: number[] = [];
  const port: CiRerunPort = {
    allowedWorkflows: (r) => (r === repo ? allowed : []),
    readWorkflowRun: async () => {
      if (run instanceof Error) throw run;
      return run;
    },
    rerunFailedJobs: async (_, id) => {
      reran.push(id);
    },
  };
  return { port, reran };
}

async function perform(runs: RunRecord[], port: CiRerunPort | undefined, prs = [pr()], ciReruns: CiRerun[] = []) {
  const state = { ciReruns };
  const saved: number[] = [];
  const reran = await performCiReruns(runs, prs, state, { ...(port && { ciRerun: port }), workerLogin: worker }, () => {}, async () => {
    saved.push(state.ciReruns.length);
  });
  return { reran, state, saved };
}

test("a failed allowed workflow run on the task PR's current head is rerun once, and the audit says who asked and what for", async () => {
  const { port, reran } = fakePort();
  const runs = [workerRun([ask()])];
  const first = await perform(runs, port);

  expect(reran).toEqual([101]);
  expect(first.reran).toBe(1);
  expect(first.saved).toEqual([1]);
  expect(first.state.ciReruns).toEqual([
    expect.objectContaining({ requestedBy: "run_w1", repo, number: 7, workflowRunId: 101, headSha: head, workflow: CI, attempt: 1, outcome: "rerun" }),
  ]);

  // The same report read on the next pass is not a second request.
  const again = await perform(runs, port, [pr()], first.state.ciReruns);
  expect(again.reran).toBe(0);
  expect(reran).toEqual([101]);
});

test.each<[string, CiRerunRequest, WorkflowRunFacts, string[], RegExp]>([
  ["another PR", ask(101, 8), failedRun(), [CI], /o\/canary#8 is not a pull request of this task/],
  ["another repository", ask(101, 7, "o/other"), failedRun(), [CI], /o\/other#7 is not a pull request of this task/],
  ["a run in another repository", ask(), failedRun({ repo: "o/fork" }), [CI], /is in o\/fork, not o\/canary/],
  ["a stale head", ask(), failedRun({ headSha: "b".repeat(40) }), [CI], /stale: workflow run 101 ran on bbbbbbbbbbbb, but the PR's head is aaaaaaaaaaaa/],
  ["a run still in progress", ask(), failedRun({ status: "in_progress", conclusion: null }), [CI], /has not failed \(in_progress\)/],
  ["a run that succeeded", ask(), failedRun({ conclusion: "success" }), [CI], /has not failed \(completed, success\)/],
  ["a canceled run", ask(), failedRun({ conclusion: "cancelled" }), [CI], /has not failed/],
  ["a workflow not on the allowlist", ask(), failedRun({ path: ".github/workflows/deploy.yml" }), [CI], /deploy\.yml is not a workflow o\/canary allows reruns of/],
  ["a repository with no allowlist", ask(), failedRun(), [], /allows no CI reruns/],
  ["a run GitHub shows rerun twice already", ask(), failedRun({ attempt: 3 }), [CI], /already rerun 2 times, the most allowed/],
])("a request for %s is rejected and recorded, and nothing is rerun", async (_, request, run, allowed, reason) => {
  const { port, reran } = fakePort(run, allowed);
  const { state } = await perform([workerRun([request])], port);
  expect(reran).toEqual([]);
  expect(state.ciReruns).toEqual([expect.objectContaining({ requestedBy: "run_w1", workflowRunId: request.workflowRunId, outcome: "rejected", reason: expect.stringMatching(reason) })]);
});

test.each<[string, Partial<PullRequestFacts>, RegExp]>([
  ["a PR the worker App did not open", { author: "someone" }, /was not opened by Sergeant's worker App/],
  ["a closed PR", { state: "closed" }, /is closed/],
])("a request for %s is rejected before GitHub is asked", async (_, over, reason) => {
  const { port, reran } = fakePort(new Error("must not be read"));
  const { state } = await perform([workerRun([ask()])], port, [pr(over)]);
  expect(reran).toEqual([]);
  expect(state.ciReruns[0]).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(reason) });
});

test("at most two reruns per workflow run, counting this task's records when GitHub's attempt lags", async () => {
  const { port, reran } = fakePort(failedRun({ attempt: 1 }));
  const earlier: CiRerun[] = ["run_w1", "run_w2"].map((requestedBy) => ({ requestedBy, repo, number: 7, workflowRunId: 101, outcome: "rerun", reason: "", at: "2026-10-16T10:00:00.000Z" }));
  const { state } = await perform([workerRun([ask()], "run_w3")], port, [pr()], earlier);
  expect(reran).toEqual([]);
  expect(state.ciReruns.at(-1)).toMatchObject({ requestedBy: "run_w3", outcome: "rejected", reason: expect.stringMatching(/already rerun 2 times/) });
});

test("without a rerun App every request is rejected, and a GitHub failure is recorded rather than retried", async () => {
  const none = await perform([workerRun([ask()])], undefined);
  expect(none.state.ciReruns[0]).toMatchObject({ outcome: "rejected", reason: "this Sergeant has no CI rerun App configured" });

  const { port, reran } = fakePort(new Error("GitHub GET o/canary actions/runs/101 failed (404)"));
  const runs = [workerRun([ask()])];
  const first = await perform(runs, port);
  expect(first.state.ciReruns[0]).toMatchObject({ outcome: "failed", reason: expect.stringMatching(/404/) });
  await perform(runs, port, [pr()], first.state.ciReruns);
  expect(reran).toEqual([]);
});

test("a running worker's requests wait for its end", async () => {
  const { port, reran } = fakePort();
  const { state } = await perform([{ ...workerRun([ask()]), status: "running" }], port);
  expect(reran).toEqual([]);
  expect(state.ciReruns).toEqual([]);
});
