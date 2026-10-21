import type { ReviewStanding } from "./actions.ts";
import type { PullRequestFacts } from "./github.ts";
import { protectedCiFiles } from "./protected-ci.ts";
import { tierAtLeast, type ReviewTierFacts } from "./review-tiers.ts";
import type { RunRecord } from "./runs.ts";

// TECH-6553: what a head's review tier requires before Sergeant merges it or hands it to a human
// (06 §6a, M16). The tier is the map's, raised by any run; reviews count only for the exact head.

type Head = Pick<PullRequestFacts, "repo" | "number" | "headSha">;

const UNREAD: ReviewTierFacts = { tier: "T3", rule: "the PR's review tier was not read, so it fails closed" };

/**
 * The PR's tier: its head's tier from the map (T3 when it was not read), at least T3 for protected CI
 * or an unknown file list (M15) whatever the source read, and raised by any worker's or reviewer's
 * report naming the PR at any head. A raise sticks for later heads; nothing here lowers it.
 */
export function effectiveTier(pr: Pick<PullRequestFacts, "repo" | "number" | "reviewTier" | "changedFiles">, runs: RunRecord[]): ReviewTierFacts {
  let tier = pr.reviewTier ?? UNREAD;
  const ci = protectedCiFiles(pr);
  if (ci.length > 0 && !tierAtLeast(tier.tier, "T3")) tier = { ...tier, tier: "T3", rule: `the PR changes protected CI configuration (${ci.join(", ")}), at least T3` };
  for (const run of runs) {
    const named = run.role === "worker" ? (run.report?.pullRequests ?? []) : (run.report?.reviewed ?? []);
    for (const entry of named) {
      if (entry.repo !== pr.repo || entry.number !== pr.number || !entry.raiseTier || tierAtLeast(tier.tier, entry.raiseTier.tier)) continue;
      tier = { ...tier, tier: entry.raiseTier.tier, rule: `raised to ${entry.raiseTier.tier} by ${run.role} ${run.runId}: ${entry.raiseTier.reason.trim()}` };
    }
  }
  return tier;
}

/**
 * The separate reviewer runs that approved exactly this head with no blocking finding. A run that
 * started from an earlier title or description of the issue does not count once `issueRevision` is given (M13).
 */
export function approvingReviews(head: Head, runs: RunRecord[], issueRevision?: string): RunRecord[] {
  return runs.filter(
    (r) =>
      r.role === "reviewer" &&
      r.status === "succeeded" &&
      r.report?.verdict === "approve" &&
      r.report.reviewed.some((p) => p.repo === head.repo && p.number === head.number && p.headSha === head.headSha) &&
      !r.report.findings.some((f) => f.severity === "blocking") &&
      (issueRevision === undefined || r.issueRevision === undefined || r.issueRevision === issueRevision),
  );
}

/** GitHub's associations of someone with a role in the repository; an outsider's approval on a public repository never counts. */
const MEMBER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** The humans who approved exactly this head on GitHub, other than the PR's author, each with a role in the repository. */
export function humanApprovals(pr: Pick<PullRequestFacts, "headSha" | "author" | "humanFeedback">): string[] {
  const approvers = pr.humanFeedback.filter(
    (f) => f.kind === "review" && f.state === "APPROVED" && f.commitId === pr.headSha && f.author !== pr.author && MEMBER_ASSOCIATIONS.has(f.association ?? ""),
  );
  return [...new Set(approvers.map((f) => f.author))];
}

/**
 * Why this head's tier does not allow the step, or null when it does (M16): only T0 accepts the worker's
 * `not_required`; T1 and up need a reviewer's approval of the exact head (M6 checks the one named); and
 * for Sergeant's own merge, T2 needs a second approving reviewer run or a human's approval of the head,
 * and T3 and T4 are never Sergeant's to approve or merge. A handoff gives the human who merges the
 * rest of what T2 to T4 require, which GitHub's required-reviewer rule enforces.
 */
export function tierRefusal(
  tier: ReviewTierFacts,
  standing: ReviewStanding,
  pr: Head & Pick<PullRequestFacts, "author" | "humanFeedback">,
  runs: RunRecord[],
  { handToHuman, issueRevision }: { handToHuman: boolean; issueRevision?: string },
): string | null {
  const what = `${pr.repo}#${pr.number} is review tier ${tier.tier} (${tier.rule})`;
  if (standing.kind === "not_required" && tier.tier !== "T0") {
    return `${what}; the worker's not_required covers only T0, so a reviewer run must approve head ${pr.headSha} first`;
  }
  if (handToHuman) return null;
  if (tierAtLeast(tier.tier, "T3")) return `${what}; a human approves and merges it, never Sergeant`;
  if (tier.tier === "T2") {
    const reviews = approvingReviews(pr, runs, issueRevision);
    if (reviews.length < 2 && humanApprovals(pr).length === 0) {
      return `${what}; it needs two independent reviewer runs approving head ${pr.headSha}, or a human's approval of it on GitHub, and has ${reviews.length} approving review${reviews.length === 1 ? "" : "s"} and no human approval`;
    }
  }
  return null;
}

/** The tier and the reviews of the exact head behind a merge or a handoff, as audit evidence for the PR and the issue. */
export function tierEvidence(pr: PullRequestFacts, runs: RunRecord[], standing?: ReviewStanding): { tier: ReviewTierFacts; reviews: string[] } {
  const reviews = [
    ...approvingReviews(pr, runs).map((r) => `a fresh review approved this exact head (reviewer run ${r.runId})`),
    ...humanApprovals(pr).map((login) => `${login} approved this exact head on GitHub`),
  ];
  if (reviews.length === 0 && standing?.kind === "not_required") reviews.push(`the worker run ${standing.workerRunId} reported that this head needs no review (T0 only)`);
  return { tier: effectiveTier(pr, runs), reviews };
}

/** One line naming the tier and its rule, for a comment. */
export const tierLine = (tier: ReviewTierFacts) => `Review tier: **${tier.tier}**, because ${tier.rule}.`;
