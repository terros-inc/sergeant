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
  type SituationReport,
} from "@terros/sergeant-contracts";
import type { ActionOutcome } from "./execute.ts";

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
 * TECH-5052: once Sergeant has acted on a human's answer, its question thread is resolved in Linear,
 * so an open thread only ever means "still needs a human". Acted on means a grant of the budget
 * question's window, or a turn that named the question it `answered`, asked nothing, and whose every
 * action was done. An unusable answer gets a follow-up in the same thread instead
 * (`ask_human.followsUp`) and stays open. The adapter resolves only a thread Sergeant started and leaves a resolved one alone.
 * Best-effort: a failure is logged and never retried, and it never stops the task.
 */
export async function resolveAnswered(
  turn: { answered?: string | undefined; outcomes: ActionOutcome[] },
  situation: Pick<SituationReport, "conversation" | "budget">,
  linear: Pick<LinearPort, "resolveThread">,
  log: (line: string) => void,
): Promise<void> {
  const { conversation, budget } = situation;
  const { outcomes } = turn;
  const granted = outcomes.some((o) => o.status === "done" && o.granted);
  // A turn that asks does nothing else (Q1), so it acted on no answer: its question follows one up.
  const applied = outcomes.every((o) => o.status === "done" && o.action.kind !== "ask_human");
  const answered = applied ? ownQuestion(conversation, turn.answered) : undefined;
  const ids = new Set<string>();
  if (granted && budget.questionId) ids.add(budget.questionId);
  if (answered) ids.add(answered.id);
  for (const id of ids) {
    if (!linear.resolveThread) return;
    await linear.resolveThread(id).then(
      (result) => log(`question ${id} answered and acted on: ${result.replaceAll("_", " ")}`),
      (e: Error) => log(`could not resolve the thread of question ${id}: ${e.message}`),
    );
  }
}
