import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, rename, writeFile } from "node:fs/promises";
import { ApiBudgetAlert, ApiBudgetSample, ApiBudgetWindow, ApiCallCount, ApiEndpointCount, API_USAGE_HOURS, LinearRateLimitedError, RateLimitEvent, type ApiUsage } from "@terros/sergeant-contracts";
import { rateLimitRefusal } from "@terros/sergeant-github";
import { linearFailure } from "@terros/sergeant-linear";
import { z } from "zod";
import { budgetsOf, recordAnswer, recordBudgets, recordPausedTask, recordRefusal, type BudgetState } from "./api-budget.ts";
import { endpointOf } from "./api-endpoint.ts";

// TECH-5942: GitHub and Linear API calls counted per clock hour by what made them, so an operator sees
// which part of Sergeant spends the rate limits (`sgt admin status`, and one log line per provider for
// each finished hour). The source is whatever the innermost `withSource` around the call named; a call
// outside one is `other`. TECH-6208: and by endpoint (api-endpoint.ts), with the budgets, rate-limit
// events, and low-budget warnings their responses carry (api-budget.ts), kept for 7 days in
// `<state dir>/api-usage.json` so a restart loses at most the last minute (`sgt admin api`). Losing the
// file loses only this history: an unreadable one is set aside and counting starts afresh.

const source = new AsyncLocalStorage<string>();

/** Runs `step` with its GitHub and Linear calls counted as `name`'s. */
export const withSource = <T>(name: string, step: () => T): T => source.run(name, step);

type Provider = ApiCallCount["provider"];

const HOUR_MS = 3_600_000;
const KEEP_MS = API_USAGE_HOURS * HOUR_MS;
/** Distinct endpoints kept per provider and hour; past them, a call counts under `other`. */
const MAX_ENDPOINTS = 200;

const UsageFile = z.object({
  sources: z.array(ApiCallCount),
  endpoints: z.array(ApiEndpointCount),
  samples: z.array(ApiBudgetSample),
  windows: z.array(ApiBudgetWindow),
  events: z.array(RateLimitEvent),
  alerts: z.array(ApiBudgetAlert),
});

export type ApiCalls = ReturnType<typeof apiCalls>;

