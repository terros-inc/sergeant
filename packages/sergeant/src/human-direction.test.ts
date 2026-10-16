import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  commentIdFor,
  conversationRevision,
  issueRevision,
  QUESTION_HEADING,
  type AgentComment,
  type Conversation,
  type HumanPullRequestFeedback,
  type PullRequestFacts,
  type RefusedMerge,
} from "@terros/sergeant-contracts";
import { cleanup, dir, issue, pr, saved, scenario, turnOf } from "./budget-scenario.ts";
import { handoffKey } from "./handoff.ts";
import { questionKey } from "./question.ts";
import { Slot } from "./slots.ts";

// TECH-6165: the budget counts only active time, the time a run or a planner turn is running. A task
// handed to a human to merge ran out its window with nothing running and logged "budget exhausted …
// parking quietly" every poll; then a human's review after that went unanswered until they wrote
// "Extend". Now a wait uses none of the window, any human direction starts a fresh window and a turn, and
// a change no human made resumes the task in the window it has; a merge or close of the handed-off PR, or
// an edit to the issue, which nobody is credited with, takes a turn even in an exhausted window, and opens
// no fresh one. Sergeant's own open question stays open whatever its PR's reviews say.

afterEach(cleanup);

const hour = 3_600_000;
const feedback = (author: string, kind: HumanPullRequestFeedback["kind"], at: string): HumanPullRequestFeedback => ({
  id: `${kind}:${author}:${at}`, kind, author, state: kind === "review" ? "CHANGES_REQUESTED" : null, body: "Rename the flag.", path: null, line: null,
  commitId: kind === "comment" ? null : pr.headSha, createdAt: at, updatedAt: at, url: `${pr.url}#${kind}`,
});

/** Sergeant handed the PR to a human to merge at `at`: the refused merge and its head-keyed comment. */
function handedOff(at: string): { refusedMerges: RefusedMerge[]; agentComments: AgentComment[] } {
  const refused = { repo: pr.repo, number: pr.number, url: pr.url, headSha: pr.headSha, conversationRevision: "0".repeat(64), reason: "Changes must be approved by a code owner", at };
  return {
    refusedMerges: [{ ...refused, commentPostedAt: at, fingerprint: "before" } as RefusedMerge],
    agentComments: [{ id: commentIdFor(handoffKey(issue.id, refused)), createdAt: at, body: "Ready for a human to merge." }],
  };
}

/**
 * A task with nothing running that has just handed its PR to a human, `activeMs` of its two-hour window
 * already used by the work before. `onPoll` changes the world; the loop stops after `polls`.
 */
async function waiting(opts: {
  activeMs: number;
  polls: number;
  /** More of the task's `state.json`. */
  state?: Record<string, unknown>;
  /** More of the conversation. */
  conversation?: (live: Conversation) => Partial<Conversation>;
  onPoll: (poll: number, world: { pullRequest: PullRequestFacts; live: Conversation }) => { pullRequest?: PullRequestFacts; live?: Conversation } | void;
}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const startedAt = new Date(Date.now() - 3 * hour).toISOString();
  const wait = handedOff(new Date().toISOString());
  let pullRequest = pr;
  const logs: string[] = [];
  const turns: string[] = [];
  const base: Conversation = { issue, humanComments: [], agentComments: wait.agentComments };
  const run = await scenario({
    state: { startedAt, runIds: [], refusedMerges: wait.refusedMerges, budget: { activeMs: opts.activeMs }, ...opts.state },
    conversation: { ...base, ...opts.conversation?.(base) },
    runner: { start: async () => {}, status: async () => { throw new Error("no runs"); }, cancel: async () => {} },
    // Nothing for Sergeant to do but wait on the human; each turn records the window it saw.
    reasoner: async (situation) => (turns.push(situation.budget.windowStart), turnOf([])),
    pullRequest: () => pullRequest,
    onPoll: async (poll, live) => {
      const changed = opts.onPoll(poll, { pullRequest, live });
      if (changed?.pullRequest) pullRequest = changed.pullRequest;
      if (poll >= opts.polls) await writeFile(join(dir, "STOP"), "");
      return changed?.live ?? live;
    },
    loop: { idleMinutes: 24 * 60, log: (line) => void logs.push(line) },
  });
  const quiet = logs.filter((l) => /budget exhausted|parking quietly/.test(l));
  return { ...run, startedAt, logs, quiet, turns };
}

