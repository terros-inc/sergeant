import type { WebhookHealth } from "@terros/sergeant-contracts";

// TECH-5942: whether each webhook source with a signing secret is delivering. Polling only backs up the
// webhooks, at a slow safety interval whether or not they deliver, so a webhook that stops delivering
// leaves tasks up to that interval behind: it must not go unnoticed. Accepted deliveries are logged at
// most hourly, as a count. Deliveries refused again and again, or none for hours (a secret configured but never
// delivered to included), is said once as a warning in the log and stays in `sgt admin status` until a
// delivery is accepted. Only in memory: a restart starts afresh.

export type WebhookSource = WebhookHealth["source"];

/** An accepted delivery this recent means the source is delivering. */
export const DELIVERING_MS = 30 * 60_000;
/** No accepted delivery for this long, since serve started or the last one, is said once. */
export const SILENT_MS = 6 * 60 * 60_000;
/** This many refusals in a row, with no delivery accepted in between, is said once. */
export const REFUSED_IN_A_ROW = 5;
/** Accepted deliveries are logged, as a count, at most this often. */
const ACCEPTED_LOG_MS = 60 * 60_000;

export type WebhookHealthTracker = ReturnType<typeof webhookHealth>;

export function webhookHealth(secrets: { linear?: string; github?: string }, log: (line: string) => void, now: () => number = Date.now) {
  const startedAt = now();
  const sources = (["linear", "github"] as const).filter((s) => secrets[s]);
  const state = new Map(
    sources.map((s) => [
      s,
      { accepted: 0, lastAcceptedAt: undefined as number | undefined, refused: 0, inARow: 0, lastRefusedAt: undefined as number | undefined, lastRefusal: undefined as string | undefined, alert: undefined as string | undefined, loggedAt: undefined as number | undefined, unlogged: 0 },
    ]),
  );
  const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
  const raise = (source: WebhookSource, alert: string) => {
    const s = state.get(source);
    if (!s || s.alert) return;
    s.alert = alert;
    log(`WARNING: ${source} webhook: ${alert}`);
  };

  return {
    accepted(source: WebhookSource): void {
      const s = state.get(source);
      if (!s) return;
      const at = now();
      s.accepted++;
      s.unlogged++;
      s.inARow = 0;
      s.lastAcceptedAt = at;
      if (s.alert) log(`${source} webhook delivering again: ${s.alert.replace(/\.$/, "")} no longer holds`);
      s.alert = undefined;
      if (s.loggedAt === undefined || at - s.loggedAt >= ACCEPTED_LOG_MS) {
        log(s.loggedAt === undefined ? `${source} webhook: first delivery accepted` : `${source} webhook: ${s.unlogged} deliveries accepted since ${iso(s.loggedAt)}`);
        s.loggedAt = at;
        s.unlogged = 0;
      }
    },
    refused(source: WebhookSource, reason: string): void {
      const s = state.get(source);
      if (!s) return;
      s.refused++;
      s.inARow++;
      s.lastRefusedAt = now();
      s.lastRefusal = reason;
      if (s.inARow >= REFUSED_IN_A_ROW) {
        raise(source, `${s.inARow} deliveries in a row refused (${reason}): if it is a bad signature, the signing secret the sender uses differs from the one serve has.`);
      }
    },
    /** Says once that a source has had no delivery for `SILENT_MS`; serve calls it at each intake. */
    check(): void {
      for (const [source, s] of state) {
        const since = s.lastAcceptedAt ?? startedAt;
        if (now() - since < SILENT_MS) continue;
        const hours = Math.floor((now() - since) / 3_600_000);
        raise(source, s.lastAcceptedAt === undefined ? `no delivery accepted in the ${hours} hours since serve started: check the sender's webhook is active, subscribed to events, and pointed at this host.` : `no delivery accepted for ${hours} hours, since ${iso(s.lastAcceptedAt)}.`);
      }
    },
    /** Whether `source` has a secret and a delivery was accepted within `DELIVERING_MS`. */
    delivering(source: WebhookSource): boolean {
      const at = state.get(source)?.lastAcceptedAt;
      return at !== undefined && now() - at < DELIVERING_MS;
    },
    status(): WebhookHealth[] {
      return [...state].map(([source, s]) => ({
        source,
        accepted: s.accepted,
        lastAcceptedAt: iso(s.lastAcceptedAt),
        refused: s.refused,
        lastRefusedAt: iso(s.lastRefusedAt),
        lastRefusal: s.lastRefusal ?? null,
        delivering: this.delivering(source),
        alert: s.alert ?? null,
      }));
    },
  };
}
