import type { MergePr, PullRequestFacts, RunRecord } from "@terros/sergeant-contracts";

const FALLBACK = "Reason recorded in Sergeant's task record";

export function readinessComment(action: MergePr, pr: PullRequestFacts, runs: RunRecord[]): { comment: string; modelText: string } {
  const reason = action.readinessReason?.trim() || FALLBACK;
  const suggestions = action.feedback ?? [];
  const standing = action.reviewStanding;
  const runId = standing.kind === "reviewed" ? standing.reviewRunId : standing.workerRunId;
  const run = runs.find((candidate) => candidate.runId === runId);
  const verdict = standing.kind === "reviewed" && run?.report && "verdict" in run.report ? run.report.verdict : standing.kind === "reviewed" ? "approve" : "not required";
  const native = pr.humanFeedback
    .filter((feedback) => feedback.kind === "review" && feedback.commitId === pr.headSha)
    .map((feedback) => `- ${feedback.author}: GitHub review ${feedback.state} on this head`);
  const passed = pr.checks.required.filter((check) => check.state === "passed").length;
  const evidence = [`- Sergeant ${standing.kind === "reviewed" ? "reviewer" : "worker"} ${runId}: ${verdict}`, ...native, `- Required checks: ${passed} of ${pr.checks.required.length} passed`];
  const suggestionLines = suggestions.map((suggestion) => `Suggested, not acted on: ${suggestion}`);
  const modelText = [reason, ...suggestions].join("\n");
  return {
    modelText,
    comment: [`READY TO MERGE | SHA: ${pr.headSha}`, "", `Reason: ${reason}`, "", "Evidence on this head:", ...evidence, ...suggestionLines].join("\n"),
  };
}

export function redactedReadiness(comment: string): string {
  return comment.replace(/Reason: [\s\S]*?(?=\n\nEvidence on this head:)/, `Reason: ${FALLBACK}`).replace(/\nSuggested, not acted on:.*$/gm, "");
}
