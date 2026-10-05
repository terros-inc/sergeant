import { z } from "zod";
import { RepoSlug, Sha } from "./conversation.ts";

/** Required-check state on one exact commit, as GitHub reports it. */
export const CheckSummary = z.object({
  sha: Sha,
  /** The base branch's required checks; a required check GitHub has no run for is `missing`. */
  required: z.array(
    z.object({ name: z.string().min(1), state: z.enum(["passed", "failed", "pending", "missing"]) }),
  ),
});
export type CheckSummary = z.infer<typeof CheckSummary>;

/**
 * One piece of human (non-bot) feedback on a PR (TECH-4987): a submitted review, an inline review
 * comment, or a comment on the PR's conversation. Humans' feedback outranks Sergeant's own reviewer.
 */
export const HumanPullRequestFeedback = z.object({
  /** `review:<id>`, `review_comment:<id>`, or `comment:<id>`: unique within the PR. */
  id: z.string().min(1),
  kind: z.enum(["review", "review_comment", "comment"]),
  author: z.string().min(1),
  /** A review's state; null for a comment. A dismissed review reads `DISMISSED`. */
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]).nullable(),
  body: z.string(),
  /** Where an inline review comment sits; null otherwise. */
  path: z.string().nullable(),
  line: z.number().int().nullable(),
  /** The head a review or inline comment was made on; null for a conversation comment. */
  commitId: Sha.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  /** A review cannot be edited in place on GitHub's API, so its own is its submission time. */
  updatedAt: z.iso.datetime({ offset: true }),
  url: z.url(),
  /**
   * GitHub's `author_association` (`OWNER`, `MEMBER`, `COLLABORATOR`, `NONE`, ...): whether the author
   * has a role in the repository. Absent where a source does not know it.
   */
  association: z.string().optional(),
});
export type HumanPullRequestFeedback = z.infer<typeof HumanPullRequestFeedback>;

/**
 * GitHub's `mergeable_state` (TECH-5013). `unknown` while GitHub is still computing it, and for any
 * value GitHub returns that is not listed here.
 */
export const MergeableState = z.enum(["clean", "unstable", "behind", "blocked", "dirty", "draft", "has_hooks", "unknown"]);
export type MergeableState = z.infer<typeof MergeableState>;

/** Live PR state, re-read from GitHub whenever a decision depends on it. */
export const PullRequestFacts = z.object({
  repo: RepoSlug,
  number: z.number().int().positive(),
  url: z.url(),
  /** The GitHub login that opened the PR, which never changes; an App's is `<slug>[bot]`. */
  author: z.string().min(1),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  headSha: Sha,
  /** The merge commit once GitHub reports the PR merged; null before then. */
  mergedSha: Sha.nullable(),
  /** When GitHub merged it; null before then, absent where a source does not know it. */
  mergedAt: z.iso.datetime({ offset: true }).nullish(),
  baseRef: z.string().min(1),
  /** The base branch's head commit GitHub compares the PR against; absent where a source does not know it. */
  baseSha: Sha.optional(),
  /** The PR description; GitHub's empty body is "". M9 reads its closing reference. */
  body: z.string(),
  /** null while GitHub has not computed mergeability yet. */
  mergeable: z.boolean().nullable(),
  /** Why GitHub would or would not merge it now; M7 reads it. */
  mergeableState: MergeableState,
  checks: CheckSummary,
  /** Every human review and comment on the PR, oldest first; never a bot's (Sergeant's own approval included). */
  humanFeedback: z.array(HumanPullRequestFeedback),
});
export type PullRequestFacts = z.infer<typeof PullRequestFacts>;
