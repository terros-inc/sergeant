import { expect, test } from "vitest";
import { conversationRevision, issueRevision, type Conversation, type HumanPullRequestFeedback, type ProposedAction, type RunSpec, type SituationReport } from "@terros/sergeant-contracts";
import { execute } from "./execute.ts";
import { conversation, head, ports, pr, situation } from "./execute-fixtures.ts";
import { takeTurn } from "./index.ts";
import { descriptionNote } from "./update-description.ts";

// TECH-6166: a worker stopped on a human's inline PR comment because the issue description, by then
// stale, said the opposite. The latest human steering wins for what it addresses: Sergeant replaces the
// description, notes it in the thread, and the work follows the comment.

const at = "2026-10-02T06:01:00.000Z";
const kept = "Add the bulk update.";
const described: Conversation = { ...conversation, issue: { ...conversation.issue, description: `${kept}\n\nKeep the single-record update.` } };
const inline: HumanPullRequestFeedback = {
  id: "review_comment:41", kind: "review_comment", author: "captain", state: null, body: "Drop the single-record update: bulk covers it.",
  path: "src/update.ts", line: 12, commitId: head, createdAt: at, updatedAt: at, url: `${pr.url}#discussion_r41`,
};
const reviewed = { ...pr, humanFeedback: [inline] };
const turnOf = (c: Conversation): SituationReport => ({ ...situation, conversation: c, pullRequests: [reviewed], conversationRevision: conversationRevision(c, [reviewed]) });
const dropped = `${kept}\n\nDrop the single-record update (a reviewer's inline comment on the PR).`;
const edit = (over: Partial<Extract<ProposedAction, { kind: "update_description" }>> = {}): Extract<ProposedAction, { kind: "update_description" }> => ({
  kind: "update_description",
  description: dropped,
  why: `captain's inline comment on ${pr.url} drops the single-record update the description kept.`,
  ...over,
});

/**
 * The executor's fake ports over one Linear issue whose description the edit writes, recording the
 * writes and comments. `meanwhile` is a human's edit landing between Sergeant's read and its write;
 * `livePr` is the task's PR as GitHub returns it now.
 */
function linear(live: Conversation, meanwhile?: string, livePr = reviewed) {
  const { p } = ports({ conversation: live });
  p.github.readPullRequest = async () => livePr;
  let text = live.issue.description;
  const edits: string[] = [];
  const comments: Parameters<typeof p.linear.postComment>[0][] = [];
  p.linear.readConversation = async () => ({ ...live, issue: { ...live.issue, description: text } });
  p.linear.updateDescription = async (_id, { from, to }) => {
    if (meanwhile !== undefined) text = meanwhile;
    if (text !== from) return { updated: false };
    text = to;
    edits.push(to);
    return { updated: true };
  };
  p.linear.postComment = async (req) => void comments.push(req);
  return { p, edits, comments, text: () => text };
}

test("a human inline comment that conflicts with the description: the description follows it, with a note, and the worker gets the new text", async () => {
  const { p, edits, comments } = linear(described);
  const specs: RunSpec[] = [];
  p.runner.start = async (spec) => void specs.push(spec);
  const proposal = edit();
  const start: ProposedAction = { kind: "start_worker", objective: "Drop the single-record update, as captain's inline comment asks.", repositories: [pr.repo] };
  const reasoner = { turn: async () => ({ output: { summary: "the comment changes scope", actions: [proposal, start] }, model: "m", promptVersion: "p" }) };

  const { outcomes } = await takeTurn(turnOf(described), { ...p, reasoner });

  expect(outcomes.map((o) => o.status)).toEqual(["done", "done"]);
  expect(edits).toEqual([dropped]);
  // A PR comment has no Linear thread, so the note is on the issue.
  expect(comments).toEqual([{ issueId: "i1", body: descriptionNote(proposal.why), key: expect.stringMatching(/^description:i1:[0-9a-f]{64}$/) }]);
  // The worker started after the edit works from the new text, and its run records that text.
  const worker = specs[0] as Extract<RunSpec, { role: "worker" }>;
  expect(worker.conversation.issue.description).toBe(dropped);
  expect(worker.context.pullRequests[0]?.humanFeedback).toEqual([inline]);
  const started = outcomes[1]?.status === "done" ? outcomes[1].started : undefined;
  expect(started?.issueRevision).toBe(issueRevision({ ...described.issue, description: dropped }));
});

// Review f2: a worker started after an edit whose note failed still gets the text Linear now has.
test("a run started after an edit whose note failed gets the new description", async () => {
  const { p, text } = linear(described);
  p.linear.postComment = async () => { throw new Error("Linear is down"); };
  const specs: RunSpec[] = [];
  p.runner.start = async (spec) => void specs.push(spec);
  const start: ProposedAction = { kind: "start_worker", objective: "Drop the single-record update.", repositories: [pr.repo] };
  const reasoner = { turn: async () => ({ output: { summary: "the comment changes scope", actions: [edit(), start] }, model: "m", promptVersion: "p" }) };

  const { outcomes } = await takeTurn(turnOf(described), { ...p, reasoner });

  expect(outcomes.map((o) => o.status)).toEqual(["failed", "done"]);
  expect(text()).toBe(dropped);
  expect((specs[0] as Extract<RunSpec, { role: "worker" }>).conversation.issue.description).toBe(dropped);
});

test("a scope change in a Linear comment is noted in that comment's thread", async () => {
  const top = { id: "c1", author: { id: "u1", name: "Captain" }, createdAt: at, updatedAt: at, body: "Bulk only?" };
  const reply = { ...top, id: "c2", body: "Yes: drop the single-record update.", parentId: "c1" };
  const live = { ...described, humanComments: [top, reply] };
  const { p, edits, comments } = linear(live);
  expect(await execute(edit({ commentId: "c2" }), turnOf(live), p)).toMatchObject({ status: "done", result: { thread: "c1" } });
  expect(edits).toHaveLength(1);
  expect(comments).toMatchObject([{ parentId: "c1" }]);
});

test("the description is never edited over a change the turn did not see, for a comment that is not a human's, or to the text it already has", async () => {
  const humanEdit = { ...described, issue: { ...described.issue, description: "A human rewrote it meanwhile." } };
  const raced = linear(humanEdit);
  expect(await execute(edit(), turnOf(described), raced.p)).toMatchObject({ status: "denied", rule: "U1" });

  // Review f3: a human's edit between Sergeant's read and its write is not overwritten.
  const instant = linear(described, "A human rewrote it in the same instant.");
  expect(await execute(edit(), turnOf(described), instant.p)).toMatchObject({ status: "denied", rule: "U1" });
  expect(instant.text()).toBe("A human rewrote it in the same instant.");

  // Review f1: a human's PR comment since the turn is newer steering, so the edit waits for the next turn.
  const later = { ...inline, id: "review_comment:42", body: "Actually, keep the single-record update." };
  const steered = linear(described, undefined, { ...reviewed, humanFeedback: [inline, later] });
  expect(await execute(edit(), turnOf(described), steered.p)).toMatchObject({ status: "denied", rule: "U1" });

  const unknown = linear(described);
  expect(await execute(edit({ commentId: "sergeant-own" }), turnOf(described), unknown.p)).toMatchObject({ status: "denied", rule: "U2" });

  const same = linear(described);
  expect(await execute(edit({ description: described.issue.description }), turnOf(described), same.p)).toMatchObject({ status: "denied", rule: "U3" });

  const all = [raced, instant, steered, unknown, same];
  expect(all.flatMap((l) => [...l.edits, ...l.comments])).toEqual([]);
});
