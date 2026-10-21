import type { LinearPort, TurnOutput } from "@terros/sergeant-contracts";

/**
 * TECH-6490: a turn that proposes no action and names nothing it waits on has not decided to wait,
 * whatever its summary says (it may describe actions it never proposed). Its fingerprint is left
 * uncommitted so a fresh turn runs on the same facts, at most `HOLLOW_TURN_RETRIES` more times; after
 * that the fingerprint is committed and the issue says the task is stuck, so a human can wake it.
 * The count lives only in memory: a restart allows another retry, which is bounded by restarts.
 */
export const HOLLOW_TURN_RETRIES = 1;

export const isHollow = (output: TurnOutput) => output.actions.length === 0 && output.waitingOn === undefined;

/** What the next turn reads in recentTurns, so it does not take the summary for something done. */
export const HOLLOW_TURN_NOTE = "proposed no action and named nothing it waits on, so nothing was done";

/** Tracks hollow turns on one fingerprint; `next` says what to do with the latest. */
export function hollowTurns() {
  let last: { fingerprint: string; count: number } | undefined;
  return {
    next(fingerprint: string): "retry" | "flag" {
      last = last?.fingerprint === fingerprint ? { fingerprint, count: last.count + 1 } : { fingerprint, count: 1 };
      return last.count > HOLLOW_TURN_RETRIES ? "flag" : "retry";
    },
    clear() {
      last = undefined;
    },
  };
}

/** Once per fingerprint; Linear derives the comment id from the key across restarts. */
export async function flagHollowTurn(
  issueId: string,
  fingerprint: string,
  summary: string,
  linear: Pick<LinearPort, "postComment">,
  log: (line: string) => void,
): Promise<void> {
  const body = [
    "**Sergeant is stuck on this task**",
    "",
    `Sergeant's last ${HOLLOW_TURN_RETRIES + 1} turns on the same facts proposed no action and named nothing the task waits on. The latest said:`,
    "",
    ...summary.split("\n").map((line) => `> ${line}`),
    "",
    "None of that was done. Sergeant takes no more turns until something changes: a reply here, an edit to the issue, or a change to its PRs or runs wakes a fresh turn.",
  ].join("\n");
  await linear.postComment({ issueId, key: `hollow-turn:${issueId}:${fingerprint}`, body }).then(
    () => log("posted that the task is stuck: its turns proposed nothing"),
    (e: Error) => log(`could not post that the task is stuck: ${e.message}`),
  );
}
