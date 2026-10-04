import { appendFile, stat } from "node:fs/promises";
import { checkBudget, checkDelegation, NoModelAccount, RunId, type BudgetStatus, type Conversation, type FiledFollowup, type PullRequestFacts, type RunRecord } from "@terros/sergeant-contracts";
import { cancelPending, recordStop } from "./cancel.ts";
import { outcomeComment } from "./outcome.ts";
import { cancelRuns } from "./poll.ts";
import { accountRefusal, notOwned, reassigned } from "./owner.ts";
import type { Ports } from "./execute.ts";
import type { LoopOptions, LoopResult, TaskState } from "./loop.ts";
import { approvedHead, auditDrawn, implementerOf, type ReviewFacts, reviewFacts } from "./review-quality.ts";
import { pause } from "./wake.ts";

// The task loop after the closing PR's merge (loop.ts): the outcome comment, the audit draw, waiting
// for reviews still running, and watching Linear for the issue reaching Done.

type Merged = NonNullable<TaskState["merged"]>;

/** The task's record of a closing merge, with its outcome comment built from the live facts. */
export function mergedOf(
  pr: PullRequestFacts,
  mergedSha: string,
  runs: RunRecord[],
  followups: FiledFollowup[],
  issue: Pick<Conversation["issue"], "title" | "description">,
): Merged {
  const outcome = outcomeComment(pr, mergedSha, runs, followups, issue);
  return { repo: pr.repo, number: pr.number, headSha: pr.headSha, mergedSha, at: new Date().toISOString(), outcome };
}

/**
 * One pass of the loop once the closing PR merged. Post-merge effects and an audit reviewer are task
 * work too. A resumed task that gave up its slot while waiting must be readmitted before it can post,
 * draw, or start that reviewer; until then this returns nothing and the loop waits a poll. Once both
 * are done, observing completion and waiting on a running audit need no slot (TECH-5127).
 */
export async function driveMerged(
  merged: Merged,
  ctx: {
    runIds: RunId[];
    stop: string;
    opts: LoopOptions;
    deps: Ports;
    log: (line: string) => void;
    save: () => Promise<void>;
    resolveDue: (conversation: Conversation) => Promise<boolean>;
    recordReviews: (runs: RunRecord[]) => Promise<void>;
    budgetOf: (runs: RunRecord[], unknownRuns: number) => BudgetStatus;
  },
): Promise<LoopResult | undefined> {
  const { opts, deps, log, save } = ctx;
  const effects = (merged.outcome && !merged.outcomePostedAt) || !merged.auditDrawnAt;
  if (effects && opts.slot && !opts.slot.work()) {
    log("queued: waiting for a free task slot");
    return undefined;
  }
  await deps.linear.readConversation(opts.issueId).then(ctx.resolveDue, (e: Error) => log(`could not read the conversation: ${e.message}`));
  // TECH-5179: reassigned or unassigned after the merge, the task stops as a handoff, like before it
  // (poll-checks.ts), checked again all through the completion wait and the reviews below. The loop
  // drives the recorded stop at its next poll, canceling any audit still running; a completed issue
  // keeps its status (cancel.ts).
  const handOff = async (moved: string) => {
    await recordStop(opts.dir, moved, { handoff: { delegatedAt: deps.owner?.delegatedAt, merged: true } });
    log(`stopping after the merge: ${moved}`);
    return undefined;
  };
  const moved = await movedFromOwner(opts, deps, log);
  if (moved) return handOff(moved);
  const stopped = await postOutcome(merged, opts, deps, log, save);
  if (stopped) return stopped;
  // The audit sample is drawn after the merge, so it cannot hold it up.
  await drawAudit(merged, ctx.runIds, opts, deps, log, save, ctx.budgetOf);
  const result = await observeCompletion(merged, opts, deps, log);
  if ("moved" in result) return handOff(result.moved);
  const finished = await finishReviews(merged, result, { runIds: ctx.runIds, recordReviews: ctx.recordReviews, stop: ctx.stop, opts, deps, log });
  if (await cancelPending(opts.dir)) return undefined;
  // Seen through: the issue is Done and every review finished, so intake resumes it no more.
  if (finished.outcome === "done" && !opts.signal?.aborted && !(await exists(ctx.stop))) {
    merged.completedAt = new Date().toISOString();
    await save();
  }
  return finished;
}

