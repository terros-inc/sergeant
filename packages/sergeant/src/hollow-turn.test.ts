import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, TurnOutput } from "@terros/sergeant-contracts";
import { agent, pr, repo } from "./loop-fixtures.ts";
import { HOLLOW_TURN_NOTE } from "./hollow-turn.ts";
import { runLoop } from "./loop.ts";

// TECH-6490: a turn whose summary said it was editing the issue and starting a worker, with no actions,
// was recorded as a decision to wait: its fingerprint committed, nothing retried, and the task idle with
// no sign anything went wrong. A turn that waits on purpose says what on, and records as before.

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

async function scenario(output: TurnOutput) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-hollow-test-"));
  const live: Conversation = {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [{ repo, number: 7 }] },
    humanComments: [],
    agentComments: [],
  };
  const comments: { key: string; body: string }[] = [];
  let turns = 0;
  const result = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, idleMinutes: 0, progressComments: false, log: () => {} },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: { readConversation: async () => live, postComment: async (c) => void comments.push(c), createFollowupIssue: async () => { throw new Error("unused"); }, moveIssueToStarted: async () => ({ moved: false as const }), readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }) },
      github: { readPullRequest: async () => ({ ...pr, checks: { sha: pr.headSha, required: [{ name: "validate", state: "pending" }] } }), closePullRequest: async () => {}, mergePolicy: () => "human", mergePullRequest: async () => { throw new Error("unused"); } },
      runner: { start: async () => {}, status: async () => { throw new Error("no runs"); }, cancel: async () => {} },
      reasoner: { turn: async () => (turns++, { output, model: "m", promptVersion: "p" }) },
    },
  );
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { lastFingerprint?: string; recentTurns: { outcomes: string[] }[] };
  return { result, turns, comments, state };
}

test("a turn that promises actions but proposes none is taken again, then flagged in Linear", async () => {
  const { result, turns, comments, state } = await scenario({ summary: "I'm adding the instruction to the issue and starting a worker.", actions: [] });

  // The first hollow turn leaves the same facts uncommitted, so the retry runs at once; the second is
  // the bound, so its fingerprint is committed and the loop goes idle rather than paying every poll.
  expect(turns).toBe(2);
  expect(result.outcome).toBe("idle");
  expect(state.lastFingerprint).toBeDefined();
  // The retry reads that nothing was done, rather than taking the summary for something done.
  expect(state.recentTurns.map((t) => t.outcomes)).toEqual([[HOLLOW_TURN_NOTE], [HOLLOW_TURN_NOTE]]);
  expect(comments).toEqual([{ issueId: "i1", key: expect.stringMatching(/^hollow-turn:i1:[0-9a-f]{64}$/), body: expect.stringContaining("> I'm adding the instruction to the issue and starting a worker.") }]);
});

test("a turn that proposes nothing and says what it waits on records once, with no retry or flag", async () => {
  const { result, turns, comments, state } = await scenario({ summary: "CI is still running on the PR.", actions: [], waitingOn: "CI on o/canary#7" });

  expect(turns).toBe(1);
  expect(result.outcome).toBe("idle");
  expect(state.recentTurns.map((t) => t.outcomes)).toEqual([[]]);
  expect(comments).toEqual([]);
});
