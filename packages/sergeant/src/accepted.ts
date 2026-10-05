import { readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Conversation, LinearPort, PullRequestFacts } from "@terros/sergeant-contracts";
import type { DelegatedIssue } from "@terros/sergeant-linear";
import type { LoopResult } from "./loop-options.ts";
import type { TaskState } from "./task-state.ts";

// TECH-5118: a task a human accepted as it is stays ended. Its loop sets `state.json` aside, so intake
// resumes it no more, and leaves `accepted.json` beside it, since the issue stays delegated: in Todo,
// intake would otherwise start it again as new work and ask the budget question again. The marker
// holds while the issue stays delegated and in Todo. A human re-triggers the task the way they would
// any issue, and the marker is cleared at the first intake that sees it: the issue moved out of Todo
// (to In Progress or Backlog, say) or no longer delegated or open, or `sgt task wake`. Back in Todo,
// it then starts a fresh task, as after a stop. A comment alone re-triggers nothing, since a "thanks"
// after the acceptance is not a request for more work.

const markerFile = (dir: string) => join(dir, "accepted.json");

/**
 * TECH-5120: once per acceptance, keyed by the human reply that accepted, so an ending replayed after a
 * crash or a failed post posts nothing new; a later acceptance, after the task was re-triggered, is a
 * new reply and gets its own.
 */
export const acceptedKey = (issueId: string, replyId: string) => `accepted:${issueId}:${replyId}`;

/** The one line that tells the human Sergeant has stopped and what is left is theirs. */
export function acceptedComment(pullRequests: Pick<PullRequestFacts, "repo" | "number" | "url" | "state">[], cost?: string): string {
  const open = pullRequests.filter((p) => p.state === "open").map((p) => `[${p.repo}#${p.number}](${p.url})`);
  const left = open.length > 0 ? `${open.join(", ")} and this issue are` : "This issue is";
  return `Sergeant has stopped: the work was accepted as it is. ${left} yours to merge or close.${cost ? `\n\n${cost}` : ""}`;
}

/** Posts the acceptance's comment; a Linear failure throws, so the loop fails and its ending is replayed. */
export async function postAccepted(issueId: string, replyId: string, body: string, linear: Pick<LinearPort, "postComment">): Promise<void> {
  await linear.postComment({ issueId, key: acceptedKey(issueId, replyId), body });
}

/** Records that a human accepted the task in `dir` as it is; written before `state.json` is set aside. */
export const markAccepted = (dir: string, at: string) => writeFile(markerFile(dir), JSON.stringify({ at }));

/**
 * The accepted ending (loop.ts), replayed from the saved accepting turn, never decided again by a fresh
 * turn (TECH-5136): its question thread is resolved first (TECH-5138), then one keyed line says
 * Sergeant has stopped (TECH-5120), then `state.json` is set aside like a stop's, so intake resumes it
 * no more; its PRs and the issue are left for a human. The marker keeps intake from starting it afresh
 * while the issue stays in Todo. A failed resolve returns nothing, so the loop waits for the next pass;
 * a failed post throws, so the loop fails and the resumed task replays the ending under the same key.
 * Either way the acknowledgment appears only on a task that is ending.
 */
export async function endAccepted(
  accepted: NonNullable<TaskState["accepted"]>,
  dir: string,
  issueId: string,
  linear: Pick<LinearPort, "readConversation" | "postComment">,
  resolveDue: (conversation: Conversation) => Promise<boolean>,
): Promise<LoopResult | undefined> {
  const { at, replyId, comment } = accepted;
  const conversation = await linear.readConversation(issueId);
  if (!(await resolveDue(conversation))) return undefined;
  if (replyId) await postAccepted(conversation.issue.id, replyId, comment, linear);
  await markAccepted(dir, at);
  await rename(join(dir, "state.json"), join(dir, `state.accepted-${at.replace(/[:.]/g, "-")}.json`));
  return { outcome: "accepted", detail: "a human accepted the work as it is" };
}

/**
 * The tasks a human accepted whose issue is still delegated and in Todo, so intake starts none of them.
 * Every other acceptance is cleared: the human moved the issue or woke the task since.
 */
export async function heldAcceptances(
  stateDir: string,
  listed: DelegatedIssue[],
  woken: (ref: string) => boolean,
  log: (line: string) => void,
): Promise<Set<string>> {
  const held = new Set<string>();
  for (const ref of await readdir(join(stateDir, "tasks")).catch(() => [])) {
    const file = markerFile(join(stateDir, "tasks", ref));
    if (!(await stat(file).then(() => true, () => false))) continue;
    const issue = listed.find((i) => i.identifier === ref);
    if (issue?.state.type === "unstarted" && !woken(ref)) {
      held.add(ref);
      continue;
    }
    await rm(file, { force: true });
    const why = woken(ref) ? "the task was woken" : issue ? `the issue moved to ${issue.state.name}` : "the issue is no longer delegated and open";
    log(`${ref}: accepted as it is earlier; ${why}, so in Todo it starts a fresh task`);
  }
  return held;
}