/**
 * Posts the merge's outcome comment once, as the V2 agent, and only while the issue is still
 * delegated to it. Keyed by issue and merge, so a crash before `state.json` records it cannot post a
 * second one. Returns a result only when the loop must stop instead. Deliberately not held to the
 * budget (B1): it reports a merge that already happened, and withholding it would hide that merge
 * from the human.
 */
export async function postOutcome(
  merged: Merged,
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

export const mergedHead = (m: Merged) => ({ repo: m.repo, number: m.number, headSha: m.headSha, mergedSha: m.mergedSha });

/**
 * Once per merge, the audit draw (06 §8). A merged head no fresh review approved skipped review; a
 * stable sample of those gets a separate fresh reviewer of exactly that head, started only while the
 * issue is still delegated (A1). Its run id comes from the head, so a restart before the save starts
 * no second audit.
 */
export async function drawAudit(
  merged: Merged,
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
    // An audit is a new run, so it starts only within the task's budget too (B1, UNF-728), paid by the
    // task's owner like every other run, and only while the issue is still assigned to them (TECH-5179).
    const { owner } = deps;
    const refused = delegation.allowed ? checkBudget(budgetOf(runs, 0), new Date()) : delegation;
    // Linear's history is reread too, right before the start: a newer or someone else's delegation is a
    // handoff, and unreadable history starts nothing (fails closed).
    let moved: string | undefined;
    let unreadable: string | undefined;
    if (owner && refused.allowed) moved = await notOwned(owner, conversation.issue, deps).catch((e: Error) => ((unreadable = e.message), undefined));
    if (!refused.allowed) {
      log(`audit of ${head.repo}#${head.number} not started: ${refused.reason}`);
    } else if (!owner) {
      log(`audit of ${head.repo}#${head.number} not started: the task has no admitted owner to pay for it`);
    } else if (unreadable !== undefined) {
      log(`audit of ${head.repo}#${head.number} not started: who delegated the issue is unreadable: ${unreadable}`);
    } else if (moved) {
      log(`audit of ${head.repo}#${head.number} not started: ${moved}`);
      await recordStop(opts.dir, moved, { handoff: { delegatedAt: owner.delegatedAt, merged: true } });
    } else {
      const runId = RunId.parse(`run_audit-${head.headSha}`);
      const skipped = implementerOf(runs, head)?.reported?.review.reason ?? "no reason on record";
      // A start that fails costs one audit sample, not the task: the merge is already done.
      const pr = await deps.github.readPullRequest(head.repo, head.number).catch((e: Error) => {
        log(`audit review ${runId} failed to read ${head.repo}#${head.number}: ${e.message}`);
        return undefined;
      });
      if (pr) {
        await deps.runner
          .start({
            runId,
            owner: { id: owner.id, name: owner.name },
            role: "reviewer",
            conversation,
            repositories: [head.repo],
            subject: [{ repo: head.repo, number: head.number, headSha: head.headSha }],
            pullRequests: [pr],
            focus: auditFocus(head, skipped),
          })
          .then(() => {
            merged.audit = { runId };
            log(`audit review ${runId} started for ${head.repo}#${head.number} (nonblocking: the merge is done)`);
          })
          .catch(async (e: Error) => {
            log(`audit review ${runId} failed to start: ${e.message}`);
            // The owner is told once per condition what to fix, as for any other start (owner.ts).
            if (!(e instanceof NoModelAccount)) return;
            const refusal = accountRefusal(conversation.issue.id, owner, e);
            await deps.linear.postComment({ issueId: conversation.issue.id, ...refusal }).catch((p: Error) => log(`could not post the model-account refusal: ${p.message}`));
          });
      }
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
export async function finishReviews(
  merged: Merged,
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
    // TECH-5179: a review after the merge is still paid by the task's owner, so the issue reassigned or
    // unassigned meanwhile stops the task and cancels the review, as before the merge.
    const moved = await movedFromOwner(ctx.opts, ctx.deps, ctx.log);
    if (moved) {
      await cancelRuns(running, ctx.deps, ctx.log);
      await recordStop(ctx.opts.dir, moved, { handoff: { delegatedAt: ctx.deps.owner?.delegatedAt, merged: true } });
      return { outcome: "stopped", detail: `${moved}; review ${running.join(", ")} canceled` };
    }
    ctx.log(`waiting: review ${running.join(", ")} running (nonblocking: the merge is done)`);
    await pause((ctx.opts.pollSeconds ?? 60) * 1000, ctx.opts.signal);
  }
}

/** Why the merged task's issue is no longer its owner's (owner.ts), read live; undefined while it is or unreadable. */
async function movedFromOwner(opts: LoopOptions, deps: Ports, log: (line: string) => void): Promise<string | undefined> {
  if (!deps.owner) return undefined;
  const owner = deps.owner;
  return deps.linear.readConversation(opts.issueId).then(
    (c) => reassigned(owner, c.issue),
    (e: Error) => (log(`could not read the conversation: ${e.message}`), undefined),
  );
}

/** An audit's must-fix findings on merged code, kept for a human to act on. */
export async function logFollowUp(f: ReviewFacts, run: RunRecord, file: string, log: (line: string) => void): Promise<void> {
  const followUp = { at: f.at, issue: f.issue, merged: f.merged, auditRunId: run.runId, verdict: f.verdict, mustFix: f.mustFix, summary: run.report?.summary };
  await appendFile(file, `${JSON.stringify(followUp)}\n`);
  const where = f.merged ? `${f.merged.repo}#${f.merged.number} merged as ${f.merged.mergedSha}` : "the merged head";
  log(`AUDIT FOLLOW-UP ${f.issue}: ${where} has ${f.mustFix.length} must-fix finding(s) (${f.mustFix.map((m) => m.id).join(", ")}) from audit ${run.runId}; recorded in ${file}`);
}

/**
 * Step 13: whether Linear reaches Done through the GitHub integration, observed, not assumed. The
 * issue reassigned or unassigned away from the task's owner meanwhile ends the wait as `moved`
 * (TECH-5179), so an audit the owner pays for stops promptly.
 */
export async function observeCompletion(
  merged: Merged,
  opts: LoopOptions,
  deps: Ports,
  log: (line: string) => void,
): Promise<LoopResult | { moved: string }> {
  const deadline = Date.parse(merged.at) + (opts.completionWaitMinutes ?? 10) * 60_000;
  let seen = "";
  for (;;) {
    const { issue } = await deps.linear.readConversation(opts.issueId);
    const moved = deps.owner && reassigned(deps.owner, issue);
    if (moved) return { moved };
    if (issue.state !== seen) log(`after merge: ${issue.identifier} is ${(seen = issue.state)}`);
    const detail = `${merged.repo}#${merged.number} merged as ${merged.mergedSha} at ${merged.at}; ${issue.identifier} is ${issue.state}`;
    if (issue.state === "Done") return { outcome: "done", detail };
    if (Date.now() > deadline) return { outcome: "merged_not_done", detail };
    if (opts.signal?.aborted) return { outcome: "stopped", detail };
    await pause(Math.min(15_000, (opts.pollSeconds ?? 60) * 1000), opts.signal);
  }
}

export const exists = (path: string) => stat(path).then(() => true, () => false);
