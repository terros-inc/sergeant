import { appendFile } from "node:fs/promises";
import { checkBudget, checkDelegation, NoModelAccount, RunId, type BudgetStatus, type PullRequestFacts, type RunRecord } from "@terros/sergeant-contracts";
import { cancelPending, recordStop } from "./cancel.ts";
import type { Ports } from "./execute.ts";
import type { LoopOptions } from "./loop-options.ts";
import { accountRefusal, reassigned } from "./owner.ts";
import { approvedHead, auditDrawn, implementerOf, type ReviewFacts } from "./review-quality.ts";
import type { TaskState } from "./task-state.ts";

// The audit of a merged head that skipped fresh review (06 §8, after-merge.ts): the draw, the
// nonblocking reviewer it starts, and the follow-up kept for a human when it finds must-fix issues.

type Merged = NonNullable<TaskState["merged"]>;

export const mergedHead = (m: Merged) => ({ repo: m.repo, number: m.number, headSha: m.headSha, mergedSha: m.mergedSha });

/**
 * Once per merge, the audit draw (06 §8). A merged head no fresh review approved skipped review; a
 * stable sample of those gets a separate fresh reviewer of exactly that head, started only while the
 * issue is still delegated (A1). Its run id comes from the head, so a restart before the save starts
 * no second audit. False while the draw is not done: an owner's refusal Linear has not accepted yet.
 */
export async function drawAudit(
  merged: Merged,
  runIds: RunId[],
  opts: LoopOptions,
  deps: Ports,
  log: (line: string) => void,
  save: () => Promise<void>,
  budgetOf: (runs: RunRecord[], unknownRuns: number) => BudgetStatus,
): Promise<boolean> {
  if (merged.auditDrawnAt) return true;
  const runs = await Promise.all(runIds.map((id) => deps.runner.status(id)));
  const head = mergedHead(merged);
  if (!approvedHead(runs, head) && auditDrawn(opts.auditSampleRate ?? 0.2, head)) {
    const conversation = await deps.linear.readConversation(opts.issueId);
    const delegation = checkDelegation(conversation.issue, deps.agentUserId);
    // An audit is a new run, so it starts only within the task's budget too (B1, UNF-728), paid by the
    // task's owner like every other run, and only while the issue is still assigned to them (TECH-5179).
    const { owner } = deps;
    const refused = delegation.allowed ? checkBudget(budgetOf(runs, 0), new Date()) : delegation;
    // Reassigned or unassigned since, it is a handoff. A redelegation by the same assignee after the
    // merge is the same owner, so Linear's history is not reread here (TECH-5179).
    const moved = owner && refused.allowed ? reassigned(owner, conversation.issue) : undefined;
    if (!refused.allowed) {
      log(`audit of ${head.repo}#${head.number} not started: ${refused.reason}`);
    } else if (!owner) {
      log(`audit of ${head.repo}#${head.number} not started: the task has no admitted owner to pay for it`);
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
      // Recorded under the task's start/cancel lock before the start, as every run is (UNF-728): a stop
      // recorded first starts nothing, and one recorded after finds the audit in `state.json` to cancel.
      const exclusive = deps.exclusive ?? ((step) => step());
      const start = async (p: PullRequestFacts) => {
        if (await cancelPending(opts.dir)) return log(`audit review ${runId} not started: the task is stopping`);
        merged.audit = { runId };
        await save();
        await deps.runner.start({
          runId,
          owner: { id: owner.id, name: owner.name },
          role: "reviewer",
          conversation,
          repositories: [head.repo],
          subject: [{ repo: head.repo, number: head.number, headSha: head.headSha }],
          pullRequests: [p],
          focus: auditFocus(head, skipped),
        });
        log(`audit review ${runId} started for ${head.repo}#${head.number} (nonblocking: the merge is done)`);
      };
      if (pr) {
        const failed = await exclusive(() => start(pr)).then(
          () => undefined,
          (e: Error) => e,
        );
        if (failed) {
          delete merged.audit;
          log(`audit review ${runId} failed to start: ${failed.message}`);
          // The owner is told once per condition what to fix, as for any other start (owner.ts), retried
          // on the next pass until Linear accepts it: the draw is left unrecorded until then.
          if (failed instanceof NoModelAccount) {
            const refusal = accountRefusal(conversation.issue.id, owner, failed);
            const posted = await deps.linear.postComment({ issueId: conversation.issue.id, ...refusal }).then(
              () => true,
              (p: Error) => (log(`could not post the model-account refusal, retrying: ${p.message}`), false),
            );
            if (!posted) return false;
          }
        }
      }
    }
  }
  merged.auditDrawnAt = new Date().toISOString();
  await save();
  return true;
}

const auditFocus = (head: { headSha: string; mergedSha: string }, skipped: string) =>
  `Audit review (nonblocking). This head was merged as ${head.mergedSha} without a fresh review: the worker judged
review unnecessary ("${skipped}"). Sergeant audits a random sample of such skips to measure whether they were
safe. Review it exactly as you would before a merge. Your blocking findings become follow-up work; the merge is
not undone.`;

/** An audit's must-fix findings on merged code, kept for a human to act on. */
export async function logFollowUp(f: ReviewFacts, run: RunRecord, file: string, log: (line: string) => void): Promise<void> {
  const followUp = { at: f.at, issue: f.issue, merged: f.merged, auditRunId: run.runId, verdict: f.verdict, mustFix: f.mustFix, summary: run.report?.summary };
  await appendFile(file, `${JSON.stringify(followUp)}\n`);
  const where = f.merged ? `${f.merged.repo}#${f.merged.number} merged as ${f.merged.mergedSha}` : "the merged head";
  log(`AUDIT FOLLOW-UP ${f.issue}: ${where} has ${f.mustFix.length} must-fix finding(s) (${f.mustFix.map((m) => m.id).join(", ")}) from audit ${run.runId}; recorded in ${file}`);
}
