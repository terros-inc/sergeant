import type { SituationReport } from "@terros/sergeant-contracts";
import type { ActionOutcome } from "./execute.ts";
import { failedMerges } from "./poll.ts";
import type { TaskState } from "./task-state.ts";

/** Drops bounded retries and completed handoffs when any fingerprinted fact changes. */
export function reconcileMergeRetries(state: TaskState, fingerprint: string): boolean {
  const retries = state.mergeRetries.filter((r) => r.fingerprint === fingerprint);
  // Records from before TECH-5077 have no fingerprint and retain their old M12 behavior.
  const refusals = state.refusedMerges.filter((r) => r.fingerprint === undefined || r.fingerprint === fingerprint);
  if (retries.length === state.mergeRetries.length && refusals.length === state.refusedMerges.length) return false;
  state.mergeRetries = retries;
  state.refusedMerges = refusals;
  return true;
}

export const dueMergeRetries = (state: TaskState, graceMs: number) => state.mergeRetries.filter((r) => Date.now() - Date.parse(r.at) >= graceMs);

/**
 * Consumes due re-checks and turns another unchanged failure into the existing human handoff. Any
 * failure while a re-check is pending for the same facts is that re-check, whichever turn caused it
 * (TECH-5089): a human's wake before the grace ends must not restart the grace.
 */
export function recordMergeRetries(
  state: TaskState,
  outcomes: ActionOutcome[],
  situation: SituationReport,
  fingerprint: string,
  dueRetries: TaskState["mergeRetries"],
): void {
  const keyOf = (r: { repo: string; number: number; headSha: string }) => `${r.repo}#${r.number}@${r.headSha}`;
  const pending = new Set(state.mergeRetries.filter((r) => r.fingerprint === fingerprint).map(keyOf));
  const due = new Set(dueRetries.map(keyOf));
  state.mergeRetries = state.mergeRetries.filter((r) => !due.has(keyOf(r)));
  for (const failure of failedMerges(outcomes, situation)) {
    const others = <T extends { repo: string; number: number }>(list: T[]) => list.filter((r) => r.repo !== failure.repo || r.number !== failure.number);
    // A human-merge handoff (TECH-5244) is no failure to re-check: it waits for a human at once.
    if (failure.human || pending.has(keyOf(failure))) {
      state.mergeRetries = others(state.mergeRetries);
      state.refusedMerges = [...others(state.refusedMerges), { ...failure, fingerprint }];
    } else {
      state.mergeRetries = [...others(state.mergeRetries), { ...failure, fingerprint }];
    }
  }
}
