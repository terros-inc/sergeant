import { HumanHandoffError, tierAtLeast, tierEvidence, tierLine, type Conversation, type MergePr, type PullRequestFacts, type RefusedMerge, type ReviewTierFacts, type RunRecord } from "@terros/sergeant-contracts";
import type { ActionOutcome, Ports } from "./execute-types.ts";

// TECH-5244: in a repository whose `mergePolicy` is `human`, Sergeant never approves or merges, nor
// anywhere for a T3 or T4 head (TECH-6553). A `merge_pr` that passes the same merge preflight as
// anywhere else hands the head to a human instead:
// the PR is marked ready, review is requested from the code owners GitHub asked or else the issue's
// assignee, and the review summary is posted on the PR and (handoff.ts) on the issue. The handoff is
// recorded like a merge GitHub refused, so M12 refuses another try at the same facts and the loop waits
// for the human's merge, which then ends the task as any closing merge does.

const MAX_SUMMARY = 4_000;

/** What gave the head its review standing, in a sentence or two for a human. */
export function reviewSummary(standing: MergePr["reviewStanding"], head: Pick<PullRequestFacts, "repo" | "number" | "headSha">, runs: RunRecord[]): string {
  const run = runs.find((r) => r.runId === (standing.kind === "reviewed" ? standing.reviewRunId : standing.workerRunId));
  const report = run?.report;
  const text =
    standing.kind === "reviewed"
      ? `Sergeant's reviewer (${standing.reviewRunId}) approved this head: ${report && "summary" in report ? report.summary.trim() : "no summary"}`
      : `The worker (${standing.workerRunId}) reported that this head needs no fresh review: ${
          report && "pullRequests" in report ? (report.pullRequests.find((p) => p.repo === head.repo && p.number === head.number && p.headSha === head.headSha)?.review.reason.trim() ?? "no reason") : "no reason"
        }`;
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text;
}

/** Why the head went to a human: protected CI, its tier (T3 or T4), or the repository's policy. */
function handoffReason(protectedFiles: string[], tier: ReviewTierFacts | undefined): string {
  if (protectedFiles.length) return `This PR changes protected CI configuration (${protectedFiles.join(", ")}), so it requires human review and human merge; Sergeant never approves it, merges it, or enables auto-merge.`;
  if (tier && tierAtLeast(tier.tier, "T3")) return `This PR is review tier ${tier.tier}, so it requires human review and human merge whatever the repository's merge policy; Sergeant never approves or merges a T3 or T4 PR.`;
  return "This repository's merge policy is `human`, so Sergeant does not approve or merge it: a human reviews and merges it.";
}

/** The tier and the reviews of the head, as audit evidence (TECH-6553); empty without a tier. */
export function evidenceLines(evidence: { tier: ReviewTierFacts; reviews: string[] } | undefined): string[] {
  if (!evidence) return [];
  return [tierLine(evidence.tier), `Reviews of this head: ${evidence.reviews.join("; ") || "none on record"}.`];
}

/** The comment on the PR itself; GitHub posts it once per head, since the head is in it. */
export function prHandoffComment(
  pr: Pick<PullRequestFacts, "headSha">,
  summary: string,
  protectedFiles: string[] = [],
  evidence?: { tier: ReviewTierFacts; reviews: string[] },
): string {
  return [
    "**Ready for a human to merge**",
    "",
    `Sergeant's merge gate passed on head \`${pr.headSha}\`: its required checks are green and it has review standing. ${handoffReason(protectedFiles, evidence?.tier)}`,
    "",
    ...(evidence ? [...evidenceLines(evidence), ""] : []),
    summary,
  ].join("\n");
}

/** Hands a gated head in a `human` repository to a human; never an approval or a merge. */
export async function handToHuman(
  action: MergePr,
  pr: PullRequestFacts,
  issue: Conversation["issue"],
  /** `tierForced`: the head's tier (T3 or T4) or protected CI sends it to a human, not the repository's policy. */
  ctx: { runs: RunRecord[]; liveRevision: string; ports: Ports; protectedFiles?: string[]; tierForced?: boolean },
): Promise<ActionOutcome> {
  const { ports } = ctx;
  try {
    if (!ports.github.handToHuman) throw new HumanHandoffError("complete handoff", "this Sergeant cannot hand a PR to a human");
    const summary = reviewSummary(action.reviewStanding, pr, ctx.runs);
    const evidence = tierEvidence(pr, ctx.runs, action.reviewStanding);
    const assignee = issue.assignee?.url && ports.githubLoginForLinearProfile?.(issue.assignee.url);
    // TECH-6553: a T3 or T4 head also asks the map's `humanTeam`, whose approvals GitHub's
    // required-reviewer rule counts.
    const team = ctx.tierForced && evidence.tier.humanTeam;
    let requested: string[];
    ({ requested } = await ports.github.handToHuman({
      repo: pr.repo,
      number: pr.number,
      expectedHeadSha: pr.headSha,
      reviewers: assignee ? [assignee] : [],
      ...(team && { teamReviewers: [team] }),
      comment: prHandoffComment(pr, summary, ctx.protectedFiles, evidence),
    }));
    ports.log?.(`${pr.repo}#${pr.number}: handed to a human to merge; review requested from ${requested.join(", ") || "nobody"}`);
    const refused: RefusedMerge = {
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      headSha: pr.headSha,
      conversationRevision: ctx.liveRevision,
      reason: ctx.protectedFiles?.length
        ? `the PR changes protected CI configuration: ${ctx.protectedFiles.join(", ")}`
        : ctx.tierForced
          ? `the PR is review tier ${evidence.tier.tier}: ${evidence.tier.rule}`
          : "the repository's merge policy is human",
      human: { requested, summary, ...(ctx.protectedFiles?.length && { protectedFiles: ctx.protectedFiles }), tier: evidence.tier, reviews: evidence.reviews },
      at: new Date().toISOString(),
    };
    const why = ctx.protectedFiles?.length
      ? "protected CI changes require human review and merge"
      : ctx.tierForced
        ? `review tier ${evidence.tier.tier} requires human review and merge`
        : `${pr.repo} is merged only by humans`;
    return { action, status: "denied", rule: "H1", reason: `${why}: handed to a human, review requested from ${requested.join(", ") || "nobody"}`, refused };
  } catch (e) {
    if (e instanceof HumanHandoffError) return { action, status: "failed", error: e.message, handoffStep: e.step };
    return { action, status: "failed", error: (e as Error).message, handoffStep: "complete handoff" };
  }
}
