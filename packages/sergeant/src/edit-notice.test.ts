import { expect, test } from "vitest";
import { commentIdFor, conversationRevision, issueRevision, type Conversation, type LinearPort } from "@terros/sergeant-contracts";
import { budgetQuestionKey } from "./budget.ts";
import { noteEdit, questionKey, type Seen } from "./question.ts";

// TECH-5034: the issue's description was rewritten while the task sat on a budget question, and nothing
// acknowledged it. An edit made while Sergeant waits on a reply gets one short comment, once.

const asked = "2026-10-03T02:12:00.000Z";
const original: Conversation = {
  issue: {
    id: "i1",
    identifier: "UNF-1",
    url: "https://linear.app/x/issue/UNF-1",
    title: "Add the skill",
    description: "Link the standard.",
    state: "In Progress",
    stateType: "started",
    delegate: null,
    linkedPullRequests: [],
  },
  humanComments: [],
  agentComments: [],
};
const seen: Seen = { revision: conversationRevision(original), issue: issueRevision(original.issue) };
const edited = (agentComments: Conversation["agentComments"], humanComments: Conversation["humanComments"] = []): Conversation => ({
  ...original,
  issue: { ...original.issue, description: "Bundle references/documentation-standard.md." },
  agentComments,
  humanComments,
});
const posting = () => {
  const posted: { key: string; body: string }[] = [];
  const linear: Pick<LinearPort, "postComment"> = { postComment: async (c) => void posted.push({ key: c.key, body: c.body }) };
  return { posted, linear };
};

test("an edit while a budget question waits is noted once, and not after a human replied", async () => {
  const budget = { id: commentIdFor(budgetQuestionKey("i1", undefined)), createdAt: asked, body: "Continue?" };
  const { posted, linear } = posting();
  expect(await noteEdit(edited([budget]), seen, budget, linear)).toBe(true);
  expect(posted).toEqual([{ key: `edit-noted:i1:${issueRevision(edited([]).issue)}`, body: expect.stringContaining("changed while Sergeant was waiting") }]);
  // Linear now shows the notice: a later poll posts nothing more for the same text.
  const notice = { id: commentIdFor(posted[0]?.key ?? ""), createdAt: "2026-10-03T02:22:00.000Z", body: posted[0]?.body ?? "" };
  expect(await noteEdit(edited([budget, notice]), seen, budget, linear)).toBe(false);
  const reply = { id: "h1", author: { id: "u1", name: "Ada" }, createdAt: "2026-10-03T02:30:00.000Z", updatedAt: "2026-10-03T02:30:00.000Z", body: "Extend" };
  expect(await noteEdit(edited([budget], [reply]), seen, budget, posting().linear)).toBe(false);
});

test("an edit while the last turn's question waits is noted; one with nothing waiting is not", async () => {
  const question = { id: commentIdFor(questionKey("i1", seen.revision)), createdAt: asked, body: "**Question for you**" };
  expect(await noteEdit(edited([question]), seen, undefined, posting().linear)).toBe(true);
  expect(await noteEdit(edited([]), seen, undefined, posting().linear)).toBe(false);
  expect(await noteEdit({ ...original, agentComments: [question] }, seen, undefined, posting().linear)).toBe(false);
});
