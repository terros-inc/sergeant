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

/** Consumes due re-checks and turns another unchanged failure into the existing human handoff. */
export function recordMergeRetries(
  state: TaskState,
  outcomes: ActionOutcome[],
  situation: SituationReport,
  fingerprint: string,
  dueRetries: TaskState["mergeRetries"],
): void {
  const due = new Set(dueRetries.map((r) => `${r.repo}#${r.number}@${r.headSha}`));
  state.mergeRetries = state.mergeRetries.filter((r) => !due.has(`${r.repo}#${r.number}@${r.headSha}`));
  for (const failure of failedMerges(outcomes, situation)) {
    const key = `${failure.repo}#${failure.number}@${failure.headSha}`;
    if (due.has(key)) {
      state.refusedMerges = [...state.refusedMerges.filter((r) => r.repo !== failure.repo || r.number !== failure.number), { ...failure, fingerprint }];
    } else {
      state.mergeRetries = [...state.mergeRetries.filter((r) => r.repo !== failure.repo || r.number !== failure.number), { ...failure, fingerprint }];
    }
  }
}
