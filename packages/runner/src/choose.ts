import type { QuotaReading } from "@terros/sergeant-contracts";
import type { Adapter } from "./agents.ts";

// Which of the task owner's model accounts runs a worker or reviewer, from live quota (TECH-5179, after
// TECH-5117). Deterministic: no model is asked.

/** An account whose 5-hour window has less than this percent left is used only when no other is usable. */
export const FIVE_HOUR_FLOOR_PERCENT = 20;

/** One of the owner's accounts and what was read of its quota; no reading when there is no reader. */
export type Candidate<A> = { account: A; adapter: Adapter; name: string; quota: QuotaReading | undefined };
/** The account chosen, why, and whether it is below the 5-hour floor (the owner is warned). */
export type AccountChoice<A> = Candidate<A> & { reason: string; low: boolean };

const known = <A>(c: Candidate<A>) => c.quota?.weekly !== undefined && c.quota.fiveHour !== undefined;
const weeklyLeft = <A>(c: Candidate<A>) => c.quota?.weekly?.remainingPercent ?? 0;
const fiveHourLeft = <A>(c: Candidate<A>) => c.quota?.fiveHour?.remainingPercent ?? 0;
/** Known to have nothing left in one of its windows. */
export const spent = <A>(c: Candidate<A>) => known(c) && (weeklyLeft(c) <= 0 || fiveHourLeft(c) <= 0);
const ready = <A>(c: Candidate<A>) => known(c) && !spent(c) && fiveHourLeft(c) >= FIVE_HOUR_FLOOR_PERCENT;
const low = <A>(c: Candidate<A>) => known(c) && !spent(c) && fiveHourLeft(c) < FIVE_HOUR_FLOOR_PERCENT;
// Readings are compared exact; only the recorded reason rounds them.
const shown = (w: { remainingPercent: number } | undefined) => (w ? Math.round(w.remainingPercent * 10) / 10 : "?");
export const percent = <A>(c: Candidate<A>) => `${shown(c.quota?.weekly)}% weekly, ${shown(c.quota?.fiveHour)}% 5-hour left`;

/**
 * The account for one run: among the accounts whose 5-hour window is at the floor or above, the one
 * with the most weekly capacity left; with none, the one below the floor with the most weekly left,
 * flagged `low`; with none of those, one whose quota could not be read, the `prefer`red provider's
 * first. A reviewer passes its worker's provider as `avoid`, so review comes from a different AI
 * whenever an account of another provider is as good a choice. Undefined when every account is spent.
 */
export function chooseAccount<A>(candidates: Candidate<A>[], opts: { prefer: Adapter; avoid?: Adapter | undefined }): AccountChoice<A> | undefined {
  const best = (tier: Candidate<A>[], order: (a: Candidate<A>, b: Candidate<A>) => number) => {
    const other = tier.filter((c) => c.adapter !== opts.avoid);
    return (other.length > 0 ? other : tier).toSorted(order)[0];
  };
  const byWeeklyLeft = (a: Candidate<A>, b: Candidate<A>) => weeklyLeft(b) - weeklyLeft(a);
  const usable = candidates.filter(ready);
  const chosen = best(usable, byWeeklyLeft);
  if (chosen) return { ...chosen, low: false, reason: `${chosen.name}, ${percent(chosen)}: the most weekly left of ${usable.length} usable` };
  const thin = best(candidates.filter(low), byWeeklyLeft);
  if (thin) return { ...thin, low: true, reason: `${thin.name}, ${percent(thin)}: no account at the ${FIVE_HOUR_FLOOR_PERCENT}% 5-hour floor, so the most weekly left below it` };
  const preferred = (c: Candidate<A>) => (c.adapter === opts.prefer ? 0 : 1);
  const unread = best(candidates.filter((c) => !known(c)), (a, b) => preferred(a) - preferred(b));
  if (unread) return { ...unread, low: false, reason: `${unread.name}, quota unknown (${unread.quota?.error ?? "not read"}): no account known usable` };
  return undefined;
}
