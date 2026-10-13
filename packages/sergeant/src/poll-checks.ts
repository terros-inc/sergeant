import {
  checkBudget,
  checkLive,
  commentIdFor,
  type AgentComment,
  type BudgetStatus,
  type Conversation,
  type GateVerdict,
  type RepoSlug,
  type RunRecord,
  type SituationReport,
} from "@terros/sergeant-contracts";
import { join } from "node:path";
import { budgetQuestion, budgetQuestionKey, openWindow, type BudgetWindow } from "./budget.ts";
import { recordStop, stopReason } from "./cancel.ts";
import { askHuman, describeOutcome, type Ports } from "./execute.ts";
import type { LoopOptions } from "./loop-options.ts";
import { reassigned, redelegated } from "./owner.ts";
import { cancelRuns, landedOf, readPullRequests } from "./poll.ts";
import { reviewWindowFeedback } from "./pr-wait.ts";
import { latestAnswer, noteEdit, openQuestion } from "./question.ts";
import { stopCase } from "./stop-case.ts";
import { recordBudgetStop, recordReply, windowTurns } from "./stop-ledger.ts";
import type { WindowFacts } from "./stop-rubric.ts";
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

/**
 * TECH-5923: the history reread is most of a poll's Linear cost, so a poll rereads it at most this
 * often. An effect that spends the owner's quota or lands their work still rereads it first (`notOwned`).
 * TECH-5974: the proof is persisted in `state.json` (`ownerProvenAt`), so a restart does not reread a
 * still-valid one; past this window it is a safety net for a missed delegation webhook.
 */
export const OWNER_RECHECK_MS = 10 * 60_000;

/**
 * TECH-5974: an extra per-issue slice of up to this long is added to the recheck window, so proofs that
 * expire together (after a restart, say) reread spread out over it, not all at once in one Linear burst.
 */
export const OWNER_RECHECK_JITTER_MS = 5 * 60_000;

/** A deterministic offset in `[0, OWNER_RECHECK_JITTER_MS)` from the issue id, stable for a task's life. */
export function ownerRecheckJitter(issueId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < issueId.length; i++) hash = Math.imul(hash ^ issueId.charCodeAt(i), 0x01000193);
  // A final avalanche, so ids that differ only in their last digits (TECH-5900, TECH-5901, …) still spread.
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2c1b3c6d);
  hash ^= hash >>> 12;
  return (hash >>> 0) % OWNER_RECHECK_JITTER_MS;
}

/** The budget as this poll sees it, and the current window's budget question if Linear has it. */
export type BudgetCheck = { budget: BudgetStatus; exhausted: GateVerdict; budgetKey: string; budgetAsked: AgentComment | undefined };

/**
 * A1/A2, and the owner's reassignment or redelegation: why the task stops for good, once the stop is
 * recorded (cancel.ts); `hold` when the owner's delegation cannot be proven this poll; undefined to go on.
 */
