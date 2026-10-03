import {
  commentIdFor,
  conversationRevision,
  issueRevision,
  QUESTION_HEADING,
  type AgentComment,
  type Conversation,
  type ConversationRevision,
  type LinearPort,
  type ProposedAction,
} from "@terros/sergeant-contracts";

// UNF-727: Sergeant asks a human in Linear and does nothing more on the task until a human changes the
// conversation. The wait is never stored. A question is posted under a key made of the issue and the
// conversation revision reasoning asked from, so "waiting" is exactly "that comment exists and no human
// has commented or edited the issue since": one Linear read re-derives it after a restart, asking again
// at the same revision posts nothing new, and any human change ends the wait and wakes a turn that
// interprets the reply (or asks again). Nothing times out on the human's behalf.

export const questionKey = (issueId: string, revision: ConversationRevision) => `question:${issueId}:${revision}`;

/** The question Sergeant asked that no human has responded to yet, from the live conversation. */
export function openQuestion(conversation: Conversation): AgentComment | undefined {
  const id = commentIdFor(questionKey(conversation.issue.id, conversationRevision(conversation)));
  return conversation.agentComments.find((c) => c.id === id);
}

/** The one concise question comment (07 §4). */
export function questionComment(ask: Extract<ProposedAction, { kind: "ask_human" }>, footer?: string): string {
  const options = ask.options ? ["", "Options:", ...ask.options.map((o, i) => `${i + 1}. ${o}`)] : [];
  const reply = ask.options ? "Reply in your own words; a number is fine." : "Reply in your own words.";
  return [
    QUESTION_HEADING,
    "",
    ask.question.trim(),
    ...options,
    "",
    footer ?? `${reply} Sergeant does nothing more on this issue until someone replies.`,
  ].join("\n");
}

/** The Linear conversation the last turn saw: its revision, which keys a question it asked, and its issue text. */
export type Seen = { revision: ConversationRevision; issue: string };

/**
 * TECH-5034: a human edited the issue's title or description while Sergeant waited for a reply to its
 * question or its budget question. One short comment says it was noticed, once per edited text: its key
 * names the new text, so a restart or a later poll posts nothing new. The next turn reads the current
 * text, and M13 holds any merge until the work is checked against it. Returns whether it posted.
 */
export async function noteEdit(
  conversation: Conversation,
  seen: Seen | undefined,
  budgetAsked: AgentComment | undefined,
  linear: Pick<LinearPort, "postComment">,
): Promise<boolean> {
  const { issue, agentComments, humanComments } = conversation;
  const current = issueRevision(issue);
  if (!seen || seen.issue === current) return false;
  const questionId = commentIdFor(questionKey(issue.id, seen.revision));
  const asked = agentComments.find((c) => c.id === questionId) ?? budgetAsked;
  if (!asked || humanComments.some((c) => Date.parse(c.createdAt) > Date.parse(asked.createdAt))) return false;
  const key = `edit-noted:${issue.id}:${current}`;
  if (agentComments.some((c) => c.id === commentIdFor(key))) return false;
  const body = "Noted: this issue's title or description changed while Sergeant was waiting for a reply. It works from the current text once it resumes, and checks the work against it before merging.";
  await linear.postComment({ issueId: issue.id, body, key });
  return true;
}
