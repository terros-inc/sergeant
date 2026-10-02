import { z } from "zod";
import type { GrantBudget } from "./actions.ts";
import type { Conversation } from "./conversation.ts";
import type { GateVerdict } from "./gate.ts";

const Instant = z.iso.datetime({ offset: true });

/**
 * The task's budget now (01 `BudgetStatus`), recomputed by the core every poll and never stored. Wall
 * time is hard: no new effect after `wallDeadline`. Spend is best-effort: the reported cost of finished
 * runs and of reasoning turns; a run's cost is known only once it ends, so the wall time is the
 * backstop (04 §7). There is no billing ledger.
 */
export const BudgetStatus = z.object({
  /** One window: the configured allowance. Each human grant adds one more (K4). */
  window: z.object({ wallMinutes: z.number().positive(), costUsd: z.number().positive() }),
  /** One window after the task started, or after the latest grant. */
  wallDeadline: Instant,
  spentUsd: z.number().nonnegative(),
  /** The window's cost times the windows granted so far. */
  costLimitUsd: z.number().positive(),
  /** Runs whose cost is not known: running, canceled, or ended without reporting one. */
  unknownCostRuns: z.number().int().nonnegative(),
  grants: z.array(z.object({ commentId: z.string().min(1), at: Instant })),
  /** The question Sergeant asked when this window ran out; only a human reply after it can grant. */
  questionId: z.string().min(1).optional(),
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

/**
 * K1 and K3 (03 §7): a grant cites a human comment on this issue posted after the budget question,
 * and no earlier grant cites it. Reasoning reads the reply; this checks only that one exists to cite.
 */
export function checkGrant(action: GrantBudget, facts: { budget: BudgetStatus; conversation: Conversation }): GateVerdict {
  const deny = (rule: string, reason: string): GateVerdict => ({ allowed: false, rule, reason });
  const comment = facts.conversation.humanComments.find((c) => c.id === action.commentId);
  if (!comment) return deny("K1", `${action.commentId} is not a human comment on this issue`);
  const question = facts.conversation.agentComments.find((c) => c.id === facts.budget.questionId);
  if (!question) return deny("K3", "Sergeant has not asked whether to continue past this budget");
  if (Date.parse(comment.createdAt) <= Date.parse(question.createdAt)) {
    return deny("K3", `${comment.id} predates the budget question`);
  }
  if (facts.budget.grants.some((g) => g.commentId === comment.id)) return deny("K3", `${comment.id} already granted a window`);
  return { allowed: true };
}
