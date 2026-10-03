// Installs `sgt` for this checkout (TECH-5119): a tiny wrapper script on PATH, so it works in every
// shell, unlike an alias. `pnpm install-sgt` writes `~/.local/bin/sgt` (or `$SGT_BIN_DIR/sgt`).
// It replaces only a wrapper it wrote itself, never another file or a symlink, and never writes
// through one: the new wrapper is written beside it and renamed over it.
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const dir = process.env.SGT_BIN_DIR || join(homedir(), ".local", "bin");
const target = join(dir, "sgt");
// Single-quoted for sh, so a path with spaces, `$` or quotes still works.
const shQuote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const wrapper = `#!/bin/sh\nexec node ${shQuote(join(repo, "packages", "cli", "src", "sgt.ts"))} "$@"\n`;
// Any checkout's wrapper, including one written before this check existed.
const ours = /^#!\/bin\/sh\nexec node '.*\/packages\/cli\/src\/sgt\.ts' "\$@"\n$/s;

const existing = lstatSync(target, { throwIfNoEntry: false });
if (existing) {
  const reason = existing.isSymbolicLink()
    ? "is a symlink"
    : !existing.isFile() || existing.size > 4096 || !ours.test(readFileSync(target, "utf8"))
      ? "is not a wrapper written by pnpm install-sgt"
      : undefined;
  if (reason) {
    console.error(`refusing to replace ${target}: it ${reason}. Move it away, or set SGT_BIN_DIR to install elsewhere.`);
    process.exit(1);
  }
}

mkdirSync(dir, { recursive: true });
const temp = join(dir, `.sgt.${process.pid}.tmp`);
try {
  writeFileSync(temp, wrapper, { flag: "wx" });
  chmodSync(temp, 0o755);
  renameSync(temp, target);
} catch (e) {
  rmSync(temp, { force: true });
  throw e;
}
console.log(`installed ${target} -> ${repo}`);
if (!(process.env.PATH ?? "").split(delimiter).includes(dir)) {
  console.log(`${dir} is not on your PATH: add  export PATH=${shQuote(dir)}:"$PATH"  to your shell profile`);
}
