import { createHash } from "node:crypto";
import type { QuotaReading } from "@terros/sergeant-contracts";
import { z } from "zod";
import type { Adapter } from "./agents.ts";

// Live quota for each model account (TECH-5117, TECH-5113): the weekly and 5-hour windows Claude
// Code's `/usage` and Codex's usage endpoint show. A read never throws and never waits long: a failure
// is an unknown reading, and the chooser then passes the account over or keeps the configured provider.

/** A model account to read: its id, the agent CLI it serves, and its credential. */
export type QuotaAccount = { id: string; adapter: Adapter; credential: string };
export type ReadQuota = (account: QuotaAccount) => Promise<QuotaReading>;

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
const failure = (error: unknown) =>
  error instanceof Unreadable
    ? error.message
    : error instanceof Error
      ? error.name === "TimeoutError"
        ? "timed out"
        : `unreadable (${error.name})`
      : "unreadable";

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
  fetch?: typeof globalThis.fetch;
  now?: () => number;
};

/** Reads each account's quota with its own credential, cached for `QUOTA_CACHE_MS`. */
export function accountQuota(opts: QuotaOptions = {}): ReadQuota {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const get = (url: string, init: RequestInit = {}) => fetchFn(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS), ...init });

  async function claude(token: string): Promise<Omit<QuotaReading, "adapter" | "readAt">> {
    const auth = { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" };
    let usageFailure: string;
    try {
      const usage = await get("https://api.anthropic.com/api/oauth/usage", { headers: auth });
      if (usage.ok) {
        const body = ClaudeUsage.parse(await usage.json());
        const read = windows(claudeWindow(body.seven_day), claudeWindow(body.five_hour));
        if (!("error" in read)) return { source: "usage-endpoint", ...read };
        usageFailure = `usage endpoint ${read.error}`;
      } else {
        usageFailure = `usage endpoint answered ${usage.status}`;
      }
    } catch (error) {
      usageFailure = `usage endpoint ${failure(error)}`;
    }

    try {
      const probe = await get("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { ...auth, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 1, messages: [{ role: "user", content: "." }] }),
      });
      await probe.body?.cancel().catch(() => undefined);
      const read = windows(headerWindow(probe.headers, "7d"), headerWindow(probe.headers, "5h"));
      return "error" in read ? { error: `${usageFailure}; header fallback answered ${probe.status} without limits` } : { source: "header-fallback", ...read };
    } catch (error) {
      return { error: `${usageFailure}; header fallback ${failure(error)}` };
    }
  }

  async function codex(credential: string): Promise<Omit<QuotaReading, "adapter" | "readAt">> {
    if (!credential.startsWith("{")) return { error: "an OpenAI API key has no subscription quota" };
    const { tokens } = CodexAuth.parse(JSON.parse(credential));
    const res = await get("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${tokens.access_token}`, ...(tokens.account_id && { "ChatGPT-Account-Id": tokens.account_id }) },
    });
    if (!res.ok) throw new Unreadable(`usage endpoint answered ${res.status}`);
    const limits = CodexUsage.parse(await res.json()).rate_limit;
    const all = [limits?.primary_window, limits?.secondary_window].flatMap((w) => (w ? [w] : []));
    const window = (w: (typeof all)[number] | undefined): Window | undefined => w && { remainingPercent: left(w.used_percent), ...unixTime(w.reset_at) };
    return windows(window(all.find((w) => w.limit_window_seconds > 86_400)), window(all.find((w) => w.limit_window_seconds <= 86_400)));
  }

  // Keyed by the credential, so a replaced one is read afresh; the key is a hash, never the credential.
  const cache = new Map<string, { at: number; reading: Promise<QuotaReading> }>();
  return ({ id, adapter, credential }) => {
    const key = `${id}:${createHash("sha256").update(credential).digest("hex")}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < QUOTA_CACHE_MS) return hit.reading;
    const readAt = new Date(now()).toISOString();
    // A JSON or schema error can quote what it read, credential included, so only its kind is kept.
    const reading = (adapter === "codex-local" ? codex(credential) : claude(credential)).then(
      (r) => ({ adapter, account: id, readAt, ...r }),
      (e: unknown) => ({
        adapter,
        account: id,
        readAt,
        error: failure(e),
      }),
    );
    cache.set(key, { at: now(), reading });
    return reading;
  };
}

function windows(weekly: Window | undefined, fiveHour: Window | undefined) {
  return weekly && fiveHour ? { weekly, fiveHour } : { ...(weekly && { weekly }), ...(fiveHour && { fiveHour }), error: "a quota window is missing" };
}
