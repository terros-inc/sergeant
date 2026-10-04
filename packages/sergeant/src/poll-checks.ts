import { checkBudget, checkLive, commentIdFor, type AgentComment, type BudgetStatus, type Conversation, type GateVerdict, type RunRecord, type SituationReport } from "@terros/sergeant-contracts";
import { budgetQuestion, budgetQuestionKey, openWindow, type BudgetWindow } from "./budget.ts";
import { recordStop, stopReason } from "./cancel.ts";
import { askHuman, describeOutcome, type Ports } from "./execute.ts";
import type { LoopOptions } from "./loop-options.ts";
import { reassigned } from "./owner.ts";
import { cancelRuns, landedOf, readPullRequests } from "./poll.ts";
import { latestAnswer, noteEdit, openQuestion } from "./question.ts";
import type { TaskState } from "./task-state.ts";

// The checks the loop (loop.ts) makes on every poll before a turn: the delegation, stop-state, and
// reassignment stop (A1/A2, TECH-5179), the budget, and the holds on unknown runs and on unanswered
// questions. Each says whether the loop goes on; the loop itself does all the waiting.

/** What the checks act through: the loop's options, ports, task state, and its log and save. */
export type PollContext = {
  opts: LoopOptions;
  deps: Ports;
  state: TaskState;
  log: (line: string) => void;
  save: () => Promise<void>;
};

/** The budget as this poll sees it, and the current window's budget question if Linear has it. */
export type BudgetCheck = { budget: BudgetStatus; exhausted: GateVerdict; budgetKey: string; budgetAsked: AgentComment | undefined };

/** A1/A2, and the owner's reassignment: why the task stops for good, once the stop is recorded (cancel.ts); undefined to go on. */
export async function checkStop(conversation: Conversation, runs: RunRecord[], { opts, deps, state }: PollContext): Promise<string | undefined> {
  // Before anything starts and on every poll: an issue not delegated to the V2 agent, or no longer
  // (A1), or that a human moved to Backlog, Canceled, or Done (A2), is not Sergeant's to work on, and
  // its task stops for good (cancel.ts). Done after the worker's closing PR merged is the task's
  // normal end instead, taken below. The executor re-checks both live before each effect.
  const active = checkLive(conversation.issue, deps.agentUserId);
  const finished =
    !active.allowed &&
    conversation.issue.stateType === "completed" &&
    landedOf(await readPullRequests(runs, conversation.issue.linkedPullRequests, opts.enrolledRepositories, deps), runs, deps.workerLogin) !== undefined;
  if (!active.allowed && !finished) {
    await recordStop(opts.dir, stopReason(conversation.issue));
    return active.reason;
  }
  // TECH-5179 (owner.ts): the issue no longer assigned to the owner the task was admitted for stops it
  // the same way, so token ownership never moves mid-task.
  const moved = active.allowed && state.owner ? reassigned(state.owner, conversation.issue) : undefined;
  if (moved) {
    await recordStop(opts.dir, moved);
    return moved;
  }
  return undefined;
}

/**
 * The budget and the holds before PRs are read, in order: an exhausted budget with live runs cancels
 * them, a run whose status is unknown waits, and an open question waits. Returns the hold, if any.
 */
