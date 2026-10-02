import {
  commentIdFor,
  conversationRevision,
  type AgentComment,
  type Conversation,
  type ConversationRevision,
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
export function questionComment(ask: Extract<ProposedAction, { kind: "ask_human" }>): string {
  const options = ask.options ? ["", "Options:", ...ask.options.map((o, i) => `${i + 1}. ${o}`)] : [];
  const reply = ask.options ? "Reply in your own words; a number is fine." : "Reply in your own words.";
  return [
    "**Question for you**",
    "",
    ask.question.trim(),
    ...options,
    "",
    `${reply} Sergeant does nothing more on this issue until someone replies.`,
  ].join("\n");
}
