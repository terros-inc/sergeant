// Keeps source files small (TECH-4957): any tracked source or test file over 600 lines fails CI;
// files over 300 lines are listed as refactor targets without failing. No allowlist.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const WARN = 300;
const FAIL = 600;
const SOURCE = /\.(ts|tsx|js|mjs|sh|tf)$/;
// Lockfiles and generated files are not written by hand; Markdown is not source.
const SKIP = /(^|\/)[^/]*[.-]lock\.|\.(gen|generated)\.[^/]+$/;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => SOURCE.test(f) && !SKIP.test(f));
const sizes = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (/@generated\b/.test(text.slice(0, 500))) continue;
  const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  if (lines > WARN) sizes.push({ file, lines });
}
sizes.sort((a, b) => b.lines - a.lines);

const over = sizes.filter((s) => s.lines > FAIL);
const targets = sizes.filter((s) => s.lines <= FAIL);
for (const { file, lines } of targets) console.log(`::warning file=${file}::${file} has ${lines} lines (over ${WARN}: refactor target)`);
for (const { file, lines } of over) console.log(`::error file=${file}::${file} has ${lines} lines (over ${FAIL}: split it)`);
console.log(`${files.length} source files checked: ${targets.length} over ${WARN} lines, ${over.length} over ${FAIL}.`);
if (over.length > 0) process.exit(1);
