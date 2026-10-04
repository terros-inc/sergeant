import type { QuotaReading } from "@terros/sergeant-contracts";
import type { Adapter } from "./agents.ts";

// Which of the task owner's model accounts runs a worker or reviewer, from live quota (TECH-5179, after
// TECH-5117). Deterministic: no model is asked.

/** An account whose 5-hour window has less than this percent left is skipped while another is usable. */
export const FIVE_HOUR_FLOOR_PERCENT = 20;

/** One of the owner's accounts and what was read of its quota; no reading when there is no reader. */
export type Candidate<A> = { account: A; adapter: Adapter; name: string; quota: QuotaReading | undefined };
/** The account chosen, and why. */
export type AccountChoice<A> = Candidate<A> & { reason: string };

/** Known to have nothing left in one of its windows. */
export const spent = <A>(c: Candidate<A>) => (c.quota?.weekly?.remainingPercent ?? 1) <= 0 || (c.quota?.fiveHour?.remainingPercent ?? 1) <= 0;
/** Both windows read: only then does an account's quota rank (TECH-5179); a partial reading ranks after. */
const known = <A>(c: Candidate<A>) => c.quota?.weekly !== undefined && c.quota.fiveHour !== undefined;
const belowFloor = <A>(c: Candidate<A>) => (c.quota?.fiveHour?.remainingPercent ?? FIVE_HOUR_FLOOR_PERCENT) < FIVE_HOUR_FLOOR_PERCENT;
// Readings are compared exact; only the recorded reason rounds them.
const shown = (w: { remainingPercent: number } | undefined) => (w ? Math.round(w.remainingPercent * 10) / 10 : "?");
export const percent = <A>(c: Candidate<A>) => `${shown(c.quota?.weekly)}% weekly, ${shown(c.quota?.fiveHour)}% 5-hour left`;

/**
 * The account for one run, by one rule: among the usable accounts (not spent), the one with the most
 * weekly capacity left, skipping those whose 5-hour window is under the floor while another usable one
 * exists. An account whose quota could not be read in both windows is usable (a known zero in either
 * still spends it) and ranks after every known one; among
 * those, the `prefer`red provider's comes first. A reviewer passes its worker's provider as `avoid`, so
 * review comes from a different AI whenever the owner has a usable account of another provider.
 * Undefined when no account is usable.
 */
export function chooseAccount<A>(candidates: Candidate<A>[], opts: { prefer: Adapter; avoid?: Adapter | undefined }): AccountChoice<A> | undefined {
  const usable = candidates.filter((c) => !spent(c));
  const roomy = usable.filter((c) => !belowFloor(c));
  const pool = roomy.length > 0 ? roomy : usable;
  const other = pool.filter((c) => c.adapter !== opts.avoid);
  const weekly = (c: Candidate<A>) => (known(c) ? (c.quota?.weekly?.remainingPercent ?? -1) : -1);
  const preferred = (c: Candidate<A>) => (c.adapter === opts.prefer ? 0 : 1);
  const chosen = (other.length > 0 ? other : pool).toSorted((a, b) => weekly(b) - weekly(a) || preferred(a) - preferred(b))[0];
  if (!chosen) return undefined;
  const unread = !known(chosen) ? `, quota unknown (${chosen.quota?.error ?? "not read"})` : "";
  const floor = roomy.length === 0 && belowFloor(chosen) ? `, every usable account under the ${FIVE_HOUR_FLOOR_PERCENT}% 5-hour floor` : "";
  return { ...chosen, reason: `${chosen.name}, ${percent(chosen)}: the most weekly left of ${usable.length} usable${floor}${unread}` };
}
