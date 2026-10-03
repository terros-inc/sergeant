import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

const installer = fileURLToPath(new URL("../container/install-codex-commit-msg-hook.sh", import.meta.url));
const isolatedEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: isolatedEnv }).trim();

async function executable(path: string, source: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  await chmod(path, 0o755);
}

test("Codex hook preserves repository hooks and strips Codex trailers at default and configured paths", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "sergeant-codex-hooks-"));

  for (const [name, configuredHooks] of [
    ["default", false],
    ["configured", true],
  ] as const) {
    const repository = join(workspace, name);
    await mkdir(repository);
    git(repository, "init", "-b", "main");
    git(repository, "config", "user.name", "Test User");
    git(repository, "config", "user.email", "test@example.com");
    if (configuredHooks) git(repository, "config", "core.hooksPath", ".repo-hooks");

    const hookDir = configuredHooks ? join(repository, ".repo-hooks") : join(repository, ".git", "hooks");
    await executable(join(hookDir, "pre-commit"), `#!/bin/sh\nprintf ran > "${join(repository, "pre-commit-ran")}"\n`);
    await executable(join(hookDir, "commit-msg"), '#!/bin/sh\nprintf "\\nRepository-hook: ran\\n" >> "$1"\n');
    await writeFile(join(repository, "change.txt"), "change\n");
    git(repository, "add", "change.txt");
  }

  execFileSync(installer, { env: { ...isolatedEnv, SERGEANT_WORKSPACE_ROOT: workspace } });

  for (const name of ["default", "configured"]) {
    const repository = join(workspace, name);
    git(
      repository,
      "commit",
      "-m",
      "Test commit\n\nCo-authored-by: Codex <noreply@openai.com>\nco-AUTHORED-BY: Codex <codex@openai.com>\nCo-authored-by: Human <human@example.com>",
    );

    expect(await readFile(join(repository, "pre-commit-ran"), "utf8")).toBe("ran");
    expect(git(repository, "show", "-s", "--format=%B")).toBe(
      "Test commit\n\nCo-authored-by: Human <human@example.com>\n\nRepository-hook: ran",
    );
  }
});
