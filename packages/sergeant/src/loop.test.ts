import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, CreateFollowup, MergePr, PullRequestFacts, RunRecord, SituationReport } from "@terros/sergeant-contracts";
import { runLoop } from "./loop.ts";

// UNF-708 found the merge gate and the merge effect 24 minutes apart through the file bridge. With
// direct effectors they are one action, so a human comment that lands while reasoning is deciding
// must deny that merge and wake a new turn that sees it, never be overtaken by the merge. The same
// holds for a reassignment (UNF-724), which instead stops the loop; and a merge gets exactly one
// outcome comment, even when the loop is run again. A non-blocking finding merged as is becomes one
// follow-up issue however often reasoning proposes it (UNF-729), and the outcome lists it.

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
  report: {
    reportVersion: "s2-review-report/1",
    reviewed: [{ repo, number: 7, headSha: head }],
    verdict: "approve",
    findings: [{ id: "f1", severity: "non_blocking", description: "Retries have no jitter." }],
    summary: "",
  },
};
const followup: CreateFollowup = { kind: "create_followup", key: "retry-jitter", title: "Add jitter to retries", description: "Review f1.", relation: "related" };
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
    knownGaps: ["No live check yet."],
    followups: [],
  },
};
const merge: MergePr = { kind: "merge_pr", repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } };
const comment = { id: "c1", author: { id: "u1", name: "Human" }, createdAt: "2026-10-02T06:01:00.000Z", updatedAt: "2026-10-02T06:01:00.000Z", body: "Hold on: also update the README." };

const agent = { id: "agent-v2", name: "Sergeant" };

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

/**
 * A loop over fakes whose reasoner always proposes the merge and a follow-up for the review's
 * non-blocking finding; `duringTurn` changes Linear meanwhile.
 */
async function scenario(duringTurn: (live: Conversation, turn: number) => Conversation) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-loop-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: ["run_worker", "run_review"], recentTurns: [] }));

  let live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  const seen: SituationReport[] = [];
  const merged: unknown[] = [];
  const comments: { body: string; key: string }[] = [];
  const filed: string[] = [];
  const closed: { number: number; comment: string }[] = [];

  const run = () => runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, log: () => {} },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: {
        readConversation: async () => live,
      readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
      moveIssueToStarted: async () => ({ moved: false as const }),
        postComment: async (c) => void comments.push(c),
        createFollowupIssue: async (req) => (filed.push(req.key), { identifier: "UNF-2", url: "https://linear.app/x/issue/UNF-2" }),
      },
      github: {
        readPullRequest: async () => pr,
        closePullRequest: async ({ number, comment }) => void closed.push({ number, comment }),
        mergePullRequest: async (req) => {
          merged.push(req);
          live = { ...live, issue: { ...live.issue, state: "Done", stateType: "completed" } };
          return { mergedSha: "c".repeat(40) };
        },
      },
      runner: { start: async () => {}, status: async (id) => (id === worker.runId ? worker : review), cancel: async () => {} },
      reasoner: {
        async turn(situation) {
          seen.push(situation);
          live = duringTurn(live, seen.length);
          return { output: { summary: "merge", actions: [merge, followup] }, model: "m", promptVersion: "p" };
        },
      },
    },
  );
  return { result: await run(), rerun: run, seen, merged, comments, filed, closed };
}

test("a human comment landing before the merge denies it and wakes a turn that sees it", async () => {
  // The human comments while the first turn is still deciding to merge.
  const { result, rerun, seen, merged, comments, filed } = await scenario((live, turn) => (turn === 1 ? { ...live, humanComments: [comment] } : live));

  expect(seen.map((s) => s.conversation.humanComments.length)).toEqual([0, 1]);
  expect(seen[1]?.recentTurns[0]?.outcomes[0]).toMatch(/denied by M10/);
  expect(merged).toEqual([{ ...merge }]);
  expect(result.outcome).toBe("done");
  // Filed in the first turn; the second turn's identical proposal files nothing new.
  expect(filed).toEqual(["followup:canary_UNF-1:retry-jitter"]);
  expect(seen[1]?.followups).toMatchObject([{ key: "retry-jitter", identifier: "UNF-2" }]);

  // One evidence-bearing outcome, and running the command again posts nothing more.
  expect(comments).toHaveLength(1);
  expect(comments[0]?.body).toContain(pr.url);
  expect(comments[0]?.body).toContain(head.slice(0, 12));
  expect(comments[0]?.body).toContain("validate");
  expect(comments[0]?.body).toContain("[UNF-2](https://linear.app/x/issue/UNF-2) Add jitter to retries");
  expect((await rerun()).outcome).toBe("done");
  expect(comments).toHaveLength(1);
  expect(filed).toHaveLength(1);
});

