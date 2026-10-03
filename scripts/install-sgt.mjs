// Installs `sgt` for this checkout (TECH-5119): a tiny wrapper script on PATH, so it works in every
// shell, unlike an alias. `pnpm install-sgt` writes `~/.local/bin/sgt` (or `$SGT_BIN_DIR/sgt`).
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const dir = process.env.SGT_BIN_DIR || join(homedir(), ".local", "bin");
const target = join(dir, "sgt");
// Single-quoted for sh, so a checkout path with spaces or `$` still works.
const quoted = `'${join(repo, "packages", "cli", "src", "sgt.ts").replaceAll("'", `'\\''`)}'`;

mkdirSync(dir, { recursive: true });
writeFileSync(target, `#!/bin/sh\nexec node ${quoted} "$@"\n`);
chmodSync(target, 0o755);
console.log(`installed ${target} -> ${repo}`);
if (!(process.env.PATH ?? "").split(delimiter).includes(dir)) {
  console.log(`${dir} is not on your PATH: add  export PATH="${dir}:$PATH"  to your shell profile`);
}
