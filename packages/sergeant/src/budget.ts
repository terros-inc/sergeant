import { commentIdFor, type AgentComment, type BudgetStatus, type Conversation, type ProposedAction, type PullRequestFacts, type RunRecord, type SituationReport } from "@terros/sergeant-contracts";
import { latestAnswer, latestQuestion } from "./question.ts";

// UNF-728: a task-level budget, the hard boundary against runaway time (00 P7). Wall time runs from
// the window's start; spend is the reported cost of the window's finished runs and turns. When either
// is exhausted, the loop cancels running work through the runner and asks the human, through the
// ordinary question path (UNF-727), whether to continue. A human's answer to any of Sergeant's
// questions, that one included, opens a fresh window (TECH-5059): "extend" needs nothing more. A reply
// to it that accepts the work as it is ends the task instead (TECH-5118, accept_as_is).

export type BudgetWindow = BudgetStatus["window"];

export const DEFAULT_BUDGET: BudgetWindow = { wallMinutes: 120, costUsd: 25 };

/** What `state.json` keeps of the budget: the window, and when and over which runs it opened. */
export type TaskBudget = {
  /** Fixed when the window opens; a restart with other options does not change it. */
  window: BudgetWindow;
  /** When the window opened, if not at the task's start. */
  since?: string | undefined;
  /** Runs of earlier windows, which this one does not count. */
  priorRuns: string[];
};

/**
 * The one way a task gets a fresh budget window: from `at`, with zero spend and `window`, the
 * installation's budget now. A human's answer to one of Sergeant's questions opens one (TECH-5059);
 * so should any other human decision that resets the clock.
 */
export function openWindow(state: { turnCostUsd: number; runIds: string[]; budget: TaskBudget }, at: string, window: BudgetWindow): void {
  state.turnCostUsd = 0;
  state.budget = { window, since: at, priorRuns: [...state.runIds] };
}

/**
 * The budget question's idempotency key: one per task and window, keyed by the window's start (the
 * task's start for its first window), so a restart finds the question already asked from Linear alone
 * and never asks it twice. TECH-5145: the first window's key was `0` for every task, so a re-triggered
 * task's first budget question matched the earlier task's, Linear posted nothing, and the task found
 * that earlier, answered question and never waited for a human.
 */
export const budgetQuestionKey = (issueId: string, windowStart: string) => `budget-question:${issueId}:${windowStart}`;

/**
 * Whether `comment` is this task's budget question for the window from `windowStart`. A first-window
 * question posted under the old `0` key before TECH-5145 is this task's only if posted since it started.
 */
export function isBudgetQuestion(comment: Pick<AgentComment, "id" | "createdAt">, issueId: string, taskStart: string, windowStart: string): boolean {
  if (comment.id === commentIdFor(budgetQuestionKey(issueId, windowStart))) return true;
  return windowStart === taskStart && comment.id === commentIdFor(`budget-question:${issueId}:0`) && Date.parse(comment.createdAt) >= Date.parse(taskStart);
}

/**
 * TECH-5118: whether a human has replied to Sergeant's budget question, the question it asked last (or a
 * clarifying question in that question's thread). Read from the conversation alone, so it survives a
 * restart: a window opens at the task's start or at a later human comment's time, so every budget
 * question of this task has the key of one of those times.
 *
 * TECH-5137: only a reply given in the current window counts. A reply to one of this task's questions
 * opens a window from itself (poll-checks.ts), so it is never older than `windowStart`; a reply from
 * before a re-trigger predates this task's start, and so its first window. Without this, a re-triggered
 * task whose latest answer was still the earlier task's could end on it, and its acknowledgment, keyed
 * by that reply (accepted.ts), matched the earlier one, so Linear posted nothing. TECH-5145: nor is an
 * earlier task's budget question this task's, whatever was said after it.
 */
export function answeredBudgetQuestion(conversation: Conversation, budget: Pick<BudgetStatus, "taskStart" | "windowStart">): boolean {
  const asked = latestQuestion(conversation);
  const reply = latestAnswer(conversation);
  if (!asked || !reply || Date.parse(reply.createdAt) < Date.parse(budget.windowStart)) return false;
  const { issue, humanComments, agentComments } = conversation;
  const thread = asked.parentId ?? asked.id;
  const root = agentComments.find((c) => c.id === thread) ?? { id: thread, createdAt: asked.createdAt };
  const since = (at: string) => Date.parse(at) >= Date.parse(budget.taskStart);
  const windows = [budget.taskStart, ...humanComments.map((c) => c.createdAt).filter(since)];
  return windows.some((windowStart) => isBudgetQuestion(root, issue.id, budget.taskStart, windowStart));
}

/** The task's budget now, from what `state.json` keeps (start, window, turn spend) and the run records. */
export function budgetStatus(input: {
  window: BudgetWindow;
  since?: string | undefined;
  priorRuns?: string[] | undefined;
  startedAt: string;
  turnCostUsd: number;
  runs: RunRecord[];
  /** Runs whose status could not be read this poll. */
  unknownRuns: number;
}): BudgetStatus {
  const { window } = input;
  const windowStart = input.since ?? input.startedAt;
  const runs = input.runs.filter((r) => !input.priorRuns?.includes(r.runId));
  const runCost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  return {
    window,
    taskStart: input.startedAt,
    windowStart,
    wallDeadline: new Date(Date.parse(windowStart) + window.wallMinutes * 60_000).toISOString(),
    spentUsd: round(runCost + input.turnCostUsd),
    costLimitUsd: window.costUsd,
    unknownCostRuns: runs.filter((r) => r.costUsd === undefined).length + input.unknownRuns,
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
      "Extend: continue in a fresh window, from your reply, of the installation's budget",
      "Accept as-is: stop here and leave the work where it is",
    ],
  };
}

const describePr = (p: PullRequestFacts) => {
  const checks = p.checks.required.map((c) => `${c.name} ${c.state}`).join(", ") || "no required checks";
  return `${p.url} ${p.state}${p.draft ? " draft" : ""}, ${checks}`;
};

const round = (usd: number) => Math.round(usd * 100) / 100;
