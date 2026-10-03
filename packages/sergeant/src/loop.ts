import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { conversationRevision, linearUploads, issueRevision, SituationReport, type Conversation, type ProposedAction, type RunRecord } from "@terros/sergeant-contracts";
import type { Reasoner } from "@terros/sergeant-reasoning";
import { drawAudit, exists, finishReviews, observeCompletion, postOutcome } from "./after-merge.ts";
import { budgetStatus, DEFAULT_BUDGET } from "./budget.ts";
import { cancelPending, driveCancel } from "./cancel.ts";
import { describeOutcome, execute, type Ports } from "./execute.ts";
import { postHandoff } from "./handoff.ts";
import { takeTurn } from "./index.ts";
import type { LoopOptions, LoopResult } from "./loop-options.ts";
import { outcomeComment } from "./outcome.ts";
import { checkHolds, checkStop, holdForBudget, type PollContext } from "./poll-checks.ts";
import { cancelRuns, describePr, fingerprintOf, landedOf, mergeNotSettled, readPullRequests } from "./poll.ts";
import { resolveAnswered } from "./question.ts";
import { postRereviewRequests } from "./rereview.ts";
import { recordReviews as recordReviewFacts } from "./review-telemetry.ts";
import { humanWait } from "./slots.ts";
import { applyTurn, loadState } from "./task-state.ts";
import { pause } from "./wake.ts";
import { watchKey } from "./webhooks.ts";

export type { LoopOptions, LoopResult } from "./loop-options.ts";
export { readTaskState, type TaskState } from "./task-state.ts";

// The walking skeleton's loop for one explicitly selected issue (UNF-706): poll, build a fresh
// Situation Report, take a reasoning turn when something changed, execute through the Gate, and
// after the closing PR's merge post one outcome comment and watch Linear for the issue reaching Done;
// a `Part of` PR's merge leaves the task working on the rest (UNF-734). It runs only while the issue
// is delegated to Sergeant's V2 agent (UNF-724), not in Backlog, Canceled, or Done (TECH-4989), and
// within its budget (UNF-728), and holds while a question it asked is unanswered (UNF-727). Every finished review is recorded as telemetry, and a
// merged head that skipped fresh review may be sampled for a nonblocking audit review (UNF-730). A
// deliberately temporary local store (`state.json`) lets a restarted loop resume; Linear, GitHub, and
// the runner's own run records stay the authority for everything else.

