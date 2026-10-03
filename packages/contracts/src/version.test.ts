import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { sergeantVersion } from "./version.ts";

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function repo(commits: number) {
  const dir = mkdtempSync(join(tmpdir(), "sgt-version-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env }).toString().trim();
  git("init", "-q");
  for (let i = 0; i < commits; i++) git("commit", "-q", "--allow-empty", "-m", `c${i}`);
  return { dir, git, sha: () => git("rev-parse", "--short=7", "HEAD") };
}

test("a tag plus N commits counts the commits into the patch number", () => {
  const r = repo(1);
  r.git("tag", "v2.0.0");
  // A non-semver tag after it (like v1-final) must not be picked up.
  r.git("commit", "-q", "--allow-empty", "-m", "x");
  r.git("tag", "v1-final");
  for (let i = 0; i < 36; i++) r.git("commit", "-q", "--allow-empty", "-m", `n${i}`);
  expect(sergeantVersion(r.dir)).toEqual({ version: `2.0.37+${r.sha()}` });
});

test("a commit exactly on a tag is that version, and a newer tag restarts the count", () => {
  const r = repo(3);
  r.git("tag", "v2.0.0");
  expect(sergeantVersion(r.dir)).toEqual({ version: `2.0.0+${r.sha()}` });
  r.git("commit", "-q", "--allow-empty", "-m", "a");
  r.git("tag", "v2.1.0");
  r.git("commit", "-q", "--allow-empty", "-m", "b");
  expect(sergeantVersion(r.dir)).toEqual({ version: `2.1.1+${r.sha()}` });
});

test("without a version tag it falls back to 0.0.0+<sha> and says so", () => {
  const r = repo(2);
  expect(sergeantVersion(r.dir)).toEqual({ version: `0.0.0+${r.sha()}`, fallback: "no vMAJOR.MINOR.PATCH tag" });
  const bare = mkdtempSync(join(tmpdir(), "sgt-nogit-"));
  dirs.push(bare);
  expect(sergeantVersion(bare)).toEqual({ version: "0.0.0+unknown", fallback: expect.stringMatching(/^git cannot read the checkout: fatal: not a git repository/) });
});

test("prerelease and extra-dotted tags are skipped for the nearest real vX.Y.Z", () => {
  const r = repo(1);
  r.git("tag", "v2.0.0");
  r.git("commit", "-q", "--allow-empty", "-m", "a");
  r.git("tag", "v2.1.0-rc.1");
  r.git("commit", "-q", "--allow-empty", "-m", "b");
  r.git("tag", "v2.1.0.1");
  expect(sergeantVersion(r.dir)).toEqual({ version: `2.0.2+${r.sha()}` });
});

test("a checkout owned by another user is trusted, and a refusal is reported as one", () => {
  // serve runs as the sergeant user against the root-owned host checkout; git calls that dubious ownership.
  const r = repo(1);
  r.git("tag", "v2.0.0");
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
  try {
    expect(sergeantVersion(r.dir)).toEqual({ version: `2.0.0+${r.sha()}` });
    expect(sergeantVersion(r.dir, { trust: false })).toEqual({
      version: "0.0.0+unknown",
      fallback: expect.stringMatching(/^git cannot read the checkout: fatal: detected dubious ownership/),
    });
  } finally {
    delete process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER;
  }
});
