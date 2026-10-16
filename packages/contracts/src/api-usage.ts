import { z } from "zod";
import { ApiCallCount } from "./admin.ts";

// `GET /v1/admin/api?hours=N` (TECH-6208): what spent Sergeant's GitHub and Linear API budgets, kept
// across restarts for 7 days in `<state dir>/api-usage.json`, for `sgt admin api` and the MCP `health`
// tool. Only calls `serve` makes are counted: workers and reviewers use the worker App's own
// installation, a budget of its own, and anything else spending the control-plane App's budget shows
// as the `unaccounted` gap of a budget window.

/** How far back `hours` may reach: the record keeps 7 days. */
export const API_USAGE_HOURS = 168;

export const ApiProvider = z.enum(["github", "linear"]);

/** One provider's calls to one endpoint in one clock hour: `GET /repos/{o}/{r}/pulls/{n}/reviews`, or a GraphQL operation (`query SergeantIssue`). */
export const ApiEndpointCount = z.object({
  hour: z.string(),
  provider: ApiProvider,
  endpoint: z.string(),
  calls: z.number().int(),
  /** Of them, answered 304 Not Modified, which GitHub's rate limit does not count. */
  notModified: z.number().int(),
});
export type ApiEndpointCount = z.infer<typeof ApiEndpointCount>;

/** GitHub's `core` and `graphql` budgets, and Linear's `requests` and `complexity`. */
export const ApiResource = z.enum(["core", "graphql", "requests", "complexity"]);
export type ApiResource = z.infer<typeof ApiResource>;

/** A budget as a response's `x-ratelimit-*` headers reported it: the last one in each 5 minutes. */
export const ApiBudgetSample = z.object({
  at: z.string(),
  provider: ApiProvider,
  resource: ApiResource,
  limit: z.number().int(),
  remaining: z.number().int(),
  resetAt: z.string(),
});
export type ApiBudgetSample = z.infer<typeof ApiBudgetSample>;

/**
 * One GitHub budget window (one `x-ratelimit-reset`) as serve saw it: the budget left at its first
 * response and its lowest since, and the calls serve made after that first one that GitHub counts
 * (not 304s). `firstRemaining - lowestRemaining - counted` is what something else spent: the gap.
 */
export const ApiBudgetWindow = z.object({
  provider: ApiProvider,
  resource: ApiResource,
  resetAt: z.string(),
  limit: z.number().int(),
  firstAt: z.string(),
  firstRemaining: z.number().int(),
  lastAt: z.string(),
  lowestRemaining: z.number().int(),
  counted: z.number().int(),
});
export type ApiBudgetWindow = z.infer<typeof ApiBudgetWindow>;

/**
 * A rate-limit refusal and the pause it started: GitHub's `primary` (hourly) or `secondary` limit, or
 * Linear's `RATELIMITED`. Refusals of the same kind before its `until` are counted in it; one after
 * starts a new event. `endedAt`: the provider's first answer after `until` that was not a refusal, or
 * `until` itself when the next call after it was refused again; null while neither came yet. `tasks`:
 * the task loops it paused.
 */
export const RateLimitEvent = z.object({
  provider: ApiProvider,
  kind: z.enum(["primary", "secondary", "linear"]),
  status: z.number().int(),
  startedAt: z.string(),
  until: z.string(),
  endedAt: z.string().nullable(),
  refusals: z.number().int(),
  tasks: z.array(z.string()),
});
export type RateLimitEvent = z.infer<typeof RateLimitEvent>;

/** A budget fell below 15% of its limit before its reset: logged as a warning, once until that reset. */
export const ApiBudgetAlert = z.object({
  at: z.string(),
  provider: ApiProvider,
  resource: ApiResource,
  limit: z.number().int(),
  remaining: z.number().int(),
  resetAt: z.string(),
});
export type ApiBudgetAlert = z.infer<typeof ApiBudgetAlert>;

export const ApiUsage = z.object({
  /** The first hour shown: `hours` before now, or when the record starts if later. */
  since: z.string(),
  sources: z.array(ApiCallCount),
  endpoints: z.array(ApiEndpointCount),
  samples: z.array(ApiBudgetSample),
  windows: z.array(ApiBudgetWindow),
  events: z.array(RateLimitEvent),
  alerts: z.array(ApiBudgetAlert),
});
export type ApiUsage = z.infer<typeof ApiUsage>;
