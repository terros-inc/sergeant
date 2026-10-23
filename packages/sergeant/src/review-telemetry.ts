import { appendFile } from "node:fs/promises";
import type { RunRecord } from "@terros/sergeant-contracts";
import { logFollowUp, mergedHead } from "./audit.ts";
import { type ReviewFacts, reviewFacts } from "./review-quality.ts";
import { landings, type TaskState } from "./task-state.ts";

// Review telemetry (UNF-730): every reviewer run that has finished, merged or not, gets a
// `reviews.jsonl` line, and another only when a later-known fact (the merge, a resulting change)
// changes it. An audit's must-fix findings on merged code also go to `audit-followups.jsonl` for a
// human; nothing is reopened or reverted. Telemetry only: nothing here gates a turn or an effect.
export async function recordReviews(
  runs: RunRecord[],
  state: TaskState,
  ctx: { issueId: string; auditFollowups: string; reviews: string; log: (line: string) => void; save: () => Promise<void> },
): Promise<void> {
  const { log, save } = ctx;
  const facts: ReviewFacts[] = [];
  for (const run of runs) {
    if (run.role !== "reviewer" || run.status === "running") continue;
    // TECH-6477: an audit of a merge reopened since is still that merge's audit.
    const audited = landings(state).find((m) => m.audit?.runId === run.runId);
    const merged = audited ?? state.merged;
    const owner = audited && state.owner && { id: state.owner.id, name: state.owner.name };
    const f = reviewFacts(run, { trigger: audited ? "audit" : "required", issue: ctx.issueId, runs, merged: merged ? mergedHead(merged) : null, ...(owner && { accountsOf: owner }) });
    const known = JSON.stringify([f.status, f.merged, f.resultingMutation]);
    if (state.reviewsRecorded[run.runId] === known) continue;
    if (f.followUp && state.reviewsRecorded[run.runId] === undefined) await logFollowUp(f, run, ctx.auditFollowups, log);
    state.reviewsRecorded[run.runId] = known;
    facts.push(f);
  }
  if (facts.length === 0) return;
  await appendFile(ctx.reviews, facts.map((f) => `${JSON.stringify(f)}\n`).join(""));
  await save();
}
