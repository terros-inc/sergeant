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
  const asked = latestQuestion(conversation);
  if (!asked) return undefined;
  return conversation.humanComments.filter((c) => at(c) > at(asked)).sort((a, b) => at(a) - at(b))[0];
}

/** Sergeant's latest question comment, its budget question included. */
export function latestQuestion(conversation: Conversation): AgentComment | undefined {
  return conversation.agentComments.filter((c) => c.body.startsWith(QUESTION_HEADING)).sort((a, b) => at(b) - at(a))[0];
}

const at = (c: { createdAt: string }) => Date.parse(c.createdAt);

/**
 * TECH-5057: resolve Sergeant's question threads in Linear so an open thread only ever means "still
 * needs a human". The loop runs this on every pass, the merged task's included, and the rule is derived
 * from facts, never from reasoning's say-so. A thread resolves when, for the latest question Sergeant
 * asked in it (the budget question included):
 *   - it is Sergeant's own question (a Linear comment of its that opens with the question heading);
 *   - a human has commented after it, in its thread or on the issue (`humanComments` is only humans');
 *   - the task has acted since that reply: a turn that proposed no ask_human had read it (`actedThrough`,
 *     saved with that turn in `state.json`).
 * An unusable answer gets a follow-up in the same thread (`ask_human.followsUp`); that turn asks, so it
 * acts on nothing and the thread stays open until a turn moves on from a later reply. Every such thread
 * is resolved, not only the latest question's, so a lost resolve is not stranded by a newer question.
 * Nothing about the resolve itself is stored: a process lost after the turn was saved resolves the
 * thread on the restarted loop's first pass, from the same facts, with no new turn or human comment
 * needed. The adapter leaves a resolved thread alone, so a retry is harmless; `done` (this process's
 * memory) only spares Linear a call per pass. A failure is logged and retried on the next pass.
 */
export async function resolveAnswered(
  conversation: Conversation,
  actedThrough: string | undefined,
  linear: Pick<LinearPort, "resolveThread">,
  done: Set<string>,
  log: (line: string) => void,
): Promise<void> {
  if (!linear.resolveThread || actedThrough === undefined) return;
  const at = (c: { createdAt: string }) => Date.parse(c.createdAt);
  const latest = new Map<string, AgentComment>();
  for (const c of conversation.agentComments.filter((c) => c.body.startsWith(QUESTION_HEADING))) {
    const thread = c.parentId ?? c.id;
    const seen = latest.get(thread);
    if (!seen || at(c) > at(seen)) latest.set(thread, c);
  }
  const acted = Date.parse(actedThrough);
  for (const [thread, question] of latest) {
    if (done.has(thread)) continue;
    if (!conversation.humanComments.some((c) => at(c) > at(question) && at(c) <= acted)) continue;
    await linear.resolveThread(thread).then(
      (result) => (done.add(thread), log(`question ${question.id} answered and acted on: ${result.replaceAll("_", " ")}`)),
      (e: Error) => log(`could not resolve the thread of question ${question.id}: ${e.message}`),
    );
  }
}
