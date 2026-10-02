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
  baseRef: z.string().min(1),
  /** The PR description; GitHub's empty body is "". M9 reads its closing reference. */
  body: z.string(),
  /** null while GitHub has not computed mergeability yet. */
  mergeable: z.boolean().nullable(),
  checks: CheckSummary,
});
export type PullRequestFacts = z.infer<typeof PullRequestFacts>;
