import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkBudget,
  checkDelegation,
  commentIdFor,
  conversationRevision,
  linearUploads,
  issueRevision,
  reportedClosing,
  SituationReport,
  type ProposedAction,
  type RunRecord,
} from "@terros/sergeant-contracts";
import type { Reasoner } from "@terros/sergeant-reasoning";
import { drawAudit, exists, finishReviews, observeCompletion, postOutcome } from "./after-merge.ts";
import { budgetQuestion, budgetQuestionKey, budgetStatus, DEFAULT_BUDGET } from "./budget.ts";
import { askHuman, describeOutcome, execute, type Ports } from "./execute.ts";
import { postHandoff } from "./handoff.ts";
import { takeTurn } from "./index.ts";
import type { LoopOptions, LoopResult } from "./loop-options.ts";
import { outcomeComment } from "./outcome.ts";
import { cancelRuns, describePr, fingerprintOf, mergeNotSettled, readPullRequests } from "./poll.ts";
import { noteEdit, openQuestion, questionKey } from "./question.ts";
import { recordReviews as recordReviewFacts } from "./review-telemetry.ts";
import { blockedQuestion } from "./slots.ts";
import { applyTurn, loadState } from "./task-state.ts";
import { pause } from "./wake.ts";
import { watchKey } from "./webhooks.ts";

export type { LoopOptions, LoopResult } from "./loop-options.ts";
export { readTaskState, type TaskState } from "./task-state.ts";

// The walking skeleton's loop for one explicitly selected issue (UNF-706): poll, build a fresh
// Situation Report, take a reasoning turn when something changed, execute through the Gate, and
// after the closing PR's merge post one outcome comment and watch Linear for the issue reaching Done;
// a `Part of` PR's merge leaves the task working on the rest (UNF-734). It runs only while the issue
// is delegated to Sergeant's V2 agent (UNF-724) and within its budget (UNF-728), and holds while a
// question it asked is unanswered (UNF-727). Every finished review is recorded as telemetry, and a
// merged head that skipped fresh review may be sampled for a nonblocking audit review (UNF-730). A
// deliberately temporary local store (`state.json`) lets a restarted loop resume; Linear, GitHub, and
// the runner's own run records stay the authority for everything else.

