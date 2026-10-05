import { FEEDBACK_MARKER, issueRevision, type Conversation, type FiledFollowup, type PullRequestFacts, type RunRecord } from "@terros/sergeant-contracts";
import { approvedHead } from "./review-quality.ts";

/**
 * The one concise outcome comment Sergeant posts after a merge (07 §3): the PR, the reviewed head,
 * the validation observed on it, the merge result, known gaps, and follow-ups filed. Built from live PR facts and the
 * run records: the ones the merge was allowed on, or, for a merge `state.json` never recorded, the
 * ones re-read after it. No run ids or other internals; Done is left to the GitHub integration.
 * Known gaps are judged against the issue's current title and description (TECH-5034), so a human
 * merge of work checked against older text, or over a review's unmet requirements, says so.
 */
export function outcomeComment(
  pr: PullRequestFacts,
  mergedSha: string,
  runs: RunRecord[],
  followups: FiledFollowup[],
  issue: Pick<Conversation["issue"], "title" | "description">,
  /** TECH-5227: the task's total cost line (cost.ts). */
  cost?: string,
): string {
  const head = pr.headSha;
  const covers = (r: { repo: string; number: number }) => r.repo === pr.repo && r.number === pr.number;

  // The worker that last reported this PR names its known gaps and, for this head, any review waiver.
  const worker = runs.findLast((r) => r.role === "worker" && r.report?.pullRequests.some(covers));
  const report = worker?.role === "worker" ? worker.report : null;
  const waiver = report?.pullRequests.find((r) => covers(r) && r.headSha === head)?.review;
  const review = approvedHead(runs, pr)
    ? "a fresh review approved this exact head"
    : waiver && !waiver.required
      ? `not required for this head (${waiver.reason})`
      : "no fresh review of this head on record";

  const checks = pr.checks.required;
  const validation = checks.every((c) => c.state === "passed")
    ? `required checks passed on that head: ${checks.map((c) => c.name).join(", ") || "none declared"}`
    : `required checks on that head: ${checks.map((c) => `${c.name} ${c.state}`).join(", ")}`;
  const gaps = [...(report?.knownGaps ?? []), ...acceptanceGaps(pr, runs, issueRevision(issue))].map((g) => g.trim().replace(/\.$/, ""));

  return [
    `**Merged** [${pr.repo}#${pr.number}](${pr.url}): head \`${head.slice(0, 12)}\` merged as \`${mergedSha.slice(0, 12)}\`.`,
    `- Review: ${review}.`,
    `- Validation: ${validation}.`,
    `- Known gaps: ${gaps.length > 0 ? gaps.join("; ") : "none reported"}.`,
    ...(followups.length > 0 ? [`- Follow-ups filed: ${followups.map((f) => `[${f.identifier}](${f.url}) ${f.title}`).join("; ")}.`] : []),
    ...(cost ? [`- ${cost}`] : []),
  ].join("\n");
}

/**
 * What the merged head leaves unmet of the current acceptance criteria, as far as the records show:
 * every run that checked this head started from an earlier title or description, or the latest review
 * that started from the current text found requirements unmet (marked as blocking acceptance findings).
 */
function acceptanceGaps(pr: PullRequestFacts, runs: RunRecord[], current: string): string[] {
  const atHead = (r: { repo: string; number: number; headSha: string }) => r.repo === pr.repo && r.number === pr.number && r.headSha === pr.headSha;
  const checked = runs.filter((r) => (r.role === "reviewer" ? r.report?.reviewed.some(atHead) : r.report?.pullRequests.some(atHead)));
  const stale = checked.length > 0 && checked.every((r) => r.issueRevision !== undefined && r.issueRevision !== current);
  const review = checked.findLast((r) => r.role === "reviewer" && r.issueRevision === current);
  const unmet = review?.role === "reviewer" ? (review.report?.findings ?? []).filter((f) => f.severity === "blocking" && f.category === "acceptance") : [];
  return [
    ...(stale ? ["this head was checked only against an earlier title or description of the issue, not its current acceptance criteria"] : []),
    ...unmet.map((f) => `unmet per review: ${f.description.split("\n")[0]?.slice(0, 200)}`),
  ];
}

/**
 * TECH-5186: the one short Sergeant feedback comment posted on the issue after the closing merge, three
 * lines at most, for a retro across tasks (TECH-5187) to read. Nothing to post without a line worth
 * keeping: "Nothing notable" is a healthy answer, not feedback.
 */
export function feedbackComment(lines: readonly string[] | undefined): string | undefined {
  const kept = (lines ?? [])
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l !== "" && !/^nothing notable\.?$/i.test(l))
    .slice(0, 3);
  return kept.length > 0 ? kept.map((l, i) => (i === 0 ? `${FEEDBACK_MARKER} ${l}` : l)).join("\n") : undefined;
}

/**
 * A task's feedback when no reasoning turn picked it (a human's merge, or the issue completed in Linear
 * without a recognized closing merge): only the explicit feedback of the worker that last reported `pr`
 * (the last worker report when none is given). `feedbackComment` keeps the first three lines.
 */
export function workerFeedback(runs: RunRecord[], pr?: { repo: string; number: number }): string[] {
  const covers = (prs: { repo: string; number: number }[]) => !pr || prs.some((r) => r.repo === pr.repo && r.number === pr.number);
  const worker = runs.findLast((r) => r.role === "worker" && r.report && covers(r.report.pullRequests));
  return worker?.role === "worker" ? (worker.report?.feedback ?? []) : [];
}
