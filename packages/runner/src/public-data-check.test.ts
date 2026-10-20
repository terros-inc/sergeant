import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// The check every public repository's CI, its pre-push hook, and a Sergeant worker's push run
// (container/check-public-data.mjs, TECH-5914). The denylisted name is synthetic: the real list is
// never committed to a public repository.
const SCRIPT = join(import.meta.dirname, "..", "container", "check-public-data.mjs");
const HOOK = join(import.meta.dirname, "..", "container", "git-template", "hooks", "pre-push");
const NAME = "Zephyr Roofing";
// Joined at run time, so this file itself passes the check it tests.
const COMPANY_ID = ["C", "Qx7Lp2Rk"].join(".");
const USER_ID = ["U", "Tz4Nw8Bv1m"].join(".");
const EMAIL = ["owner", "roofing-co.com"].join("@");
const PHONE = ["415-867", "5309"].join("-");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "public-data-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  const commit = (file: string, text: string, message = "Change") => {
    writeFileSync(join(dir, file), text);
    git("add", file);
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, base: commit("README.md", "# Fixture\n"), commit };
}

function check(dir: string, args: string[], input = "", denylist = NAME) {
  const r = spawnSync("node", [SCRIPT, ...args], { cwd: dir, input, encoding: "utf8", env: { ...process.env, PUBLIC_DATA_DENYLIST: denylist } });
  return { code: r.status, out: r.stderr };
}

test("a commit with a denylisted customer name or a C./U. ID fails, and the name is never printed", () => {
  const r = repo();
  r.commit("fixture.ts", `export const company = "zephyr roofing";\n`);
  const named = check(r.dir, ["range", r.base, "HEAD"]);
  expect(named.code).toBe(1);
  expect(named.out).toMatch(/fixture\.ts:1: denylisted customer name/);
  expect(named.out).not.toMatch(/zephyr/i);

  const c = repo();
  c.commit("ids.test.ts", `const company = "${COMPANY_ID}";\n`, "Add fixture");
  expect(check(c.dir, ["range", c.base, "HEAD"]).out).toMatch(/ids\.test\.ts:1: Terros ID/);
  const u = repo();
  u.commit("notes.md", "Reported by a rep\n", `Fix the sync for ${USER_ID}`);
  expect(check(u.dir, ["range", u.base, "HEAD"]).out).toMatch(/message:1: Terros ID/);
});

test("synthetic placeholders and ordinary code pass", () => {
  const r = repo();
  r.commit(
    "fixture.ts",
    [
      `const company = { id: "C.example", name: "Acme Solar", owner: "U.example1" };`,
      `const rep = { email: "rep@example.test", other: "user@example.com", phone: "(555) 555-0123", e164: "+15555550100" };`,
      `if (role === Role.manager || role === Role.ADMIN || Team.teamId || Program.Status) git.push("git@github.com:org/repo.git");`,
      `const account = Account.findById(id); const c = C.map((x) => x); const u = "U.example-owner";`,
      `const when = "2026-10-13T01:56:59.581Z"; const sha = "253039287a7aeee36148f3090ca39c98dab50143";`,
    ].join("\n"),
  );
  expect(check(r.dir, ["range", r.base, "HEAD"])).toEqual({ code: 0, out: "" });
});

test("every Terros ID form fails: short keys, long keys, UUIDs, letters-only mixed case, either separator", () => {
  // Joined at run time, so this file itself passes the check it tests.
  const ids = [
    ["C", "ab12"],
    ["Program", "Qx7Lp2Rk9Tz4Nw8Bv1m"],
    ["Account", "3f2b8c1e-9d4a-4b6e-8f0a-1c2d3e4f5a6b"],
    ["U", "QxLpRkTz"],
    ["Group", "Tz4_Nw8"],
  ].map(([prefix, key], i) => [prefix, key].join(i % 2 ? ":" : "."));
  for (const id of ids) {
    const r = repo();
    r.commit("ids.ts", `const id = "${id}";\n`);
    expect(check(r.dir, ["range", r.base, "HEAD"]).out, id).toMatch(/ids\.ts:1: Terros ID/);
  }
});

