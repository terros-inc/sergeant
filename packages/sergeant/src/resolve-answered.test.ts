import { expect, test } from "vitest";
import { type AgentComment, type Conversation, type HumanComment, QUESTION_HEADING } from "@terros/sergeant-contracts";
import { resolveAnswered } from "./question.ts";

// TECH-5057: the resolve decision, re-derived every turn from the facts. These pin the guards the two
// independent reviews of TECH-5052 flagged: a thread nobody answered must never resolve, a zero-action
// turn included, and the decision must not rest on an id reasoning asserted.

const t = (s: string) => `2026-10-03T00:00:${s}.000Z`;
const question = (id: string, at: string): AgentComment => ({ id, createdAt: at, body: `${QUESTION_HEADING}\n\nWhich?` });
const reply = (id: string, at: string): HumanComment => ({ id, author: { id: "u1", name: "H" }, createdAt: at, updatedAt: at, body: "the second one" });
const convo = (agentComments: AgentComment[], humanComments: HumanComment[]): { conversation: Conversation } => ({
  conversation: {
    issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", stateType: "started", delegate: null, linkedPullRequests: [] },
    humanComments,
    agentComments,
  },
});

const run = async (actedThrough: string | undefined, situation: { conversation: Conversation }) => {
  const resolved: string[] = [];
  await resolveAnswered(situation.conversation, actedThrough, { resolveThread: async (id) => (resolved.push(id), "resolved") }, new Set(), () => {});
  return resolved;
};

test("resolves the question once a human replied after it and a turn moved on from the reply", async () => {
  const situation = convo([question("q1", t("10"))], [reply("c1", t("20"))]);
  expect(await run(t("20"), situation)).toEqual(["q1"]);
});

test("never resolves a question no human has replied to, even after a turn that acted", async () => {
  const situation = convo([question("q1", t("10"))], [reply("c0", t("05"))]);
  expect(await run(t("05"), situation)).toEqual([]);
});

test("does not resolve when no turn has acted since the reply (a follow-up asked, or no turn yet)", async () => {
  const situation = convo([question("q1", t("10"))], [reply("c0", t("05")), reply("c1", t("20"))]);
  expect(await run(t("05"), situation)).toEqual([]);
  expect(await run(undefined, situation)).toEqual([]);
});

test("a follow-up in the thread keeps it open until a turn acts on the follow-up's reply", async () => {
  const followUp = { ...question("q1b", t("30")), parentId: "q1" };
  const situation = convo([question("q1", t("10")), followUp], [reply("c1", t("20")), reply("c2", t("40"))]);
  expect(await run(t("20"), situation)).toEqual([]);
  expect(await run(t("40"), situation)).toEqual(["q1"]);
});

test("resolves an earlier answered thread too, while a newer question still waits", async () => {
  const situation = convo([question("q1", t("05")), question("q2", t("30"))], [reply("c1", t("20"))]);
  expect(await run(t("20"), situation)).toEqual(["q1"]);
});
