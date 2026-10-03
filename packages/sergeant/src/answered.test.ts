import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, type Conversation, type ProposedAction } from "@terros/sergeant-contracts";
import { budgetQuestionKey } from "./budget.ts";
import { cleanup, dir, human, saved, scenario, start, turnOf, worker } from "./budget-scenario.ts";

// TECH-5057: an open question thread in Linear must mean "still needs a human". Each turn re-derives,
// from the facts rather than from what reasoning says, whether to resolve Sergeant's own question: a
// human has replied after it and the task has acted since (a turn that did not ask again). An unusable
// answer is followed up in the same thread, which keeps it open; a resolve a crash loses is retried.

afterEach(cleanup);

const ask: ProposedAction = { kind: "ask_human", question: "Purge deleted accounts' data at once, or after 30 days?", options: ["At once", "After 30 days"] };
const lastAsked = (live: Conversation) => live.agentComments.at(-1);
/** A human reply to the latest question, one second after it. */
const replyTo = (live: Conversation, id: string, body: string): Conversation => {
  const at = new Date(Date.parse(lastAsked(live)?.createdAt ?? "") + 1_000).toISOString();
  return { ...live, humanComments: [...live.humanComments, human(id, at, body)] };
};

test("a budget question answered \"Extend\" is resolved after the turn that continues", async () => {
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const budgetQuestion = commentIdFor(budgetQuestionKey("i1", undefined));
  const { resolved, posted } = await scenario({
    state: { startedAt: threeHoursAgo, runIds: [] },
    runner: { start: async () => {}, status: async () => worker("running"), cancel: async () => {} },
    // Continuing after the answer is a zero-action turn: it did not ask again, so the task has acted.
    reasoner: async () => turnOf([]),
    onPoll: async (poll, live) => {
      if (poll > 20) await writeFile(join(dir, "STOP"), "");
      return live.agentComments.length > 0 && live.humanComments.length === 0 ? replyTo(live, "c1", "Extend") : live;
    },
  });

  expect(posted).toHaveLength(1);
  expect((await saved()).budget.since).toBeDefined();
  expect(resolved).toEqual([budgetQuestion]);
});

test("a question answered with an option is resolved after the turn that applies it", async () => {
  const started: string[] = [];
  let question = "";
  const { resolved } = await scenario({
    runner: { start: async (spec) => void started.push(spec.runId), status: async () => worker("running"), cancel: async () => {} },
    reasoner: async (situation) => {
      const { humanComments, agentComments } = situation.conversation;
      if (humanComments.length === 0) return turnOf([ask]);
      question = agentComments[0]?.id ?? "";
      return turnOf([start]);
    },
    onPoll: async (_poll, live) => {
      if (started.length > 0) await writeFile(join(dir, "STOP"), "");
      return live.agentComments.length > 0 && live.humanComments.length === 0 ? replyTo(live, "c1", "2") : live;
    },
  });

  expect(started).toHaveLength(1);
  expect(question).not.toBe("");
  expect(resolved).toEqual([question]);
});

test("a question with no human reply is never resolved, including a zero-action turn", async () => {
  // The question stays unanswered: the loop waits and takes no further turn, so nothing is resolved.
  const { resolved, posted } = await scenario({
    runner: { start: async () => {}, status: async () => worker("succeeded"), cancel: async () => {} },
    reasoner: async (situation) => (situation.conversation.humanComments.length === 0 ? turnOf([ask]) : turnOf([])),
    onPoll: async (poll, live) => {
      if (poll > 5) await writeFile(join(dir, "STOP"), "");
      return live;
    },
  });

  expect(posted).toHaveLength(1);
  expect(resolved).toEqual([]);
});

test("a resolve a crash loses is retried and happens on the next turn", async () => {
  let question = "";
  const attempts: string[] = [];
  const { resolved } = await scenario({
    // The first resolve is lost as if the process died right after the turn was saved; the next succeeds.
    beforeResolve: (id) => {
      attempts.push(id);
      if (attempts.length === 1) throw new Error("process died before resolving");
    },
    runner: { start: async () => {}, status: async () => worker("succeeded"), cancel: async () => {} },
    // After the reply the task continues with zero actions each turn: it does not ask again, so it acts.
    reasoner: async (situation) => {
      const { humanComments, agentComments } = situation.conversation;
      if (humanComments.length === 0) return turnOf([ask]);
      question ||= agentComments[0]?.id ?? "";
      return turnOf([]);
    },
    onPoll: async (_poll, live) => {
      // Post the answer; after the first (lost) resolve, a second human comment wakes the next turn.
      if (live.agentComments.length > 0 && live.humanComments.length === 0) return replyTo(live, "c1", "2");
      if (attempts.length === 1 && live.humanComments.length === 1) return replyTo(live, "c2", "thanks");
      if (attempts.length >= 2) await writeFile(join(dir, "STOP"), "");
      return live;
    },
  });

  // The first attempt was lost; the same decision, re-derived next turn, resolved the thread once more.
  expect(attempts.length).toBeGreaterThanOrEqual(2);
  expect(resolved).toEqual([question]);
});

test("an unusable answer stays open and is followed up in the same thread; its usable reply resolves it", async () => {
  const started: string[] = [];
  let question = "";
  const logs: string[] = [];
  const { resolved, replies } = await scenario({
    loop: { log: (line) => void logs.push(line) },
    runner: { start: async (spec) => void started.push(spec.runId), status: async () => worker("running"), cancel: async () => {} },
    reasoner: async (situation) => {
      const { humanComments, agentComments } = situation.conversation;
      const asked = agentComments.at(-1)?.id ?? "";
      if (humanComments.length === 0) return turnOf([ask]);
      question ||= asked;
      const followUp: ProposedAction = { ...ask, question: "Neither option says how long to keep backups. Which do you mean?", followsUp: asked };
      if (humanComments.length === 1) return turnOf([followUp]);
      return turnOf([start]);
    },
    onPoll: async (_poll, live) => {
      if (started.length > 0) await writeFile(join(dir, "STOP"), "");
      if (live.agentComments.length === 1 && live.humanComments.length === 0) return replyTo(live, "c1", "Hmm, it depends.");
      if (live.agentComments.length === 2 && live.humanComments.length === 1) {
        // Nothing was resolved while the answer was unusable and the follow-up still awaited a reply.
        expect(logs.filter((l) => l.includes("acted on"))).toEqual([]);
        return replyTo(live, "c2", "After 30 days, backups included.");
      }
      return live;
    },
  });

  expect(question).not.toBe("");
  expect(replies).toEqual([{ body: expect.stringContaining("Which do you mean?"), parentId: question }]);
  expect(started).toHaveLength(1);
  // The follow-up was answered; the latest question is the follow-up, so its thread resolves, not the first.
  expect(resolved).toHaveLength(1);
  expect(resolved[0]).not.toBe(question);
});
