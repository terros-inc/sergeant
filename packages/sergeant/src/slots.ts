import type { ProposedAction, SituationReport } from "@terros/sergeant-contracts";
import type { DelegatedIssue } from "@terros/sergeant-linear";

// Task slots (TECH-5008, simplified by TECH-5015). A task holds one of `maxTasks` slots while it runs
// work (a worker or reviewer run, or a reasoning turn) and while it waits, for one grace each: up to
// the grace on an external condition (checks, mergeability, an API, anything else outside Sergeant),
// after which it asks a human (loop.ts), then up to the grace on that human's answer. Unanswered past
// that, the slot is released: the loop keeps polling, cheaply, and once something changes it queues
// and is admitted in the same order as new work. Only in memory: after a restart every task is
// admitted afresh, and a question already past its grace (timed from Linear) releases at the first poll.

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

/**
 * One task loop's slot, shared by the loop and the service: `held` while it works or waits within a
 * grace, `released` while an unanswered question is past it, `queued` once released and it has work.
 */
export class Slot {
  state: "held" | "released" | "queued" = "held";

  /** Called whenever a slot frees or a task queues for one. */
  readonly changed: () => void;

  constructor(changed: () => void) {
    this.changed = changed;
  }

  /** The human did not answer within the grace, and nothing changed: the next task in order gets the slot. */
  release(): void {
    if (this.state === "released") return;
    this.state = "released";
    this.changed();
  }

  /** The task has work to do now: true while it holds its slot; otherwise it queues for one. */
  take(): boolean {
    if (this.state === "released") {
      this.state = "queued";
      this.changed();
    }
    return this.state === "held";
  }
}

/** The question a task asks once it has waited the grace on something outside Sergeant with nothing changing. */
export function blockedQuestion(s: SituationReport, minutes: number, grace: number): Extract<ProposedAction, { kind: "ask_human" }> {
  const prs = s.pullRequests.map(
    (p) => `${p.repo}#${p.number} ${p.state}, mergeable ${p.mergeable ?? "unknown"}, checks ${p.checks.required.map((c) => `${c.name}=${c.state}`).join(",") || "none"}`,
  );
  const lines = [
    `Sergeant has waited ${minutes} minutes with nothing changing and no work running.`,
    "",
    `- PRs: ${prs.join("; ") || "none"}.`,
    ...(s.recentTurns.length > 0 ? [`- Last decision: ${s.recentTurns.at(-1)?.summary}`] : []),
    "",
    "What should Sergeant do?",
    "",
    `If the wait clears on GitHub (a merge, checks, a review), Sergeant continues without a reply. Otherwise it needs one: it keeps this task's slot for ${grace} more minutes, then frees it for other work; a reply or a change on GitHub then queues the task for a slot again.`,
  ];
  return { kind: "ask_human", question: lines.join("\n").slice(0, 4_000) };
}

/** The question a task asks once Linear, GitHub, or the runner has been unreadable for the grace. */
export function unavailableQuestion(what: string, minutes: number, grace: number): Extract<ProposedAction, { kind: "ask_human" }> {
  const question = [
    `Sergeant has waited ${minutes} minutes on an outage: ${what}.`,
    "",
    "What should Sergeant do?",
    "",
    `Sergeant retries every poll and continues as soon as the read succeeds. It keeps this task's slot for ${grace} more minutes, then frees it for other work; once the read succeeds, a reply or any other change queues the task for a slot again.`,
  ].join("\n");
  return { kind: "ask_human", question: question.slice(0, 4_000) };
}

/** The blocked question's closing line, in place of the usual "does nothing more until someone replies". */
export const blockedFooter = "Reply in your own words.";
