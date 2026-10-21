import type { LinearPort, TurnOutput } from "@terros/sergeant-contracts";
import type { TaskState } from "./task-state.ts";

/**
 * TECH-6490: a turn whose intent names actions it did not propose, or that proposes none and does not
 * say it waits, has not decided anything its summary may describe. Its fingerprint is left uncommitted
 * so a fresh turn runs on the same facts, at most `HOLLOW_TURN_RETRIES` more times. After that the
 * issue says the task is stuck, so a human can wake it, and only once that comment is posted is the
 * fingerprint committed: until then each poll posts it again, with no paid turn. The count is in
 * `state.json`, so a restart neither resets the bound nor loses the flag.
 */
export const HOLLOW_TURN_RETRIES = 1;

export function isHollow({ intent, actions }: TurnOutput): boolean {
  if (intent?.kind === "wait") return false;
  if (intent?.kind === "act") return intent.kinds.some((kind) => !actions.some((a) => a.kind === kind));
  return actions.length === 0;
}

/** What the next turn reads in recentTurns, so it does not take the summary for something done. */
export const HOLLOW_TURN_NOTE = "did not propose the actions it described, or said neither what it does nor what it waits on, so none of that was done";

type Hollow = NonNullable<TaskState["hollow"]>;

/** `state.hollow` after a hollow turn on `fingerprint`, which would otherwise have committed `commit`. */
export function countHollow(state: TaskState, fingerprint: string, commit: string, summary: string): Hollow {
  const count = state.hollow?.fingerprint === fingerprint ? state.hollow.count + 1 : 1;
  return { fingerprint, count, commit, summary };
}

export const flagDue = (hollow: Hollow | undefined, fingerprint: string): hollow is Hollow =>
  hollow?.fingerprint === fingerprint && hollow.count > HOLLOW_TURN_RETRIES;

/**
 * Posts that the task is stuck, once per fingerprint (Linear derives the comment id from the key across
 * restarts). Posted, the turn's fingerprint is committed and the count cleared; true when it was.
 */
export async function flagHollowTurn(
  issueId: string,
  state: TaskState,
  linear: Pick<LinearPort, "postComment">,
  log: (line: string) => void,
): Promise<boolean> {
  const hollow = state.hollow;
  if (!hollow) return false;
  const body = [
    "**Sergeant is stuck on this task**",
    "",
    `Sergeant's last ${hollow.count} turns on the same facts did not propose the actions they described, or said neither what they do nor what the task waits on. The latest said:`,
    "",
    ...hollow.summary.split("\n").map((line) => `> ${line}`),
    "",
    "None of that was done. Sergeant takes no more turns until something changes: a reply here, an edit to the issue, or a change to its PRs or runs wakes a fresh turn.",
  ].join("\n");
  try {
    await linear.postComment({ issueId, key: `hollow-turn:${issueId}:${hollow.fingerprint}`, body });
  } catch (e) {
    log(`could not post that the task is stuck, trying again next poll: ${(e as Error).message}`);
    return false;
  }
  log("posted that the task is stuck: its turns did not propose what they described");
  state.lastFingerprint = hollow.commit;
  state.hollow = undefined;
  return true;
}
