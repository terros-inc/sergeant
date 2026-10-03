import {
  commentIdFor,
  conversationRevision,
  issueRevision,
  QUESTION_HEADING,
  type AgentComment,
  type Conversation,
  type ConversationRevision,
  type HumanComment,
  type LinearPort,
  type ProposedAction,
  type SituationReport,
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
    QUESTION_HEADING,
    "",
    ask.question.trim(),
    ...options,
    "",
    `${reply} Sergeant does nothing more on this issue until someone replies.`,
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

/** Sergeant's question comment with this id, if the conversation has one. */
export const ownQuestion = (conversation: Conversation, id: string | undefined) =>
  id === undefined ? undefined : conversation.agentComments.find((c) => c.id === id && c.body.startsWith(QUESTION_HEADING));

/**
 * TECH-5059: the human's answer to Sergeant's latest question (its budget question included): the first
 * human comment after it. An answer gives the task a fresh budget window from the answer (budget.ts).
 */
export function latestAnswer(conversation: Conversation): HumanComment | undefined {
  const at = (c: { createdAt: string }) => Date.parse(c.createdAt);
  const asked = conversation.agentComments.filter((c) => c.body.startsWith(QUESTION_HEADING)).sort((a, b) => at(b) - at(a))[0];
  if (!asked) return undefined;
  return conversation.humanComments.filter((c) => at(c) > at(asked)).sort((a, b) => at(a) - at(b))[0];
}

/**
 * TECH-5057: resolve Sergeant's question thread in Linear so an open thread only ever means "still
 * needs a human". The rule is re-derived every turn from the facts, never from reasoning's say-so, and
 * resolves the latest question Sergeant asked (the budget question included) when all hold:
 *   - it is Sergeant's own question (a Linear comment of its that opens with the question heading);
 *   - a human has commented after it, in its thread or on the issue (`humanComments` is only humans');
 *   - the task has acted since that reply, which is this turn: it read the reply (it is in the
 *     conversation) and moved on rather than asking again (`acted`).
 * An unusable answer gets a follow-up in the same thread instead (`ask_human.followsUp`): that turn is
 * asking, so `acted` is false and the thread stays open until a usable reply arrives. The adapter
 * resolves only a thread Sergeant started and leaves a resolved one alone, so resolving is idempotent:
 * a resolve a crash skips (it runs after the fingerprint is saved) is re-derived from the same facts
 * and retried on the next turn, with no ordering to get right. Best-effort: a failure is logged, never
 * retried within the turn, and never stops the task.
 */
export async function resolveAnswered(
  acted: boolean,
  situation: Pick<SituationReport, "conversation">,
  linear: Pick<LinearPort, "resolveThread">,
  log: (line: string) => void,
): Promise<void> {
  const { conversation } = situation;
  if (!linear.resolveThread || !acted) return;
  const at = (c: { createdAt: string }) => Date.parse(c.createdAt);
  const question = conversation.agentComments.filter((c) => c.body.startsWith(QUESTION_HEADING)).sort((a, b) => at(b) - at(a))[0];
  if (!question) return;
  const reply = conversation.humanComments.find((c) => at(c) > at(question));
  if (!reply) return;
  const { id } = question;
  await linear.resolveThread(id).then(
    (result) => log(`question ${id} answered and acted on: ${result.replaceAll("_", " ")}`),
    (e: Error) => log(`could not resolve the thread of question ${id}: ${e.message}`),
  );
}