export async function checkHolds(
  poll: { conversation: Conversation; live: string[]; unknown: { unknown: string; error: string }[]; budgetOf: () => BudgetStatus },
  configured: BudgetWindow,
  { opts, deps, state, log, save }: PollContext,
): Promise<{ hold: "budget" | "unknown" | "question" } | (BudgetCheck & { hold?: undefined })> {
  const { conversation, live, unknown } = poll;
  // TECH-5059: a human's answer to Sergeant's latest question, the budget question included, opens a
  // fresh window from the answer, with zero spend and the installation's budget now. Only an answer
  // newer than the window's start does, so it opens one window once, across restarts too.
  const answer = latestAnswer(conversation);
  if (answer && Date.parse(answer.createdAt) > Date.parse(state.budget.since ?? state.startedAt)) {
    openWindow(state, answer.createdAt, configured);
    await save();
    log(`a human answered (${answer.id}): a fresh budget window of ${JSON.stringify(configured)} from ${answer.createdAt}`);
  }
  // The budget question of the current window, if Linear has it: its id is derived from a key, so a
  // crash between posting it and saving anything loses nothing. The first window's key is the task's
  // start, so an earlier task's budget question, answered or not, is never this one's (TECH-5145).
  const windowStart = state.budget.since ?? state.startedAt;
  const budgetKey = budgetQuestionKey(conversation.issue.id, windowStart);
  const questionId = commentIdFor(budgetKey);
  const budgetAsked = conversation.agentComments.find((c) => c.id === questionId);
  const budget = poll.budgetOf();
  // UNF-728: an exhausted budget cancels running work through the runner, every poll until confirmed,
  // whatever else is going on; the executor refuses every new effect (B1).
  const exhausted = checkBudget(budget, new Date());
  if (!exhausted.allowed && live.length > 0) {
    log(`budget exhausted (${exhausted.reason}): canceling ${live.join(", ")}`);
    await cancelRuns(live, deps, log);
    return { hold: "budget" };
  }
  if (unknown.length > 0) {
    // An unreadable runner is a wait like any other: past the grace it gives up the slot (TECH-5015),
    // unless a readable run is confirmed running (live lists the unknown runs too).
    if (live.length === unknown.length) opts.slot?.waiting(Date.now());
    else opts.slot?.work();
    log(`waiting: status unavailable for ${unknown.map((u) => `${u.unknown} (${u.error})`).join(", ")}`);
    return { hold: "unknown" };
  }
  // An edit while Sergeant waits on a reply gets one short notice (TECH-5034); retried next poll if it fails.
  await noteEdit(conversation, state.seen, budgetAsked, deps.linear).then(
    (posted) => posted && log(`noted an edit to ${conversation.issue.identifier} made while waiting on a reply`),
    (e: Error) => log(`could not note the edit to ${conversation.issue.identifier}: ${e.message}`),
  );
  // While the question Sergeant asked is unanswered it takes no turn and makes no effect, and no
  // runaway guard ends the wait for the human (UNF-727). Any human change ends it: see question.ts.
  // The loop also drops any question it still has to post.
  const question = openQuestion(conversation);
  if (question) {
    if (live.length === 0) opts.slot?.waiting(Date.parse(question.createdAt));
    log(`waiting: the question posted at ${question.createdAt} has no human reply yet`);
    return { hold: "question" };
  }
  return { budget, exhausted, budgetKey, budgetAsked };
}

/** Whether the loop holds for the budget question: asking it, or waiting for a human's reply. */
export async function holdForBudget(situation: SituationReport, conversation: Conversation, check: BudgetCheck, { opts, deps, log }: PollContext): Promise<boolean> {
  const { exhausted, budgetAsked } = check;
  // One question per exhausted window, posted like any question but under a key of the task and the
  // window, and retried every poll until Linear shows it. Until a human replies after it, nothing
  // happens and no runaway guard ends the wait (UNF-727); the reply opens a fresh window (above) and
  // wakes a turn that reads it.
  if (!exhausted.allowed && !budgetAsked) {
    const asked = await askHuman(budgetQuestion(situation, exhausted.reason), situation, deps, check.budgetKey);
    log(`budget exhausted (${exhausted.reason}): asking whether to continue: ${describeOutcome(asked)}`);
    return true;
  }
  if (budgetAsked && !conversation.humanComments.some((c) => Date.parse(c.createdAt) > Date.parse(budgetAsked.createdAt))) {
    opts.slot?.waiting(Date.parse(budgetAsked.createdAt));
    log(`waiting: the budget question posted at ${budgetAsked.createdAt} has no human reply yet`);
    return true;
  }
  return false;
}
