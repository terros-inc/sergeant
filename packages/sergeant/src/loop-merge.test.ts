import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, MergePr, PullRequestFacts, RunRecord, SituationReport } from "@terros/sergeant-contracts";
import { agent, head, pr, repo, review, worker } from "./loop-fixtures.ts";
import { runLoop } from "./loop.ts";

// Which merge ends the task (loop.ts): only the worker's closing PR, even one merged while
// `state.json` did not record it, and its outcome is posted exactly once.

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test("a merge state.json never recorded is read back from GitHub and still gets exactly one outcome", async () => {
  // The process died after GitHub merged the PR but before state.json was saved: the restart sees
  // pre-merge state, the PR already merged, and a reasoner with nothing left to propose.
  dir = await mkdtemp(join(tmpdir(), "sergeant-loop-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds: ["run_worker", "run_review"], recentTurns: [] }));
  const mergedSha = "c".repeat(40);
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "Done", stateType: "completed", delegate: agent, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [{ repo, number: 7 }] },
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
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [{ repo, number: 7 }, { repo, number: 8 }] },
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
