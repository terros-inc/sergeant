import type { BudgetStatus, ProposedAction, PullRequestFacts, RunRecord, SituationReport } from "@terros/sergeant-contracts";

// UNF-728: a task-level budget, the hard boundary against runaway time (00 P7). Wall time runs from
// the task's start, or from the latest grant; spend is the reported cost of finished runs and turns.
// When either is exhausted, the loop cancels running work through the runner and asks the human,
// through the ordinary question path (UNF-727), whether to continue. A reply reasoning reads as
// "extend" becomes a `grant_budget` citing it: one more window. Anything else leaves the task stopped.

export type BudgetWindow = BudgetStatus["window"];

export const DEFAULT_BUDGET: BudgetWindow = { wallMinutes: 120, costUsd: 25 };

/**
 * The budget question's idempotency key: one per task and window (0 for the first, then one per
 * grant), so a restart finds the question already asked from Linear alone and never asks it twice.
 */
export const budgetQuestionKey = (issueId: string, window: number) => `budget-question:${issueId}:${window}`;

/** The task's budget now, from what `state.json` keeps (start, window, turn spend, grants) and the run records. */
export function budgetStatus(input: {
  window: BudgetWindow;
  startedAt: string;
  turnCostUsd: number;
  grants: BudgetStatus["grants"];
  questionId?: string | undefined;
  runs: RunRecord[];
  /** Runs whose status could not be read this poll. */
  unknownRuns: number;
}): BudgetStatus {
  const { window, grants } = input;
  const windowStart = grants.at(-1)?.at ?? input.startedAt;
  const runCost = input.runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  return {
    window,
    wallDeadline: new Date(Date.parse(windowStart) + window.wallMinutes * 60_000).toISOString(),
    spentUsd: round(runCost + input.turnCostUsd),
    costLimitUsd: window.costUsd * (grants.length + 1),
    unknownCostRuns: input.runs.filter((r) => r.costUsd === undefined).length + input.unknownRuns,
    grants,
    ...(input.questionId !== undefined && { questionId: input.questionId }),
  };
}

/** The one concise comment on exhaustion: why it stopped, where the work stands, and whether to continue. */
export function budgetQuestion(situation: SituationReport, why: string): Extract<ProposedAction, { kind: "ask_human" }> {
  const { budget, runs, pullRequests, recentTurns } = situation;
  const unknown = budget.unknownCostRuns > 0 ? ` (cost unknown for ${budget.unknownCostRuns} run${budget.unknownCostRuns === 1 ? "" : "s"})` : "";
  const lines = [
    `Sergeant stopped this task: its budget is exhausted (${why}). Running work was canceled.`,
    "",
    `- Spent: $${budget.spentUsd.toFixed(2)} of $${budget.costLimitUsd.toFixed(2)} reported${unknown}.`,
    `- Runs: ${runs.map((r) => `${r.role} ${r.status}`).join(", ") || "none"}.`,
    `- PRs: ${pullRequests.map(describePr).join("; ") || "none"}.`,
    ...(recentTurns.length > 0 ? [`- Last decision: ${recentTurns.at(-1)?.summary}`] : []),
    "",
    "Continue?",
  ];
  return {
    kind: "ask_human",
    question: lines.join("\n").slice(0, 4_000),
    options: [
      `Extend: one more window (${budget.window.wallMinutes} more minutes and $${budget.window.costUsd} more)`,
      "Accept as-is: stop here and leave the work where it is",
    ],
  };
}

const describePr = (p: PullRequestFacts) => {
  const checks = p.checks.required.map((c) => `${c.name} ${c.state}`).join(", ") || "no required checks";
  return `${p.url} ${p.state}${p.draft ? " draft" : ""}, ${checks}`;
};

const round = (usd: number) => Math.round(usd * 100) / 100;