test("a reassignment landing before the merge denies it and stops the loop, closing the task's PR", async () => {
  // A human hands the issue to V1's agent while the turn is deciding to merge.
  const { result, seen, merged, comments, filed, closed } = await scenario((live) => ({ ...live, issue: { ...live.issue, delegate: { id: "agent-v1", name: "Sergeant V1" } } }));

  expect(seen).toHaveLength(1);
  expect([...merged, ...filed]).toEqual([]);
  // Undelegation is the human's cancel (TECH-4989): the open PR is closed, and the stop said once.
  expect(closed).toEqual([{ number: 7, comment: "Closed: the Linear issue is no longer delegated to Sergeant." }]);
  expect(comments).toEqual([expect.objectContaining({ key: expect.stringMatching(/^cancel:i1:/), body: expect.stringContaining(`Closed [${repo}#7](${pr.url})`) })]);
  expect(result).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("Sergeant V1") });
});

test("a merge state.json never recorded is read back from GitHub and still gets exactly one outcome", async () => {
  // The process died after GitHub merged the PR but before state.json was saved: the restart sees
  // pre-merge state, the PR already merged, and a reasoner with nothing left to propose.
  dir = await mkdtemp(join(tmpdir(), "sergeant-loop-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds: ["run_worker", "run_review"], recentTurns: [] }));
  const mergedSha = "c".repeat(40);
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "Done", stateType: "completed", delegate: agent, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  const comments: { body: string; key: string }[] = [];
  const turns: SituationReport[] = [];
  const run = () => runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, idleMinutes: 0, log: () => {} },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: { readConversation: async () => live, postComment: async (c) => void comments.push(c), createFollowupIssue: async () => { throw new Error("unused"); }, moveIssueToStarted: async () => ({ moved: false as const }), readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }) },
      github: {
        readPullRequest: async () => ({ ...pr, state: "merged", mergedSha }),
        closePullRequest: async () => {}, mergePullRequest: async () => { throw new Error("already merged"); },
      },
      runner: { start: async () => {}, status: async (id) => (id === worker.runId ? worker : review), cancel: async () => {} },
      reasoner: {
        async turn(situation) {
          turns.push(situation);
          return { output: { summary: "already merged; nothing to do", actions: [] }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  expect((await run()).outcome).toBe("done");
  expect(turns).toEqual([]);
  expect(comments).toHaveLength(1);
  expect(comments[0]?.key).toBe(`outcome:i1:${repo}#7:${mergedSha}`);
  expect(comments[0]?.body).toContain(head.slice(0, 12));
  expect(comments[0]?.body).toContain("a fresh review approved this exact head");
  expect(comments[0]?.body).toContain("No live check yet");
  expect((await run()).outcome).toBe("done");
  expect(comments).toHaveLength(1);
});

test("a PR Linear links with no worker report is still polled, and its checks changing wakes a turn", async () => {
  // A human attached PR 7 (or a restart lost the run that reported it): no recorded run names it. PR 8
  // is linked too but merged by someone else, so it is not taken for this task's merge.
  dir = await mkdtemp(join(tmpdir(), "sergeant-loop-test-"));
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, linkedPullRequests: [{ repo, number: 7 }, { repo, number: 8 }, { repo: "other/repo", number: 1 }] },
    humanComments: [],
    agentComments: [],
  };
  let checks: PullRequestFacts["checks"] = { sha: head, required: [{ name: "validate", state: "pending" }] };
  const other: PullRequestFacts = { ...pr, number: 8, url: `https://github.com/${repo}/pull/8`, author: "a-human", state: "merged", mergedSha: "d".repeat(40) };
  const read: string[] = [];
  const seen: SituationReport[] = [];

  const result = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, idleMinutes: 0, log: () => {} },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: { readConversation: async () => live, postComment: async () => {}, createFollowupIssue: async () => { throw new Error("unused"); }, moveIssueToStarted: async () => ({ moved: false as const }), readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }) },
      github: {
        readPullRequest: async (r, n) => (read.push(`${r}#${n}`), n === 7 ? { ...pr, checks } : other),
        closePullRequest: async () => {}, mergePullRequest: async () => { throw new Error("unused"); },
      },
      runner: { start: async () => {}, status: async () => { throw new Error("no runs"); }, cancel: async () => {} },
      reasoner: {
        async turn(situation) {
          seen.push(situation);
          checks = { sha: head, required: [{ name: "validate", state: "passed" }] };
          return { output: { summary: "waiting on CI", actions: [] }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  expect(result.outcome).toBe("idle");
  expect(new Set(read)).toEqual(new Set([`${repo}#7`, `${repo}#8`]));
  expect(seen.map((s) => s.pullRequests.find((p) => p.number === 7)?.checks.required[0]?.state)).toEqual(["pending", "passed"]);
});

// UNF-734: a task with a `Part of` PR and a closing `Fixes` PR. Only the closing PR's merge
// completes the task, it must merge last (M9), and a restart after only the `Part of` merge resumes
// the task instead of posting an outcome.
test.each([
  ["with both PRs open", false],
  ["restarted after only the Part of PR merged", true],
])("a Part of merge keeps the task working until the closing PR merges (%s)", async (_, partMerged) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-loop-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: ["run_worker"], recentTurns: [] }));
  const reported = (number: number, closesIssue: boolean) =>
    ({ repo, number, headSha: head, url: `https://github.com/${repo}/pull/${number}`, closesIssue, review: { required: false, reason: "docs" } });
  const twoPrs: RunRecord = { ...worker, report: { ...worker.report!, pullRequests: [reported(7, false), reported(8, true)] } } as RunRecord;
  const prs = new Map<number, PullRequestFacts>([
    [7, { ...pr, body: "Part of UNF-1", ...(partMerged && { state: "merged", mergedSha: "d".repeat(40) }) }],
    [8, { ...pr, number: 8, url: `https://github.com/${repo}/pull/8`, body: "Fixes UNF-1" }],
  ]);
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, linkedPullRequests: [{ repo, number: 7 }, { repo, number: 8 }] },
    humanComments: [],
    agentComments: [],
  };
  const merges: number[] = [];
  const comments: { body: string; key: string }[] = [];
  const turns: SituationReport[] = [];
  const mergeOf = (number: number): MergePr => ({ kind: "merge_pr", repo, number, expectedHeadSha: head, reviewStanding: { kind: "not_required", workerRunId: "run_worker" } });

  const result = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, completionWaitMinutes: 0, log: () => {} },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: { readConversation: async () => live, postComment: async (c) => void comments.push(c), createFollowupIssue: async () => { throw new Error("unused"); }, moveIssueToStarted: async () => ({ moved: false as const }), readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }) },
      github: {
        readPullRequest: async (_repo, number) => prs.get(number)!,
        closePullRequest: async () => {}, mergePullRequest: async ({ number }) => {
          merges.push(number);
          const mergedSha = String(number).repeat(40);
          prs.set(number, { ...prs.get(number)!, state: "merged", mergedSha });
          return { mergedSha };
        },
      },
      runner: { start: async () => {}, status: async () => twoPrs, cancel: async () => {} },
      reasoner: {
        async turn(situation) {
          turns.push(situation);
          // Proposes the closing PR first every turn: M9 holds it until the Part of PR has merged.
          return { output: { summary: "merge", actions: [mergeOf(8), mergeOf(7)] }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  expect(merges).toEqual(partMerged ? [8] : [7, 8]);
  expect(turns).toHaveLength(partMerged ? 1 : 2);
  if (!partMerged) expect(turns[1]?.recentTurns[0]?.outcomes[0]).toMatch(/denied by M9/);
  expect(result.outcome).toBe("merged_not_done");
  expect(comments.map((c) => c.key)).toEqual([`outcome:i1:${repo}#8:${"8".repeat(40)}`]);
});
