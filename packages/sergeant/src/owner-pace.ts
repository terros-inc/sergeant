import { pause } from "./wake.ts";

/**
 * TECH-5974: the steady pace of the task loops' delegation-history rereads (poll-checks.ts), and the
 * few that may go at once. Loops poll on the same ~15-minute cadence after a restart, so their rechecks
 * fall due on the same tick whatever their jitter; one shared pacer keeps ~44 of them to a few at once
 * and then one every 10 seconds (about 7 minutes for all), never one burst.
 */
export const OWNER_READ_SPACING_MS = 10_000;
export const OWNER_READ_BURST = 4;

/** Paces the service's ownership rereads, in the order loops ask (a token bucket). Only in memory. */
export class OwnerReadPacer {
  #tat = 0;
  readonly spacingMs: number;
  readonly burst: number;
  readonly wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  constructor(spacingMs = OWNER_READ_SPACING_MS, burst = OWNER_READ_BURST, wait: (ms: number, signal?: AbortSignal) => Promise<void> = pause) {
    this.spacingMs = spacingMs;
    this.burst = burst;
    this.wait = wait;
  }

  /** Waits for this reread's turn: reserved at once, so loops asking together get distinct turns. */
  async turn(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const tat = Math.max(this.#tat, now);
    this.#tat = tat + this.spacingMs;
    await this.wait(Math.max(0, tat - (this.burst - 1) * this.spacingMs - now), signal);
  }
}
