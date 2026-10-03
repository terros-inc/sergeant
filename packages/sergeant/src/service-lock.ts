import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Holds the state directory's SQLite exclusive lock until the returned release runs. */
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
