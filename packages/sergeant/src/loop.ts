import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  BudgetStatus,
  checkBudget,
  checkDelegation,
  commentIdFor,
  conversationRevision,
  FiledFollowup,
  RepoSlug,
  reportedClosing,
  RunId,
  Sha,
  SituationReport,
  type ProposedAction,
  type PullRequestFacts,
  type PullRequestRef,
  type RunRecord,
} from "@terros/sergeant-contracts";
import type { Reasoner } from "@terros/sergeant-reasoning";
import { z } from "zod";
import { budgetQuestion, budgetQuestionKey, budgetStatus, DEFAULT_BUDGET, type BudgetWindow } from "./budget.ts";
import { askHuman, describeOutcome, execute, type Ports } from "./execute.ts";
import { takeTurn } from "./index.ts";
import { outcomeComment } from "./outcome.ts";
import { openQuestion } from "./question.ts";
import { approvedHead, auditDrawn, implementerOf, type ReviewFacts, reviewFacts } from "./review-quality.ts";

// The walking skeleton's loop for one explicitly selected issue (UNF-706): poll, build a fresh
// Situation Report, take a reasoning turn when something changed, execute through the Gate, and
// after the closing PR's merge post one outcome comment and watch Linear for the issue reaching Done;
// a `Part of` PR's merge leaves the task working on the rest (UNF-734). It runs only while the issue
// is delegated to Sergeant's V2 agent (UNF-724) and within its budget (UNF-728), and holds while a
// question it asked is unanswered (UNF-727). Every finished review is recorded as telemetry, and a
// merged head that skipped fresh review may be sampled for a nonblocking audit review (UNF-730). A
// deliberately temporary local store (`state.json`) lets a restarted loop resume; Linear, GitHub, and
// the runner's own run records stay the authority for everything else.

const TaskState = z.object({
  issueId: z.string(),
  startedAt: z.iso.datetime(),
  turns: z.number().int(),
  lastTurnAt: z.iso.datetime().optional(),
  /** What the last turn saw; an unchanged situation gets no new turn. */
  lastFingerprint: z.string().optional(),
  runIds: z.array(RunId),
  /**
   * Runs saved before the runner was asked to start them and not yet seen started: a crash, or a
   * start that failed, in between. Each is confirmed with the runner, or canceled, before anything else.
   */
  unconfirmedStarts: z.array(RunId).default([]),
  /** Follow-up issues filed for this task, shown to every later turn and listed in the outcome. */
  followups: z.array(FiledFollowup).default([]),
  recentTurns: z.array(z.object({ at: z.iso.datetime(), summary: z.string(), outcomes: z.array(z.string()) })),
  /** Reported cost of every reasoning turn; runs report their own. */
  turnCostUsd: z.number().default(0),
  budget: z
    .object({
      /** Fixed when the task starts; a restart with other flags does not change it, only a grant extends it. */
      window: BudgetStatus.shape.window,
      grants: z.array(z.object({ commentId: z.string(), at: z.iso.datetime() })),
    }),
  merged: z
    .object({
      repo: RepoSlug,
      number: z.number().int(),
      headSha: Sha,
      mergedSha: Sha,
      at: z.iso.datetime(),
      /** The outcome comment, built from the facts the merge was allowed on; posted once. */
      outcome: z.string().optional(),
      outcomePostedAt: z.iso.datetime().optional(),
      /** When the audit sample was drawn for the merged head; done once. */
      auditDrawnAt: z.iso.datetime().optional(),
      /** The sampled audit review of the merged head. */
      audit: z.object({ runId: RunId }).optional(),
    })
    .optional(),
  /** Per finished review: the later-known facts its last `reviews.jsonl` line carried. */
  reviewsRecorded: z.record(z.string(), z.string()).default({}),
});
export type TaskState = z.infer<typeof TaskState>;
type State = TaskState;

export type LoopOptions = {
  issueId: string;
  enrolledRepositories: RepoSlug[];
  /**
   * Holds `state.json`, `turns.jsonl` (every turn's report, output, and outcomes), `reviews.jsonl`
   * (`ReviewFacts` for every finished review; the last line per run id holds),
   * `audit-followups.jsonl` (audit must-fix findings on merged code), and `STOP`.
   */
  dir: string;
  /** The fraction of merged heads that skipped fresh review which get an audit review (06 §8). */
  auditSampleRate?: number;
  pollSeconds?: number;
  /** Runaway guards: reasoning turns in total, and minutes with nothing changing and nothing running. */
  maxTurns?: number;
  idleMinutes?: number;
  /**
   * The task's budget window: hard wall time from the start, and best-effort spend (default 120
   * minutes, $25). Used when the task starts; an existing task keeps the window it started with.
   */
  budget?: Partial<BudgetWindow>;
  /** How long to watch Linear after the merge for the GitHub integration to move the issue. */
  completionWaitMinutes?: number;
  log?: (line: string) => void;
  /** Ends the loop at its next poll, never mid-turn: the service stopping. */
  signal?: AbortSignal;
  /** A human asking for a turn now (`sgt task wake`). */
  wake?: Wake;
};

