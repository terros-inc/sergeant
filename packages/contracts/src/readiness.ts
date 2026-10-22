import type { Sha } from "./conversation.ts";

export type GitHubAccount = { login: string; type: "User" | "Bot" };

/** A possible readiness declaration plus the configured identity that must have posted it. */
export type ReadinessDeclaration = {
  id: string;
  body: string;
  author: GitHubAccount;
  performedViaGitHubAppId: number | null;
  sergeantAppId: number;
  createdAt: string;
};

export type ReadinessReview = {
  author: GitHubAccount;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  commitId: Sha;
  submittedAt: string;
};

/** The GitHub facts needed to classify one declaration. They are read, never persisted. */
export type ReadinessPullRequestFacts = {
  state: "open" | "closed" | "merged";
  headSha: Sha;
  mergedAt: string | null;
  mergedBy: GitHubAccount | null;
  closedAt: string | null;
  reviews: ReadinessReview[];
  mergedViaMergeQueue: boolean;
  addedToMergeQueueActor: GitHubAccount | null;
};

export type ReadinessClassification =
  | { class: "AGREED"; reason: "same_head" }
  | { class: "DIFFERENT_HEAD"; reason: "different_head" }
  | { class: "REJECTED"; reason: "changes_requested" }
  | { class: "UNKNOWN"; reason: "pending" | "closed_unmerged" | "not_human_merge" | "uninterpretable" };

const READY_LINE = /^READY TO MERGE \| SHA: ([0-9a-f]{40}|[0-9a-f]{64})$/;

/** Classifies Sergeant's declaration against the PR's eventual GitHub outcome (design 16 §5). */
export function classifyReadiness(
  declaration: ReadinessDeclaration,
  facts: ReadinessPullRequestFacts,
): ReadinessClassification {
  const firstLine = declaration.body.split(/\r?\n/, 1)[0] ?? "";
  const declaredSha = READY_LINE.exec(firstLine)?.[1];
  const hasReason = declaration.body.split(/\r?\n/).some((line) => /^Reason:\s*\S/.test(line));
  const ownApp =
    declaration.author.type === "Bot" &&
    declaration.performedViaGitHubAppId === declaration.sergeantAppId;
  if (!ownApp || !declaredSha || !hasReason) return { class: "UNKNOWN", reason: "uninterpretable" };

  const declaredAt = Date.parse(declaration.createdAt);
  if (!Number.isFinite(declaredAt)) return { class: "UNKNOWN", reason: "uninterpretable" };
  if (facts.state === "open") return { class: "UNKNOWN", reason: "pending" };

  if (facts.state === "merged") {
    const mergedAt = facts.mergedAt === null ? Number.NaN : Date.parse(facts.mergedAt);
    if (!Number.isFinite(mergedAt) || mergedAt <= declaredAt || facts.mergedBy === null) {
      return { class: "UNKNOWN", reason: "uninterpretable" };
    }
    const humanMerger = facts.mergedBy.type === "User" || (facts.mergedViaMergeQueue && facts.addedToMergeQueueActor?.type === "User");
    if (facts.mergedBy.type === "Bot" && facts.mergedViaMergeQueue && !humanMerger) {
      return { class: "UNKNOWN", reason: "uninterpretable" };
    }
    if (!humanMerger) return { class: "UNKNOWN", reason: "not_human_merge" };
    return facts.headSha === declaredSha
      ? { class: "AGREED", reason: "same_head" }
      : { class: "DIFFERENT_HEAD", reason: "different_head" };
  }

  const closedAt = facts.closedAt === null ? Number.NaN : Date.parse(facts.closedAt);
  if (!Number.isFinite(closedAt) || closedAt <= declaredAt) {
    return { class: "UNKNOWN", reason: "closed_unmerged" };
  }

  const latest = new Map<string, ReadinessReview>();
  const decisive = facts.reviews
    .filter(
      (review) =>
        review.author.type === "User" &&
        review.commitId === declaredSha &&
        review.state !== "COMMENTED" &&
        review.state !== "DISMISSED" &&
        Date.parse(review.submittedAt) <= closedAt,
    )
    .toSorted((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  for (const review of decisive) latest.set(review.author.login, review);
  const rejected = [...latest.values()].some(
    (review) => review.state === "CHANGES_REQUESTED" && Date.parse(review.submittedAt) > declaredAt,
  );
  return rejected
    ? { class: "REJECTED", reason: "changes_requested" }
    : { class: "UNKNOWN", reason: "closed_unmerged" };
}
