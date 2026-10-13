import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// The check every public repository's CI, its pre-push hook, and a Sergeant worker's push run
// (container/check-public-data.mjs, TECH-5914). The denylisted name is synthetic: the real list is
// never committed to a public repository.
const SCRIPT = join(import.meta.dirname, "..", "container", "check-public-data.mjs");
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
      `if (role === Role.manager || Team.teamId || Program.Status) git.push("git@github.com:org/repo.git");`,
      `const when = "2026-10-13T01:56:59.581Z"; const sha = "253039287a7aeee36148f3090ca39c98dab50143";`,
    ].join("\n"),
  );
  expect(check(r.dir, ["range", r.base, "HEAD"])).toEqual({ code: 0, out: "" });
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

test("with no denylist it still checks IDs and says names went unchecked", () => {
  const r = repo();
  r.commit("a.md", "Zephyr Roofing\n");
  expect(check(r.dir, ["range", r.base, "HEAD"], "", "")).toMatchObject({ code: 0, out: expect.stringMatching(/no customer-name denylist/) });
});