test("a task waiting on a merge past its window's length uses none of it, and posts and logs nothing of its budget", async () => {
  const { posted, quiet, turns, startedAt } = await waiting({
    activeMs: 30 * 60_000,
    polls: 8,
    // The human takes five hours, well past the two-hour window, and has not merged yet.
    onPoll: (poll) => void (poll === 3 && vi.setSystemTime(Date.now() + 5 * hour)),
  });

  expect(posted).toEqual([]);
  expect(quiet).toEqual([]);
  // One turn saw the handoff, in the task's first window; the wait took none.
  expect(turns).toEqual([startedAt]);
  const { budget } = await saved();
  expect(budget.since).toBeUndefined();
  expect((budget as { activeMs?: number }).activeMs).toBeLessThan(31 * 60_000);
});

test("a human's PR review after the window ran out starts a fresh window and a turn", async () => {
  let reviewedAt = "";
  const { posted, quiet, turns } = await waiting({
    // The work before the handoff used the whole window: the wait is parked, and says nothing of it.
    activeMs: 3 * hour,
    polls: 6,
    onPoll: (poll, { pullRequest }) => {
      if (poll !== 3) return;
      reviewedAt = new Date().toISOString();
      return { pullRequest: { ...pullRequest, humanFeedback: [feedback("captain", "review", reviewedAt), feedback("captain", "review_comment", reviewedAt)] } };
    },
  });

  expect(posted).toEqual([]);
  expect(quiet).toEqual([]);
  expect(turns).toEqual([reviewedAt]);
  const { budget } = await saved();
  expect(budget.since).toBe(reviewedAt);
  // The fresh window is the task's second: its budget question would be keyed by that number.
  expect(budget.windowSeq).toBe(1);
});

test("a change no human made after the window's length wakes a turn in the window it has", async () => {
  const { posted, quiet, turns, startedAt } = await waiting({
    activeMs: 30 * 60_000,
    polls: 8,
    onPoll: (poll, { pullRequest }) => {
      if (poll === 3) vi.setSystemTime(Date.now() + 5 * hour);
      // A review bot's required check fails on the PR: GitHub keeps an App's comments out of human feedback.
      if (poll === 5) return { pullRequest: { ...pullRequest, checks: { sha: pr.headSha, required: [{ name: "validate", state: "failed" }] } } };
    },
  });

  // Two turns, both in the task's first window: the bot woke the second, reset nothing, and the five
  // hours waited left it with the time it had.
  expect(turns).toEqual([startedAt, startedAt]);
  expect(posted).toEqual([]);
  expect(quiet).toEqual([]);
  const { budget } = await saved();
  expect(budget.since).toBeUndefined();
  expect(budget.windowSeq).toBeUndefined();
});

test("a human's PR review while Sergeant's own question is open leaves that question pending", async () => {
  let questionAt = "";
  const { posted, turns, logs } = await waiting({
    activeMs: 30 * 60_000,
    polls: 6,
    // Sergeant asked the owner something, unrelated to the PR, and nobody has answered on the issue.
    conversation: (live) => {
      questionAt = new Date().toISOString();
      return { agentComments: [...live.agentComments, { id: commentIdFor(questionKey(issue.id, conversationRevision(live))), createdAt: questionAt, body: `${QUESTION_HEADING}\n\nShip the flag on, or off?` }] };
    },
    onPoll: (poll, { pullRequest }) => {
      if (poll !== 3) return;
      vi.setSystemTime(Date.now() + 60_000);
      return { pullRequest: { ...pullRequest, humanFeedback: [feedback("captain", "review", new Date().toISOString())] } };
    },
  });

  // The review answers nothing Sergeant asked: no turn, no fresh window, and the question still waits.
  expect(posted).toEqual([]);
  expect(turns).toEqual([]);
  expect(logs.at(-1)).toBe(`waiting: the question posted at ${questionAt} has no human reply yet`);
  const { budget } = await saved();
  expect(budget.since).toBeUndefined();
  expect(budget.windowSeq).toBeUndefined();
});

