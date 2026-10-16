import { commentIdFor, type BudgetStatus, type ProposedAction, type RunRecord, type SituationReport } from "@terros/sergeant-contracts";
import { latestAnswer, latestQuestion } from "./question.ts";
import { recommendationLine, type StopCase } from "./stop-case.ts";

// UNF-728: a task-level budget, the hard boundary against runaway time (00 P7). TECH-6165: its time is
// active time, the time a worker or reviewer run or a planner turn is running in the window; waiting on a
// human, CI or a task slot never counts. Spend is the reported cost of the window's finished runs and
// turns. When either is exhausted, the loop cancels running work through the runner and asks the human,
// through the ordinary question path (UNF-727), whether to continue. Any human direction opens a fresh
// window (TECH-5059, TECH-6165, poll-checks.ts): an answer to that question, so "extend" needs nothing
// more, or any other human comment or review; a bot's never does, nor an unattributed edit or merge. A reply to it that accepts the
// work as it is ends the task instead (TECH-5118, accept_as_is).

export type BudgetWindow = BudgetStatus["window"];

export const DEFAULT_BUDGET: BudgetWindow = { wallMinutes: 120, costUsd: 25 };

/**
 * TECH-5219: the window a task works in, `window` with its repositories' overrides (the installation
 * config's `repositories[slug].budget`) applied: each field of a repository's override replaces the
 * window's, and over several repositories the largest of each field holds. A task with no run in a
 * repository yet has `window` itself.
 */
export function windowFor(window: BudgetWindow, repositories: readonly string[], override: (repo: string) => Partial<BudgetWindow> | undefined): BudgetWindow {
  const windows = repositories.map((r) => {
    const own = override(r);
    return { wallMinutes: own?.wallMinutes ?? window.wallMinutes, costUsd: own?.costUsd ?? window.costUsd };
  });
  if (windows.length === 0) return window;
  return { wallMinutes: Math.max(...windows.map((w) => w.wallMinutes)), costUsd: Math.max(...windows.map((w) => w.costUsd)) };
}

/** What `state.json` keeps of the budget: the window, and when and over which runs it opened. */
export type TaskBudget = {
  /** Fixed when the window opens; a restart with other options does not change it. */
  window: BudgetWindow;
  /** When the window opened, if not at the task's start. */
  since?: string | undefined;
  /** Runs of earlier windows, which this one does not count. */
  priorRuns: string[];
  /** TECH-6165: the window's active time already counted, in ms (`clockActive`). */
  activeMs?: number | undefined;
  /** TECH-6165: since when a run or turn has been running, while one is; its time counts too. */
  activeSince?: string | undefined;
  /** TECH-6165: which window of the task this is, counting from 0 (`openWindow`); absent before any has opened. */
  windowSeq?: number | undefined;
};

/**
 * The one way a task gets a fresh budget window: from `at`, with zero spend and `window`, the
 * installation's budget now, and none of its active time used; work still running counts from now. Any
 * human direction opens one (TECH-6165, poll-checks.ts): an answer to one of Sergeant's questions
 * (TECH-5059), any other human comment or review on the issue or its PRs (TECH-5218, TECH-5913); so does
 * its last blocker going (TECH-5803).
 */
export function openWindow(state: { turnCostUsd: number; runIds: string[]; budget: TaskBudget }, at: string, window: BudgetWindow): void {
  state.turnCostUsd = 0;
  const active = state.budget.activeSince !== undefined ? { activeSince: new Date().toISOString() } : {};
  state.budget = { window, since: at, priorRuns: [...state.runIds], activeMs: 0, ...active, windowSeq: (state.budget.windowSeq ?? 0) + 1 };
}

/**
 * TECH-6165: starts the window's clock when a run or turn is running (`active`) and stops it, counting
 * the time, when none is. The loop calls it as it sees runs and around each turn. Returns whether it
 * changed anything, to save.
 */
export function clockActive(budget: TaskBudget, active: boolean, at: number = Date.now()): boolean {
  if (active === (budget.activeSince !== undefined)) return false;
  if (active) budget.activeSince = new Date(at).toISOString();
  else {
    budget.activeMs = (budget.activeMs ?? 0) + Math.max(0, at - Date.parse(budget.activeSince ?? ""));
    budget.activeSince = undefined;
  }
  return true;
}

/**
 * The budget question's idempotency key: one per task and window, keyed by the task's start and the
 * window's number (TECH-6165, `windowSeq`), so a restart finds the question already asked from Linear
 * alone and never asks it twice. TECH-5145: the first window's key was `0` for every task, so a
 * re-triggered task's first budget question matched the earlier task's, Linear posted nothing, and the
 * task found that earlier, answered question and never waited for a human; the task's start keeps them apart.
 */
export const budgetQuestionKey = (issueId: string, taskStart: string, windowSeq: number | undefined) => `budget-question:${issueId}:${taskStart}:${windowSeq ?? 0}`;

/**
 * TECH-6225: the key a budget question had before TECH-6165, its window's start. A task saved then may
 * still have its question open under it; a deploy that missed it asked again.
 */
export const legacyBudgetQuestionKey = (issueId: string, windowStart: string) => `budget-question:${issueId}:${windowStart}`;

