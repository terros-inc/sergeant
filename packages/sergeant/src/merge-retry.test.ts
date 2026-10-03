import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, MergePr, PullRequestFacts, RunRecord, SituationReport } from "@terros/sergeant-contracts";
import { runLoop } from "./loop.ts";

// TECH-5062: a merge that did not happen takes no paid turn per poll. The turn's fingerprint is
// committed, so the task reasons again only when the facts change: here a moved base or head, or
// GitHub settling a mergeability the merge's own live read found still computing (M7).

const head = "a".repeat(40);
const repo = "o/canary";
const pr: PullRequestFacts = {
  repo,
  number: 7,
  url: `https://github.com/${repo}/pull/7`,
  state: "open",
  draft: false,
  author: "sergeant-worker[bot]",
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  baseSha: "b".repeat(40),
  body: "Fixes UNF-1",
  mergeable: true,
  checks: { sha: head, required: [{ name: "validate", state: "passed" }] },
  humanFeedback: [],
};
const review: RunRecord = {
  runId: "run_review",
  role: "reviewer",
  status: "succeeded",
  provider: "p",
  model: "m",
  report: { reportVersion: "s2-review-report/1", reviewed: [{ repo, number: 7, headSha: head }], verdict: "approve", findings: [], summary: "" },
};
const worker: RunRecord = {
  runId: "run_worker",
  role: "worker",
  status: "succeeded",
  provider: "p",
  model: "m",
  report: {
    reportVersion: "s2-worker-report/1",
    outcome: "completed",
    summary: "",
    pullRequests: [{ repo, number: 7, headSha: head, url: pr.url, closesIssue: true, review: { required: true, reason: "" } }],
    knownGaps: [],
    followups: [],
  },
};
const merge: MergePr = { kind: "merge_pr", repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } };

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test.each([
  ["M7 denies it: the merge's live read finds GitHub still computing", "M7", /denied by M7/],
  ["GitHub rejects it with a temporary 405 (the base branch moved)", "405", /failed \(GitHub 405: Base branch was modified\)/],
])("a merge that did not happen takes no turn until the facts change, then exactly one (%s)", async (_, path, firstOutcome) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-merge-retry-test-"));
  // A task saved before TECH-4991 holds a temporary 405 recorded as a policy refusal: it must not
  // hold the merge under M12.
  const stale = { repo, number: 7, url: pr.url, headSha: head, conversationRevision: "0".repeat(64), reason: "Pull Request is not mergeable", at: "2026-10-02T00:00:00.000Z", commentPostedAt: "2026-10-02T00:00:01.000Z" };
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: ["run_worker", "run_review"], recentTurns: [], refusedMerges: [stale] }));
  let live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: { id: "agent-v2", name: "Sergeant" }, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  let livePr = pr;
  // Set during the first turn: from the merge's own read on, GitHub is still computing mergeability
  // (M7), or it answers the merge with a temporary 405.
  let computing = false;
  let notReadyOnce = false;
  const attempts: number[] = [];
  const seen: SituationReport[] = [];

  // idleMinutes 0: the first poll whose facts match the committed fingerprint ends the loop idle.
  const run = () => runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, idleMinutes: 0, completionWaitMinutes: 0, log: () => {} },
    {
      agentUserId: "agent-v2",
      workerLogin: "sergeant-worker[bot]",
      linear: {
        readConversation: async () => live,
        postComment: async () => {},
        createFollowupIssue: async () => { throw new Error("unused"); },
        moveIssueToStarted: async () => ({ moved: false as const }),
      },
      github: {
        closePullRequest: async () => {},
        readPullRequest: async () => (computing ? { ...livePr, mergeable: null } : livePr),
        mergePullRequest: async () => {
          attempts.push(seen.length);
          if (notReadyOnce) throw ((notReadyOnce = false), new Error("GitHub 405: Base branch was modified"));
          livePr = { ...livePr, state: "merged", mergedSha: "c".repeat(40) };
          live = { ...live, issue: { ...live.issue, state: "Done" } };
          return { mergedSha: "c".repeat(40) };
        },
      },
      runner: { start: async () => {}, status: async (id) => (id === worker.runId ? worker : review), cancel: async () => {} },
      reasoner: {
        async turn(situation) {
          seen.push(situation);
          if (seen.length === 1 && path === "M7") computing = true;
          else if (seen.length === 1) notReadyOnce = true;
          return { output: { summary: "merge", actions: [merge] }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  // The merge does not happen. The polls after it, and a restart, show no new fact (GitHub still
  // computing is what the merge's read found): no more turns.
  expect((await run()).outcome).toBe("idle");
  expect((await run()).outcome).toBe("idle");
  expect(seen).toHaveLength(1);
  expect(seen[0]?.refusedMerges).toEqual([]);
  // GitHub settles, or the base moves: one turn, which merges.
  if (path === "M7") computing = false;
  else livePr = { ...livePr, baseSha: "d".repeat(40) };
  expect((await run()).outcome).toBe("done");
  expect(seen).toHaveLength(2);
  expect(seen[1]?.recentTurns.at(-1)?.outcomes[0]).toMatch(firstOutcome);
  expect(attempts).toEqual(path === "M7" ? [2] : [1, 2]);
});

test("a failed merge takes one more turn for a new head, then none while the facts stay put", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-merge-retry-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: ["run_worker", "run_review"], recentTurns: [] }));
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: { id: "agent-v2", name: "Sergeant" }, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  let livePr = pr;
  let turns = 0;
  const run = () => runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, idleMinutes: 0, completionWaitMinutes: 0, log: () => {} },
    {
      agentUserId: "agent-v2",
      workerLogin: "sergeant-worker[bot]",
      linear: { readConversation: async () => live, postComment: async () => {}, createFollowupIssue: async () => { throw new Error("unused"); }, moveIssueToStarted: async () => ({ moved: false as const }) },
      github: {
        closePullRequest: async () => {},
        readPullRequest: async () => livePr,
        mergePullRequest: async () => { throw new Error("GitHub 405: Pull Request is not mergeable"); },
      },
      runner: { start: async () => {}, status: async (id) => (id === worker.runId ? worker : review), cancel: async () => {} },
      reasoner: {
        async turn(situation) {
          turns++;
          const now = situation.pullRequests[0]?.headSha ?? head;
          return { output: { summary: "merge", actions: [{ ...merge, expectedHeadSha: now }] }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  expect((await run()).outcome).toBe("idle");
  expect((await run()).outcome).toBe("idle");
  expect(turns).toBe(1);
  const next = "e".repeat(40);
  livePr = { ...livePr, headSha: next, checks: { ...livePr.checks, sha: next } };
  expect((await run()).outcome).toBe("idle");
  expect((await run()).outcome).toBe("idle");
  expect(turns).toBe(2);
});