export async function runLoop(opts: LoopOptions, deps: Ports & { reasoner: Reasoner }): Promise<LoopResult> {
  const log = opts.log ?? ((line: string) => console.log(`[${new Date().toISOString()}] ${line}`));
  const pollMs = (opts.pollSeconds ?? 60) * 1000;
  const graceMs = (opts.waitingGraceMinutes ?? 15) * 60_000;
  // A question unanswered for the grace gives up the task's slot; the loop keeps polling without one.
  const releasePast = (askedAt: string) => {
    if (opts.slot?.state !== "held" || Date.now() - Date.parse(askedAt) < graceMs) return;
    log("no human answer within the grace: task slot released until something changes");
    opts.slot.release();
  };
  const wait = (ms: number) => (opts.wake ? opts.wake.sleep(ms, opts.signal) : pause(ms, opts.signal));
  const files = {
    state: join(opts.dir, "state.json"),
    turns: join(opts.dir, "turns.jsonl"),
    reviews: join(opts.dir, "reviews.jsonl"),
    auditFollowups: join(opts.dir, "audit-followups.jsonl"),
    stop: join(opts.dir, "STOP"),
  };
  await mkdir(opts.dir, { recursive: true });
  const state = await loadState(files.state, opts.issueId, { ...DEFAULT_BUDGET, ...opts.budget });
  // Replaced whole, never rewritten in place: the API and a task cancel read it while the loop runs.
  const save = async () => {
    const tmp = `${files.state}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, files.state);
  };
  // The start time and the budget window are on disk before anything else happens.
  await save();
  const requested = { ...state.budget.window, ...opts.budget };
  if (requested.wallMinutes !== state.budget.window.wallMinutes || requested.costUsd !== state.budget.window.costUsd) {
    log(`ignoring the budget options: this task keeps its window of ${JSON.stringify(state.budget.window)}; only a grant extends it`);
  }
  // A run's id is saved before the runner is asked to start it (UNF-728).
  const ports: Ports & { reasoner: Reasoner } = {
    ...deps,
    log,
    async recordRun(runId) {
      state.runIds.push(runId);
      state.unconfirmedStarts.push(runId);
      await save();
    },
  };
  // A question whose post failed or was never confirmed (UNF-727). It is posted again under the same
  // key every poll until Linear shows it or a human changes the conversation, never left to an idle
  // guard. Only in memory: a restart instead finds the turn's fingerprint uncommitted and takes a turn.
  let unposted: { action: ProposedAction; situation: SituationReport } | undefined;

  const recordReviews = (runs: RunRecord[]) =>
    recordReviewFacts(runs, state, { issueId: opts.issueId, auditFollowups: files.auditFollowups, reviews: files.reviews, log, save });

  // A PR GitHub refused to let Sergeant merge waits for a human: say so once on the issue, retried
  // every poll until Linear confirms it, only while the issue is still Sergeant's (A1 checked first).
  const postHandoffs = async (issueId: string) => {
    for (const r of state.refusedMerges) {
      if (r.commentPostedAt || !(await postHandoff(issueId, r, deps.linear, log))) continue;
      r.commentPostedAt = new Date().toISOString();
      await save();
    }
  };

  // A run whose status cannot be read is unknown, never stopped (04 §6).
  const readRuns = async () => {
    const read = await Promise.all(state.runIds.map((id) => deps.runner.status(id).catch((e: Error) => ({ unknown: id, error: e.message }))));
    return { runs: read.filter((r): r is RunRecord => !("unknown" in r)), unknown: read.filter((r) => "unknown" in r) };
  };
  const budgetOf = (runs: RunRecord[], unknownRuns: number, questionId?: string) =>
    budgetStatus({ ...state.budget, startedAt: state.startedAt, turnCostUsd: state.turnCostUsd, ...(questionId && { questionId }), runs, unknownRuns });

  for (;;) {
    if (await exists(files.stop)) return { outcome: "stopped", detail: `${files.stop} exists` };
    if (opts.signal?.aborted) return { outcome: "stopped", detail: "the service is stopping" };
    // A start never seen through: the runner either knows the run, or confirms it stopped or never
    // started, which drops it. Until then it stays in `runIds`, unknown, so it is canceled like any
    // other run on an undelegation or an exhausted budget.
    for (const runId of state.unconfirmedStarts) {
      const known = await deps.runner.status(runId).then(() => true, () => false);
      if (!known && (await cancelRuns([runId], deps, log)) > 0) continue;
      state.unconfirmedStarts = state.unconfirmedStarts.filter((id) => id !== runId);
      if (!known) state.runIds = state.runIds.filter((id) => id !== runId);
      await save();
    }

    if (state.merged) {
      const stopped = await postOutcome(state.merged, opts, deps, log, save);
      if (stopped) return stopped;
      // The audit sample is drawn after the merge, so it cannot hold it up.
      await drawAudit(state.merged, state.runIds, opts, deps, log, save, budgetOf);
      const result = await observeCompletion(state.merged, opts, deps, log);
      return finishReviews(state.merged, result, { runIds: state.runIds, recordReviews, stop: files.stop, opts, deps, log });
    }

    const { runs, unknown } = await readRuns();
    await recordReviews(runs);
    const live = [...runs.filter((r) => r.status === "running").map((r) => r.runId), ...unknown.map((u) => u.unknown)];
    const conversation = await deps.linear.readConversation(opts.issueId);
    // What a webhook names to end this loop's wait (webhooks.ts): the issue, its PRs, and their heads.
    const watch = (prs: { repo: string; number: number; headSha?: string }[]) => {
      if (!opts.wake) return;
      const keys = prs.flatMap((p) => [watchKey.pullRequest(p.repo, p.number), ...(p.headSha ? [watchKey.head(p.repo, p.headSha)] : [])]);
      opts.wake.watched = [conversation.issue.id, ...keys];
    };
    watch(conversation.issue.linkedPullRequests);
    // Before anything starts and on every poll: an issue not delegated to the V2 agent, or no longer,
    // is not Sergeant's to work on. Undelegation is the human's cancel: its runs are canceled so they
    // publish nothing more, and the loop stops only once the runner confirms each one stopped. The
    // executor re-checks live before each start and merge (A1).
    const delegation = checkDelegation(conversation.issue, deps.agentUserId);
    if (!delegation.allowed) {
      if ((await cancelRuns(live, deps, log)) === 0) {
        await recordReviews((await readRuns()).runs);
        return { outcome: "stopped", detail: delegation.reason };
      }
      log(`stopping (${delegation.reason}): retrying cancellation`);
      await wait(pollMs);
      continue;
    }
    // The budget question of the current window, if Linear has it: its id is derived from a key, so a
    // crash between posting it and saving anything loses nothing.
    const questionId = commentIdFor(budgetQuestionKey(conversation.issue.id, state.budget.grants.length));
    const budgetAsked = conversation.agentComments.find((c) => c.id === questionId);
    const budget = budgetOf(runs, unknown.length, budgetAsked && questionId);
    // UNF-728: an exhausted budget cancels running work through the runner, every poll until confirmed,
    // whatever else is going on; the executor refuses every new effect (B1).
    const exhausted = checkBudget(budget, new Date());
    if (!exhausted.allowed && live.length > 0) {
      log(`budget exhausted (${exhausted.reason}): canceling ${live.join(", ")}`);
      await cancelRuns(live, deps, log);
      await wait(pollMs);
      continue;
    }
    if (unknown.length > 0) {
      log(`waiting: status unavailable for ${unknown.map((u) => `${u.unknown} (${u.error})`).join(", ")}`);
      await wait(pollMs);
      continue;
    }
    // An edit while Sergeant waits on a reply gets one short notice (TECH-5034); retried next poll if it fails.
    await noteEdit(conversation, state.seen, budgetAsked, deps.linear).then(
      (posted) => posted && log(`noted an edit to ${conversation.issue.identifier} made while waiting on a reply`),
      (e: Error) => log(`could not note the edit to ${conversation.issue.identifier}: ${e.message}`),
    );
    // While the question Sergeant asked is unanswered it takes no turn and makes no effect, and no
    // runaway guard ends the wait for the human (UNF-727). Any human change ends it: see question.ts.
    const question = openQuestion(conversation);
    if (question) {
      unposted = undefined;
      if (live.length === 0) releasePast(question.createdAt);
      log(`waiting: the question posted at ${question.createdAt} has no human reply yet`);
      await wait(pollMs);
      continue;
    }
    if (unposted && conversationRevision(unposted.situation.conversation) === conversationRevision(conversation)) {
      const retry = await execute(unposted.action, unposted.situation, deps);
      log(`asking again: ${describeOutcome(retry)}`);
      if (retry.status !== "failed") unposted = undefined;
      await wait(pollMs);
      continue;
    }
    unposted = undefined;
    const pullRequests = await readPullRequests(runs, conversation.issue.linkedPullRequests, opts.enrolledRepositories, deps);
    watch(pullRequests);
    await postHandoffs(conversation.issue.id);
    // A closing merge `state.json` never recorded (the process died between GitHub's merge and the
    // save, say) is read back from GitHub, not left to reasoning: the outcome is built from the live
    // facts and posted under the same per-merge key, so it still lands exactly once. Only the worker's
    // own PR reported closing: a human may link one merged elsewhere, and a merged `Part of` PR is only
    // a fact for the next turn.
    const landed = pullRequests.find((p) => p.state === "merged" && p.author === deps.workerLogin && reportedClosing(runs, p) === true);
    if (landed?.mergedSha) {
      const outcome = outcomeComment(landed, landed.mergedSha, runs, state.followups, conversation.issue);
      state.merged = {
        repo: landed.repo,
        number: landed.number,
        headSha: landed.headSha,
        mergedSha: landed.mergedSha,
        at: new Date().toISOString(),
        outcome,
      };
      await save();
      log(`${landed.repo}#${landed.number} is already merged as ${landed.mergedSha}`);
      continue;
    }
    const situation = SituationReport.parse({
      taskId: `canary_${conversation.issue.identifier}`,
      generatedAt: new Date().toISOString(),
      conversationRevision: conversationRevision(conversation, pullRequests),
      conversation,
      uploads: linearUploads(conversation),
      issueRevision: issueRevision(conversation.issue),
      enrolledRepositories: opts.enrolledRepositories,
      pullRequests,
      runs,
      followups: state.followups,
      refusedMerges: state.refusedMerges,
      budget,
      recentTurns: state.recentTurns,
    });
    // One question per exhausted window, posted like any question but under a key of the task and the
    // window, and retried every poll until Linear shows it. Until a human replies after it, nothing
    // happens and no runaway guard ends the wait (UNF-727); the reply wakes a turn, which may grant one
    // more window.
    if (!exhausted.allowed && !budgetAsked) {
      const key = budgetQuestionKey(conversation.issue.id, state.budget.grants.length);
      const asked = await askHuman(budgetQuestion(situation, exhausted.reason), situation, deps, key);
      log(`budget exhausted (${exhausted.reason}): asking whether to continue: ${describeOutcome(asked)}`);
      await wait(pollMs);
      continue;
    }
    if (budgetAsked && !conversation.humanComments.some((c) => Date.parse(c.createdAt) > Date.parse(budgetAsked.createdAt))) {
      releasePast(budgetAsked.createdAt);
      log(`waiting: the budget question posted at ${budgetAsked.createdAt} has no human reply yet`);
      await wait(pollMs);
      continue;
    }

    const fingerprint = fingerprintOf(situation);
    const running = runs.filter((r) => r.status === "running").map((r) => `${r.role} ${r.runId}`);
    if (running.length > 0 || (fingerprint === state.lastFingerprint && !opts.wake?.pending)) {
      const quietMs = Date.now() - Date.parse(state.lastTurnAt ?? state.startedAt);
      if (running.length === 0 && quietMs > (opts.idleMinutes ?? 60) * 60_000) {
        return { outcome: "idle", detail: `nothing changed for ${Math.round(quietMs / 60_000)} minutes` };
      }
      // Nothing running and nothing changed: the task waits on something outside Sergeant, keeping its
      // slot. Past the grace it asks a human, as a question (question.ts) so the usual wait follows.
      if (running.length === 0 && quietMs >= graceMs) {
        const key = questionKey(conversation.issue.id, conversationRevision(conversation));
        const asked = await askHuman(blockedQuestion(situation, Math.round(quietMs / 60_000)), situation, deps, key);
        log(`blocked past the grace: asking a human: ${describeOutcome(asked)}`);
        await wait(pollMs);
        continue;
      }
      log(running.length > 0 ? `waiting: ${running.join(", ")} running` : "waiting: nothing changed since the last turn");
      await wait(pollMs);
      continue;
    }
    // A task whose slot was released while a question went unanswered queues for one before its turn.
    if (opts.slot && !opts.slot.take()) {
      log("queued: waiting for a free task slot");
      await wait(pollMs);
      continue;
    }
    if (state.turns >= (opts.maxTurns ?? 12)) return { outcome: "turn_limit", detail: `${state.turns} turns taken` };
    if (opts.wake) opts.wake.pending = false;

    log(`turn ${state.turns + 1}: ${runs.length} runs, PRs ${pullRequests.map(describePr).join("; ") || "none"}`);
    const { turn, outcomes } = await takeTurn(situation, ports);
    const at = new Date().toISOString();
    const described = outcomes.map(describeOutcome);
    log(`turn ${state.turns + 1} (${turn.model}, $${turn.costUsd ?? "?"}): ${turn.output.summary}`);
    for (const line of described) log(`  ${line}`);

    const failedAsk = outcomes.find((o) => o.action.kind === "ask_human" && o.status === "failed");
    if (failedAsk) unposted = { action: failedAsk.action, situation };
    const retryMerge = outcomes.some((o) => mergeNotSettled(o, situation));
    applyTurn(
      state,
      { at, situation, summary: turn.output.summary, costUsd: turn.costUsd ?? 0, outcomes, described, fingerprint: failedAsk || retryMerge ? undefined : fingerprint },
      log,
    );
    await appendFile(files.turns, `${JSON.stringify({ at, situation, turn, outcomes })}\n`);
    await save();
    await postHandoffs(conversation.issue.id);
    if (retryMerge) {
      log("the merge did not happen for a reason the next poll may not show: another turn after the next poll");
      await wait(pollMs);
    }
  }
}