test("a merge commit's message and the content it adds beyond its parents are checked", () => {
  const r = repo();
  r.git("checkout", "--quiet", "-b", "side");
  r.commit("side.md", "Side change\n");
  r.git("checkout", "--quiet", "main");
  r.commit("main.md", "Main change\n");
  // A clean merge whose message names the customer.
  r.git("merge", "--quiet", "--no-ff", "-m", "Merge the Zephyr Roofing fix", "side");
  const named = check(r.dir, ["range", r.base, "HEAD"]);
  expect(named.code).toBe(1);
  expect(named.out).toMatch(/message:1: denylisted customer name/);

  // An evil merge: the ID appears only in the merge commit, not in either parent.
  const e = repo();
  e.git("checkout", "--quiet", "-b", "side");
  e.commit("side.md", "Side change\n");
  e.git("checkout", "--quiet", "main");
  e.commit("main.md", "Main change\n");
  e.git("merge", "--quiet", "--no-ff", "--no-commit", "side");
  writeFileSync(join(e.dir, "main.md"), `Main change for ${COMPANY_ID}\n`);
  e.git("add", "main.md");
  e.git("commit", "--quiet", "-m", "Merge side");
  const evil = check(e.dir, ["range", e.base, "HEAD"]);
  expect(evil.code).toBe(1);
  expect(evil.out).toMatch(/main\.md:1: Terros ID/);
  // From either parent, as a pre-push from a clone that has it, the merge's addition still fails.
  expect(check(e.dir, ["range", "HEAD^1", "HEAD"]).out).toMatch(/main\.md:1: Terros ID/);
  expect(check(e.dir, ["range", "HEAD^2", "HEAD"]).code).toBe(1);
});

test("emails, phone numbers, PR text and branch names are checked", () => {
  const r = repo();
  r.commit("contact.md", `Call ${PHONE} or write to ${EMAIL}\n`);
  const out = check(r.dir, ["range", r.base, "HEAD"]).out;
  expect(out).toMatch(/contact\.md:1: phone number/);
  expect(out).toMatch(/contact\.md:1: email address/);
  expect(check(r.dir, ["text", "PR body"], "Title\n\nFixes the sync for Zephyr Roofing.\n").out).toMatch(/PR body:3: denylisted customer name/);
});

test("as a pre-push hook it checks only what the remote does not have, and the branch name", () => {
  const remote = repo();
  remote.commit("old.md", `Legacy ${EMAIL}\n`);
  const r = repo();
  r.git("remote", "add", "origin", remote.dir);
  r.git("fetch", "--quiet", "origin");
  r.git("reset", "--quiet", "--hard", "origin/main");
  const clean = r.commit("new.md", "Placeholder data only\n");
  const push = (sha: string, branch: string) => check(r.dir, ["pre-push", "origin"], `refs/heads/x ${sha} refs/heads/${branch} ${"0".repeat(40)}\n`);
  expect(push(clean, "sergeant/tech-1-fix")).toEqual({ code: 0, out: "" });
  expect(push(clean, "sergeant/tech-1-zephyr-roofing").out).toMatch(/branch name:1: denylisted customer name/);
  const named = r.commit("new.md", "Zephyr Roofing\n");
  expect(push(named, "sergeant/tech-1-fix").code).toBe(1);
});

// TECH-6222: a worker's clone sets no `core.hooksPath`, so a repository's own `.githooks/pre-push` ran
// only if the image's hook runs it. It must get the push's arguments and refs, and its refusal must stop
// the push before the image's own check.
test("the image's pre-push hook runs the repository's own .githooks/pre-push first, and its refusal stops the push", () => {
  const r = repo();
  mkdirSync(join(r.dir, ".githooks"));
  const own = join(r.dir, ".githooks", "pre-push");
  writeFileSync(own, `#!/bin/sh\necho "$@" > "$(dirname "$0")/seen"\ncat >> "$(dirname "$0")/seen"\nexit 1\n`);
  chmodSync(own, 0o755);
  const refs = `refs/heads/x ${r.base} refs/heads/x ${"0".repeat(40)}\n`;
  const push = spawnSync("sh", [HOOK, "origin", "https://example.test/o/r.git"], { cwd: r.dir, input: refs, encoding: "utf8" });
  expect(push.status).toBe(1);
  expect(readFileSync(join(r.dir, ".githooks", "seen"), "utf8")).toBe(`origin https://example.test/o/r.git\n${refs}`);
});