export type LoopResult = {
  outcome: "done" | "merged_not_done" | "stopped" | "turn_limit" | "idle";
  detail: string;
};

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

  // Review telemetry (UNF-730): every reviewer run that has finished, merged or not, gets a
  // `reviews.jsonl` line, and another only when a later-known fact (the merge, a resulting change)
  // changes it. An audit's must-fix findings on merged code also go to `audit-followups.jsonl` for a
  // human; nothing is reopened or reverted. Telemetry only: nothing here gates a turn or an effect.
  const recordReviews = async (runs: RunRecord[]) => {
    const facts: ReviewFacts[] = [];
    for (const run of runs) {
      if (run.role !== "reviewer" || run.status === "running") continue;
      const trigger = run.runId === state.merged?.audit?.runId ? "audit" : "required";
      const f = reviewFacts(run, { trigger, issue: opts.issueId, runs, merged: state.merged ? mergedHead(state.merged) : null });
      const known = JSON.stringify([f.status, f.merged, f.resultingMutation]);
      if (state.reviewsRecorded[run.runId] === known) continue;
      if (f.followUp && state.reviewsRecorded[run.runId] === undefined) await logFollowUp(f, run, files.auditFollowups, log);
      state.reviewsRecorded[run.runId] = known;
      facts.push(f);
    }
    if (facts.length === 0) return;
    await appendFile(files.reviews, facts.map((f) => `${JSON.stringify(f)}\n`).join(""));
    await save();
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
    // While the question Sergeant asked is unanswered it takes no turn and makes no effect, and no
    // runaway guard ends the wait for the human (UNF-727). Any human change ends it: see question.ts.
    const question = openQuestion(conversation);
    if (question) {
      unposted = undefined;
      log(`waiting: the question posted at ${question.createdAt} has no human reply yet`);
      await wait(pollMs);
      continue;
    }
    if (unposted?.situation.conversationRevision === conversationRevision(conversation)) {
      const retry = await execute(unposted.action, unposted.situation, deps);
      log(`asking again: ${describeOutcome(retry)}`);
      if (retry.status !== "failed") unposted = undefined;
      await wait(pollMs);
      continue;
    }
    unposted = undefined;
    const pullRequests = await readPullRequests(runs, conversation.issue.linkedPullRequests, opts.enrolledRepositories, deps);
    // A closing merge `state.json` never recorded (the process died between GitHub's merge and the
    // save, say) is read back from GitHub, not left to reasoning: the outcome is built from the live
    // facts and posted under the same per-merge key, so it still lands exactly once. Only the worker's
    // own PR reported closing: a human may link one merged elsewhere, and a merged `Part of` PR is only
    // a fact for the next turn.
    const landed = pullRequests.find((p) => p.state === "merged" && p.author === deps.workerLogin && reportedClosing(runs, p) === true);
    if (landed?.mergedSha) {
      const outcome = outcomeComment(landed, landed.mergedSha, runs, state.followups);
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
      conversationRevision: conversationRevision(conversation),
      conversation,
      enrolledRepositories: opts.enrolledRepositories,
      pullRequests,
      runs,
      followups: state.followups,
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
      log(`waiting: the budget question posted at ${budgetAsked.createdAt} has no human reply yet`);
      await wait(pollMs);
      continue;
    }

    const fingerprint = fingerprintOf(situation);
    const running = runs.filter((r) => r.status === "running").map((r) => `${r.role} ${r.runId}`);
    if (running.length > 0 || (fingerprint === state.lastFingerprint && !opts.wake?.pending)) {
      const quietMinutes = (Date.now() - Date.parse(state.lastTurnAt ?? state.startedAt)) / 60_000;
      if (running.length === 0 && quietMinutes > (opts.idleMinutes ?? 60)) {
        return { outcome: "idle", detail: `nothing changed for ${Math.round(quietMinutes)} minutes` };
      }
      log(running.length > 0 ? `waiting: ${running.join(", ")} running` : "waiting: nothing changed since the last turn");
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
    state.turns += 1;
    state.turnCostUsd += turn.costUsd ?? 0;
    state.lastTurnAt = at;
    state.lastFingerprint = failedAsk ? undefined : fingerprint;
    state.recentTurns = [...state.recentTurns, { at, summary: turn.output.summary, outcomes: described }].slice(-8);
    const done = outcomes.flatMap((o) => (o.status === "done" ? [o] : []));
    for (const o of done) {
      const { started, granted } = o;
      if (started) state.unconfirmedStarts = state.unconfirmedStarts.filter((id) => id !== started.runId);
      if (granted && !state.budget.grants.some((g) => g.commentId === granted.commentId)) state.budget.grants.push({ commentId: granted.commentId, at });
      const { followup } = o;
      if (followup && !state.followups.some((f) => f.key === followup.key)) state.followups.push(followup);
    }
    // After the follow-ups, so a merge lists those filed earlier in the same turn.
    for (const o of done) {
      if (o.action.kind === "merge_pr" && o.merged) {
        if (reportedClosing(situation.runs, o.merged.pr) !== true) {
          log(`${o.action.repo}#${o.action.number} merged as Part of ${situation.conversation.issue.identifier}; the task continues`);
          continue;
        }
        const mergedSha = Sha.parse(o.merged.mergedSha);
        const outcome = outcomeComment(o.merged.pr, mergedSha, situation.runs, state.followups);
        state.merged = { repo: o.action.repo, number: o.action.number, headSha: o.merged.pr.headSha, mergedSha, at, outcome };
      }
    }
    await appendFile(files.turns, `${JSON.stringify({ at, situation, turn, outcomes })}\n`);
    await save();
  }
}

