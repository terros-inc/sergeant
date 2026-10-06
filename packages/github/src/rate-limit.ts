import { GitHubRateLimitedError, type GitHubRateLimit } from "@terros/sergeant-contracts";

// GitHub's API rate limits (TECH-5336). Every response's `x-ratelimit-*` headers are recorded, for
// `sgt admin status`. A refusal for a limit pauses every GitHub call of this installation: until
// `x-ratelimit-reset` for the primary (hourly) limit, for `retry-after` for a secondary one, and for a
// minute when GitHub gives neither, as its documentation asks. A call made while paused throws at
// once, never reaching GitHub, and the pause is logged once, when it starts.

const SECONDARY_DEFAULT_MS = 60_000;

const int = (value: string | null) => (value === null || !/^\d+$/.test(value) ? null : Number(value));

export function rateLimiter(log: (line: string) => void, now: () => number = Date.now) {
  let budget: Omit<GitHubRateLimit, "pausedUntil"> | null = null;
  let pausedUntil = 0;
  const iso = (ms: number) => new Date(ms).toISOString();

  return {
    /** Throws, without a call, while a rate limit is waited out. */
    check(): void {
      if (now() < pausedUntil) throw new GitHubRateLimitedError(iso(pausedUntil));
    },

    /** Records the budget `res` reports; when it is a rate-limit refusal, pauses every call and throws. */
    async observe(res: Response): Promise<void> {
      const header = (name: string) => res.headers.get(name);
      const remaining = int(header("x-ratelimit-remaining"));
      const reset = int(header("x-ratelimit-reset"));
      // GraphQL and search have budgets of their own; the one REST reads spend is `core`.
      if (remaining !== null && (header("x-ratelimit-resource") ?? "core") === "core") {
        budget = { limit: int(header("x-ratelimit-limit")), remaining, resetAt: reset === null ? null : iso(reset * 1000), observedAt: iso(now()) };
      }
      if (res.status !== 403 && res.status !== 429) return;
      const retryAfter = int(header("retry-after"));
      let until: number;
      let kind: string;
      if (remaining === 0 && reset !== null) [until, kind] = [reset * 1000, "primary"];
      else if (retryAfter !== null) [until, kind] = [now() + retryAfter * 1000, "secondary"];
      else if (res.status === 429 || /rate limit/i.test(await message(res))) [until, kind] = [now() + SECONDARY_DEFAULT_MS, "secondary"];
      else return;
      // A reset already past by this host's clock still pauses briefly, so a skewed clock cannot spin.
      until = Math.max(until, now() + 1000);
      const started = now() >= pausedUntil;
      if (until > pausedUntil) pausedUntil = until;
      const error = new GitHubRateLimitedError(iso(pausedUntil), `GitHub API ${kind} rate limit: no GitHub calls until ${iso(pausedUntil)}`);
      if (started) log(`${error.message} (HTTP ${res.status}${budget?.limit ? `, ${budget.limit} calls an hour` : ""})`);
      throw error;
    },

    status(): GitHubRateLimit | null {
      const paused = now() < pausedUntil ? iso(pausedUntil) : null;
      if (!budget && !paused) return null;
      return { limit: null, remaining: null, resetAt: null, observedAt: null, ...budget, pausedUntil: paused };
    },
  };
}

/** GitHub's `message`, read from a copy so the caller can still read the body. */
const message = async (res: Response) => {
  const body = (await res.clone().json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? body.message : "";
};
