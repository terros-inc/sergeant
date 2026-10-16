import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, QUESTION_HEADING, type AgentComment, type Conversation } from "@terros/sergeant-contracts";
import { budgetQuestionKey, legacyBudgetQuestionKey } from "./budget.ts";
import { cleanup, dir, human, saved, scenario, turnOf, worker } from "./budget-scenario.ts";

// TECH-6225: the deploy of TECH-6165 asked the budget question again on tasks already stopped on an open
// one, some of which had run nothing. Their question was keyed by its window's start, which the new key
// did not find, and their saved window counted all the wall time it had had as active, so it was
// exhausted. A deploy or restart now posts nothing for an open question, a task saved before active time
// was kept starts with none, and only work counts toward exhaustion.

afterEach(cleanup);

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const window = { wallMinutes: 120, costUsd: 25 };
const asked = (key: string, at: string): AgentComment => ({
  id: commentIdFor(key),
  createdAt: at,
  body: `${QUESTION_HEADING}\n\nSergeant stopped this task: its budget is exhausted (wall time exhausted). Continue?`,
});
const runner = { start: async () => {}, status: async () => worker("succeeded", 5), cancel: async () => {} };
const stopAt = (n: number) => async (poll: number, live: Conversation) => {
  if (poll >= n) await writeFile(join(dir, "STOP"), "");
  return live;
};

test.each([
  ["in its first window", undefined],
  ["in a window an answer opened", ago(200)],
])("a task saved before TECH-6165 with its budget question open %s posts nothing on restart, and its reply is the budget question's", async (_case, since) => {
  const startedAt = ago(300);
  const answered = since ? [human("c0", since, "Go on.")] : [];
  const question = asked(legacyBudgetQuestionKey("i1", since ?? startedAt), ago(60));
  let reply: ReturnType<typeof human> | undefined;
  let turns = 0;
  const { result, posted } = await scenario({
    state: { startedAt, runIds: ["run_w"], turnCostUsd: 0, budget: { window, ...(since && { since }), priorRuns: [] } },
    conversation: { agentComments: [question], humanComments: answered },
    runner,
    reasoner: async () => (turns++, turnOf([{ kind: "accept_as_is" }])),
    // The human answers only after the loop has waited on the question for a few polls.
    onPoll: (poll, live) => (poll < 5 ? live : { ...live, humanComments: [...answered, (reply ??= human("c1", ago(0), "2"))] }),
  });

  // Nothing posted while it waited, and the reply to that question may accept the work.
  expect(posted.filter((b) => /budget is exhausted/.test(b))).toEqual([]);
  expect(turns).toBe(1);
  expect(result).toEqual({ outcome: "accepted", detail: "a human accepted the work as it is" });
});

test("a task saved before TECH-6165 that has run nothing since is not exhausted: it takes its turn with no budget question", async () => {
  let turns = 0;
  const { posted } = await scenario({
    // Five hours since it started, more than twice its window, but no run and no turn in that time.
    state: { startedAt: ago(300), runIds: [], turnCostUsd: 0, budget: { window, priorRuns: [] } },
    runner,
    reasoner: async () => (turns++, turnOf([])),
    onPoll: stopAt(3),
  });

  expect(posted).toEqual([]);
  expect(turns).toBe(1);
  expect((await saved()).budget.activeMs).toBeLessThan(60_000);
});

test("a task that used up its active time asks once, and a restart, or a later window, asks nothing more while it is open", async () => {
  const startedAt = ago(300);
  const state = { startedAt, runIds: ["run_w"], turnCostUsd: 0, budget: { window, priorRuns: [], activeMs: 121 * 60_000, windowSeq: 0 } };
  const first = await scenario({ state, runner, reasoner: async () => turnOf([]), onPoll: stopAt(4) });

  expect(first.posted).toEqual([expect.stringMatching(/active time exhausted/)]);
  const question = first.live.agentComments[0];
  expect(question?.id).toBe(commentIdFor(budgetQuestionKey("i1", startedAt, 0)));

  // A restart (the deploy) with the question still open.
  await rm(join(dir, "STOP"));
  const restart = await scenario({ state, conversation: { agentComments: first.live.agentComments }, runner, reasoner: async () => turnOf([]), onPoll: stopAt(4) });
  expect(restart.posted).toEqual([]);

  // A human's PR review opened a fresh window (TECH-6165), which the work then used up, but the issue's
  // question still has no reply: it is the one the human answers, and no second one is asked.
  const reviewedAt = ago(100);
  await rm(join(dir, "STOP"));
  const later = await scenario({
    state: { ...state, budget: { window, since: reviewedAt, priorRuns: [], activeMs: 121 * 60_000, windowSeq: 1 } },
    conversation: { agentComments: first.live.agentComments },
    runner,
    reasoner: async () => turnOf([]),
    onPoll: stopAt(4),
  });
  expect(later.posted).toEqual([]);
});

// A task saved before TECH-6165 whose budget question was asked in a window a human's PR review opened:
// its key names that review's time, which nothing else keeps. A restart finds it under the saved window's
// start and keeps it, and a later PR review opens a window whose start is not that one.
async function restartedOnLegacyQuestion() {
  const startedAt = ago(400);
  const reviewedAt = ago(300);
  const question = asked(legacyBudgetQuestionKey("i1", reviewedAt), ago(60));
  const state = { startedAt, runIds: ["run_w"], turnCostUsd: 0, budget: { window, since: reviewedAt, priorRuns: [] } };
  const restart = await scenario({ state, conversation: { agentComments: [question] }, runner, reasoner: async () => turnOf([]), onPoll: stopAt(3) });
  expect(restart.posted).toEqual([]);
  await rm(join(dir, "STOP"));
  // A later PR review opened window 1, which the work has used up.
  const later = { ...(await saved()), budget: { window, since: ago(30), priorRuns: ["run_w"], activeMs: 121 * 60_000, windowSeq: 1 } };
  return { question, later };
}

test("a pre-TECH-6165 budget question still open asks nothing more once a PR review opens a later window that runs out", async () => {
  const { question, later } = await restartedOnLegacyQuestion();
  const { posted } = await scenario({ state: later, conversation: { agentComments: [question] }, runner, reasoner: async () => turnOf([]), onPoll: stopAt(4) });
  expect(posted).toEqual([]);
});

test("a reply accepting the work as it is to a pre-TECH-6165 budget question from a PR review's window ends the task, in a later window", async () => {
  const { question, later } = await restartedOnLegacyQuestion();
  let reply: ReturnType<typeof human> | undefined;
  const { result, posted } = await scenario({
    state: later,
    conversation: { agentComments: [question] },
    runner,
    reasoner: async () => turnOf([{ kind: "accept_as_is" }]),
    onPoll: (poll, live) => (poll < 3 ? live : { ...live, humanComments: [(reply ??= human("c1", ago(0), "Accept it as it is."))] }),
  });
  expect(posted.filter((b) => /budget is exhausted/.test(b))).toEqual([]);
  expect(result).toEqual({ outcome: "accepted", detail: "a human accepted the work as it is" });
});
