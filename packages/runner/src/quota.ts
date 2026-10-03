import type { QuotaReading } from "@terros/sergeant-contracts";
import { z } from "zod";
import type { Adapter } from "./agents.ts";

// Live quota for each provider's installation credential (TECH-5117): the weekly and 5-hour windows
// Claude Code's `/usage` and Codex's usage endpoint show. A read never throws and never waits long: a
// failure is an unknown reading, and the chooser then keeps the configured provider.

export type ReadQuota = (adapter: Adapter) => Promise<QuotaReading>;

const READ_TIMEOUT_MS = 5_000;
/** A burst of launches shares one reading. */
export const QUOTA_CACHE_MS = 5 * 60_000;

/** A failure whose message is safe to record: a status, never a response body or a credential. */
class Unreadable extends Error {}

type Window = NonNullable<QuotaReading["weekly"]>;
// Exact, not rounded: 80.4% used is 19.6% left, below the floor. Only float noise is dropped, so a
// header's 0.57 reads as 43% left rather than 43.00000000000001%.
const left = (usedPercent: number) => Math.max(0, Math.min(100, Number((100 - usedPercent).toFixed(6))));
const unixTime = (seconds: number | null | undefined) => (seconds ? { resetsAt: new Date(seconds * 1000).toISOString() } : {});

/** `GET /api/oauth/usage`, what Claude Code's `/usage` reads: percent used per window, with its reset. */
const ClaudeWindow = z.object({ utilization: z.number(), resets_at: z.string().nullish() }).nullish();
const ClaudeUsage = z.object({ five_hour: ClaudeWindow, seven_day: ClaudeWindow });
const claudeWindow = (w: z.infer<typeof ClaudeWindow>): Window | undefined =>
  w ? { remainingPercent: left(w.utilization), ...(w.resets_at && { resetsAt: new Date(w.resets_at).toISOString() }) } : undefined;

/**
 * Claude's subscription limits also come back on every Messages response as the
 * `anthropic-ratelimit-unified-*` headers (utilization as a fraction, reset as Unix seconds). A token
 * that may only run inference (`claude setup-token`) cannot read `/api/oauth/usage`, so its reading
 * comes from a one-token Haiku request instead.
 */
const headerWindow = (headers: Headers, name: "5h" | "7d"): Window | undefined => {
  const utilization = headers.get(`anthropic-ratelimit-unified-${name}-utilization`);
  if (utilization === null || !Number.isFinite(Number(utilization))) return undefined;
  return { remainingPercent: left(Number(utilization) * 100), ...unixTime(Number(headers.get(`anthropic-ratelimit-unified-${name}-reset`))) };
};

/** `GET /backend-api/wham/usage`, what Codex reads for its own limits: two windows, told apart by length. */
const CodexWindow = z
  .object({ used_percent: z.number(), limit_window_seconds: z.number(), reset_at: z.number().nullish() })
  .nullish();
const CodexUsage = z.object({ rate_limit: z.object({ primary_window: CodexWindow, secondary_window: CodexWindow }).nullish() });
const CodexAuth = z.object({ tokens: z.object({ access_token: z.string(), account_id: z.string().nullish() }) });

export type QuotaOptions = {
  claudeOAuthToken: string;
  codexCredential: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

/** Reads each provider's quota with the installation's own credential, cached for `QUOTA_CACHE_MS`. */
export function providerQuota(opts: QuotaOptions): ReadQuota {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const get = (url: string, init: RequestInit = {}) => fetchFn(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), ...init });

  async function claude(): Promise<Omit<QuotaReading, "adapter" | "readAt">> {
    const auth = { Authorization: `Bearer ${opts.claudeOAuthToken}`, "anthropic-beta": "oauth-2025-04-20" };
    // One limit for the whole read, the header fallback included.
    const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
    const usage = await get("https://api.anthropic.com/api/oauth/usage", { headers: auth, signal });
    if (usage.ok) {
      const body = ClaudeUsage.parse(await usage.json());
      return windows(claudeWindow(body.seven_day), claudeWindow(body.five_hour));
    }
    if (usage.status !== 401 && usage.status !== 403) throw new Unreadable(`usage endpoint answered ${usage.status}`);
    const probe = await get("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: { ...auth, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "." }] }),
    });
    await probe.body?.cancel();
    const read = windows(headerWindow(probe.headers, "7d"), headerWindow(probe.headers, "5h"));
    return "error" in read ? { error: `usage endpoint answered ${usage.status}; messages answered ${probe.status} without limits` } : read;
  }

  async function codex(): Promise<Omit<QuotaReading, "adapter" | "readAt">> {
    if (!opts.codexCredential.startsWith("{")) return { error: "an OpenAI API key has no subscription quota" };
    const { tokens } = CodexAuth.parse(JSON.parse(opts.codexCredential));
    const res = await get("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${tokens.access_token}`, ...(tokens.account_id && { "ChatGPT-Account-Id": tokens.account_id }) },
    });
    if (!res.ok) throw new Unreadable(`usage endpoint answered ${res.status}`);
    const limits = CodexUsage.parse(await res.json()).rate_limit;
    const all = [limits?.primary_window, limits?.secondary_window].flatMap((w) => (w ? [w] : []));
    const window = (w: (typeof all)[number] | undefined): Window | undefined => w && { remainingPercent: left(w.used_percent), ...unixTime(w.reset_at) };
    return windows(window(all.find((w) => w.limit_window_seconds > 86_400)), window(all.find((w) => w.limit_window_seconds <= 86_400)));
  }

  const cache = new Map<Adapter, { at: number; reading: Promise<QuotaReading> }>();
  return (adapter) => {
    const hit = cache.get(adapter);
    if (hit && now() - hit.at < QUOTA_CACHE_MS) return hit.reading;
    const readAt = new Date(now()).toISOString();
    // A JSON or schema error can quote what it read, credential included, so only its kind is kept.
    const reading = (adapter === "codex-local" ? codex() : claude()).then(
      (r) => ({ adapter, readAt, ...r }),
      (e: Error) => ({
        adapter,
        readAt,
        error: e instanceof Unreadable ? e.message : e.name === "TimeoutError" ? "timed out" : `unreadable (${e.name})`,
      }),
    );
    cache.set(adapter, { at: now(), reading });
    return reading;
  };
}

function windows(weekly: Window | undefined, fiveHour: Window | undefined) {
  return weekly && fiveHour ? { weekly, fiveHour } : { ...(weekly && { weekly }), ...(fiveHour && { fiveHour }), error: "a quota window is missing" };
}
