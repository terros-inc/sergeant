import { LinearRateLimitedError } from "@terros/sergeant-contracts";
import { z } from "zod";

// Linear's API rate limits (TECH-5923). Linear refuses a call over its hourly request or complexity
// budget with HTTP 400 and the error code `RATELIMITED`; the refusal names when each budget resets in
// `x-ratelimit-*-reset` headers (epoch ms). A refusal pauses every Linear call of the adapter until the
// exhausted budget resets, so a loop or sweep that keeps calling does not keep the budget spent.

const DEFAULT_PAUSE_MS = 60_000;
const BUDGETS = ["requests", "complexity", "endpoint-requests"] as const;

export const graphqlErrors = z.array(z.object({ message: z.string(), extensions: z.object({ code: z.string().optional() }).optional() }));
const body = z.object({ errors: graphqlErrors.optional() });

const int = (value: string | null) => (value === null || !/^-?\d+$/.test(value) ? null : Number(value));

/**
 * When a `RATELIMITED` refusal's spent budgets reset: the latest reset of those whose remaining is spent
 * (complexity: less than this call cost), else a minute. A reset already past still pauses a second,
 * so a skewed clock cannot spin.
 */
export function rateLimitedUntil(headers: Headers, now: number): number {
  const cost = int(headers.get("x-complexity")) ?? 0;
  const resets = BUDGETS.flatMap((budget) => {
    const remaining = int(headers.get(`x-ratelimit-${budget}-remaining`));
    const reset = int(headers.get(`x-ratelimit-${budget}-reset`));
    const spent = remaining !== null && (budget === "complexity" ? remaining < Math.max(cost, 1) : remaining <= 0);
    return spent && reset !== null ? [reset] : [];
  });
  return Math.max(resets.length > 0 ? Math.max(...resets) : now + DEFAULT_PAUSE_MS, now + 1000);
}

/**
 * The error a Linear response carries, or undefined when it carries none: a `LinearRateLimitedError`
 * for `RATELIMITED`, else Linear's own codes and messages, so a refusal says why (TECH-5923: a bare
 * "(400)" hid the rate limit). `json` is the parsed body, undefined when it was not JSON.
 */
export function linearFailure(res: Response, json: unknown, now: number): Error | undefined {
  const parsed = body.safeParse(json);
  const errors = (parsed.success && parsed.data.errors) || [];
  if (errors.some((e) => e.extensions?.code === "RATELIMITED")) {
    return new LinearRateLimitedError(new Date(rateLimitedUntil(res.headers, now)).toISOString());
  }
  const detail = errors.map((e) => (e.extensions?.code ? `${e.extensions.code}: ${e.message}` : e.message)).join("; ");
  if (!res.ok) return new Error(`Linear API request failed (${res.status}${detail ? `: ${detail}` : ""})`);
  return errors.length > 0 ? new Error(`Linear API error: ${detail}`) : undefined;
}
