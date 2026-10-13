import { AsyncLocalStorage } from "node:async_hooks";
import type { ApiCallCount } from "@terros/sergeant-contracts";

// TECH-5942: GitHub and Linear API calls counted per clock hour by what made them, so an operator sees
// which part of Sergeant spends the rate limits (`sgt admin status`, and one log line per provider for
// each finished hour). The source is whatever the innermost `withSource` around the call named; a call
// outside one is `other`. Only in memory: a restart starts counting afresh.

const source = new AsyncLocalStorage<string>();

/** Runs `step` with its GitHub and Linear calls counted as `name`'s. */
export const withSource = <T>(name: string, step: () => T): T => source.run(name, step);

type Provider = ApiCallCount["provider"];

export function apiCalls(log: (line: string) => void, now: () => number = Date.now) {
  // Two clock hours at most: the current one and the one before it.
  let hours: { hour: number; counts: Map<string, ApiCallCount> }[] = [];

  const record = (provider: Provider, notModified: boolean) => {
    const hour = Math.floor(now() / 3_600_000) * 3_600_000;
    let current = hours.at(-1);
    if (current?.hour !== hour) {
      if (current) summarize(current.counts);
      current = { hour, counts: new Map() };
      hours = [...hours.filter((h) => h.hour === hour - 3_600_000), current];
    }
    const from = source.getStore() ?? "other";
    const key = `${provider} ${from}`;
    const count = current.counts.get(key) ?? { hour: new Date(hour).toISOString(), provider, source: from, calls: 0, notModified: 0 };
    count.calls++;
    if (notModified) count.notModified++;
    current.counts.set(key, count);
  };

  const summarize = (counts: Map<string, ApiCallCount>) => {
    for (const provider of ["github", "linear"] as const) {
      const of = sorted([...counts.values()].filter((c) => c.provider === provider));
      if (of.length === 0) continue;
      const total = of.reduce((n, c) => n + c.calls, 0);
      log(`api calls ${provider} ${of[0]?.hour}: ${total} (${of.map(describeCount).join(", ")})`);
    }
  };

  return {
    /** `fetch`, with each call to an API host (not an upload) counted for `provider`; a 304 is counted as not modified. */
    counting(provider: Provider, fetchFn: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
      return async (input, init) => {
        const res = await fetchFn(input, init);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(url).hostname.startsWith("api.")) record(provider, res.status === 304);
        return res;
      };
    },
    /** The counts for this clock hour and the one before it, most calls first within each hour. */
    status(): ApiCallCount[] {
      const hour = Math.floor(now() / 3_600_000) * 3_600_000;
      return hours.filter((h) => h.hour >= hour - 3_600_000).flatMap((h) => sorted([...h.counts.values()]));
    },
  };
}

const sorted = (counts: ApiCallCount[]) => counts.sort((a, b) => b.calls - a.calls || a.source.localeCompare(b.source));

/** `feedback sweep 812 (304: 400)`: how many calls, and how many GitHub answered 304, which its rate limit does not count. */
export const describeCount = (c: ApiCallCount) => `${c.source} ${c.calls}${c.notModified ? ` (304: ${c.notModified})` : ""}`;
