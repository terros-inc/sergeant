import type { QuotaReading } from "@terros/sergeant-contracts";
import type { Adapter } from "./agents.ts";

// Which of the task owner's model accounts runs a worker or reviewer, from live quota (TECH-5179, after
// TECH-5117), paced to each window's reset (TECH-5213). Deterministic: no model is asked, and nothing
// is remembered between launches.

const HOUR_MS = 60 * 60_000;
/** Each window's nominal length, from which its time left is a share. */
const WINDOW_MS = { weekly: 7 * 24 * HOUR_MS, fiveHour: 5 * HOUR_MS } as const;
/**
 * About one run's length. A window's time left counts as at least this much of it (20% of the 5-hour
 * window, about 0.6% of the week), so a sliver of quota just before its reset does not look underused
 * and start a run that will outlast it.
 */
const RUN_MS = HOUR_MS;
/** A reviewer takes the other provider than its worker's when that provider's best score is at least this share of the best. */
export const REVIEW_DIVERSITY_SHARE = 0.8;

/** One of the owner's accounts and what was read of its quota; no reading when there is no reader. */
export type Candidate<A> = { account: A; adapter: Adapter; name: string; quota: QuotaReading | undefined };
/** The account chosen, and why. */
export type AccountChoice<A> = Candidate<A> & { reason: string };

/** Known to have nothing left in one of its windows. */
export const spent = <A>(c: Candidate<A>) => (c.quota?.weekly?.remainingPercent ?? 1) <= 0 || (c.quota?.fiveHour?.remainingPercent ?? 1) <= 0;
// Readings are compared exact; only the recorded reason rounds them.
const shown = (w: { remainingPercent: number } | undefined) => (w ? Math.round(w.remainingPercent * 10) / 10 : "?");
/** Its percent left in each window, or in the one window its provider reports, saying so. */
export const percent = <A>(c: Candidate<A>) => {
  const unreported = c.quota?.unreported;
  if (!unreported) return `${shown(c.quota?.weekly)}% weekly, ${shown(c.quota?.fiveHour)}% 5-hour left`;
  const [name, reported] = unreported === "weekly" ? ["5-hour", c.quota?.fiveHour] : ["weekly", c.quota?.weekly];
  return `${shown(reported)}% ${name} (no ${unreported} window reported)`;
};

/**
 * A window's pace: percent left over percent of the window's time left. Above 1 it is ahead of its
 * reset and would expire unused; below 1 it runs out before its reset. Undefined without a reset time.
 */
function pace(window: { remainingPercent: number; resetsAt?: string | undefined } | undefined, length: number, now: number) {
  const resetsAt = window?.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  if (!window || Number.isNaN(resetsAt)) return undefined;
  const timeLeftPercent = (Math.min(length, Math.max(RUN_MS, resetsAt - now)) / length) * 100;
  return window.remainingPercent / timeLeftPercent;
}

/**
 * The tighter of an account's two paces, or the one window's pace when its provider reported only that
 * one (`unreported`, TECH-5342). Undefined (a partial reading) unless every window it should have has a
 * percent and a reset.
 */
export function score<A>(c: Candidate<A>, now: number): number | undefined {
  const weekly = pace(c.quota?.weekly, WINDOW_MS.weekly, now);
  const fiveHour = pace(c.quota?.fiveHour, WINDOW_MS.fiveHour, now);
  if (c.quota?.unreported === "5-hour") return weekly;
  if (c.quota?.unreported === "weekly") return fiveHour;
  return weekly === undefined || fiveHour === undefined ? undefined : Math.min(weekly, fiveHour);
}

/**
 * The account for one run. Among the usable accounts (not spent), the one with the highest `score`,
 * whichever its provider: no provider is preferred (TECH-5390). One whose provider reports a single
 * window is scored on that window alone. One whose reading is partial or unknown is usable (a known
 * zero in either window still spends it) and ranks after every scored one; ties keep the candidates'
 * order. A reviewer passes its worker's provider as `avoid`: it takes the other provider's best account
 * when that scores within `REVIEW_DIVERSITY_SHARE` of the best, or when no account is scored, and
 * otherwise the best overall. Undefined when no account is usable.
 */
export function chooseAccount<A>(
  candidates: Candidate<A>[],
  opts: { avoid?: Adapter | undefined; now?: number | undefined } = {},
): AccountChoice<A> | undefined {
  const now = opts.now ?? Date.now();
  const usable = candidates.filter((c) => !spent(c)).map((c) => ({ ...c, score: score(c, now) }));
  const ranked = usable.toSorted((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const best = ranked[0];
  if (!best) return undefined;
  const other = ranked.find((c) => c.adapter !== opts.avoid);
  const diverse = opts.avoid !== undefined && other !== undefined && (best.score === undefined || (other.score ?? -1) >= best.score * REVIEW_DIVERSITY_SHARE);
  const pick = diverse ? other : best;
  const { score: chosenScore, ...chosen } = pick;
  const unscored = chosen.quota?.error ?? (chosen.quota ? "partial: a window without a reset" : "not read");
  const rank =
    chosenScore === undefined
      ? `quota unknown (${unscored})`
      : `pace ${Math.round(chosenScore * 100) / 100}, ${pick === best ? "the highest" : `within ${Math.round((1 - REVIEW_DIVERSITY_SHARE) * 100)}% of the best for another provider than its worker's`}`;
  return { ...chosen, reason: `${chosen.name}, ${percent(chosen)}: ${rank} of ${usable.length} usable` };
}
