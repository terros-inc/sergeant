import type { RepoSlug } from "@terros/sergeant-contracts";
import type { BudgetWindow } from "./budget.ts";
import type { Slot } from "./slots.ts";
import type { Wake } from "./wake.ts";

export type LoopOptions = {
  issueId: string;
  enrolledRepositories: RepoSlug[];
  /**
   * Holds `state.json`, `turns.jsonl` (every turn's report, output, and outcomes), `reviews.jsonl`
   * (`ReviewFacts` for every finished review; the last line per run id holds),
   * `audit-followups.jsonl` (audit must-fix findings on merged code), and `STOP`.
   */
  dir: string;
  /** The fraction of merged heads that skipped fresh review which get an audit review (06 §8). */
  auditSampleRate?: number;
  /** TECH-5227: false posts no progress comment after a review round (progress.ts); default true. */
  progressComments?: boolean;
  pollSeconds?: number;
  /** The service's existing waiting grace; also delays the one bounded retry after a merge failure. */
  waitingGraceMinutes?: number;
  /**
   * Minutes with nothing changing and nothing running before the loop ends. No turn count ends a task
   * (TECH-5059): a runaway is bounded by its budget window, and every effect is keyed or taken only
   * when something changed since the last turn.
   */
  idleMinutes?: number;
  /**
   * The task's budget window: hard wall time from the start, and best-effort spend (default 120
   * minutes, $25). Used when the task starts; an existing task keeps the window it started with.
   */
  budget?: Partial<BudgetWindow>;
  /** How long to watch Linear after the merge for the GitHub integration to move the issue. */
  completionWaitMinutes?: number;
  log?: (line: string) => void;
  /** Ends the loop at its next poll, never mid-turn: the service stopping. */
  signal?: AbortSignal;
  /** A human asking for a turn now (`sgt task wake`). */
  wake?: Wake;
  /** The task's slot (TECH-5008): told when the task waits on a human, and asked before each turn. */
  slot?: Slot;
};

export type LoopResult = {
  outcome: "done" | "merged_not_done" | "stopped" | "accepted" | "idle";
  detail: string;
};
