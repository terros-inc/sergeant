import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Holds `<stateDir>/service.lock` until released or this process exits, refusing while another
 * process, or another service in this one, holds it. The exclusion is SQLite's exclusive lock, an
 * OS file lock, so a dead holder's is released with the process and there is no stale lock to take
 * over. The file is never removed: a remover could unlink it under a starter that just opened it,
 * and the next starter would lock a fresh file beside it. `service.pid` only names the holder.
 */
export async function lockStateDir(stateDir: string): Promise<() => Promise<void>> {
  await mkdir(stateDir, { recursive: true });
  const db = new DatabaseSync(join(stateDir, "service.lock"), { timeout: 0 });
  try {
    db.exec("BEGIN EXCLUSIVE");
  } catch (e) {
    db.close();
    const holder = (await readFile(join(stateDir, "service.pid"), "utf8").catch(() => "")).trim();
    throw new Error(`a Sergeant service${holder && ` (pid ${holder})`} already serves ${stateDir}: ${(e as Error).message}`);
  }
  await writeFile(join(stateDir, "service.pid"), `${process.pid}\n`);
  return async () => db.close();
}
