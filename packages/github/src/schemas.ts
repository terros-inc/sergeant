import { z } from "zod";

export const pullRequest = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  user: z.object({ login: z.string().min(1) }),
  body: z.string().nullish(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  merged_at: z.string().nullable(),
  mergeable: z.boolean().nullable(),
  merge_commit_sha: z.string().nullable(),
  head: z.object({ sha: z.string() }),
  base: z.object({ ref: z.string().min(1), sha: z.string() }),
});
/** What a closed PR's branch delete checks (TECH-5230): its head branch, its head repository, and whether it merged. */
export const pullRequestHead = z.object({
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  head: z.object({ ref: z.string().min(1), sha: z.string(), repo: z.object({ full_name: z.string() }).nullable() }),
});
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
  observedChecksFallback: z.boolean().default(false),
});
