import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, CreateFollowup, MergePr, PullRequestFacts, SituationReport } from "@terros/sergeant-contracts";
import { agent, head, pr, repo, review, worker } from "./loop-fixtures.ts";
import { runLoop } from "./loop.ts";

// UNF-708 found the merge gate and the merge effect 24 minutes apart through the file bridge. With
// direct effectors they are one action, so a human comment that lands while reasoning is deciding
// must deny that merge and wake a new turn that sees it, never be overtaken by the merge. The same
// holds for a reassignment (UNF-724), which instead stops the loop; and a merge gets exactly one
// outcome comment, even when the loop is run again. A follow-up reasoning proposes becomes one issue
// however often it is proposed (UNF-729), and the outcome lists it; the merge's feedback, one Sergeant
// feedback comment and label (TECH-5186).

const followup: CreateFollowup = { kind: "create_followup", key: "retry-jitter", title: "Add jitter to retries", category: "concrete_bug", why: "Retries stampede.", description: "Review f1.", relation: "related" };
const merge: MergePr = { kind: "merge_pr", repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" }, feedback: ["CI took 20 minutes to start."] };
const comment = { id: "c1", author: { id: "u1", name: "Human" }, createdAt: "2026-10-02T06:01:00.000Z", updatedAt: "2026-10-02T06:01:00.000Z", body: "Hold on: also update the README." };

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

/**
 * A loop over fakes whose reasoner always proposes the merge and a follow-up; `duringTurn` changes
 * Linear meanwhile.
 */
async function scenario(duringTurn: (live: Conversation, turn: number) => Conversation) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-loop-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: ["run_worker", "run_review"], recentTurns: [] }));

  let live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  const seen: SituationReport[] = [];
  const merged: unknown[] = [];
  const comments: { body: string; key: string }[] = [];
  const filed: string[] = [];
  const closed: { number: number; comment: string }[] = [];
  const labels: string[] = [];

  const run = () => runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, progressComments: false, log: () => {} },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: {
        readConversation: async () => live,
      readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
      moveIssueToStarted: async () => ({ moved: false as const }),
        postComment: async (c) => void comments.push(c),
        createFollowupIssue: async (req) => (filed.push(req.key), { identifier: "UNF-2", url: "https://linear.app/x/issue/UNF-2" }), addLabel: async (_, name) => void labels.push(name) },
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
  return { result: await run(), rerun: run, seen, merged, comments, filed, closed, labels };
}

test("a human comment landing before the merge denies it and wakes a turn that sees it", async () => {
  // The human comments while the first turn is still deciding to merge.
  const { result, rerun, seen, merged, comments, filed, labels } = await scenario((live, turn) => (turn === 1 ? { ...live, humanComments: [comment] } : live));

  expect(seen.map((s) => s.conversation.humanComments.length)).toEqual([0, 1]);
  expect(seen[1]?.recentTurns[0]?.outcomes[0]).toMatch(/denied by M10/);
  expect(merged).toEqual([{ ...merge, squash: { issueIdentifier: "UNF-1", closesIssue: true, builtBy: "Built by Sergeant (worker: p, review: p)" } }]);
  expect(result.outcome).toBe("done");
  // Filed in the first turn; the second turn's identical proposal files nothing new.
  expect(filed).toEqual(["followup:canary_UNF-1:retry-jitter"]);
  expect(seen[1]?.followups).toMatchObject([{ key: "retry-jitter", identifier: "UNF-2" }]);

  // One evidence-bearing outcome, one feedback comment and label, and running it again posts nothing more.
  expect(comments.map((c) => c.body.split(":")[0])).toEqual(["**Merged** [o/canary#7](https", "**Sergeant feedback"]);
  expect(comments[1]?.body).toBe("**Sergeant feedback:** CI took 20 minutes to start.");
  expect(comments[0]?.body).toContain(pr.url);
  expect(comments[0]?.body).toContain(head.slice(0, 12));
  expect(comments[0]?.body).toContain("validate");
  expect(comments[0]?.body).toContain("[UNF-2](https://linear.app/x/issue/UNF-2) Add jitter to retries");
  expect((await rerun()).outcome).toBe("done");
  expect([comments.length, labels]).toEqual([2, ["sergeant-feedback"]]);
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

test("a PR Linear links with no worker report is still polled, and its checks changing wakes a turn", async () => {
  // A human attached PR 7 (or a restart lost the run that reported it): no recorded run names it. PR 8
  // is linked too but merged by someone else, so it is not taken for this task's merge.
  dir = await mkdtemp(join(tmpdir(), "sergeant-loop-test-"));
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [{ repo, number: 7 }, { repo, number: 8 }, { repo: "other/repo", number: 1 }] },
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
