import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { signIn } from "./signin.ts";

// TECH-5196: the provider sign-ins against fake `codex` and `claude` executables on PATH. What matters:
// Codex signs in to a throwaway CODEX_HOME, never the person's own, and that directory, credential and
// all, is gone afterwards whether the login worked or not; a missing CLI says what to install.

let dir = "";
let bin = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sgt-signin-test-"));
  bin = join(dir, "bin");
  await mkdir(bin);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fake = (name: string, script: string) => writeFile(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
const env = () => ({ PATH: bin, HOME: join(dir, "home"), CODEX_HOME: join(dir, "home", ".codex") });
const noSecret = async () => expect.unreachable("asked for a secret");
const gone = (path: string) => access(path).then(() => false, () => true);

test("codex signs in to a throwaway CODEX_HOME, returns its auth.json, and deletes it, even when the login fails", async () => {
  const seen = join(dir, "codex-home");
  await fake("codex", `[ "$1" = login ] || exit 9\necho "$CODEX_HOME" > ${seen}\nprintf '{"tokens":{"access_token":"secret"}}' > "$CODEX_HOME/auth.json"`);
  expect(await signIn("codex", { env: env(), askSecret: noSecret })).toBe('{"tokens":{"access_token":"secret"}}');
  const home = (await readFile(seen, "utf8")).trim();
  expect(home).not.toBe(env().CODEX_HOME);
  expect(await gone(home)).toBe(true);
  expect(await gone(env().CODEX_HOME)).toBe(true);

  await fake("codex", `echo "$CODEX_HOME" > ${seen}\nprintf '{}' > "$CODEX_HOME/auth.json"\nexit 1`);
  await expect(signIn("codex", { env: env(), askSecret: noSecret })).rejects.toThrow("`codex login` exited 1; nothing was registered");
  expect(await gone((await readFile(seen, "utf8")).trim())).toBe(true);
});

test("claude runs `claude setup-token` on the terminal, then takes the token the person pastes", async () => {
  await fake("claude", `[ "$1" = setup-token ] || exit 9`);
  const prompts: string[] = [];
  const token = await signIn("claude", { env: env(), askSecret: async (prompt) => (prompts.push(prompt), "sk-ant-oat01-pasted") });
  expect(token).toBe("sk-ant-oat01-pasted");
  expect(prompts).toEqual([expect.stringContaining("Paste the token `claude setup-token` printed")]);
});

test("a missing provider CLI says what to install", async () => {
  await expect(signIn("claude", { env: env(), askSecret: noSecret })).rejects.toThrow("`claude` is not installed or not on your PATH: install Claude Code");
  await expect(signIn("codex", { env: env(), askSecret: noSecret })).rejects.toThrow("install the Codex CLI (`npm install -g @openai/codex`)");
});
