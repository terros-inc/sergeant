import type { ApiBudgetAlert, ApiBudgetSample, ApiBudgetWindow, ApiResource, RateLimitEvent } from "@terros/sergeant-contracts";

// TECH-6208: GitHub's and Linear's API budgets over time, as their responses report them, the
// rate-limit refusals that paused Sergeant, and a warning before a budget runs out. Kept with the call
// counts in `<state dir>/api-usage.json` (api-calls.ts), so all of it survives a restart.

type Provider = ApiBudgetSample["provider"];

/** A budget is sampled at most this often: the last response in each slot is the one kept. */
export const SAMPLE_MS = 5 * 60_000;
/** Below this share of its limit before its reset, a budget is warned about, once until that reset. */
export const LOW_BUDGET = 0.15;

export type BudgetState = { samples: ApiBudgetSample[]; windows: ApiBudgetWindow[]; events: RateLimitEvent[]; alerts: ApiBudgetAlert[] };

type Budget = { resource: ApiResource; limit: number; remaining: number; resetMs: number };

const int = (value: string | null) => (value === null || !/^\d+$/.test(value) ? null : Number(value));
const iso = (ms: number) => new Date(ms).toISOString();

/**
 * The budgets a response reports: GitHub's `core` or `graphql` one (`x-ratelimit-reset` in epoch
 * seconds; search and other resources are not kept), or Linear's `requests` and `complexity` ones
 * (`x-ratelimit-<budget>-reset` in epoch ms).
 */
export function budgetsOf(provider: Provider, headers: Headers): Budget[] {
  const read = (prefix: string, resource: ApiResource, resetScale: number): Budget[] => {
    const [limit, remaining, reset] = [int(headers.get(`${prefix}limit`)), int(headers.get(`${prefix}remaining`)), int(headers.get(`${prefix}reset`))];
    return limit === null || remaining === null || reset === null ? [] : [{ resource, limit, remaining, resetMs: reset * resetScale }];
  };
  if (provider === "linear") return [...read("x-ratelimit-requests-", "requests", 1), ...read("x-ratelimit-complexity-", "complexity", 1)];
  const resource = headers.get("x-ratelimit-resource") ?? "core";
  return resource === "core" || resource === "graphql" ? read("x-ratelimit-", resource, 1000) : [];
}

/**
 * Records one response's budgets: a sample, GitHub's window with serve's counted calls in it, and a
 * warning, logged, when a budget is below `LOW_BUDGET` before its reset and none was given for it
 * since its last warned-about reset passed: once per window, not on every call.
 */
export function recordBudgets(state: BudgetState, provider: Provider, status: number, budgets: Budget[], now: number, log: (line: string) => void): void {
  for (const b of budgets) {
    const sample: ApiBudgetSample = { at: iso(now), provider, resource: b.resource, limit: b.limit, remaining: b.remaining, resetAt: iso(b.resetMs) };
    const last = state.samples.findLast((s) => s.provider === provider && s.resource === b.resource);
    if (last && Math.floor(Date.parse(last.at) / SAMPLE_MS) === Math.floor(now / SAMPLE_MS)) state.samples[state.samples.lastIndexOf(last)] = sample;
    else state.samples.push(sample);

    // Linear's resets move with every call, so only GitHub's fixed hourly windows are kept as windows.
    if (provider === "github") {
      const window = state.windows.find((w) => w.resource === b.resource && w.resetAt === sample.resetAt);
      if (!window) {
        state.windows.push({ provider, resource: b.resource, resetAt: sample.resetAt, limit: b.limit, firstAt: sample.at, firstRemaining: b.remaining, lastAt: sample.at, lowestRemaining: b.remaining, counted: 0 });
      } else {
        window.lastAt = sample.at;
        window.lowestRemaining = Math.min(window.lowestRemaining, b.remaining);
        if (status !== 304) window.counted++;
      }
    }

    if (b.remaining >= b.limit * LOW_BUDGET || now >= b.resetMs) continue;
    const warned = state.alerts.findLast((a) => a.provider === provider && a.resource === b.resource);
    if (warned && Date.parse(warned.resetAt) > now) continue;
    state.alerts.push({ at: sample.at, provider, resource: b.resource, limit: b.limit, remaining: b.remaining, resetAt: sample.resetAt });
    const percent = Math.round((100 * b.remaining) / b.limit);
    log(`WARNING: ${provider} ${b.resource} API budget low: ${b.remaining} of ${b.limit} left (${percent}%) until its reset at ${sample.resetAt}`);
  }
}

/**
 * A rate-limit refusal: counted in the provider's open event of the same kind, else it ends any open
 * one and starts its own.
 */
export function recordRefusal(state: BudgetState, provider: Provider, refusal: { kind: RateLimitEvent["kind"]; status: number; until: number }, now: number): void {
  const open = state.events.findLast((e) => e.provider === provider && e.endedAt === null);
  if (open && open.kind === refusal.kind) {
    open.refusals++;
    if (refusal.until > Date.parse(open.until)) open.until = iso(refusal.until);
    return;
  }
  if (open) open.endedAt = iso(now);
  state.events.push({ provider, kind: refusal.kind, status: refusal.status, startedAt: iso(now), until: iso(refusal.until), endedAt: null, refusals: 1, tasks: [] });
}

/**
 * An answer that was no refusal ends the provider's open event, once its pause is over: one answered
 * before then was already in flight when the refusal came.
 */
export function recordAnswer(state: BudgetState, provider: Provider, now: number): void {
  const open = state.events.findLast((e) => e.provider === provider && e.endedAt === null);
  if (open && now >= Date.parse(open.until)) open.endedAt = iso(now);
}

/** A task loop the provider's open rate-limit event paused. */
export function recordPausedTask(state: BudgetState, provider: Provider, issueId: string): void {
  const open = state.events.findLast((e) => e.provider === provider && e.endedAt === null);
  if (open && !open.tasks.includes(issueId)) open.tasks.push(issueId);
}
