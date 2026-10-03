import { outstandingChangeRequests, type SituationReport } from "@terros/sergeant-contracts";
import type { DelegatedIssue } from "@terros/sergeant-linear";

// Fair task slots (TECH-5008). A task occupies one of `maxTasks` slots while its loop is running work
// (a worker or reviewer run, or a reasoning turn) or waiting on a human within the grace. Past the
// grace the service releases the slot: the loop keeps polling, cheaply, and once the human answers it
// asks for a slot again and is admitted in the same order as new work. Only in memory: after a restart
// every task is admitted afresh, and a wait already past its grace (timed from Linear's facts) gives
// its slot back at the loop's first poll.

/** Linear status rank: In Review, then In Progress (any other started state), then Todo, then the rest. */
function statusRank(state: DelegatedIssue["state"]): number {
  if (state.name.toLowerCase() === "in review") return 0;
  if (state.type === "started") return 1;
  if (state.type === "unstarted") return 2;
  return 3;
}

/** Urgent (1) first, then High, Medium, Low; no priority (0) last. */
const priorityRank = (priority: number) => (priority >= 1 && priority <= 4 ? priority : 5);

/** Admission order: status (finishing beats starting), then priority, then newest first. */
export function admissionOrder(a: DelegatedIssue, b: DelegatedIssue): number {
  return (
    statusRank(a.state) - statusRank(b.state) ||
    priorityRank(a.priority) - priorityRank(b.priority) ||
    Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
}

/** One task loop's hold on a slot, shared by the loop and the service. */
export class Slot {
  /** Since when the task has waited on a human while holding its slot. */
  waitingSince: number | undefined;
  /** Past the grace: the task holds no slot until the service admits it again. */
  released = false;
  /** Released, and has work again: queued for a slot. */
  wanted = false;

  /** Called whenever the slot changes in a way that may free one or queue for one. */
  readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
  }

  /** The task waits on a human since `since` (ms): it keeps its slot for the grace, then is released. */
  waiting(since: number): void {
    this.wanted = false;
    if (!this.released) this.waitingSince ??= since;
    this.changed();
  }

  /** The task has work to do now: true while it holds a slot, false while it is queued for one. */
  work(): boolean {
    if (!this.released) {
      this.waitingSince = undefined;
      return true;
    }
    if (!this.wanted) {
      this.wanted = true;
      this.changed();
    }
    return !this.released;
  }
}

/**
 * The human a quiet task with nothing running waits on, besides a question or a budget reply (loop.ts):
 * a merge GitHub refused it on an open PR's current head, or changes a human requested on an open PR.
 */
export function humanWait(s: SituationReport): string | undefined {
  for (const pr of s.pullRequests) {
    if (pr.state !== "open") continue;
    if (s.refusedMerges.some((r) => r.repo === pr.repo && r.number === pr.number && r.headSha === pr.headSha)) return `a human merge of ${pr.repo}#${pr.number}`;
    const requested = outstandingChangeRequests(pr.humanFeedback);
    if (requested.length > 0) return `${requested.join(", ")} on the changes requested on ${pr.repo}#${pr.number}`;
  }
  return undefined;
}
