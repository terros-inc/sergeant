import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, type Conversation, type ProposedAction } from "@terros/sergeant-contracts";
import { budgetQuestionKey } from "./budget.ts";
import { cleanup, dir, human, saved, scenario, start, turnOf, worker } from "./budget-scenario.ts";

// TECH-5052: an open question thread in Linear must mean "still needs a human". Sergeant resolves its
// own question's thread once it has acted on the answer, and only then: an unusable answer gets a
// follow-up in the same thread, which stays open.

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
    reasoner: async (situation) => ({ ...turnOf([]), output: { summary: "s", actions: [], ...(situation.recentTurns.length === 0 && { answered: budgetQuestion }) } }),
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
      return { ...turnOf([start]), output: { summary: "s", actions: [start], answered: question } };
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
      // Even a turn that wrongly names the question answered while asking a follow-up resolves nothing.
      const followUp: ProposedAction = { ...ask, question: "Neither option says how long to keep backups. Which do you mean?", followsUp: asked };
      if (humanComments.length === 1) return { ...turnOf([followUp]), output: { summary: "s", actions: [followUp], answered: asked } };
      return { ...turnOf([start]), output: { summary: "s", actions: [start], answered: asked } };
    },
    onPoll: async (_poll, live) => {
      if (started.length > 0) await writeFile(join(dir, "STOP"), "");
      if (live.agentComments.length === 1 && live.humanComments.length === 0) return replyTo(live, "c1", "Hmm, it depends.");
      if (live.agentComments.length === 2 && live.humanComments.length === 1) {
        // Nothing was resolved while the answer was unusable.
        expect(logs.filter((l) => l.includes("acted on"))).toEqual([]);
        return replyTo(live, "c2", "After 30 days, backups included.");
      }
      return live;
    },
  });

  expect(question).not.toBe("");
  expect(replies).toEqual([{ body: expect.stringContaining("Which do you mean?"), parentId: question }]);
  expect(started).toHaveLength(1);
  // The follow-up was answered; the adapter resolves the thread from its top question.
  expect(resolved).toHaveLength(1);
  expect(resolved[0]).not.toBe(question);
});
