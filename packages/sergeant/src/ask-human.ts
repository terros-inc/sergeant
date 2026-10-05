import { checkLive, commentIdFor, type ProposedAction, type SituationReport } from "@terros/sergeant-contracts";
import type { ActionOutcome, Ports } from "./execute-types.ts";
import { ownQuestion, questionComment } from "./question.ts";

/**
 * Posts a question as the V2 agent under `key`, at most once however often it is retried. A follow-up
 * to one of Sergeant's own questions is a reply in that question's thread (TECH-5052).
 */
export async function askHuman(
  action: Extract<ProposedAction, { kind: "ask_human" }>,
  situation: SituationReport,
  ports: Ports,
  key: string,
): Promise<ActionOutcome> {
  const { issue } = situation.conversation;
  try {
    const active = checkLive((await ports.linear.readConversation(issue.id)).issue, ports.agentUserId);
    if (!active.allowed) return { action, status: "denied", rule: active.rule, reason: active.reason };
    const thread = ownQuestion(situation.conversation, action.followsUp);
    const parentId = thread && (thread.parentId ?? thread.id);
    await ports.linear.postComment({ issueId: issue.id, body: questionComment(action), key, ...(parentId && { parentId }) });
    return { action, status: "done", result: { commentId: commentIdFor(key) } };
  } catch (e) {
    return { action, status: "failed", error: (e as Error).message };
  }
}