export async function checkStop(conversation: Conversation, runs: RunRecord[], ctx: PollContext): Promise<string | { hold: string } | undefined> {
  const { opts, deps, state, log, save } = ctx;
  // Before anything starts and on every poll: an issue not delegated to the V2 agent, or no longer
  // (A1), or that a human moved to Backlog, Canceled, or Done (A2), is not Sergeant's to work on, and
  // its task stops for good (cancel.ts). Done after the worker's closing PR merged is the task's
  // normal end instead, taken below. The executor re-checks both live before each effect.
  const active = checkLive(conversation.issue, deps.agentUserId);
  const finished =
    !active.allowed &&
    conversation.issue.stateType === "completed" &&
    landedOf(await readPullRequests(runs, conversation.issue.linkedPullRequests, opts.enrolledRepositories, deps), runs, deps.workerLogin) !== undefined;
  // TECH-5179 (owner.ts): the issue no longer assigned to the owner the task was admitted for stops it
  // too, so token ownership never moves mid-task. It is a handoff (cancel.ts): PRs and branches are
  // kept for whoever continues. Checked first, so an undelegation or a state change seen in the same
  // poll still hands off rather than closing the PRs.
  const moved = state.owner && !finished ? reassigned(state.owner, conversation.issue) : undefined;
  if (moved) {
    await recordStop(opts.dir, moved, { handoff: { delegatedAt: state.owner?.delegatedAt } });
    return moved;
  }
  if (!active.allowed && !finished) {
    await recordStop(opts.dir, stopReason(conversation.issue));
    return active.reason;
  }
  // Linear's durable history is reread too: a newer delegation, or someone else's, is a new episode.
  // Unreadable, nothing new starts this poll (fails closed). TECH-5974: the proof is kept in state.json,
  // so a still-valid one survives a restart and is not redone; past the recheck window (with its per-issue
  // jitter) it is reread as a safety net for a missed delegation webhook, spread so a restart's proofs do
  // not expire into one Linear burst. A delegation webhook clears the proof to force a fresh read (loop.ts),
  // and an effect that spends the owner's quota rereads live regardless (notOwned).
  if (!active.allowed || !state.owner) return undefined;
  const at = Date.now();
  const provenAt = state.ownerProvenAt ? Date.parse(state.ownerProvenAt) : undefined;
  if (provenAt !== undefined && at - provenAt < OWNER_RECHECK_MS + ownerRecheckJitter(opts.issueId)) return undefined;
  let changed: string | undefined;
  try {
    changed = await redelegated(state.owner, opts.issueId, deps);
  } catch (e) {
    log(`holding: who delegated ${opts.issueId} is unreadable: ${(e as Error).message}`);
    return { hold: "delegation unreadable" };
  }
  if (changed) {
    await recordStop(opts.dir, changed, { handoff: { delegatedAt: state.owner.delegatedAt } });
    return changed;
  }
  state.ownerProvenAt = new Date(at).toISOString();
  await save();
  return undefined;
}

/**
 * The budget and the holds before PRs are read, in order: an exhausted budget with live runs cancels
 * them, a run whose status is unknown waits, and an open question waits. Returns the hold, if any.
 */
