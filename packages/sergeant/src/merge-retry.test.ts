import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, MergePr, PullRequestFacts, RunRecord, SituationReport } from "@terros/sergeant-contracts";
import { runLoop } from "./loop.ts";

// TECH-4991: a merge that does not happen for a reason the next poll cannot see must not leave the
// loop waiting on a change that never comes. The poll saw the PR mergeable, but the merge's own live
// read found GitHub still computing (M7), or GitHub answered the merge with a temporary 405. Either
// way the next poll looks like the last, so the loop must take another turn, also after a restart.

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
  ["GitHub rejects it with a temporary 405", "405", /failed \(GitHub 405: Pull Request is not mergeable\)/],
  ["GitHub rejects it with a temporary 405, and the loop restarts", "405 restart", /failed/],
  ["M7 denies it, and the loop restarts", "M7 restart", /denied by M7/],
])("a merge that did not happen while the poll saw the PR ready gets another turn (%s)", async (_, path, firstOutcome) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-merge-retry-test-"));
  // A task saved before TECH-4991 holds a temporary 405 recorded as a policy refusal: it must not
  // hold the merge under M12.
  const stale = { repo, number: 7, url: pr.url, headSha: head, conversationRevision: "0".repeat(64), reason: "Pull Request is not mergeable", at: "2026-10-02T00:00:00.000Z", commentPostedAt: "2026-10-02T00:00:01.000Z" };
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: ["run_worker", "run_review"], recentTurns: [], refusedMerges: [stale] }));
  let live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", delegate: { id: "agent-v2", name: "Sergeant" }, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  let livePr = pr;
  // Set during the first turn: the merge's own read, or GitHub's answer to the merge, is not ready yet.
  let notReadyOnce = false;
  const attempts: number[] = [];
  const seen: SituationReport[] = [];

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
        readPullRequest: async () => {
          if (path.startsWith("M7") && notReadyOnce) return (notReadyOnce = false), { ...livePr, mergeable: null };
          return livePr;
        },
        mergePullRequest: async () => {
          attempts.push(seen.length);
          if (notReadyOnce) throw ((notReadyOnce = false), new Error("GitHub 405: Pull Request is not mergeable"));
          livePr = { ...livePr, state: "merged", mergedSha: "c".repeat(40) };
          live = { ...live, issue: { ...live.issue, state: "Done" } };
          return { mergedSha: "c".repeat(40) };
        },
      },
      runner: { start: async () => {}, status: async (id) => (id === worker.runId ? worker : review), cancel: async () => {} },
      reasoner: {
        async turn(situation) {
          seen.push(situation);
          if (seen.length === 1) {
            notReadyOnce = true;
            if (path.endsWith("restart")) await writeFile(join(dir, "STOP"), "");
          }
          return { output: { summary: "merge", actions: [merge] }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  if (path.endsWith("restart")) {
    expect((await run()).outcome).toBe("stopped");
    await rm(join(dir, "STOP"));
  }
  expect((await run()).outcome).toBe("done");
  expect(seen).toHaveLength(2);
  expect(seen[0]?.refusedMerges).toEqual([]);
  
  expect(seen[1]?.recentTurns.at(-1)?.outcomes[0]).toMatch(firstOutcome);
  expect(attempts).toEqual(path.startsWith("M7") ? [2] : [1, 2]);
});
