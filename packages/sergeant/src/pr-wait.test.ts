import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { commentIdFor, type AgentComment, type HumanPullRequestFeedback, type PullRequestFacts, type RefusedMerge } from "@terros/sergeant-contracts";
import { cleanup, dir, issue, pr, saved, scenario, turnOf } from "./budget-scenario.ts";
import { handoffKey } from "./handoff.ts";
import { rereviewKey } from "./rereview.ts";

// TECH-5218: in a repository that needs a human's review, the task's window ran out while Sergeant could
// only wait on that human, and it asked the budget question for time it never spent. Waiting on a human
// PR action is a human wait, and the human's review opens a fresh window, exactly as an answer does.

afterEach(cleanup);

const review = (author: string, state: HumanPullRequestFeedback["state"], at: string): HumanPullRequestFeedback => ({
  id: `review:${author}:${at}`, kind: "review", author, state, body: "", path: null, line: null, commitId: pr.headSha, createdAt: at, updatedAt: at, url: `${pr.url}#pullrequestreview-1`,
});
const comment = (key: string, at: string): AgentComment => ({ id: commentIdFor(key), createdAt: at, body: "..." });

type Wait = { feedback: HumanPullRequestFeedback[]; refusedMerges: RefusedMerge[]; agentComments: AgentComment[] };
const waits: [string, (startedAt: string) => Wait][] = [
  [
    "a code owner's review and a human merge",
    (startedAt) => {
      const refused = { repo: pr.repo, number: pr.number, url: pr.url, headSha: pr.headSha, conversationRevision: "0".repeat(64), reason: "Changes must be approved by a code owner", at: startedAt };
      return { feedback: [], refusedMerges: [{ ...refused, commentPostedAt: startedAt } as RefusedMerge], agentComments: [comment(handoffKey(issue.id, refused), startedAt)] };
    },
  ],
  [
    "a re-review of a human's requested changes",
    (startedAt) => ({
      // Requested before this task started, so it opens no window of its own.
      feedback: [{ ...review("captain", "CHANGES_REQUESTED", new Date(Date.parse(startedAt) - 3_600_000).toISOString()), commitId: "b".repeat(40) }],
      refusedMerges: [],
      agentComments: [comment(rereviewKey(issue.id, pr), startedAt)],
    }),
  ],
];

test.each(waits)("a task waiting on %s does not exhaust its budget, and the review opens a fresh window", async (_name, waitOf) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const startedAt = new Date().toISOString();
  const wait = waitOf(startedAt);
  let feedback = wait.feedback;
  let reviewedAt = "";
  const windows: string[] = [];
  const { posted } = await scenario({
    state: { startedAt, runIds: [], refusedMerges: wait.refusedMerges },
    conversation: { agentComments: wait.agentComments },
    runner: { start: async () => {}, status: async () => { throw new Error("no runs"); }, cancel: async () => {} },
    // Nothing for Sergeant to do but wait on the human.
    reasoner: async (situation) => (windows.push(situation.budget.windowStart), turnOf([])),
    pullRequest: (): PullRequestFacts => ({ ...pr, humanFeedback: feedback }),
    onPoll: async (poll, live) => {
      // The human takes three hours, past the two-hour window, then approves.
      if (poll === 3) vi.setSystemTime(Date.now() + 3 * 3_600_000);
      if (poll === 6) feedback = [...feedback, review("captain", "APPROVED", (reviewedAt = new Date().toISOString()))];
      if (poll >= 9) await writeFile(join(dir, "STOP"), "");
      return live;
    },
    loop: { idleMinutes: 24 * 60 },
  });

  expect(posted).toEqual([]);
  expect(windows).toEqual([startedAt, reviewedAt]);
  expect((await saved()).budget.since).toBe(reviewedAt);
});

test("a task waiting on no human PR action still asks the budget question when its window runs out", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  let turns = 0;
  const { posted } = await scenario({
    state: { startedAt: new Date().toISOString(), runIds: [] },
    runner: { start: async () => {}, status: async () => { throw new Error("no runs"); }, cancel: async () => {} },
    reasoner: async () => (turns++, turnOf([])),
    onPoll: async (poll, live) => {
      if (poll === 3) vi.setSystemTime(Date.now() + 3 * 3_600_000);
      if (poll >= 5) await writeFile(join(dir, "STOP"), "");
      return live;
    },
    loop: { idleMinutes: 24 * 60 },
  });

  expect(turns).toBe(1);
  expect(posted).toEqual([expect.stringMatching(/budget is exhausted \(wall time exhausted at /)]);
});
