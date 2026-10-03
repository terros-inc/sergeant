import type { ProviderChoice, QuotaReading } from "@terros/sergeant-contracts";
import type { Adapter } from "./agents.ts";

// Which provider and which of its model accounts run a worker or reviewer, from live quota (TECH-5117,
// TECH-5113). Deterministic: no model is asked. Each provider's candidate is the account
// `chooseAccount` picked for it, so with one account per provider this is TECH-5117's choice unchanged.

/** A provider whose 5-hour window has less than this percent left is not used while another is usable. */
export const FIVE_HOUR_FLOOR_PERCENT = 20;

export type Candidate = { adapter: Adapter; quota: QuotaReading };
export type Choice = ProviderChoice & { adapter: Adapter };

const known = (c: Candidate) => c.quota.weekly !== undefined && c.quota.fiveHour !== undefined;
const usable = (c: Candidate) => known(c) && (c.quota.fiveHour?.remainingPercent ?? 0) >= FIVE_HOUR_FLOOR_PERCENT;
const byWeeklyLeft = (a: Candidate, b: Candidate) => (b.quota.weekly?.remainingPercent ?? 0) - (a.quota.weekly?.remainingPercent ?? 0);
// Readings are compared exact; only the recorded reason rounds them.
const shown = (w: { remainingPercent: number } | undefined) => (w ? Math.round(w.remainingPercent * 10) / 10 : "?");
const percent = (c: Candidate) => `${c.adapter} ${shown(c.quota.weekly)}% weekly, ${shown(c.quota.fiveHour)}% 5-hour left`;

/**
 * The worker gets the provider with the most weekly capacity left, unless its 5-hour window is below
 * the floor; then the next one that is not, or else the next one anyway (the owner's rule flips even
 * when both are below). Any unknown quota keeps the configured provider.
 */
export function chooseWorker(candidates: Candidate[], configured: Adapter): Choice {
  const readings = candidates.map((c) => c.quota);
  const unknown = candidates.filter((c) => !known(c));
  if (unknown.length > 0) {
    return { adapter: configured, reason: `quota unknown for ${unknown.map((c) => c.adapter).join(", ")}; configured ${configured}`, readings };
  }
  const ranked = [...candidates].sort(byWeeklyLeft);
  const best = ranked[0];
  if (!best) return { adapter: configured, reason: `no provider to choose from; configured ${configured}`, readings };
  const chosen = usable(best) ? best : (ranked.find(usable) ?? ranked[1] ?? best);
  const reason =
    chosen === best
      ? `most weekly left: ${percent(chosen)}${usable(chosen) ? "" : `; no other provider`}`
      : `${best.adapter} has the most weekly left but its 5-hour window is below ${FIVE_HOUR_FLOOR_PERCENT}% (${percent(best)}): ${percent(chosen)}${usable(chosen) ? "" : `, also below`}`;
  return { adapter: chosen.adapter, reason, readings };
}

/**
 * The reviewer gets a provider other than its worker's, so review comes from a different AI. When
 * every other one is known to be below the 5-hour floor it runs on the worker's provider; when an
 * other one's quota is unknown, or the worker's provider is, it keeps the configured provider.
 */
export function chooseReviewer(candidates: Candidate[], worker: Adapter | undefined, configured: Adapter): Choice {
  const readings = candidates.map((c) => c.quota);
  const same = (adapter: Adapter) => (worker !== undefined && adapter === worker ? { sameProviderAsWorker: true } : {});
  if (worker === undefined) return { adapter: configured, reason: `worker's provider unknown; configured ${configured}`, readings };
  const others = candidates.filter((c) => c.adapter !== worker);
  const other = others.filter(usable).sort(byWeeklyLeft)[0];
  if (other) return { adapter: other.adapter, reason: `other provider than the worker's ${worker}: ${percent(other)}`, readings };
  const unknown = others.filter((c) => !known(c));
  if (unknown.length > 0 || others.length === 0) {
    const why = unknown.length > 0 ? `quota unknown for ${unknown.map((c) => c.adapter).join(", ")}` : "no other provider";
    return { adapter: configured, reason: `${why}; configured ${configured}`, readings, ...same(configured) };
  }
  return {
    adapter: worker,
    reason: `every other provider's 5-hour window is below ${FIVE_HOUR_FLOOR_PERCENT}%; same provider as the worker`,
    readings,
    sameProviderAsWorker: true,
  };
}

/** An account a run may use: its quota is known, its 5-hour window at the floor or above, and its week not spent. */
export const ready = (c: Candidate) => usable(c) && (c.quota.weekly?.remainingPercent ?? 0) > 0;

/** A model account of one provider, in the owner's order: the owner's own accounts, then people's. */
export type AccountCandidate<A> = Candidate & { account: A; group: "owner" | "registered" };

/**
 * The account a provider runs on (TECH-5113): the owner's own accounts first, then the ones people
 * registered, and within each group the rule above: the most weekly capacity left among accounts
 * whose 5-hour window is at the floor or above, and whose week is not spent. With none usable it is
 * the first owner account, the installation's own, as an unknown reading keeps the configured provider.
 */
export function chooseAccount<A>(candidates: AccountCandidate<A>[]): AccountCandidate<A> & { reason: string } {
  const first = candidates[0];
  if (!first) throw new Error("chooseAccount needs at least one account");
  const name = (c: AccountCandidate<A>) => c.quota.account ?? c.adapter;
  for (const group of ["owner", "registered"] as const) {
    const best = candidates.filter((c) => c.group === group && ready(c)).sort(byWeeklyLeft)[0];
    if (best) return { ...best, reason: `${group === "owner" ? "owner's account" : "registered account"} ${name(best)}, ${percent(best).replace(`${best.adapter} `, "")}${group === "registered" ? "; no owner's account usable" : ""}` };
  }
  return { ...first, reason: `no account usable (unknown, spent, or 5-hour window below ${FIVE_HOUR_FLOOR_PERCENT}%); first owner's account ${name(first)}` };
}