test.each([
  ["closed", { state: "closed" as const }],
  ["merged", { state: "merged" as const, mergedSha: "c".repeat(40) }],
])("a handed-off PR %s after the window ran out takes a turn in that window, and opens no fresh one", async (_name, change) => {
  const { posted, logs, turns, startedAt } = await waiting({
    activeMs: 3 * hour,
    polls: 6,
    onPoll: (poll, { pullRequest }) => {
      if (poll !== 3) return;
      // Not reported closing by a worker: the task goes on, it does not end on this merge.
      return { pullRequest: { ...pullRequest, ...change } };
    },
  });

  // GitHub does not say who merged or closed it, so it is reconciled, not taken as direction.
  expect(turns).toEqual([startedAt]);
  const { budget } = await saved();
  expect(budget.since).toBeUndefined();
  expect(budget.windowSeq).toBeUndefined();
  // Nothing of the budget while the task waited; once reconciled and no longer waiting, the exhausted
  // window asks its question.
  const turnLog = logs.findIndex((l) => l.startsWith("turn "));
  expect(logs.slice(0, turnLog).filter((l) => /budget exhausted|parking quietly/.test(l))).toEqual([]);
  expect(posted).toEqual([expect.stringContaining("Sergeant stopped this task: its budget is exhausted")]);
});

test("an edit to the issue after the window ran out takes a turn in that window, and opens no fresh one", async () => {
  const lastTurnAt = new Date(Date.now() - 60_000).toISOString();
  const { posted, quiet, turns, startedAt } = await waiting({
    activeMs: 3 * hour,
    polls: 8,
    // The last turn read the issue as it was.
    state: { lastTurnAt, seen: { revision: "0".repeat(64), issue: issueRevision(issue) } },
    onPoll: (poll, { live }) => {
      if (poll !== 3) return;
      return { live: { ...live, issue: { ...live.issue, description: "D, and keep the old flag working." } } };
    },
  });

  // Linear does not say who edited it, so it wakes one turn and grants no budget; the PR's merge is still
  // awaited, so the task parks again and says nothing of its budget.
  expect(turns).toEqual([startedAt]);
  expect(posted).toEqual([]);
  expect(quiet).toEqual([]);
  const { budget } = await saved();
  expect(budget.since).toBeUndefined();
  expect(budget.windowSeq).toBeUndefined();
});

test.each(["CI", "a task slot"])("hours waiting on %s use none of the window", async (on) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const startedAt = new Date(Date.now() - 3 * hour).toISOString();
  const pending = { ...pr, checks: { sha: pr.headSha, required: [{ name: "validate", state: "pending" as const }] } };
  let pullRequest = on === "CI" ? pending : pr;
  // The task is queued for a slot from the start until the five hours have passed.
  const slot = new Slot(() => {});
  slot.released = on !== "CI";
  const turns: string[] = [];
  const { posted } = await scenario({
    // Ten minutes of the two-hour window are left.
    state: { startedAt, runIds: [], budget: { activeMs: 110 * 60_000 } },
    runner: { start: async () => {}, status: async () => { throw new Error("no runs"); }, cancel: async () => {} },
    reasoner: async (situation) => (turns.push(situation.budget.windowStart), turnOf([])),
    pullRequest: () => pullRequest,
    onPoll: async (poll, live) => {
      if (poll === 3) vi.setSystemTime(Date.now() + 5 * hour);
      if (poll === 5) {
        pullRequest = pr;
        slot.released = false;
      }
      if (poll >= 8) await writeFile(join(dir, "STOP"), "");
      return live;
    },
    loop: { idleMinutes: 24 * 60, slot },
  });

  expect(posted).toEqual([]);
  expect(turns).toEqual(on === "CI" ? [startedAt, startedAt] : [startedAt]);
  const { budget } = await saved();
  expect(budget.since).toBeUndefined();
  expect(budget.activeMs).toBeLessThan(111 * 60_000);
});
