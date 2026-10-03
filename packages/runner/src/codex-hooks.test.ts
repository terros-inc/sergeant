import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const container = fileURLToPath(new URL("../container/", import.meta.url));
const installer = join(container, "install-codex-git-hooks.sh");
const dispatcher = join(container, "codex-git-hook-dispatcher.sh");
const isolatedEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: isolatedEnv }).trim();

async function executable(path: string, source: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  await chmod(path, 0o755);
}

test("Codex dispatches repository hooks without modifying repositories", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "sergeant-codex-hooks-"));
  const hookDir = join(workspace, "image-hooks");
  const setupEnv = {
    ...isolatedEnv,
    SERGEANT_CODEX_HOOK_DIR: hookDir,
    SERGEANT_CODEX_HOOK_DISPATCHER: dispatcher,
  };

  // Startup is idempotent and repairs the image-owned directory, never a repository directory.
  execFileSync(installer, { env: setupEnv });
  execFileSync(installer, { env: setupEnv });
  const codexEnv = {
    ...isolatedEnv,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hookDir,
  };

  const repository = join(workspace, "configured-after-startup");
  await mkdir(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.name", "Test User");
  git(repository, "config", "user.email", "test@example.com");

  // Simulate Husky/lefthook changing core.hooksPath after Codex startup. This directory is tracked.
  git(repository, "config", "core.hooksPath", ".githooks");
  const repositoryHook = join(repository, ".githooks", "commit-msg");
  await executable(
    repositoryHook,
    '#!/bin/sh\n[ "${0##*/}" = commit-msg ] || exit 91\nprintf "\\nRepository-hook: ran\\n" >> "$1"\n',
  );
  await writeFile(join(repository, "change.txt"), "change\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "baseline");
  await writeFile(join(repository, "change.txt"), "changed\n");
  git(repository, "add", "change.txt");

  execFileSync(
    "git",
    [
      "commit",
      "-m",
      "Test commit\n\nCo-authored-by: Codex <noreply@openai.com>\nCo-authored-by: Human <human@example.com>",
    ],
    { cwd: repository, env: codexEnv },
  );

  expect(git(repository, "show", "-s", "--format=%B")).toBe(
    "Test commit\n\nCo-authored-by: Human <human@example.com>\n\nRepository-hook: ran",
  );
  expect(git(repository, "status", "--short")).toBe("");

  // A repository hook's exact exit status still rejects the commit, before trailer stripping.
  await executable(repositoryHook, '#!/bin/sh\n[ "${0##*/}" = commit-msg ] || exit 91\nexit 37\n');
  await writeFile(join(repository, "failure.txt"), "failure\n");
  git(repository, "add", "failure.txt");
  const rejectedMessage = join(workspace, "rejected-message");
  await writeFile(rejectedMessage, "Rejected\n\nCo-authored-by: Codex <noreply@openai.com>\n");
  const dispatched = spawnSync(join(hookDir, "commit-msg"), [rejectedMessage], { cwd: repository, env: codexEnv });
  expect(dispatched.status).toBe(37);
  expect(await readFile(rejectedMessage, "utf8")).toContain("Co-authored-by: Codex");
  const failed = spawnSync("git", ["commit", "-m", "Rejected\n\nCo-authored-by: Codex <noreply@openai.com>"], {
    cwd: repository,
    env: codexEnv,
  });
  // Git itself normalizes any hook rejection to status 1, but the commit remains blocked.
  expect(failed.status).toBe(1);
  expect(git(repository, "log", "-1", "--format=%s")).toBe("Test commit");
});

test("Codex dispatches default hooks for a linked worktree whose .git is a file", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "sergeant-codex-worktree-"));
  const main = join(workspace, "main");
  const linked = join(workspace, "linked");
  const hookDir = join(workspace, "image-hooks");
  await mkdir(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.name", "Test User");
  git(main, "config", "user.email", "test@example.com");
  await writeFile(join(main, "initial.txt"), "initial\n");
  git(main, "add", ".");
  git(main, "commit", "-m", "initial");
  git(main, "worktree", "add", "-b", "linked", linked);

  const commonDir = git(linked, "rev-parse", "--path-format=absolute", "--git-common-dir");
  await executable(join(commonDir, "hooks", "commit-msg"), '#!/bin/sh\nprintf "\\nRepository-hook: linked\\n" >> "$1"\n');
  execFileSync(installer, {
    env: {
      ...isolatedEnv,
      SERGEANT_CODEX_HOOK_DIR: hookDir,
      SERGEANT_CODEX_HOOK_DISPATCHER: dispatcher,
    },
  });
  await writeFile(join(linked, "linked.txt"), "linked\n");
  git(linked, "add", ".");
  execFileSync("git", ["commit", "-m", "Linked\n\nCo-authored-by: Codex <noreply@openai.com>"], {
    cwd: linked,
    env: {
      ...isolatedEnv,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: hookDir,
    },
  });
  expect(await readFile(join(linked, ".git"), "utf8")).toMatch(/^gitdir: /);
  expect(git(linked, "show", "-s", "--format=%B")).toBe("Linked\n\nRepository-hook: linked");
});
