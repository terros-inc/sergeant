import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { AGENTS } from "./agents.ts";

// TECH-6126: a headless Claude worker that started a background wait on CI ended its turn, and with it
// the run, before writing its report. The Claude script turns Claude Code's background tasks off.
test("the Claude Code script runs claude -p with background tasks disabled", async () => {
  const bin = await mkdtemp(join(tmpdir(), "sergeant-agents-"));
  try {
    await writeFile(join(bin, "claude"), '#!/bin/sh\necho "background=$CLAUDE_CODE_DISABLE_BACKGROUND_TASKS args=$*"\n');
    await chmod(join(bin, "claude"), 0o755);
    const { stdout } = await promisify(execFile)("sh", ["-c", AGENTS["claude-code-local"].script, "sh", "60", "opus", "5"], {
      env: { PATH: `${bin}:${process.env.PATH}` },
    });
    expect(stdout).toMatch(/^background=1 args=-p .* --model opus --max-budget-usd 5 /);
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
});
