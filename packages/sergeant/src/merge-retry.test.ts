import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, MergePr, PullRequestFacts, RunRecord } from "@terros/sergeant-contracts";
import { runLoop } from "./loop.ts";

// TECH-5077: a merge call that fails gets one re-check after the existing waiting grace. A second
// unchanged failure hands the same head to a human once; this is derived from timestamps and the
// keyed handoff record, never a turn counter.

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

async function fixture(waitingGraceMinutes = 0) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-merge-retry-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: [worker.runId, review.runId], recentTurns: [] }));
  let live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: { id: "agent-v2", name: "Sergeant" }, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  let livePr = pr;
  let failures = Infinity;
  let attempts = 0;
  let turns = 0;
  let computeOnFirstTurn = false;
  const comments: { key: string; body: string }[] = [];
  const run = () => runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, waitingGraceMinutes, idleMinutes: 0, completionWaitMinutes: 0, log: () => {} },
    {
      agentUserId: "agent-v2",
      workerLogin: "sergeant-worker[bot]",
      linear: {
        readConversation: async () => live,
        postComment: async (comment) => void comments.push(comment),
        createFollowupIssue: async () => { throw new Error("unused"); },
        readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
        moveIssueToStarted: async () => ({ moved: false as const }),
      },
      github: {
        closePullRequest: async () => {},
        readPullRequest: async () => livePr,
        mergePullRequest: async () => {
          attempts++;
          if (attempts <= failures) throw new Error("GitHub 405: Pull Request is not mergeable");
          livePr = { ...livePr, state: "merged", mergedSha: "c".repeat(40) };
          live = { ...live, issue: { ...live.issue, state: "Done", stateType: "completed" } };
          return { mergedSha: "c".repeat(40) };
        },
      },
      runner: { start: async () => {}, status: async (id) => (id === worker.runId ? worker : review), cancel: async () => {} },
      reasoner: {
        turn: async () => {
          turns++;
          if (computeOnFirstTurn && turns === 1) livePr = { ...livePr, mergeable: null };
          return { output: { summary: "merge", actions: [merge] }, model: "m", promptVersion: "p" };
        },
      },
    },
  );
  return {
    run,
    recoverAfter(count: number) { failures = count; },
    computeOnFirst() { computeOnFirstTurn = true; },
    settleMergeability() { livePr = { ...livePr, mergeable: true }; },
    async matureRetry() {
      const file = join(dir, "state.json");
      const saved = JSON.parse(await readFile(file, "utf8"));
      saved.mergeRetries[0].at = "2000-01-01T00:00:00.000Z";
      await writeFile(file, JSON.stringify(saved));
    },
    changeBase() { livePr = { ...livePr, baseSha: "d".repeat(40) }; },
    attempts: () => attempts,
    turns: () => turns,
    handoffs: () => comments.filter((c) => c.key.startsWith("merge-handoff:")),
  };
}

test("TECH-5062 still waits for an M7 mergeability fact change", async () => {
  const f = await fixture();
  f.computeOnFirst();
  f.recoverAfter(0);
  expect((await f.run()).outcome).toBe("idle");
  expect((await f.run()).outcome).toBe("idle");
  expect(f.attempts()).toBe(0);
  expect(f.turns()).toBe(1);
  f.settleMergeability();
  expect((await f.run()).outcome).toBe("done");
  expect(f.attempts()).toBe(1);
  expect(f.turns()).toBe(2);
});

test("a temporary merge failure recovers on its one delayed re-check", async () => {
  const f = await fixture(1);
  f.recoverAfter(1);
  expect((await f.run()).outcome).toBe("idle");
  expect(f.attempts()).toBe(1);
  await f.matureRetry();
  expect((await f.run()).outcome).toBe("done");
  expect(f.attempts()).toBe(2);
  expect(f.turns()).toBe(2);
  expect(f.handoffs()).toEqual([]);
});

test("a persistent 405 gets one re-check, one handoff, and no more turns", async () => {
  const f = await fixture();
  expect((await f.run()).outcome).toBe("idle");
  expect((await f.run()).outcome).toBe("idle");
  expect(f.attempts()).toBe(2);
  expect(f.turns()).toBe(2);
  expect(f.handoffs()).toEqual([{ issueId: "i1", key: `merge-handoff:i1:${repo}#7:${head}`, body: expect.stringContaining("Ready for a human to merge") }]);
  // TECH-5090: no policy blocked this merge, so the handoff must not say so.
  const body = f.handoffs()[0]?.body;
  expect(body).toContain("Sergeant's merge failed twice with nothing changing in between: GitHub 405: Pull Request is not mergeable");
  expect(body).not.toMatch(/GitHub refused|This repository needs a human/);
});

test("a fact change after the handoff starts fresh and can merge", async () => {
  const f = await fixture();
  expect((await f.run()).outcome).toBe("idle");
  f.changeBase();
  f.recoverAfter(2);
  expect((await f.run()).outcome).toBe("done");
  expect(f.attempts()).toBe(3);
  expect(f.turns()).toBe(3);
  expect(f.handoffs()).toHaveLength(1);
});
