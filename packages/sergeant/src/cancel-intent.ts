import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClosedPullRequest, RunId } from "@terros/sergeant-contracts";
import { z } from "zod";

// A task's recorded stop (cancel.ts): `cancel.json` in the task's directory, written before anything
// changes and removed only once the stop is done. Its end, with the PRs it closed, is kept after it as
// `stopped.json`, so `sgt task show` still lists them (TECH-5006).

const CancelIntent = z.object({
  /** Why the task stopped, as the end of a sentence: "the issue was moved to Backlog". */
  reason: z.string(),
  requestId: z.string(),
  at: z.iso.datetime(),
  /** The task's runs when the stop was first driven: set once, before any is canceled. */
  runIds: z.array(RunId).optional(),
  /** Those of `runIds` whose start the runner never confirmed (loop.ts), set with them; one leaves once its status reads. */
  unconfirmedStarts: z.array(RunId).optional(),
  /**
   * A handoff (TECH-5179): PRs and branches are kept and the issue goes back to Todo, undelegated.
   * `delegatedAt` is when the stopped task's owner delegated it, so a newer delegation is left alone;
   * `merged`, a task whose work already merged: only its audit stops, and the issue is left as it is.
   */
  handoff: z.object({ delegatedAt: z.string().optional(), merged: z.boolean().optional() }).optional(),
  /** The PRs this stop closed, for the issue comment and the API's answer. */
  closed: z.array(ClosedPullRequest).default([]),
  /** Completed GitHub close effects, keyed per PR and exact head so a re-drive skips them. */
  prCloseKeys: z.array(z.string()).default([]),
  /**
   * Whether the durable, idempotent warning about a stalled stop was posted. Despite its name it is
   * about cancels the runner never confirmed, not unreadable statuses; renaming it would change the record.
   */
  unreadableStatusSurfaced: z.boolean().default(false),
  /** When each canceled run's status was first read unreadable: its grace counts from then, not from `at`. */
  unreadableSince: z.record(z.string(), z.iso.datetime()).default({}),
});
export type CancelIntent = z.infer<typeof CancelIntent>;

export const intentFile = (dir: string) => join(dir, "cancel.json");

export async function readIntent(dir: string): Promise<CancelIntent | undefined> {
  const raw = await readFile(intentFile(dir), "utf8").catch(() => undefined);
  return raw === undefined ? undefined : CancelIntent.parse(JSON.parse(raw));
}

export async function writeIntent(dir: string, intent: z.input<typeof CancelIntent>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(intentFile(dir), JSON.stringify(intent, null, 2));
}

/** The task's last finished stop: kept once `cancel.json` is removed, replaced by the next one. */
const StopRecord = z.object({
  reason: z.string(),
  /** When the stop was recorded. */
  at: z.iso.datetime(),
  closed: z.array(ClosedPullRequest),
});
export type StopRecord = z.infer<typeof StopRecord>;

const stopRecordFile = (dir: string) => join(dir, "stopped.json");

export async function readStopRecord(dir: string): Promise<StopRecord | undefined> {
  const raw = await readFile(stopRecordFile(dir), "utf8").catch(() => undefined);
  return raw === undefined ? undefined : StopRecord.parse(JSON.parse(raw));
}

export const writeStopRecord = (dir: string, record: StopRecord) => writeFile(stopRecordFile(dir), JSON.stringify(record, null, 2));

/** A handoff's record of the stopped owner's delegation (TECH-5179). */
export type Handoff = NonNullable<CancelIntent["handoff"]>;
