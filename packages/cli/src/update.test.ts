import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { exec, update } from "./update.ts";

// `sgt update` against real git: a clone of a fake origin, with `pnpm install` recorded, not run.

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sgt-update-test-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" }).toString().trim();

async function commit(repo: string, file: string) {
  await writeFile(join(repo, file), file);
  git(repo, "add", file);
  git(repo, "commit", "-qm", file);
}

test("update fast-forwards a clone, shallow or not, to origin's main, installs it, and refuses another branch", async () => {
  const origin = join(dir, "origin");
  git(dir, "init", "-q", "-b", "main", origin);
  await commit(origin, "a");
  git(origin, "tag", "v2.1.0");
  await commit(origin, "b");
  git(dir, "clone", "-q", "--depth", "1", `file://${origin}`, "clone");
  const clone = join(dir, "clone");
  await commit(origin, "c");

  const ran: string[] = [];
  const run: typeof exec = (command, args, cwd) => (command === "pnpm" ? (ran.push(`${command} ${args.join(" ")}`), Promise.resolve("")) : exec(command, args, cwd));

  expect(await update(clone, run)).toMatch(/^2\.1\.2\+[0-9a-f]{7}$/);
  expect(git(clone, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "HEAD"));
  expect(ran).toEqual(["pnpm install --frozen-lockfile"]);

  await commit(origin, "d");
  expect(await update(clone, run)).toMatch(/^2\.1\.3\+/);

  git(clone, "switch", "-qc", "mine");
  await expect(update(clone, run)).rejects.toThrow(/is on mine, not main/);
  expect(ran).toHaveLength(2);
});