/**
 * Cancels each run through the runner and returns how many are not confirmed stopped. The runner
 * resolves `cancel` only once the run is stopped or gone; anything else is retried next poll.
 */
async function cancelRuns(runIds: RunId[], deps: Ports, log: (line: string) => void): Promise<number> {
  let unconfirmed = 0;
  for (const runId of runIds) {
    await deps.runner.cancel(runId).then(
      () => log(`canceled ${runId}`),
      (e: Error) => (unconfirmed++, log(`cancel ${runId} not confirmed: ${e.message}`)),
    );
  }
  return unconfirmed;
}

/**
 * Every PR in an enrolled repository that Linear links to the issue or a worker reported, re-read
 * live. Linear's link is authoritative on its own: one no recorded run reported (a human attached it,
 * or a restart lost the run id) still has its head and checks polled.
 */
async function readPullRequests(runs: RunRecord[], linked: PullRequestRef[], enrolled: RepoSlug[], deps: Ports): Promise<PullRequestFacts[]> {
  const reported = runs.flatMap((run) => (run.role === "worker" ? (run.report?.pullRequests ?? []) : []));
  const refs = new Map<string, PullRequestRef>();
  for (const pr of [...linked, ...reported]) if (enrolled.includes(pr.repo)) refs.set(`${pr.repo}#${pr.number}`, { repo: pr.repo, number: pr.number });
  return Promise.all([...refs.values()].map((r) => deps.github.readPullRequest(r.repo, r.number)));
}

