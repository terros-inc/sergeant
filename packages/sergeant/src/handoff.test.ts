import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, HumanPullRequestFeedback, MergePr, PullRequestFacts, RunRecord, SituationReport } from "@terros/sergeant-contracts";
import { handoffComment } from "./handoff.ts";
import { runLoop } from "./loop.ts";
import { Wake } from "./wake.ts";

// TECH-4987: on a repository whose policy needs a human to merge (a required code-owner review),
// GitHub refused Sergeant's merge and Sergeant kept proposing it while nothing changed, each webhook
// waking another turn. A policy refusal must produce exactly one "ready for a human to merge" comment
// and no further merge attempt until something changes: here, the code owner approving.

const head = "a".repeat(40);
const repo = "o/sales";
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
  mergeable: true, mergeableState: "clean",
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
const ownerApproval: HumanPullRequestFeedback = {
  id: "review:9",
  kind: "review",
  author: "code-owner",
  state: "APPROVED",
  body: "",
  path: null,
  line: null,
  commitId: head,
  createdAt: "2026-10-03T03:00:00.000Z",
  updatedAt: "2026-10-03T03:00:00.000Z",
  url: `${pr.url}#pullrequestreview-9`,
};

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test.each(["read pull request", "mark ready", "re-read pull request", "request reviewers", "post review summary", "complete handoff"] as const)(
  "a failed human handoff names the %s step and asks a human to take over",
  (humanFailure) => {
  const body = handoffComment({
    repo,
    number: pr.number,
    url: pr.url,
    headSha: head,
    conversationRevision: "revision",
    reason: "GitHub was unavailable",
    temporary: true,
    humanFailure,
    at: new Date().toISOString(),
  });

  expect(body).toContain(`failed twice at the **${humanFailure}** step`);
  expect(body).toContain("The PR is ready for a human to take over the handoff by hand.");
  expect(body).not.toContain("Sergeant's merge failed twice");
  },
);

test("a merge refused by repository policy gets one ready-for-human-merge comment and no retry until something changes", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-handoff-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: ["run_worker", "run_review"], recentTurns: [] }));
  let live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: { id: "agent-v2", name: "Sergeant" }, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  let livePr = pr;
  const attempts: number[] = [];
  const comments: { body: string; key: string }[] = [];
  const seen: SituationReport[] = [];
  const wake = new Wake();

  const result = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, waitingGraceMinutes: 0, completionWaitMinutes: 0, wake, progressComments: false, log: () => {} },
    {
      agentUserId: "agent-v2",
      workerLogin: "sergeant-worker[bot]",
      linear: {
        readConversation: async () => live,
        postComment: async (c) => void comments.push(c),
        createFollowupIssue: async () => { throw new Error("unused"); },
        readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
        moveIssueToStarted: async () => ({ moved: false as const }),
      },
      github: {
        readPullRequest: async () => livePr,
        closePullRequest: async () => {}, mergePolicy: () => "sergeant", mergePullRequest: async () => {
          attempts.push(seen.length);
          if (!livePr.humanFeedback.some((f) => f.author === "code-owner")) return { refused: "Waiting on code owner review from terros-inc/owners." };
          livePr = { ...livePr, state: "merged", mergedSha: "c".repeat(40) };
          live = { ...live, issue: { ...live.issue, state: "Done", stateType: "completed" } };
          return { mergedSha: "c".repeat(40) };
        },
      },
      runner: { start: async () => {}, status: async (id) => (id === worker.runId ? worker : review), cancel: async () => {} },
      reasoner: {
        async turn(situation) {
          seen.push(situation);
          // A wake owes another turn after the first three; after M12 proves the handoff holds, the
          // code owner approves during the fourth.
          if (seen.length < 4) wake.request();
          if (seen.length === 4) livePr = { ...livePr, humanFeedback: [ownerApproval] };
          return { output: { summary: "merge", actions: [merge] }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  expect(result.outcome).toBe("done");
  // Turn 1 tries and is refused; turn 2 is the sole re-check and hands off; turn 3 is refused by M12;
  // turn 4 notices the concurrent approval (M10), and turn 5 merges it.
  expect(attempts).toEqual([1, 2, 5]);
  expect(seen[1]?.recentTurns.at(-1)?.outcomes[0]).toMatch(/denied by GitHub \(refused by repository policy: Waiting on code owner review/);
  expect(seen[1]?.refusedMerges).toEqual([]);
  expect(seen[2]?.refusedMerges).toMatchObject([{ repo, number: 7, headSha: head }]);
  expect(seen[3]?.recentTurns.at(-1)?.outcomes[0]).toMatch(/denied by M12/);

  const handoffs = comments.filter((c) => c.key.startsWith("merge-handoff:"));
  expect(handoffs).toEqual([{ issueId: "i1", key: `merge-handoff:i1:${repo}#7:${head}`, body: expect.stringContaining("Ready for a human to merge") }]);
  expect(handoffs[0]?.body).toContain(pr.url);
  expect(handoffs[0]?.body).toContain(head);
  expect(handoffs[0]?.body).toContain("GitHub refused Sergeant's merge: Waiting on code owner review from terros-inc/owners.");
  expect(handoffs[0]?.body).toContain("This repository needs a human to merge it.");
  expect(comments.map((c) => c.key.split(":")[0])).toEqual(["merge-handoff", "outcome"]);
});
