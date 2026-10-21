import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Conversation, TurnOutput } from "@terros/sergeant-contracts";
import { agent, pr, repo } from "./loop-fixtures.ts";
import { HOLLOW_TURN_NOTE, isHollow } from "./hollow-turn.ts";
import { runLoop } from "./loop.ts";
import type { TaskState } from "./task-state.ts";

// TECH-6490: a turn whose summary said it was editing the issue and starting a worker, with no actions,
// was recorded as a decision to wait: its fingerprint committed, nothing retried, and the task idle with
// no sign anything went wrong. A turn that waits on purpose says so, and records as before.

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

const promising: TurnOutput = {
  summary: "I'm adding the instruction to the issue and starting a worker.",
  actions: [],
  intent: { kind: "act", kinds: ["update_description", "start_worker"] },
};

/** One loop on the task in `dir` (a fresh one unless kept), until it goes idle or `stopAfter` turns. */
async function scenario(output: TurnOutput, opts: { keepDir?: boolean; stopAfter?: number; postComment?: (c: { key: string; body: string }) => Promise<void> } = {}) {
  if (!opts.keepDir) dir = await mkdtemp(join(tmpdir(), "sergeant-hollow-test-"));
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
      linear: {
        readConversation: async () => live,
        postComment: async (c) => (await opts.postComment?.(c), void comments.push(c)),
        createFollowupIssue: async () => { throw new Error("unused"); },
        moveIssueToStarted: async () => ({ moved: false as const }),
        readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
      },
      github: { readPullRequest: async () => ({ ...pr, checks: { sha: pr.headSha, required: [{ name: "validate", state: "pending" }] } }), closePullRequest: async () => {}, mergePolicy: () => "human", mergePullRequest: async () => { throw new Error("unused"); } },
      runner: { start: async () => {}, status: async () => { throw new Error("no runs"); }, cancel: async () => {} },
      reasoner: {
        async turn() {
          if (++turns === opts.stopAfter) await writeFile(join(dir, "STOP"), "");
          return { output, model: "m", promptVersion: "p" };
        },
      },
    },
  );
  const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as TaskState;
  return { result, turns, comments, state };
}

test("a turn is hollow when its intent names actions it did not propose, or it neither acts nor waits", () => {
  const start = { kind: "start_worker" as const, objective: "Do UNF-1.", repositories: [repo] };
  expect(isHollow(promising)).toBe(true);
  // One named action proposed is not enough: the issue edit it also described never happens.
  expect(isHollow({ ...promising, actions: [start] })).toBe(true);
  expect(isHollow({ summary: "s", actions: [] })).toBe(true);
  expect(isHollow({ summary: "s", actions: [start], intent: { kind: "act", kinds: ["start_worker"] } })).toBe(false);
  expect(isHollow({ summary: "s", actions: [], intent: { kind: "wait", on: "CI" } })).toBe(false);
});

test("a turn that promises actions but proposes none is taken again, then flagged in Linear", async () => {
  const { result, turns, comments, state } = await scenario(promising);

  // The first hollow turn leaves the same facts uncommitted, so the retry runs at once; the second is
  // the bound, so the flag is posted, its fingerprint committed, and the loop goes idle.
  expect(turns).toBe(2);
  expect(result.outcome).toBe("idle");
  expect(state.lastFingerprint).toBeDefined();
  expect(state.hollow).toBeUndefined();
  // The retry reads that nothing was done, rather than taking the summary for something done.
  expect(state.recentTurns.map((t) => t.outcomes)).toEqual([[HOLLOW_TURN_NOTE], [HOLLOW_TURN_NOTE]]);
  expect(comments).toEqual([{ issueId: "i1", key: expect.stringMatching(/^hollow-turn:i1:[0-9a-f]{64}$/), body: expect.stringContaining("> I'm adding the instruction to the issue and starting a worker.") }]);
});

test("a restart after a hollow turn keeps the bound: it flags rather than paying for another retry", async () => {
  const first = await scenario(promising, { stopAfter: 1 });
  expect(first.result.outcome).toBe("stopped");
  expect(first.state.lastFingerprint).toBeUndefined();
  await rm(join(dir, "STOP"));

  const restarted = await scenario(promising, { keepDir: true });
  // Counted in memory only, the restart would start again at one retry and take two more turns.
  expect(restarted.turns).toBe(1);
  expect(restarted.comments).toHaveLength(1);
  expect(restarted.state.lastFingerprint).toBeDefined();
});

test("a flag Linear refuses leaves the facts uncommitted and is posted again, with no more turns", async () => {
  let attempts = 0;
  const flaky = async () => {
    if (++attempts === 1) throw new Error("Linear is unavailable");
  };
  const { result, turns, comments, state } = await scenario(promising, { postComment: flaky });

  expect(turns).toBe(2);
  expect(attempts).toBe(2);
  expect(comments).toHaveLength(1);
  expect(result.outcome).toBe("idle");
  expect(state.lastFingerprint).toBeDefined();
});

test("a turn that proposes nothing and says what it waits on records once, with no retry or flag", async () => {
  const { result, turns, comments, state } = await scenario({ summary: "CI is still running on the PR.", actions: [], intent: { kind: "wait", on: "CI on o/canary#7" } });

  expect(turns).toBe(1);
  expect(result.outcome).toBe("idle");
  expect(state.recentTurns.map((t) => t.outcomes)).toEqual([[]]);
  expect(comments).toEqual([]);
});
