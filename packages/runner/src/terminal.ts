import { link, open, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// TECH-5235: a run ends once. Several callers can see the same exited container at once (the task
// loop's status, a run or task view, a cancel, a post-merge read), and serves overlapping in a deploy
// share the volume. So the caller that ends a run holds `finishing` in its directory, created
// exclusively, until its record is published; every other caller waits for that record and never
// writes its own. A second writer would find the workspace already gone and lose the report.

/** A claim older than this was left by a serve that died while ending the run; ending takes seconds. */
const STALE_CLAIM_MS = 10 * 60_000;
/** How long a caller waits for another's record before the run's status is unknown for now. */
const WAIT_MS = 30_000;

/**
 * Ends a run exactly once: `write` runs only for the caller holding the run's claim and returns the
 * record it published; any other caller gets the record already published, waiting for it a while. A
 * caller that waits in vain throws, and the run is unknown for now, not failed (04 §6).
 */
export async function endOnce<T>(dir: string, read: () => Promise<T | undefined>, write: () => Promise<T>): Promise<T> {
  const claim = join(dir, "finishing");
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    if (await take(claim)) {
      try {
        // The run may have ended since this caller last looked; the record, not the claim, says so.
        return (await read()) ?? (await write());
      } finally {
        await rm(claim, { force: true });
      }
    }
    const done = await read();
    if (done) return done;
    if (Date.now() > deadline) throw new Error(`status of ${basename(dir)} unavailable: another caller is still ending the run`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function take(claim: string): Promise<boolean> {
  try {
    await writeFile(claim, `${process.pid} ${new Date().toISOString()}\n`, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const held = await stat(claim).catch(() => undefined);
  if (held && Date.now() - held.mtimeMs > STALE_CLAIM_MS) await rm(claim, { force: true });
  return false;
}

/**
 * Writes `path` durably and all at once: a reader sees no file or the whole of it. With `once`, a
 * file already there is kept, so even two writers past a broken claim cannot replace a record.
 */
export async function publish(path: string, data: string, once = false): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(tmp, "wx");
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (once) {
      await link(tmp, path).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "EEXIST") throw e;
      });
    } else {
      await rename(tmp, path);
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  const parent = await open(dirname(path), "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}
