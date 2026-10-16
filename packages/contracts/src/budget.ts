import { z } from "zod";
import type { GateVerdict } from "./gate.ts";

const Instant = z.iso.datetime({ offset: true });

/**
 * The task's budget now (01 `BudgetStatus`), recomputed by the core every poll and never stored. Its
 * time is hard: no new effect after `wallDeadline`. TECH-6165: that time is active time, while a worker or
 * reviewer run or a planner turn is running in the window; waiting on a human, CI or a task slot never
 * counts. Spend is best-effort: the reported cost of finished runs and of reasoning turns; a run's cost is
 * known only once it ends, so the time is the backstop (04 §7). There is no billing ledger.
 */
export const BudgetStatus = z.object({
  /** The configured allowance of one window. */
  window: z.object({ wallMinutes: z.number().positive(), costUsd: z.number().positive() }),
  /** When the task started: a re-triggered task starts anew, and its first window's budget question is its own (TECH-5145). */
  taskStart: Instant,
  /**
   * When the window opened: the task's start, the latest human direction (TECH-6165: an answer to one of
   * Sergeant's questions, any other human comment or review on the issue or its PRs, or the poll that saw
   * the issue edited or a PR Sergeant handed to a human merged or closed), or the poll that saw its last
   * blocker go (TECH-5803).
   */
  windowStart: Instant,
  /** TECH-6165: which window of the task this is, counting from 0, which keys its budget question; absent means 0. */
  windowSeq: z.number().int().nonnegative().optional(),
  /** TECH-6225: a budget question of this task asked before TECH-6165, keyed by its window's start; its comment id. */
  legacyQuestion: z.string().optional(),
  /**
   * When the window's active time runs out if the task works without pause from now: now plus the
   * `wallMinutes` it has not yet used (TECH-6165). Past, once they are used up.
   */
  wallDeadline: Instant,
  /** The reported spend of this window's runs and turns. */
  spentUsd: z.number().nonnegative(),
  costLimitUsd: z.number().positive(),
  /** Runs whose cost is not known: running, canceled, or ended without reporting one. */
  unknownCostRuns: z.number().int().nonnegative(),
});
export type BudgetStatus = z.infer<typeof BudgetStatus>;

/** B1 (L3): no new run, message, or merge once the active time or the observed spend is exhausted. */
export function checkBudget(budget: BudgetStatus, now: Date): GateVerdict {
  if (now.getTime() >= Date.parse(budget.wallDeadline)) {
    return { allowed: false, rule: "B1", reason: `active time exhausted (${budget.window.wallMinutes} minutes of work in this window)` };
  }
  if (budget.spentUsd >= budget.costLimitUsd) {
    return { allowed: false, rule: "B1", reason: `spent $${budget.spentUsd.toFixed(2)} of $${budget.costLimitUsd.toFixed(2)}` };
  }
  return { allowed: true };
}
