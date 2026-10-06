import { setTimeout as sleep } from "node:timers/promises";

/**
 * A human's request that a task take a turn now (`sgt task wake`, 11 §2). It ends the loop's current
 * wait, and the next poll takes a turn even if nothing changed. It skips no hold: running work, an open
 * question, and an exhausted budget still apply. Only in memory: lost on a restart.
 */
export class Wake {
  /** A turn is owed; cleared when the loop takes one. */
  pending = false;
  /**
   * What the loop last read, as `watchKey` spells it: its Linear issue's id and its PRs and their
   * heads. A webhook naming one ends the loop's wait (`interrupt`) without owing a turn.
   */
  watched: string[] = [];
  /** A GitHub webhook named what it watches since the loop last read its PRs (TECH-5336). */
  github = false;
  #interrupt = new AbortController();
  #lastNudge = 0;
  #trailing: NodeJS.Timeout | undefined;

  request(): void {
    this.pending = true;
    this.interrupt();
  }

  /** Ends the current wait, or the next one if the loop is not waiting. */
  interrupt(): void {
    this.#interrupt.abort();
  }

  /**
   * A webhook's wake: ends the wait at most once per `gapMs`. Another in that window marks it to end
   * once more when the window closes, so a burst or a replayed delivery costs at most one reread per
   * window, and an event that arrives right after another is still seen without waiting for a poll.
   */
  nudge(gapMs: number): void {
    if (this.#trailing) return;
    const fire = () => {
      this.#trailing = undefined;
      this.#lastNudge = Date.now();
      this.interrupt();
    };
    const wait = this.#lastNudge + gapMs - Date.now();
    if (wait <= 0) fire();
    else this.#trailing = setTimeout(fire, wait).unref();
  }

  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    const interrupt = this.#interrupt;
    await pause(ms, signal ? AbortSignal.any([signal, interrupt.signal]) : interrupt.signal);
    if (interrupt.signal.aborted) this.#interrupt = new AbortController();
  }
}

/** Sleeps, cut short when `signal` aborts. */
export const pause = (ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => {});