export async function checkHolds(
  poll: { conversation: Conversation; live: string[]; unknown: { unknown: string; error: string }[]; budgetOf: () => BudgetStatus },
  configured: BudgetWindow,
  ctx: PollContext,
): Promise<{ hold: "budget" | "unknown" | "question" } | (BudgetCheck & { hold?: undefined })> {
  const { opts, deps, state, log, save } = ctx;
  const { conversation, live, unknown } = poll;
  // TECH-5059: a human's answer to Sergeant's latest question, the budget question included, opens a
  // fresh window from the answer, with zero spend and the installation's budget now. Only an answer
  // newer than the window's start does, so it opens one window once, across restarts too.
  const answer = latestAnswer(conversation);
  if (answer && Date.parse(answer.createdAt) > Date.parse(state.budget.since ?? state.startedAt)) {
    // Record against the old window before save can fail after advancing it; measurement must not
    // lose a reply just because persisting the fresh window needs a retry.
    await recordReply(opts.dir, conversation).catch((e: Error) => log(`could not record the reply to the budget question: ${e.message}`));
    openWindow(state, answer.createdAt, configured);
    await save();
    log(`a human answered (${answer.id}): a fresh budget window of ${JSON.stringify(configured)} from ${answer.createdAt}`);
  }
  await openUnblockWindow(conversation, configured, ctx);
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

/**
 * TECH-5803: the task unblocked, its last open blocker completed or canceled or its "blocked by"
 * relation removed, opens a fresh window from the poll that sees it, exactly as an answer does (above),
 * however exhausted the window it replaces. Linear has no time for a removed relation, so the blockers
 * the last poll read are kept in `state.json`, and so is the window's start (budget.ts). A blocker list
 * Linear did not give (absent) changes nothing; one still open, or unread past its page, keeps waiting.
 */
async function openUnblockWindow(conversation: Conversation, configured: BudgetWindow, { state, log, save }: PollContext): Promise<void> {
  const blockedBy = conversation.issue.blockedBy;
  const before = state.blockedBy;
  if (!blockedBy || (before && before.join("\n") === blockedBy.join("\n"))) return;
  state.blockedBy = blockedBy;
  if (before?.length && blockedBy.length === 0) {
    const at = new Date().toISOString();
    openWindow(state, at, configured);
    state.unblockedAt.push(at);
    log(`unblocked (was waiting on ${before.join(", ")}): a fresh budget window of ${JSON.stringify(configured)} from ${at}`);
  }
  await save();
}

/**
 * TECH-5218, TECH-5913: human feedback on the task's PR, or an issue comment after Sergeant's review
 * escalation, opens a fresh window exactly as an answer does. Only input newer than the window's start
 * does, so it opens one window once, across restarts too. Returns whether it opened one.
 */
export async function openReviewWindow(situation: SituationReport, configured: BudgetWindow, { state, log, save }: PollContext): Promise<boolean> {
  const feedback = reviewWindowFeedback(situation)
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .at(-1);
  if (!feedback || Date.parse(feedback.createdAt) <= Date.parse(state.budget.since ?? state.startedAt)) return false;
  openWindow(state, feedback.createdAt, configured);
  await save();
  const source = "url" in feedback ? `${feedback.author} responded on the PR (${feedback.url})` : `${feedback.author.name} commented on the issue`;
  log(`${source}: a fresh budget window of ${JSON.stringify(configured)} from ${feedback.createdAt}`);
  return true;
}

/**
 * Whether the loop holds for the budget question: asking it, or waiting for a human's reply. Not while
 * Sergeant waits on a human PR action (`humanWait`, pr-wait.ts): that is a human wait, like a question.
 */
export async function holdForBudget(
  situation: SituationReport,
  conversation: Conversation,
  check: BudgetCheck,
  { opts, deps, state, log }: PollContext,
  humanWait?: string,
): Promise<boolean> {
  const { exhausted, budgetAsked } = check;
  // One question per exhausted window, posted like any question but under a key of the task and the
  // window, and retried every poll until Linear shows it. Until a human replies after it, nothing
  // happens and no runaway guard ends the wait (UNF-727); the reply opens a fresh window (above) and
  // wakes a turn that reads it.
  // TECH-6021: the question makes the case for the human's call, built here from the ledger (stop-case.ts).
  if (!exhausted.allowed && !budgetAsked && !humanWait) {
    const stop = stopCase(await windowFacts(situation, { opts, deps, state }));
    const asked = await askHuman(budgetQuestion(situation, exhausted.reason, stop), situation, deps, check.budgetKey);
    const { call, rule } = stop.recommendation;
    log(`budget exhausted (${exhausted.reason}): asking whether to continue, recommending ${call} (rubric rule ${rule}): ${describeOutcome(asked)}`);
    if (asked.status === "done") {
      await recordBudgetStop(opts.dir, conversation.issue.identifier, commentIdFor(check.budgetKey), stop.recommendation).catch((e: Error) => log(`could not record the stop's recommendation: ${e.message}`));
    }
    return true;
  }
  // The stop rubric's rule 0: a task only waiting on a human posts nothing (TECH-5218, TECH-5913).
  if (!exhausted.allowed && humanWait) {
    opts.slot?.waiting(Date.parse(state.lastTurnAt ?? state.startedAt));
    log(`budget exhausted (${exhausted.reason}), but the task is waiting on ${humanWait}; parking quietly (rubric rule 0)`);
    return true;
  }
  if (budgetAsked && !conversation.humanComments.some((c) => Date.parse(c.createdAt) > Date.parse(budgetAsked.createdAt))) {
    opts.slot?.waiting(Date.parse(budgetAsked.createdAt));
    log(`waiting: the budget question posted at ${budgetAsked.createdAt} has no human reply yet`);
    return true;
  }
  return false;
}

/** The window as the stop rubric reads it: its runs in start order, steers, restarts and turns (stop-rubric.ts). */
async function windowFacts(situation: SituationReport, { opts, deps, state }: Pick<PollContext, "opts" | "deps" | "state">): Promise<WindowFacts> {
  const byId = new Map(situation.runs.map((r) => [r.runId, r]));
  const runs = state.runIds.filter((id) => !state.budget.priorRuns.includes(id)).flatMap((id) => byId.get(id) ?? []);
  // An unreadable ledger only thins the case: the question is still asked.
  const { turns, steers } = await windowTurns(join(opts.dir, "turns.jsonl"), situation.budget.windowStart).catch(() => ({ turns: 0, steers: {} }));
  const mergePolicy = (repo: RepoSlug) => deps.github.mergePolicy?.(repo);
  return { situation, runs, steers, retries: state.reportRecoveries, turns, turnCostUsd: state.turnCostUsd, mergePolicy };
}
