import { appendFile } from "node:fs/promises";
import type { RunRecord } from "@terros/sergeant-contracts";
import { logFollowUp, mergedHead } from "./after-merge.ts";
import { type ReviewFacts, reviewFacts } from "./review-quality.ts";
import type { TaskState } from "./task-state.ts";

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
    const trigger = run.runId === state.merged?.audit?.runId ? "audit" : "required";
    const f = reviewFacts(run, { trigger, issue: ctx.issueId, runs, merged: state.merged ? mergedHead(state.merged) : null });
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