/** What a turn depends on. `generatedAt` and recentTurns are excluded: they change every poll. */
function fingerprintOf(s: SituationReport): string {
  const facts = {
    conversation: s.conversationRevision,
    // A PR newly linked to the issue can make a refused review or merge allowable.
    linked: s.conversation.issue.linkedPullRequests.map((p) => `${p.repo}#${p.number}`).sort(),
    runs: s.runs.map((r) => [r.runId, r.status]),
    budget: s.budget.grants.length,
    prs: s.pullRequests.map((p) => [p.repo, p.number, p.state, p.draft, p.headSha, p.mergeable, p.checks]),
  };
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

const describePr = (p: PullRequestFacts) =>
  `${p.repo}#${p.number} ${p.state} @${p.headSha.slice(0, 12)} checks ${p.checks.required.map((c) => `${c.name}=${c.state}`).join(",") || "none"}`;

/**
 * Posts the merge's outcome comment once, as the V2 agent, and only while the issue is still
 * delegated to it. Keyed by issue and merge, so a crash before `state.json` records it cannot post a
 * second one. Returns a result only when the loop must stop instead. Deliberately not held to the
 * budget (B1): it reports a merge that already happened, and withholding it would hide that merge
 * from the human.
 */
async function postOutcome(
  merged: NonNullable<State["merged"]>,
  opts: LoopOptions,
  deps: Ports,
  log: (line: string) => void,
  save: () => Promise<void>,
): Promise<LoopResult | undefined> {
  if (!merged.outcome || merged.outcomePostedAt) return undefined;
  const { issue } = await deps.linear.readConversation(opts.issueId);
  const delegation = checkDelegation(issue, deps.agentUserId);
  if (!delegation.allowed) {
    return { outcome: "stopped", detail: `${merged.repo}#${merged.number} merged; outcome not posted: ${delegation.reason}` };
  }
  const key = `outcome:${issue.id}:${merged.repo}#${merged.number}:${merged.mergedSha}`;
  await deps.linear.postComment({ issueId: issue.id, body: merged.outcome, key });
  merged.outcomePostedAt = new Date().toISOString();
  await save();
  log(`posted the outcome comment on ${issue.identifier}`);
  return undefined;
}

const mergedHead = (m: NonNullable<State["merged"]>) => ({ repo: m.repo, number: m.number, headSha: m.headSha, mergedSha: m.mergedSha });

/**
 * Once per merge, the audit draw (06 §8). A merged head no fresh review approved skipped review; a
 * stable sample of those gets a separate fresh reviewer of exactly that head, started only while the
 * issue is still delegated (A1). Its run id comes from the head, so a restart before the save starts
 * no second audit.
 */
async function drawAudit(
  merged: NonNullable<State["merged"]>,
  runIds: RunId[],
  opts: LoopOptions,
  deps: Ports,
  log: (line: string) => void,
  save: () => Promise<void>,
  budgetOf: (runs: RunRecord[], unknownRuns: number) => BudgetStatus,
): Promise<void> {
  if (merged.auditDrawnAt) return;
  const runs = await Promise.all(runIds.map((id) => deps.runner.status(id)));
  const head = mergedHead(merged);
  if (!approvedHead(runs, head) && auditDrawn(opts.auditSampleRate ?? 0.2, head)) {
    const conversation = await deps.linear.readConversation(opts.issueId);
    const delegation = checkDelegation(conversation.issue, deps.agentUserId);
    // An audit is a new run, so it starts only within the task's budget too (B1, UNF-728).
    const refused = delegation.allowed ? checkBudget(budgetOf(runs, 0), new Date()) : delegation;
    if (!refused.allowed) {
      log(`audit of ${head.repo}#${head.number} not started: ${refused.reason}`);
    } else {
      const runId = RunId.parse(`run_audit-${head.headSha}`);
      const skipped = implementerOf(runs, head)?.reported?.review.reason ?? "no reason on record";
      // A start that fails costs one audit sample, not the task: the merge is already done.
      await deps.runner
        .start({
          runId,
          role: "reviewer",
          conversation,
          repositories: [head.repo],
          subject: [{ repo: head.repo, number: head.number, headSha: head.headSha }],
          focus: auditFocus(head, skipped),
        })
        .then(
          () => {
            merged.audit = { runId };
            log(`audit review ${runId} started for ${head.repo}#${head.number} (nonblocking: the merge is done)`);
          },
          (e: Error) => log(`audit review ${runId} failed to start: ${e.message}`),
        );
    }
  }
  merged.auditDrawnAt = new Date().toISOString();
  await save();
}

const auditFocus = (head: { headSha: string; mergedSha: string }, skipped: string) =>
  `Audit review (nonblocking). This head was merged as ${head.mergedSha} without a fresh review: the worker judged
review unnecessary ("${skipped}"). Sergeant audits a random sample of such skips to measure whether they were
safe. Review it exactly as you would before a merge. Your blocking findings become follow-up work; the merge is
not undone.`;

/**
 * After the merge and its outcome comment: waits for every review still running (a sampled audit, or
 * a required review the merge did not need) so its facts are recorded when it finishes.
 */
async function finishReviews(
  merged: NonNullable<State["merged"]>,
  result: LoopResult,
  ctx: { runIds: RunId[]; recordReviews: (runs: RunRecord[]) => Promise<void>; stop: string; opts: LoopOptions; deps: Ports; log: (line: string) => void },
): Promise<LoopResult> {
  const ids = merged.audit ? [...ctx.runIds, merged.audit.runId] : ctx.runIds;
  for (;;) {
    const runs = await Promise.all(ids.map((id) => ctx.deps.runner.status(id)));
    await ctx.recordReviews(runs);
    const running = runs.filter((r) => r.role === "reviewer" && r.status === "running").map((r) => r.runId);
    const audit = runs.find((r) => r.runId === merged.audit?.runId);
    if (running.length === 0) {
      if (audit?.role !== "reviewer") return result;
      const f = reviewFacts(audit, { trigger: "audit", issue: ctx.opts.issueId, runs, merged: mergedHead(merged) });
      const verdict = f.verdict ?? `${audit.status}, no report`;
      return { ...result, detail: `${result.detail}; audit ${audit.runId}: ${verdict}, ${f.mustFix.length} must-fix${f.followUp ? " (follow-up logged)" : ""}` };
    }
    if ((await exists(ctx.stop)) || ctx.opts.signal?.aborted) return { ...result, detail: `${result.detail}; review ${running.join(", ")} still running` };
    ctx.log(`waiting: review ${running.join(", ")} running (nonblocking: the merge is done)`);
    await pause((ctx.opts.pollSeconds ?? 60) * 1000, ctx.opts.signal);
  }
}

/** An audit's must-fix findings on merged code, kept for a human to act on. */
async function logFollowUp(f: ReviewFacts, run: RunRecord, file: string, log: (line: string) => void): Promise<void> {
  const followUp = { at: f.at, issue: f.issue, merged: f.merged, auditRunId: run.runId, verdict: f.verdict, mustFix: f.mustFix, summary: run.report?.summary };
  await appendFile(file, `${JSON.stringify(followUp)}\n`);
  const where = f.merged ? `${f.merged.repo}#${f.merged.number} merged as ${f.merged.mergedSha}` : "the merged head";
  log(`AUDIT FOLLOW-UP ${f.issue}: ${where} has ${f.mustFix.length} must-fix finding(s) (${f.mustFix.map((m) => m.id).join(", ")}) from audit ${run.runId}; recorded in ${file}`);
}

/** Step 13: whether Linear reaches Done through the GitHub integration, observed, not assumed. */
async function observeCompletion(
  merged: NonNullable<State["merged"]>,
  opts: LoopOptions,
  deps: Ports,
  log: (line: string) => void,
): Promise<LoopResult> {
  const deadline = Date.parse(merged.at) + (opts.completionWaitMinutes ?? 10) * 60_000;
  let seen = "";
  for (;;) {
    const { issue } = await deps.linear.readConversation(opts.issueId);
    if (issue.state !== seen) log(`after merge: ${issue.identifier} is ${(seen = issue.state)}`);
    const detail = `${merged.repo}#${merged.number} merged as ${merged.mergedSha} at ${merged.at}; ${issue.identifier} is ${issue.state}`;
    if (issue.state === "Done") return { outcome: "done", detail };
    if (Date.now() > deadline) return { outcome: "merged_not_done", detail };
    if (opts.signal?.aborted) return { outcome: "stopped", detail };
    await pause(15_000, opts.signal);
  }
}

/** The task's state, or a new task starting now with `window`; a task's stored window always wins. */
async function loadState(file: string, issueId: string, window: BudgetWindow): Promise<State> {
  const budget = { window, grants: [] };
  const state =
    (await readTaskState(file, window)) ??
    TaskState.parse({ issueId, startedAt: new Date().toISOString(), turns: 0, runIds: [], recentTurns: [], budget });
  if (state.issueId !== issueId) throw new Error(`${file} belongs to ${state.issueId}, not ${issueId}`);
  return state;
}

/** A task's saved `state.json`, if it has one. */
export async function readTaskState(file: string, window: BudgetWindow = DEFAULT_BUDGET): Promise<TaskState | undefined> {
  const raw = await readFile(file, "utf8").catch(() => undefined);
  if (raw === undefined) return undefined;
  const stored = JSON.parse(raw) as { budget?: object };
  // A task saved before it had a window adopts the one it is resumed with, once.
  return TaskState.parse({ ...stored, budget: { window, grants: [], ...stored.budget } });
}

/**
 * A human's request that a task take a turn now (`sgt task wake`, 11 §2). It ends the loop's current
 * wait, and the next poll takes a turn even if nothing changed. It skips no hold: running work, an open
 * question, an exhausted budget, and the turn limit still apply. Only in memory: lost on a restart.
 */
export class Wake {
  /** A turn is owed; cleared when the loop takes one. */
  pending = false;
  #interrupt = new AbortController();

  request(): void {
    this.pending = true;
    this.interrupt();
  }

  /** Ends the current wait, or the next one if the loop is not waiting. */
  interrupt(): void {
    this.#interrupt.abort();
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const interrupt = this.#interrupt;
    await pause(ms, signal ? AbortSignal.any([signal, interrupt.signal]) : interrupt.signal);
    if (interrupt.signal.aborted) this.#interrupt = new AbortController();
  }
}

/** Sleeps, cut short when `signal` aborts. */
const pause = (ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => {});

const exists = (path: string) => stat(path).then(() => true, () => false);
