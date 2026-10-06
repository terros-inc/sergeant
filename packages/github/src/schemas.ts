import { MergeableState, MergePolicy } from "@terros/sergeant-contracts";
import { z } from "zod";

export const pullRequest = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  user: z.object({ login: z.string().min(1) }),
  body: z.string().nullish(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged_at: z.string().nullable(),
  /** Moves with any change to the PR, its reviews and comments included (TECH-5336). */
  updated_at: z.string().optional(),
  mergeable: z.boolean().nullable(),
  /** A value missing, or one GitHub adds later, reads as `unknown`: M7 then waits rather than merging. */
  mergeable_state: MergeableState.catch("unknown"),
  merge_commit_sha: z.string().nullable(),
  head: z.object({ sha: z.string() }),
  base: z.object({ ref: z.string().min(1), sha: z.string() }),
});
/** What a squash commit message is written from (TECH-5085). */
export const pullRequestText = z.object({ title: z.string(), body: z.string().nullish(), user: z.object({ login: z.string().min(1) }) });
export const pullRequestCommits = z.array(
  z.object({
    commit: z.object({ message: z.string(), author: z.object({ name: z.string(), email: z.string() }).nullable() }),
    author: z.object({ login: z.string() }).nullable(),
  }),
);
/** What a closed PR's branch delete checks (TECH-5230): its head branch, its head repository, and whether it merged. */
export const pullRequestHead = z.object({
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  head: z.object({ ref: z.string().min(1), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
});
/** What a handoff to a human reads (TECH-5244): whether it is a draft, and whose review is requested. */
export const pullRequestReviewers = z.object({
  node_id: z.string().min(1),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  user: z.object({ login: z.string().min(1) }),
  head: z.object({ sha: z.string() }),
  requested_reviewers: z.array(z.object({ login: z.string().min(1) })).default([]),
  requested_teams: z.array(z.object({ slug: z.string().min(1) })).default([]),
});
export const graphqlErrors = z.object({ errors: z.array(z.object({ message: z.string() })).optional() });
export const pullRequestList = z.array(z.object({ number: z.number().int().positive() }));
export const gitRef = z.object({ object: z.object({ sha: z.string() }) });
export const checkRun = z.object({
  name: z.string().min(1),
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z.object({ id: z.number().int() }).nullable(),
});
export const checkRuns = z.object({ total_count: z.number().int(), check_runs: z.array(checkRun) });
export const commitStatus = z.object({
  state: z.enum(["error", "failure", "pending", "success"]),
  total_count: z.number().int().nonnegative(),
  statuses: z.array(z.object({ context: z.string().min(1), state: z.enum(["error", "failure", "pending", "success"]) })),
});
export const protection = z.object({
  contexts: z.array(z.string()).optional(),
  checks: z.array(z.object({ context: z.string(), app_id: z.number().int().nullable() })).optional(),
});
export const branchRules = z.array(z.object({ type: z.string(), parameters: z.unknown().optional() }).passthrough());
export const requiredRule = z.object({
  required_status_checks: z.array(z.object({ context: z.string().min(1), integration_id: z.number().int().nullable().optional() })),
});
export const mergeResponse = z.object({ sha: z.string(), merged: z.boolean(), message: z.string() });
export const repositoryConfig = z.object({
  mergeMethod: z.enum(["merge", "squash", "rebase"]),
  /** Absent is `human` (TECH-5244): Sergeant approves and merges only where `sergeant` is set. */
  mergePolicy: MergePolicy.default("human"),
  observedChecksFallback: z.boolean().default(false),
});
