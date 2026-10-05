import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { conversationRevision, SituationReport, type Conversation, type ProposedAction, type RunRecord } from "@terros/sergeant-contracts";
import type { Reasoner } from "@terros/sergeant-reasoning";
import { driveMerged, exists, mergedOf } from "./after-merge.ts";
import { acceptedComment, endAccepted } from "./accepted.ts";
import { postAuthAlerts } from "./auth-alert.ts";
import { budgetStatus, DEFAULT_BUDGET } from "./budget.ts";
import { cancelPending, recordStop } from "./cancel.ts";
import { describeOutcome, execute, type Ports } from "./execute.ts";
import { postHandoff } from "./handoff.ts";
import { takeTurn } from "./index.ts";
import type { LoopOptions, LoopResult } from "./loop-options.ts";
import { confirmStarts, readRuns, situationOf } from "./loop-poll.ts";
import { driveStop } from "./loop-stop.ts";
import { dueMergeRetries, reconcileMergeRetries, recordMergeRetries } from "./merge-retry.ts";
import { checkHolds, checkStop, holdForBudget, openReviewWindow, type PollContext } from "./poll-checks.ts";
import { describePr, fingerprintOf, landedOf, readPullRequests, unsettledMerges } from "./poll.ts";
import { awaitedHumanPrAction, onlyWallTimeExhausted } from "./pr-wait.ts";
import { costSoFar, costTotal, taskTurnCost } from "./cost.ts";
import { postProgress } from "./progress.ts";
import { latestAnswer, resolveAnswered } from "./question.ts";
import { postRereviewRequests } from "./rereview.ts";
import { recordReviews as recordReviewFacts } from "./review-telemetry.ts";
import { admitOwner } from "./owner.ts";
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
  const retryGraceMs = (opts.waitingGraceMinutes ?? 15) * 60_000;
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
  // TECH-5179 (owner.ts): a task is admitted only for its owner, read from Linear's history whenever a
  // task has none, so an intake after a missed webhook or a restart checks it too. Refused, nothing is
  // saved, and the next intake reads Linear again. Every run of the task is then paid by its owner. A
  // task saved before TECH-5179 that already ended (merged, accepted) only finishes, and starts no run.
  // A task already on disk that is refused (one saved before TECH-5179, with runs perhaps still going)
  // is not left unsupervised: it takes the ordinary stop as a handoff below (cancel.ts), its runs
  // canceled and its PRs kept. Only unreadable history ends this loop with nothing stopped, so the next
  // intake reads Linear again.
  const owner = state.owner ?? (state.merged || state.accepted ? undefined : await admitOwner(opts.issueId, deps, log));
  if (owner && "refused" in owner) {
    if (owner.unreadable || !(await exists(files.state))) return { outcome: "stopped", detail: owner.refused };
    await recordStop(opts.dir, `the task started before Sergeant recorded who pays for it, and Linear does not show its assignee delegated it (${owner.refused.replace(/^not started: /, "")})`, { handoff: {} });
  } else if (owner) deps = { ...deps, owner: (state.owner = owner) };
  // The start time, the owner, and the budget window are on disk before anything else happens.
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
    handoff: (reason) => recordStop(opts.dir, reason, { handoff: { delegatedAt: state.owner?.delegatedAt } }),
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

  const budgetOf = (runs: RunRecord[], unknownRuns: number) =>
    budgetStatus({ ...state.budget, startedAt: state.startedAt, turnCostUsd: state.turnCostUsd, runs, unknownRuns });

  for (;;) {
    if (await exists(files.stop)) return { outcome: "stopped", detail: `${files.stop} exists` };
    if (opts.signal?.aborted) return { outcome: "stopped", detail: "the service is stopping" };
    if (!stopping && (await cancelPending(opts.dir))) stopping = "the task is stopped";
    // A stop another driver (the API, intake) finished set the task aside: it is over.
    if (!stopping && !(await exists(files.state))) return { outcome: "stopped", detail: "the task was stopped" };
    if (stopping) {
      const stopped = await driveStop(stopping, opts, deps, log);
      if (stopped) return stopped;
      await wait(pollMs);
      continue;
    }
    await confirmStarts(state, deps, log, save);

    if (state.accepted) {
      // TECH-5118: a human accepted the work as it is in reply to the budget question, so the task ends
      // with no fresh window and nothing more asked, its saved ending replayed (accepted.ts).
      const ended = await endAccepted(state.accepted, opts.dir, opts.issueId, deps.linear, resolveDue);
      if (ended) return ended;
      await wait(pollMs);
      continue;
    }

    if (state.merged) {
      const afterMerge = { runIds: state.runIds, stop: files.stop, opts, deps, log, save, resolveDue, recordReviews, budgetOf };
      const finished = await driveMerged(state.merged, afterMerge);
      if (finished) return finished;
      await wait(pollMs);
      continue;
    }

    const { runs, unknown } = await readRuns(state, deps);
    await recordReviews(runs);
    // TECH-5227: what the task has cost, read when a comment says so (cost.ts), with Sergeant's turns over
    // the whole task: `state.turnCostUsd` is only the current budget window's.
    const spent = (turnCostUsd: number) => ({ runs, unknownRuns: unknown.length, turnCostUsd, startedAt: state.startedAt });
    const turnsSoFar = () => taskTurnCost(files.turns, state.startedAt);
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
    if (typeof stop === "object") {
      await wait(pollMs);
      continue;
    }
    if (stop) {
      stopping = stop;
      continue;
    }
    await postAuthAlerts(conversation.issue.id, runs, conversation.agentComments, deps.linear, log);
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
    // A human's review opens a fresh window (TECH-5218): the next pass rereads everything under it.
    if (await openReviewWindow(pullRequests, configured, ctx)) continue;
    // A closing merge `state.json` never recorded (the process died between GitHub's merge and the
    // save, say) is read back from GitHub, not left to reasoning: the outcome is built from the live
    // facts and posted under the same per-merge key, so it still lands exactly once. Only the worker's
    // own PR reported closing: a human may link one merged elsewhere, and a merged `Part of` PR is only
    // a fact for the next turn.
    const landed = landedOf(pullRequests, runs, deps.workerLogin);
    if (landed?.mergedSha) {
      state.merged = mergedOf(landed, landed.mergedSha, runs, state.followups, conversation.issue, costTotal(spent(await turnsSoFar())));
      await save();
      log(`${landed.repo}#${landed.number} is already merged as ${landed.mergedSha}`);
      continue;
    }
    let situation = situationOf(conversation, pullRequests, runs, budget, state, opts);
    let fingerprint = fingerprintOf(situation);
    if (reconcileMergeRetries(state, fingerprint)) {
      await save();
      situation = SituationReport.parse({ ...situation, refusedMerges: state.refusedMerges });
      fingerprint = fingerprintOf(situation);
    }
    await postHandoffs(conversation.issue.id);
    await postRereviewRequests(situation, deps, deps.linear, log);
    const retryDue = dueMergeRetries(state, retryGraceMs);
    // TECH-5218: a window whose wall time ran out while nothing changed but Sergeant waiting on a human's
    // merge or re-review is a human wait, like a question: no budget question and no turn. The human's
    // review opens a fresh window (above); their merge is the task's end. Anything else that changes
    // asks the budget question as before.
    const idle = fingerprint === state.lastFingerprint && retryDue.length === 0;
    const humanWait = idle && onlyWallTimeExhausted(budget, new Date()) ? awaitedHumanPrAction(situation) : undefined;
    if (await holdForBudget(situation, conversation, holds, ctx, humanWait)) {
      await wait(pollMs);
      continue;
    }

    const running = runs.filter((r) => r.status === "running").map((r) => `${r.role} ${r.runId}`);
    if (running.length > 0 || humanWait || (fingerprint === state.lastFingerprint && retryDue.length === 0 && !opts.wake?.pending)) {
      const quietMinutes = (Date.now() - Date.parse(state.lastTurnAt ?? state.startedAt)) / 60_000;
      if (running.length === 0 && quietMinutes > (opts.idleMinutes ?? 60)) {
        return { outcome: "idle", detail: `nothing changed for ${Math.round(quietMinutes)} minutes` };
      }
      // Running work holds a slot: a task resumed with its runs going asks for one. Any other wait (CI,
      // mergeability, a human merge) keeps it for the grace from the last turn, then quietly frees it.
      if (running.length > 0) opts.slot?.work();
      else opts.slot?.waiting(Date.parse(state.lastTurnAt ?? state.startedAt));
      log(running.length > 0 ? `waiting: ${running.join(", ")} running` : humanWait ? `waiting on ${humanWait}` : "waiting: nothing changed since the last turn");
      await wait(pollMs);
      continue;
    }
    // A task whose slot was released while it waited queues for one before its turn.
    if (opts.slot && !opts.slot.work()) {
      log("queued: waiting for a free task slot");
      await wait(pollMs);
      continue;
    }
    if (opts.wake) opts.wake.pending = false;

    log(`turn ${state.turns + 1}: ${runs.length} runs, PRs ${pullRequests.map(describePr).join("; ") || "none"}`);
    const earlierTurns = await turnsSoFar();
    const { turn, outcomes } = await takeTurn(situation, ports);
    const at = new Date().toISOString();
    const described = outcomes.map(describeOutcome);
    log(`turn ${state.turns + 1} (${turn.model}, $${turn.costUsd ?? "?"}): ${turn.output.summary}`);
    for (const line of described) log(`  ${line}`);

    // A start the owner has no usable model account for asks them instead (TECH-5217): retried the same way.
    const failedAsk = outcomes.flatMap((o) => (o.status !== "failed" ? [] : o.action.kind === "ask_human" ? [o.action] : o.unposted ? [o.unposted] : []))[0];
    if (failedAsk) unposted = { action: failedAsk, situation };
    const accepted = outcomes.some((o) => o.action.kind === "accept_as_is" && o.status === "done");
    // A merge that did not happen commits its fingerprint like any turn (TECH-5062): no paid turn every
    // poll, only when the facts change. One M7 found unsettled counts as GitHub still computing (poll.ts).
    const unsettled = unsettledMerges(outcomes, situation);
    const committed = failedAsk ? undefined : unsettled.length > 0 ? fingerprintOf(situation, unsettled) : fingerprint;
    const taskTurnCostUsd = earlierTurns + (turn.costUsd ?? 0);
    applyTurn(state, { at, situation, summary: turn.output.summary, costUsd: turn.costUsd ?? 0, taskTurnCostUsd, outcomes, described, fingerprint: committed, unknownRuns: unknown.length }, log);
    // Saved with the turn, before any of the ending's effects, so the next pass ends the task (above).
    const reply = accepted ? latestAnswer(conversation) : undefined;
    if (accepted) state.accepted = { at, ...(reply && { replyId: reply.id }), comment: acceptedComment(situation.pullRequests, costTotal({ ...spent(taskTurnCostUsd), at })) };
    recordMergeRetries(state, outcomes, situation, fingerprint, retryDue);
    await appendFile(files.turns, `${JSON.stringify({ at, situation, turn, outcomes })}\n`);
    await save();
    // TECH-5227: each finished review round not yet told gets its own short comment (progress.ts), with
    // the cost recorded up to this turn. The one switch.
    if (opts.progressComments !== false) await postProgress(opts.issueId, situation, costSoFar(spent(earlierTurns)), outcomes, deps, log);
    await postHandoffs(conversation.issue.id);
  }
}
