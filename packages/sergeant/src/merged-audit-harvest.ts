import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { isRateLimited } from "@terros/sergeant-contracts";
import { logFollowUp } from "./audit.ts";
import type { Ledger, MergedAuditDeps, MergedAuditOptions } from "./merged-audits.ts";
import { reviewFacts } from "./review-quality.ts";

// TECH-6618: finishing the merged-PR audits outside a task (06 §8, proposal 16 §6.2–6.4). A task's
// audit is recorded by its own after-merge loop; one this loop started has no task, so each pass reads
// back every audit it started and, once the run has finished, posts its nonblocking PR comment and writes
// its `ReviewFacts` line to `<stateDir>/reviews.jsonl`, once. The ledger entry remembers both, so a
// re-scan writes nothing twice. Losing the ledger re-scans the window, which may write a line again (the
// last line per run id holds) but never a second comment: the adapter returns the head's existing one.

/** Finished audits are harvested at every hourly check, not only on the daily pass, so a comment follows its audit within the hour. */
export async function harvestAudits(ledger: Ledger, opts: MergedAuditOptions, deps: MergedAuditDeps, save: () => Promise<void>): Promise<void> {
  for (const entry of ledger.started) {
    const pr = entry.subject;
    // Started before TECH-6618, with no head to record against; or done.
    if (!pr || (entry.recorded && entry.commented)) continue;
    if (opts.signal?.aborted) return;
    const run = await deps.runner.status(entry.runId).catch((e: Error) => (opts.log(`merged-PR audit ${entry.runId}: status unreadable, retrying next pass: ${e.message}`), undefined));
    if (!run || run.status === "running") continue;
    if (run.role !== "reviewer") {
      entry.recorded = entry.commented = true;
      await save();
      continue;
    }
    const facts = reviewFacts(run, { trigger: "audit", issue: pr.issue ?? `${pr.repo}#${pr.number}`, runs: [run], merged: pr });
    const on = facts.subject.find((s) => s.repo === pr.repo && s.number === pr.number && s.headSha === pr.headSha);
    let posted = false;
    if (!entry.commented) {
      // A run with no report, or one that reviewed some other head, has nothing for this PR to show.
      const report = run.report;
      if (!report || on?.found === undefined || !deps.github.postAuditComment) entry.commented = true;
      else {
        const comment = await deps.github
          .postAuditComment({ repo: pr.repo, number: pr.number, headSha: pr.headSha, verdict: report.verdict, found: on.found, summary: report.summary, findings: report.findings })
          .catch((e: Error) => {
            if (isRateLimited(e)) throw e;
            opts.log(`merged-PR audit ${entry.runId}: comment on ${pr.repo}#${pr.number} not posted, retrying next pass: ${e.message}`);
            return undefined;
          });
        if (comment) {
          entry.auditCommentId = comment.id;
          entry.commented = posted = true;
        }
      }
    }
    if (on && entry.auditCommentId !== undefined) on.auditCommentId = entry.auditCommentId;
    // The line is written once when the run finishes, and once more only when its comment posts later.
    if (entry.recorded && !posted) continue;
    if (facts.followUp && !entry.recorded) await logFollowUp(facts, run, join(opts.stateDir, "audit-followups.jsonl"), opts.log);
    await appendFile(join(opts.stateDir, "reviews.jsonl"), `${JSON.stringify(facts)}\n`);
    entry.recorded = true;
    await save();
  }
}
