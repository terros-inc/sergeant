import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, HumanPullRequestFeedback, ProposedAction, PullRequestFacts, RunRecord, RunSpec, SituationReport } from "@terros/sergeant-contracts";
import { workerBrief } from "@terros/sergeant-runner";
import { runLoop } from "./loop.ts";

// TECH-4987: the captain's "Request changes" review and inline comment on the task PR were invisible:
// Sergeant logged "nothing changed" and proposed merging over them. Human PR feedback must wake a turn
// within one poll with nothing else changing, appear in that turn's Situation Report, keep the merge
// refused (M8) despite Sergeant's own approving review, and reach the successor worker's brief.

const head = "a".repeat(40);
const repo = "o/sales";
const url = `https://github.com/${repo}/pull/7`;
const at = "2026-10-03T02:00:00.000Z";
const pr: PullRequestFacts = {
  repo, number: 7, url, state: "open", draft: false, author: "sergeant-worker[bot]", headSha: head, mergedSha: null, baseRef: "main", body: "Fixes UNF-1", mergeable: true, mergeableState: "clean",
  checks: { sha: head, required: [{ name: "validate", state: "passed" }] },
  humanFeedback: [],
};
const captain: HumanPullRequestFeedback[] = [
  { id: "review_comment:4", kind: "review_comment", author: "captain", state: null, body: "This links terros-wiki.", path: "docs/skill.md", line: 12, commitId: head, createdAt: at, updatedAt: at, url: `${url}#discussion_r4` },
  { id: "review:5", kind: "review", author: "captain", state: "CHANGES_REQUESTED", body: "Remove references to terros-wiki.", path: null, line: null, commitId: head, createdAt: at, updatedAt: at, url: `${url}#pullrequestreview-5` },
];
const records: RunRecord[] = [
  {
    runId: "run_worker", role: "worker", status: "succeeded", provider: "p", model: "m",
    report: { reportVersion: "s2-worker-report/1", outcome: "completed", summary: "", knownGaps: [], followups: [], pullRequests: [{ repo, number: 7, headSha: head, url, closesIssue: true, review: { required: true, reason: "" } }] },
  },
  {
    runId: "run_review", role: "reviewer", status: "succeeded", provider: "p", model: "m",
    report: { reportVersion: "s2-review-report/1", reviewed: [{ repo, number: 7, headSha: head }], verdict: "approve", findings: [], summary: "" },
  },
];

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test("a human's requested changes on the PR wake a turn, block the merge, and reach the successor's brief", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-human-review-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: records.map((r) => r.runId), recentTurns: [] }));
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: { id: "agent-v2", name: "Sergeant" }, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  let livePr = pr;
  const seen: SituationReport[] = [];
  const started: RunSpec[] = [];
  const merged: unknown[] = [];
  const stop = new AbortController();

  const result = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, log: () => {}, signal: stop.signal },
    {
      agentUserId: "agent-v2",
      workerLogin: "sergeant-worker[bot]",
      linear: { readConversation: async () => live, postComment: async () => {}, createFollowupIssue: async () => { throw new Error("unused"); }, moveIssueToStarted: async () => ({ moved: false as const }), readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }) },
      github: { readPullRequest: async () => livePr, closePullRequest: async () => {}, mergePolicy: () => "sergeant", mergePullRequest: async (req) => (merged.push(req), { mergedSha: "c".repeat(40) }) },
      runner: {
        start: async (spec) => void started.push(spec),
        status: async (id) => records.find((r) => r.runId === id) ?? { runId: id, role: "worker", status: "succeeded", provider: "p", model: "m", report: null },
        cancel: async () => {},
      },
      reasoner: {
        async turn(situation) {
          // A third turn is past what this test asks: end the loop at its next poll.
          if (seen.length === 2) return (stop.abort(), { output: { summary: "done", actions: [] }, model: "m", promptVersion: "p" });
          seen.push(situation);
          // After the first turn decided to wait, the captain requests changes; nothing else changes.
          if (seen.length === 1) livePr = { ...livePr, humanFeedback: captain };
          // The second turn proposes the merge anyway, as on TECH-4975, and a successor.
          const actions: ProposedAction[] = seen.length === 1 ? [] : [
            { kind: "merge_pr", repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } },
            { kind: "start_worker", objective: "Address the captain's review on the same PR.", repositories: [repo] },
          ];
          return { output: { summary: "decided", actions }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  expect(result.outcome).toBe("stopped");
  expect(seen.map((s) => s.pullRequests[0]?.humanFeedback.map((f) => f.id))).toEqual([[], ["review_comment:4", "review:5"]]);
  expect(seen[1]?.conversationRevision).not.toBe(seen[0]?.conversationRevision);
  // Sergeant's own approving review of this head does not outrank the captain's request.
  const turns = (await readFile(join(dir, "turns.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { outcomes: { status: string; rule?: string }[] });
  expect(turns[1]?.outcomes).toMatchObject([{ status: "denied", rule: "M8" }, { status: "done" }]);
  expect(merged).toEqual([]);
  expect(started).toHaveLength(1);

  const brief = workerBrief(started[0] as Extract<RunSpec, { role: "worker" }>, []);
  expect(brief).toContain("captain — review, CHANGES_REQUESTED");
  expect(brief).toContain("> Remove references to terros-wiki.");
  expect(brief).toContain("captain — inline comment on `docs/skill.md:12`");
  expect(brief).toContain("> This links terros-wiki.");
});