test("with no denylist it still checks IDs and says names went unchecked", () => {
  const r = repo();
  r.commit("a.md", "Zephyr Roofing\n");
  expect(check(r.dir, ["range", r.base, "HEAD"], "", "")).toMatchObject({ code: 0, out: expect.stringMatching(/no customer-name denylist/) });
});

test("binary files are read as text, a .gitattributes mark hides nothing, and a `++ ` line is an added line", () => {
  const r = repo();
  r.commit("logo.bin", `\0\x01PNG\nowner ${COMPANY_ID}\n\0`);
  expect(check(r.dir, ["range", r.base, "HEAD"]).out).toMatch(/logo\.bin:2: Terros ID/);

  const a = repo();
  a.commit(".gitattributes", "*.md -diff\n");
  a.commit("notes.md", "Zephyr Roofing\n");
  expect(check(a.dir, ["range", a.base, "HEAD"]).out).toMatch(/notes\.md:1: denylisted customer name/);

  // An added line that starts with `++ ` shows as `+++ ` in the diff, like a file header.
  const p = repo();
  p.commit("counter.c", `int a = 1;\n++ zephyr roofing;\n++ ${COMPANY_ID};\n`);
  const out = check(p.dir, ["range", p.base, "HEAD"]).out;
  expect(out).toMatch(/counter\.c:2: denylisted customer name/);
  expect(out).toMatch(/counter\.c:3: Terros ID/);
});

test("a rename-only or empty file's path is checked, and a path with customer data is never printed", () => {
  const r = repo();
  r.git("mv", "README.md", "zephyr-roofing-notes.md");
  r.git("commit", "--quiet", "-m", "Rename");
  const renamed = check(r.dir, ["range", r.base, "HEAD"]);
  expect(renamed.code).toBe(1);
  expect(renamed.out).toMatch(/\(a file path with customer data\) \(file path\): denylisted customer name/);
  expect(renamed.out).not.toMatch(/zephyr/i);

  const e = repo();
  e.commit("ZephyrRoofing.md", "");
  expect(check(e.dir, ["range", e.base, "HEAD"]).out).toMatch(/\(file path\): denylisted customer name/);

  // A line finding in such a file does not print its path either.
  const l = repo();
  l.commit("zephyr_roofing.ts", `const id = "${COMPANY_ID}";\n`);
  const out = check(l.dir, ["range", l.base, "HEAD"]).out;
  expect(out).toMatch(/\(a file path with customer data\):1: Terros ID/);
  expect(out).not.toMatch(/zephyr/i);
});

test("a commit's author and committer are checked, but their own email address is not a finding", () => {
  // The environment's GIT_AUTHOR_* and GIT_COMMITTER_* would override a -c user.name, so set those.
  const commitAs = (dir: string, name: string, email: string) =>
    execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "Empty"], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" },
    });
  const r = repo();
  commitAs(r.dir, "Zephyr Roofing", "rep@example.test");
  expect(check(r.dir, ["range", r.base, "HEAD"]).out).toMatch(/author\/committer:1: denylisted customer name/);
  const e = repo();
  commitAs(e.dir, "A Developer", EMAIL);
  expect(check(e.dir, ["range", e.base, "HEAD"])).toEqual({ code: 0, out: "" });
});

test("a two-character denylist entry is checked in its listed case, and a one-character entry is an error", () => {
  const r = repo();
  r.commit("vendors.md", "Parts from 3M and from Zq.\nzq is lowercase here.\n");
  const out = check(r.dir, ["range", r.base, "HEAD"], "", "Zq").out;
  expect(out).toMatch(/vendors\.md:1: denylisted customer name/);
  expect(out).not.toMatch(/vendors\.md:2:/);
  expect(check(r.dir, ["range", r.base, "HEAD"], "", "3M").code).toBe(1);
  const bad = check(r.dir, ["range", r.base, "HEAD"], "", "Zephyr Roofing,Q");
  expect(bad.code).toBe(2);
  expect(bad.out).not.toMatch(/Zephyr/);
});
