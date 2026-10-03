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

const run = async (acted: boolean, situation: { conversation: Conversation }) => {
  const resolved: string[] = [];
  await resolveAnswered(acted, situation, { resolveThread: async (id) => (resolved.push(id), "resolved") }, () => {});
  return resolved;
};

test("resolves the question once a human replied after it and the turn moved on", async () => {
  const situation = convo([question("q1", t("10"))], [reply("c1", t("20"))]);
  expect(await run(true, situation)).toEqual(["q1"]);
});

test("never resolves a question no human has replied to, even when the turn acted", async () => {
  const situation = convo([question("q1", t("10"))], []);
  expect(await run(true, situation)).toEqual([]);
});

test("does not resolve when the only human comment predates the question (a stale comment)", async () => {
  const situation = convo([question("q1", t("20"))], [reply("c1", t("10"))]);
  expect(await run(true, situation)).toEqual([]);
});

test("does not resolve on a turn that asked again (a follow-up), reply or not", async () => {
  const situation = convo([question("q1", t("10"))], [reply("c1", t("20"))]);
  expect(await run(false, situation)).toEqual([]);
});

test("resolves the latest question when several have been asked", async () => {
  const situation = convo([question("q1", t("05")), question("q2", t("20"))], [reply("c1", t("25"))]);
  expect(await run(true, situation)).toEqual(["q2"]);
});
