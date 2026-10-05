import { lstat, readdir, rm, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runFiles } from "./run-files.ts";

// TECH-5229: a run's `workspace/` (its clones, with dependencies installed) is read only until its
// terminal `record.json` is written: the report is copied out to `report.md` first, and from then on
// `status`, `cancel`, `report`, and a reviewer's earlier reports read the record and `report.md`, never the
// workspace. A continuing worker or a re-review clones afresh from GitHub. So an ended run's workspace
// is removed as it ends (runner.ts `finish`), and this sweep removes any an older serve, or a crash
// between the record and the removal, left behind. A run without a terminal record is never touched.

/** Removes the workspace of every run under `rootDir` with a terminal record; `run.json`, the record, and the report stay. */
export async function pruneWorkspaces(rootDir: string): Promise<{ pruned: number; failed: string[] }> {
  const { paths, readRecord } = runFiles(resolve(rootDir));
  let pruned = 0;
  const failed: string[] = [];
  for (const runId of await readdir(rootDir).catch(() => [])) {
    const record = await readRecord(runId).catch(() => undefined);
    if (!record || record.status === "running") continue;
    const { workspace } = paths(runId);
    if (!(await lstat(workspace).then(() => true, () => false))) continue;
    try {
      await rm(workspace, { recursive: true, force: true });
      pruned++;
    } catch (e) {
      failed.push(`${runId}: ${(e as Error).message}`);
    }
  }
  return { pruned, failed };
}

/** The run directories under `rootDir`, the space they take on disk, and the space left on their volume. */
export async function runsUsage(rootDir: string) {
  const [runs, volume] = await Promise.all([readdir(rootDir), statfs(rootDir)]);
  return { count: runs.length, bytes: await diskUsage(rootDir), volumeFreeBytes: volume.bavail * volume.bsize, volumeBytes: volume.blocks * volume.bsize };
}

/** Allocated bytes below `path`, as `du` counts them; an entry removed while it is read counts as nothing. */
async function diskUsage(path: string): Promise<number> {
  const st = await lstat(path).catch(() => undefined);
  if (!st) return 0;
  const own = st.blocks * 512;
  if (!st.isDirectory()) return own;
  const sizes = await Promise.all((await readdir(path).catch(() => [])).map((name) => diskUsage(join(path, name))));
  return sizes.reduce((sum, n) => sum + n, own);
}
