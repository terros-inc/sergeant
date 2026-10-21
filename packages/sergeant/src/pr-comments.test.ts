import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, PullRequestFacts, PullRequestFeedback, RunRecord, RunSpec, SituationReport } from "@terros/sergeant-contracts";
import { runLoop } from "./loop.ts";

// TECH-6166: after a review on the task's PR, reasoning said its data did not show the comments yet and
// started a worker just to read them on GitHub, and a review bot's comments were ignored altogether. A
// bot's review with inline comments must wake a turn by itself and be in that turn's Situation Report
// (author, time, file and line, body); the worker's own reply in the thread answers it and wakes nothing,
// and nor does Sergeant's own comment on the PR (it posted it in a turn).

const head = "a".repeat(40);
const repo = "o/r";
const url = `https://github.com/${repo}/pull/7`;
const at = (minute: number) => `2026-10-03T02:${String(minute).padStart(2, "0")}:00.000Z`;
const pr: PullRequestFacts = {
  repo, number: 7, url, state: "open", draft: false, author: "sergeant-worker[bot]", headSha: head, mergedSha: null, baseRef: "main", body: "Fixes UNF-1", changedFiles: [],
  mergeable: true, mergeableState: "clean", checks: { sha: head, required: [{ name: "validate", state: "pending" }] }, humanFeedback: [], botFeedback: [],
};
const review: PullRequestFeedback[] = [
  { id: "review:3", kind: "review", author: "review-bot[bot]", state: "COMMENTED", body: "2 findings.", path: null, line: null, commitId: head, createdAt: at(5), updatedAt: at(5), url: `${url}#pullrequestreview-3` },
  { id: "review_comment:4", kind: "review_comment", author: "review-bot[bot]", state: null, body: "Possible null dereference.", path: "src/a.ts", line: 10, commitId: head, createdAt: at(5), updatedAt: at(5), url: `${url}#discussion_r4` },
  { id: "review_comment:5", kind: "review_comment", author: "review-bot[bot]", state: null, body: "Nit: rename `cfg`.", path: "src/b.ts", line: 2, commitId: head, createdAt: at(5), updatedAt: at(5), url: `${url}#discussion_r5` },
];
const reply: PullRequestFeedback = { ...review[2]!, id: "review_comment:6", author: "sergeant-worker[bot]", body: "Keeping `cfg`: the package uses it throughout.", createdAt: at(7), updatedAt: at(7), url: `${url}#discussion_r6`, inReplyTo: "review_comment:5" };
const own: PullRequestFeedback = { ...review[0]!, id: "comment:7", kind: "comment", author: "sergeant-control[bot]", state: null, body: "Ready for your review.", createdAt: at(8), updatedAt: at(8), url: `${url}#issuecomment-7` };
const worker: RunRecord = {
  runId: "run_worker", role: "worker", status: "succeeded", provider: "p", model: "m",
  report: { reportVersion: "s2-worker-report/1", outcome: "completed", summary: "", knownGaps: [], followups: [], pullRequests: [{ repo, number: 7, headSha: head, url, closesIssue: true, review: { required: false, reason: "small" } }] },
};

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test("a bot's review wakes a turn whose Situation Report lists its inline comments; the worker's reply and Sergeant's own comment wake none", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-pr-comments-test-"));
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 0, runIds: [worker.runId], recentTurns: [] }));
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: { id: "agent-v2", name: "Sergeant" }, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  let livePr = pr;
  let readsAfterReply = 0;
  const seen: SituationReport[] = [];
  const started: RunSpec[] = [];
  const stop = new AbortController();

  await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, log: () => {}, signal: stop.signal },
    {
      agentUserId: "agent-v2",
      workerLogin: "sergeant-worker[bot]",
      controlPlaneLogin: "sergeant-control[bot]",
      linear: { readConversation: async () => live, postComment: async () => {}, createFollowupIssue: async () => { throw new Error("unused"); }, moveIssueToStarted: async () => ({ moved: false as const }), readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }) },
      github: {
        readPullRequest: async () => {
          if (livePr.botFeedback?.includes(reply) && ++readsAfterReply === 5) stop.abort();
          return livePr;
        },
        closePullRequest: async () => {},
        mergePullRequest: async () => { throw new Error("unused"); },
      },
      runner: { start: async (spec) => void started.push(spec), status: async () => worker, cancel: async () => {} },
      reasoner: {
        async turn(situation) {
          seen.push(situation);
          // After a first turn that waits on CI, the bot reviews; nothing else changes. After the second
          // turn the worker's reply lands in the nit's thread, and Sergeant comments on the PR.
          livePr = seen.length === 1 ? { ...livePr, botFeedback: review } : { ...livePr, botFeedback: [...review, reply, own] };
          return { output: { summary: "waiting", actions: [], waitingOn: "the next change" }, model: "m", promptVersion: "p" };
        },
      },
    },
  );

  expect(seen).toHaveLength(2);
  const listed = seen[1]!.pullRequests[0]!.botFeedback!;
  expect(listed.filter((f) => f.kind === "review_comment").map((f) => [f.author, f.createdAt, f.path, f.line, f.body])).toEqual([
    ["review-bot[bot]", at(5), "src/a.ts", 10, "Possible null dereference."],
    ["review-bot[bot]", at(5), "src/b.ts", 2, "Nit: rename `cfg`."],
  ]);
  // Bots are findings, not human input: the conversation revision a merge is checked against is unchanged.
  expect(seen[1]!.conversationRevision).toBe(seen[0]!.conversationRevision);
  expect(started).toEqual([]);
});
