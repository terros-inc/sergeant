import { driveCancel } from "./cancel.ts";
import type { Ports } from "./execute.ts";
import type { LoopOptions, LoopResult } from "./loop-options.ts";

// The task loop's pass once a stop is recorded for its task (loop.ts): it takes no turn and makes no
// effect, only drives that stop.

/**
 * The task's durable stop (cancel.ts), driven under the task's lock every poll until the runner
 * confirms each run stopped, its open PRs are closed, and the issue is told. Whichever of this loop,
 * `serve`'s intake, or the API drives it to the end, the loop then ends: an issue moved back to Todo
 * meanwhile is a fresh task for intake to start, never this one continued.
 */
export async function driveStop(reason: string, opts: LoopOptions, deps: Ports, log: (line: string) => void): Promise<LoopResult | undefined> {
  // A stop holds no task slot: new work may start while the runner confirms this one's runs.
  if (opts.slot && !opts.slot.released) {
    Object.assign(opts.slot, { released: true, wanted: false, waitingSince: undefined });
    opts.slot.changed();
  }
  const exclusive = deps.exclusive ?? ((step) => step());
  const drive = () => driveCancel(opts.dir, opts.issueId, deps, opts.enrolledRepositories, log);
  const progress = await exclusive(drive).catch((e: Error) => (log(`stopping (${reason}): ${e.message}`), undefined));
  if (progress?.stopping.length !== 0) {
    log(`stopping (${reason}): retrying cancellation`);
    return undefined;
  }
  return { outcome: "stopped", detail: reason };
}
