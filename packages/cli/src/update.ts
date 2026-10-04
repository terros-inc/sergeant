import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sergeantVersion } from "@terros/sergeant-contracts";

// `sgt update` (TECH-5185): brings the checkout `sgt` runs from (`pnpm install-sgt`'s wrapper runs it
// in place) to origin's main and installs its dependencies, so the next `sgt` is the current CLI. It
// only fast-forwards main: another branch, or local commits main lacks, are the human's to sort out,
// and git's own message says how. A shallow clone is deepened, since sgt's version needs a version tag.

/** Runs a command in `cwd`; resolves with its stdout, rejects with an Error carrying its stderr. */
export type Exec = (command: string, args: string[], cwd: string) => Promise<string>;

/** The checkout this `sgt` runs from. */
export const CHECKOUT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

export const exec: Exec = (command, args, cwd) =>
  new Promise((resolve, reject) =>
    execFile(command, args, { cwd }, (e, stdout, stderr) => (e ? reject(new Error(`${command} ${args.join(" ")}: ${stderr.trim() || e.message}`)) : resolve(stdout.trim()))),
  );

/** Updates the checkout at `root`; resolves with its new version (sergeantVersion). */
export async function update(root: string, run: Exec = exec): Promise<string> {
  const git = (...args: string[]) => run("git", args, root);
  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") throw new Error(`${root} is on ${branch}, not main: switch it to main (git -C ${root} switch main), then run sgt update again`);
  const shallow = (await git("rev-parse", "--is-shallow-repository")) === "true";
  await git("fetch", "--tags", ...(shallow ? ["--unshallow"] : []), "origin", "main");
  await git("merge", "--ff-only", "FETCH_HEAD");
  await run("pnpm", ["install", "--frozen-lockfile"], root);
  return sergeantVersion(root).version;
}
