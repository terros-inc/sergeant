import { createHash } from "node:crypto";
import { checkDescriptionEdit, conversationRevision, type SituationReport, type UpdateDescription } from "@terros/sergeant-contracts";
import type { ActionOutcome, Ports } from "./execute-types.ts";

// TECH-6166: a human comment that changed what the issue asks is the latest steering and wins over the
// description for what it addresses. Sergeant replaces the description and says so in the thread, so
// workers and reviewers check against one current source of truth.

/** Once per new description, so a retried action posts its note once. */
export const descriptionNoteKey = (issueId: string, description: string) =>
  `description:${issueId}:${createHash("sha256").update(description).digest("hex")}`;

/** The note in the thread: what Sergeant changed in the description, and why. */
export const descriptionNote = (why: string) => `Sergeant updated the issue description to follow a human comment: ${why}`;

/**
 * The new description and its note, on the live read the Gate allowed (U1–U3): a human's edit or
 * comment, on the issue or on one of the task's PRs (re-read here too), while reasoning ran denies it,
 * and the next turn reads it. The write happens only while the description is still the one the turn
 * read. The note then replies in the thread of the human Linear comment that changed the scope, else it
 * is a comment on the issue.
 */
export async function updateDescription(action: UpdateDescription, situation: SituationReport, ports: Ports): Promise<ActionOutcome> {
  const { conversation } = situation;
  const [live, pullRequests] = await Promise.all([
    ports.linear.readConversation(conversation.issue.id),
    Promise.all(situation.pullRequests.map((p) => ports.github.readPullRequest(p.repo, p.number))),
  ]);
  const verdict = checkDescriptionEdit(action, {
    live,
    agentUserId: ports.agentUserId,
    turnDescription: conversation.issue.description,
    turnRevision: situation.conversationRevision,
    liveRevision: conversationRevision(live, pullRequests),
  });
  if (!verdict.allowed) return { action, status: "denied", rule: verdict.rule, reason: verdict.reason };
  if (!ports.linear.updateDescription) return { action, status: "failed", error: "this Sergeant cannot edit an issue description" };
  const { updated } = await ports.linear.updateDescription(conversation.issue.id, { from: conversation.issue.description, to: action.description });
  if (!updated) return { action, status: "denied", rule: "U1", reason: "the description changed while this edit was made; the next turn reads it" };
  const steering = action.commentId ? live.humanComments.find((c) => c.id === action.commentId) : undefined;
  const parentId = steering ? (steering.parentId ?? steering.id) : undefined;
  try {
    await ports.linear.postComment({
      issueId: conversation.issue.id,
      body: descriptionNote(action.why),
      key: descriptionNoteKey(conversation.issue.id, action.description),
      ...(parentId && { parentId }),
    });
  } catch (e) {
    return { action, status: "failed", error: `the description was updated, but its note was not posted: ${(e as Error).message}`, description: action.description };
  }
  return { action, status: "done", result: { ...(parentId && { thread: parentId }) }, description: action.description };
}