/** The tracker; `file`, when given, is where `load` and `save` keep it across restarts. */
export function apiCalls(log: (line: string) => void, now: () => number = Date.now, file?: string) {
  let sources = new Map<string, ApiCallCount>();
  let endpoints = new Map<string, ApiEndpointCount>();
  let budgets: BudgetState = { samples: [], windows: [], events: [], alerts: [] };
  let currentHour: number | undefined;
  let dirty = false;

  const hourOf = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

  const count = <T extends { calls: number; notModified: number }>(map: Map<string, T>, key: string, fresh: () => T, notModified: boolean) => {
    const c = map.get(key) ?? fresh();
    c.calls++;
    if (notModified) c.notModified++;
    map.set(key, c);
  };

  const record = (provider: Provider, url: URL, init: RequestInit | undefined, notModified: boolean) => {
    const hour = hourOf(now());
    if (currentHour !== undefined && currentHour !== hour) summarize(new Date(currentHour).toISOString());
    currentHour = hour;
    const at = new Date(hour).toISOString();
    const from = source.getStore() ?? "other";
    count(sources, `${at} ${provider} ${from}`, () => ({ hour: at, provider, source: from, calls: 0, notModified: 0 }), notModified);
    let endpoint = endpointOf(url, init);
    const full = () => [...endpoints.values()].filter((e) => e.hour === at && e.provider === provider).length >= MAX_ENDPOINTS;
    if (!endpoints.has(`${at} ${provider} ${endpoint}`) && full()) endpoint = "other";
    count(endpoints, `${at} ${provider} ${endpoint}`, () => ({ hour: at, provider, endpoint, calls: 0, notModified: 0 }), notModified);
    dirty = true;
  };

  const summarize = (hour: string) => {
    for (const provider of ["github", "linear"] as const) {
      const of = sorted([...sources.values()].filter((c) => c.hour === hour && c.provider === provider));
      if (of.length === 0) continue;
      const total = of.reduce((n, c) => n + c.calls, 0);
      log(`api calls ${provider} ${hour}: ${total} (${of.map(describeCount).join(", ")})`);
    }
  };

  /** The budgets, refusal, or answer `res` reports, read from a copy so the caller still reads its body. */
  const observe = async (provider: Provider, res: Response) => {
    const at = now();
    recordBudgets(budgets, provider, res.status, budgetsOf(provider, res.headers), at, log);
    let refusal: Parameters<typeof recordRefusal>[2] | undefined;
    if (provider === "github") {
      const refused = await rateLimitRefusal(res, at);
      if (refused) refusal = { ...refused, status: res.status };
    } else if (!res.ok) {
      const failure = linearFailure(res, await res.clone().json().catch(() => undefined), at);
      if (failure instanceof LinearRateLimitedError) refusal = { kind: "linear", status: res.status, until: Date.parse(failure.until) };
    }
    if (refusal) recordRefusal(budgets, provider, refusal, at);
    else recordAnswer(budgets, provider, at);
  };

  const prune = () => {
    const keep = (iso: string) => now() - Date.parse(iso) < KEEP_MS;
    sources = new Map([...sources].filter(([, c]) => keep(c.hour)));
    endpoints = new Map([...endpoints].filter(([, c]) => keep(c.hour)));
    budgets = {
      samples: budgets.samples.filter((s) => keep(s.at)),
      windows: budgets.windows.filter((w) => keep(w.lastAt)),
      events: budgets.events.filter((e) => e.endedAt === null || keep(e.endedAt)),
      alerts: budgets.alerts.filter((a) => keep(a.at)),
    };
  };

  return {
    /** `fetch`, with each call to an API host (not an upload) counted for `provider`; a 304 is counted as not modified. */
    counting(provider: Provider, fetchFn: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
      return async (input, init) => {
        const res = await fetchFn(input, init);
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname.startsWith("api.")) {
          record(provider, url, init, res.status === 304);
          await observe(provider, res).catch((e: Error) => log(`could not record a ${provider} API response's rate limit: ${e.message}`));
        }
        return res;
      };
    },
    /** A task loop that ended on `provider`'s rate limit: named in the rate-limit event that paused it. */
    taskPaused(provider: Provider, issueId: string): void {
      recordPausedTask(budgets, provider, issueId);
      dirty = true;
    },
    /** The counts for this clock hour and the one before it, most calls first within each hour (`sgt admin status`). */
    status(): ApiCallCount[] {
      return this.usage(2).sources;
    },
    /** Everything recorded from the clock hour `hours - 1` before this one on (`sgt admin api`). */
    usage(hours: number): ApiUsage {
      const since = hourOf(now()) - (Math.min(Math.max(hours, 1), API_USAGE_HOURS) - 1) * HOUR_MS;
      const after = (iso: string | null) => iso === null || Date.parse(iso) >= since;
      return {
        since: new Date(since).toISOString(),
        sources: [...sources.values()].filter((c) => after(c.hour)).sort((a, b) => a.hour.localeCompare(b.hour) || b.calls - a.calls || a.source.localeCompare(b.source)),
        endpoints: [...endpoints.values()].filter((c) => after(c.hour)).sort((a, b) => a.hour.localeCompare(b.hour) || b.calls - a.calls || a.endpoint.localeCompare(b.endpoint)),
        samples: budgets.samples.filter((s) => after(s.at)),
        windows: budgets.windows.filter((w) => after(w.lastAt)),
        events: budgets.events.filter((e) => after(e.endedAt)),
        alerts: budgets.alerts.filter((a) => after(a.at)),
      };
    },
    /** Reads the record a previous serve saved; one that is unreadable is set aside, and counting starts afresh. */
    async load(): Promise<void> {
      if (!file) return;
      const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? undefined : Promise.reject(e)));
      if (text === undefined) return;
      let parsed: z.infer<typeof UsageFile>;
      try {
        parsed = UsageFile.parse(JSON.parse(text));
      } catch (e) {
        const aside = `${file}.unreadable-${now()}`;
        await rename(file, aside);
        log(`api-usage.json is unreadable (${(e as Error).message.split("\n")[0]}); moved to ${aside}, and API usage is recorded afresh`);
        return;
      }
      sources = new Map(parsed.sources.map((c) => [`${c.hour} ${c.provider} ${c.source}`, c]));
      endpoints = new Map(parsed.endpoints.map((c) => [`${c.hour} ${c.provider} ${c.endpoint}`, c]));
      budgets = { samples: parsed.samples, windows: parsed.windows, events: parsed.events, alerts: parsed.alerts };
      const latest = Math.max(...parsed.sources.map((c) => Date.parse(c.hour)));
      if (Number.isFinite(latest)) currentHour = latest;
      prune();
    },
    /** Writes the record, whole, if anything changed since the last save. */
    async save(): Promise<void> {
      if (!file || !dirty) return;
      dirty = false;
      prune();
      const tmp = `${file}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify({ sources: [...sources.values()], endpoints: [...endpoints.values()], ...budgets }));
        await rename(tmp, file);
      } catch (e) {
        dirty = true;
        throw e;
      }
    },
  };
}

const sorted = (counts: ApiCallCount[]) => counts.sort((a, b) => b.calls - a.calls || a.source.localeCompare(b.source));

/** `feedback sweep 812 (304: 400)`: how many calls, and how many GitHub answered 304, which its rate limit does not count. */
export const describeCount = (c: ApiCallCount) => `${c.source} ${c.calls}${c.notModified ? ` (304: ${c.notModified})` : ""}`;
