import { z } from "zod";
import type { GateVerdict } from "./gate.ts";

const Instant = z.iso.datetime({ offset: true });

/**
 * The task's budget now (01 `BudgetStatus`), recomputed by the core every poll and never stored. Wall
 * time is hard: no new effect after `wallDeadline`. Spend is best-effort: the reported cost of finished
 * runs and of reasoning turns; a run's cost is known only once it ends, so the wall time is the
 * backstop (04 §7). There is no billing ledger.
 */
export const BudgetStatus = z.object({
  /** The configured allowance of one window. */
  window: z.object({ wallMinutes: z.number().positive(), costUsd: z.number().positive() }),
  /** When the window opened: the task's start, or the latest human answer to one of Sergeant's questions. */
  windowStart: Instant,
  /** One window after `windowStart`. */
  wallDeadline: Instant,
  /** The reported spend of this window's runs and turns. */
  spentUsd: z.number().nonnegative(),
  costLimitUsd: z.number().positive(),
  /** Runs whose cost is not known: running, canceled, or ended without reporting one. */
  unknownCostRuns: z.number().int().nonnegative(),
});
export type BudgetStatus = z.infer<typeof BudgetStatus>;

/** B1 (L3): no new run, message, or merge once the wall time or the observed spend is exhausted. */
export function checkBudget(budget: BudgetStatus, now: Date): GateVerdict {
  if (now.getTime() >= Date.parse(budget.wallDeadline)) {
    return { allowed: false, rule: "B1", reason: `wall time exhausted at ${budget.wallDeadline}` };
  }
  if (budget.spentUsd >= budget.costLimitUsd) {
    return { allowed: false, rule: "B1", reason: `spent $${budget.spentUsd.toFixed(2)} of $${budget.costLimitUsd.toFixed(2)}` };
  }
  return { allowed: true };
}