/**
 * TECH-5118: whether a human has replied to Sergeant's budget question, the question it asked last (or a
 * clarifying question in that question's thread). Every budget question of this task has the key of one
 * of its windows so far, 0 to `windowSeq` (TECH-6165), however each opened, or is the one asked before
 * TECH-6165 (`legacyQuestion`).
 *
 * TECH-5137: only a reply given in the current window counts. A reply to one of this task's questions
 * opens a window from itself (poll-checks.ts), so it is never older than `windowStart`; a reply from
 * before a re-trigger predates this task's start, and so its first window. Without this, a re-triggered
 * task whose latest answer was still the earlier task's could end on it, and its acknowledgment, keyed
 * by that reply (accepted.ts), matched the earlier one, so Linear posted nothing. TECH-5145: nor is an
 * earlier task's budget question this task's, whatever was said after it.
 */
export function answeredBudgetQuestion(
  situation: Pick<SituationReport, "conversation">,
  budget: Pick<BudgetStatus, "taskStart" | "windowStart" | "windowSeq" | "legacyQuestion">,
): boolean {
  const { conversation } = situation;
  const asked = latestQuestion(conversation);
  const reply = latestAnswer(conversation);
  if (!asked || !reply || Date.parse(reply.createdAt) < Date.parse(budget.windowStart)) return false;
  const thread = asked.parentId ?? asked.id;
  const keys = Array.from({ length: (budget.windowSeq ?? 0) + 1 }, (_, seq) => budgetQuestionKey(conversation.issue.id, budget.taskStart, seq));
  // TECH-6225: or the one asked before TECH-6165, whichever window it was (poll-checks.ts `checkHolds`).
  return [...keys.map(commentIdFor), ...(budget.legacyQuestion ? [budget.legacyQuestion] : [])].includes(thread);
}

/** The task's budget now, from what `state.json` keeps (start, window, active time, turn spend) and the run records. */
export function budgetStatus(input: {
  window: BudgetWindow;
  since?: string | undefined;
  priorRuns?: string[] | undefined;
  windowSeq?: number | undefined;
  activeMs?: number | undefined;
  activeSince?: string | undefined;
  legacyQuestion?: string | undefined;
  startedAt: string;
  turnCostUsd: number;
  runs: RunRecord[];
  /** Runs whose status could not be read this poll. */
  unknownRuns: number;
}): BudgetStatus {
  const { window } = input;
  const runs = input.runs.filter((r) => !input.priorRuns?.includes(r.runId));
  const runCost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const now = Date.now();
  const activeMs = (input.activeMs ?? 0) + (input.activeSince ? Math.max(0, now - Date.parse(input.activeSince)) : 0);
  return {
    window,
    taskStart: input.startedAt,
    windowStart: input.since ?? input.startedAt,
    ...(input.windowSeq !== undefined && { windowSeq: input.windowSeq }),
    ...(input.legacyQuestion && { legacyQuestion: input.legacyQuestion }),
    wallDeadline: new Date(now + window.wallMinutes * 60_000 - activeMs).toISOString(),
    spentUsd: round(runCost + input.turnCostUsd),
    costLimitUsd: window.costUsd,
    unknownCostRuns: runs.filter((r) => r.costUsd === undefined).length + input.unknownRuns,
  };
}

/**
 * The one comment on exhaustion: why it stopped, the case for the human's call (TECH-6021, stop-case.ts:
 * what happened in the window, where the work stands and what is left, and the stop rubric's
 * recommendation with its rule and estimated remaining cost), and whether to continue.
 */
export function budgetQuestion(situation: SituationReport, why: string, stop: StopCase): Extract<ProposedAction, { kind: "ask_human" }> {
  const { budget } = situation;
  const unknown = budget.unknownCostRuns > 0 ? ` (cost unknown for ${budget.unknownCostRuns} run${budget.unknownCostRuns === 1 ? "" : "s"})` : "";
  const recommendation = recommendationLine({ ...stop.recommendation, reason: clip(stop.recommendation.reason, 1_000) });
  const prefix = [
    `Sergeant stopped this task: its budget is exhausted (${clip(why, 500)}). Running work was canceled.`,
    "",
  ];
  const suffix = [
    recommendation,
    "",
    "Continue?",
  ];
  const middle = [
    `**What happened in this window:** ${stop.happened}`,
    "",
    "**Where it stands:**",
    ...stop.standing.map((line) => `- ${line}`),
    `- Spent: $${budget.spentUsd.toFixed(2)} of $${budget.costLimitUsd.toFixed(2)} reported${unknown}.`,
    "",
  ];
  // Linear's limit must never remove the decision itself. Reserve the recommendation (including its
  // rubric rule and estimate) and the question tail, and shorten only the narrative/standing first.
  const fixed = [...prefix, ...suffix].join("\n");
  const middleText = middle.join("\n");
  const room = Math.max(0, 4_000 - fixed.length - 1);
  const clipped = middleText.length > room ? `${middleText.slice(0, Math.max(0, room - 1))}…` : middleText;
  const question = [...prefix, clipped, ...suffix].join("\n");
  return {
    kind: "ask_human",
    question,
    options: [
      "Extend: continue in a fresh window of the installation's budget, from when the task resumes work after your reply",
      "Accept as-is: stop here and leave the work where it is",
    ],
  };
}

const round = (usd: number) => Math.round(usd * 100) / 100;
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1)}…` : text);
