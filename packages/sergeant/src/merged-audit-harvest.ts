import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRateLimited, safeJson } from "@terros/sergeant-contracts";
import { logFollowUp } from "./audit.ts";
import type { Ledger, MergedAuditDeps, MergedAuditOptions } from "./merged-audits.ts";
import { reviewFacts } from "./review-quality.ts";

// TECH-6618: finishing the merged-PR audits outside a task (06 §8, proposal 16 §6.2–6.4). A task's
// audit is recorded by its own after-merge loop; one this loop started has no task, so each pass reads
// back every audit it started and, once the run has finished, posts its nonblocking PR comment and then
// writes its `ReviewFacts` line to `<stateDir>/reviews.jsonl`. The line is written exactly once, after
// the comment has settled (posted or nothing to post), so it never needs a second line to
// carry the comment's id. `reviews.jsonl` itself is the record of what was written: an audit with a line
// there is done, so a lost or stale ledger, a re-scan, or a retry never writes another.

/** Finished audits are harvested at every hourly check, not only on the daily pass, so a comment follows its audit within the hour. */
export async function harvestAudits(ledger: Ledger, opts: MergedAuditOptions, deps: MergedAuditDeps, save: () => Promise<void>): Promise<void> {
  const reviews = join(opts.stateDir, "reviews.jsonl");
  let written: Set<string> | undefined;
  for (const entry of ledger.started) {
    const pr = entry.subject;
    // Started before TECH-6618, with no head to record against until the daily re-scan gives it one; or done.
    if (!pr || entry.recorded) continue;
    if (opts.signal?.aborted) return;
    const run = await deps.runner.status(entry.runId).catch((e: Error) => (opts.log(`merged-PR audit ${entry.runId}: status unreadable, retrying next pass: ${e.message}`), undefined));
    if (!run || run.status === "running") continue;
    // Read once per pass, only when some audit has finished.
    written ??= await recordedRunIds(reviews);
    if (run.role !== "reviewer" || written.has(entry.runId)) {
      entry.recorded = true;
      await save();
      continue;
    }
    const facts = reviewFacts(run, { trigger: "audit", issue: pr.issue ?? `${pr.repo}#${pr.number}`, runs: [run], merged: pr, ...(entry.accountsOf && { accountsOf: entry.accountsOf }) });
    const on = facts.subject.find((s) => s.repo === pr.repo && s.number === pr.number && s.headSha === pr.headSha);
    // A run with no report, or one that reviewed some other head, has nothing for this PR to show.
    const report = run.report;
    if (report && on?.found !== undefined && deps.github.postAuditComment && entry.auditCommentId === undefined) {
      const comment = await deps.github
        .postAuditComment({ repo: pr.repo, number: pr.number, headSha: pr.headSha, verdict: report.verdict, found: on.found, summary: report.summary, findings: report.findings })
        .catch((e: Error) => {
          if (isRateLimited(e)) throw e;
          // Never given up: the comment is required, so an outage of any length only delays it and the line.
          opts.log(`merged-PR audit ${entry.runId}: comment on ${pr.repo}#${pr.number} not posted, retrying next pass: ${e.message}`);
          return undefined;
        });
      if (!comment) continue;
      entry.auditCommentId = comment.id;
    }
    if (on && entry.auditCommentId !== undefined) on.auditCommentId = entry.auditCommentId;
    if (facts.followUp) await logFollowUp(facts, run, join(opts.stateDir, "audit-followups.jsonl"), opts.log);
    await appendFile(reviews, `${JSON.stringify(facts)}\n`);
    written.add(entry.runId);
    entry.recorded = true;
    await save();
  }
}

/** The run ids `reviews.jsonl` already has a line for; a torn line is skipped. */
async function recordedRunIds(file: string): Promise<Set<string>> {
  const raw = await readFile(file, "utf8").catch(() => "");
  const ids = new Set<string>();
  for (const line of raw.split("\n")) {
    const runId = (safeJson(line) as { runId?: unknown } | undefined)?.runId;
    if (typeof runId === "string") ids.add(runId);
  }
  return ids;
}