export async function runLoop(opts: LoopOptions, deps: Ports & { reasoner: Reasoner }): Promise<LoopResult> {
  const log = opts.log ?? ((line: string) => console.log(`[${new Date().toISOString()}] ${line}`));
  const pollMs = (opts.pollSeconds ?? 60) * 1000;
  const wait = (ms: number) => (opts.wake ? opts.wake.sleep(ms, opts.signal) : pause(ms, opts.signal));
  const files = {
    state: join(opts.dir, "state.json"),
    turns: join(opts.dir, "turns.jsonl"),
    reviews: join(opts.dir, "reviews.jsonl"),
    auditFollowups: join(opts.dir, "audit-followups.jsonl"),
    stop: join(opts.dir, "STOP"),
  };
  await mkdir(opts.dir, { recursive: true });
  // The installation's budget now: a new task's window, and any fresh window it opens later.
  const configured = { ...DEFAULT_BUDGET, ...opts.budget };
  const state = await loadState(files.state, opts.issueId, configured);
  // Why this task is stopping: set once a stop (cancel.ts) is recorded for it, by this loop or anyone
  // else. From then on the loop takes no turn and makes no effect; it only drives that stop, and ends
  // once it is done, whatever the issue's delegation or state is by then.
  let stopping: string | undefined;
  // Replaced whole, never rewritten in place: the API and a task cancel read it while the loop runs.
  // A stop sets it aside, so the issue back in Todo is a fresh task; nothing writes it again, and a
  // write after that, a run's id before its start above all, fails rather than being lost.
  let saved = false;
  const save = async () => {
    if (saved && !(await exists(files.state))) throw new Error(`${files.state} was set aside by a stop`);
    saved = true;
    const tmp = `${files.state}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 2));
    await rename(tmp, files.state);
  };
  // The start time and the budget window are on disk before anything else happens.
  await save();
  const requested = { ...state.budget.window, ...opts.budget };
  if (requested.wallMinutes !== state.budget.window.wallMinutes || requested.costUsd !== state.budget.window.costUsd) {
    log(`ignoring the budget options: this task keeps its window of ${JSON.stringify(state.budget.window)} until a human answers one of its questions`);
  }
  const ctx: PollContext = { opts, deps, state, log, save };
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
  // TECH-5057: answered and acted-on question threads, re-derived on every pass (question.ts).
  const resolvedThreads = new Set<string>();
  const resolveDue = (conversation: Conversation) => resolveAnswered(conversation, state.actedThrough, deps.linear, resolvedThreads, log);

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
  const budgetOf = (runs: RunRecord[], unknownRuns: number) =>
    budgetStatus({ ...state.budget, startedAt: state.startedAt, turnCostUsd: state.turnCostUsd, runs, unknownRuns });

  // The task's durable stop (cancel.ts), driven under the task's lock every poll until the runner
  // confirms each run stopped, its open PRs are closed, and the issue is told. Whichever of this loop,
  // `serve`'s intake, or the API drives it to the end, the loop then ends: an issue moved back to Todo
  // meanwhile is a fresh task for intake to start, never this one continued.
  const driveStop = async (reason: string): Promise<LoopResult | undefined> => {
    const exclusive = deps.exclusive ?? ((step) => step());
    const drive = () => driveCancel(opts.dir, opts.issueId, deps, opts.enrolledRepositories, log);
    const unconfirmed = await exclusive(drive).catch((e: Error) => (log(`stopping (${reason}): ${e.message}`), undefined));
    if (unconfirmed?.length !== 0) {
      log(`stopping (${reason}): retrying cancellation`);
      return undefined;
    }
    return { outcome: "stopped", detail: reason };
  };

  for (;;) {
    if (await exists(files.stop)) return { outcome: "stopped", detail: `${files.stop} exists` };
    if (opts.signal?.aborted) return { outcome: "stopped", detail: "the service is stopping" };
    if (!stopping && (await cancelPending(opts.dir))) stopping = "the task is stopped";
    // A stop another driver (the API, intake) finished set the task aside: it is over.
    if (!stopping && !(await exists(files.state))) return { outcome: "stopped", detail: "the task was stopped" };
    if (stopping) {
      // A stop holds no task slot: new work may start while the runner confirms this one's runs.
      if (opts.slot && !opts.slot.released) {
        Object.assign(opts.slot, { released: true, wanted: false, waitingSince: undefined });
        opts.slot.changed();
      }
      const stopped = await driveStop(stopping);
      if (stopped) return stopped;
      await wait(pollMs);
      continue;
    }
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
      await deps.linear.readConversation(opts.issueId).then(resolveDue, (e: Error) => log(`could not read the conversation: ${e.message}`));
      const stopped = await postOutcome(state.merged, opts, deps, log, save);
      if (stopped) return stopped;
      // The audit sample is drawn after the merge, so it cannot hold it up.
      await drawAudit(state.merged, state.runIds, opts, deps, log, save, budgetOf);
      const result = await observeCompletion(state.merged, opts, deps, log);
      const finished = await finishReviews(state.merged, result, { runIds: state.runIds, recordReviews, stop: files.stop, opts, deps, log });
      // Seen through: the issue is Done and every review finished, so intake resumes it no more.
      if (finished.outcome === "done" && !opts.signal?.aborted && !(await exists(files.stop))) {
        state.merged.completedAt = new Date().toISOString();
        await save();
      }
      return finished;
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
    const stop = await checkStop(conversation, runs, ctx);
    if (stop) {
      stopping = stop;
      continue;
    }
    await resolveDue(conversation);
    const holds = await checkHolds({ conversation, live, unknown, budgetOf: () => budgetOf(runs, unknown.length) }, configured, ctx);
    if (holds.hold) {
      if (holds.hold === "question") unposted = undefined;
      await wait(pollMs);
      continue;
    }
    const { budget } = holds;
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
    const landed = landedOf(pullRequests, runs, deps.workerLogin);
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
    await postRereviewRequests(situation, deps.workerLogin, deps.linear, log);
    if (await holdForBudget(situation, conversation, holds, ctx)) {
      await wait(pollMs);
      continue;
    }

    const fingerprint = fingerprintOf(situation);
    const running = runs.filter((r) => r.status === "running").map((r) => `${r.role} ${r.runId}`);
    if (running.length > 0 || (fingerprint === state.lastFingerprint && !opts.wake?.pending)) {
      // Running work holds a slot: a task resumed with its runs going asks for one.
      if (running.length > 0) opts.slot?.work();
      // Waiting on a human merge or requested changes is a human wait like a question: no idle end.
      const human = running.length === 0 ? humanWait(situation) : undefined;
      if (human) opts.slot?.waiting(Date.parse(state.lastTurnAt ?? state.startedAt));
      const quietMinutes = (Date.now() - Date.parse(state.lastTurnAt ?? state.startedAt)) / 60_000;
      if (running.length === 0 && !human && quietMinutes > (opts.idleMinutes ?? 60)) {
        return { outcome: "idle", detail: `nothing changed for ${Math.round(quietMinutes)} minutes` };
      }
      log(running.length > 0 ? `waiting: ${running.join(", ")} running` : human ? `waiting on ${human}` : "waiting: nothing changed since the last turn");
      await wait(pollMs);
      continue;
    }
    // A task whose slot was released while it waited on a human queues for one before its turn.
    if (opts.slot && !opts.slot.work()) {
      log("queued: waiting for a free task slot");
      await wait(pollMs);
      continue;
    }
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