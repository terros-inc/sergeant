import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Sergeant's version, from git rather than package.json: the nearest `vMAJOR.MINOR.PATCH` tag, the
 * commits since it as the patch number, and the short SHA. Tag `v2.0.0` plus 37 commits at `aad6046`
 * is `2.0.37+aad6046`; a commit on the tag is `2.0.0+<sha>`. Without a tag or enough history (a shallow
 * clone) or when git cannot read the checkout, it is `0.0.0+<sha>` (or `0.0.0+unknown`) and `fallback`
 * says why. `root` is the checkout's top level, which git is told to trust: on the host, serve runs as
 * the sergeant user against a root-owned checkout, which git otherwise refuses as dubious ownership.
 * `trust: false` (tests) leaves git's ownership check as is. If git's top level is not `root` (a copy of
 * sgt nested inside another repo, without its own .git), it is `0.0.0+unknown`, never that repo's tags or SHA. */
export function sergeantVersion(
  root = fileURLToPath(new URL("../../..", import.meta.url)),
  { trust = true } = {},
): { version: string; fallback?: string } {
  let trusted: string;
  try {
    trusted = realpathSync(root);
  } catch {
    return { version: "0.0.0+unknown", fallback: `no such directory: ${root}` };
  }
  const git = (...args: string[]) =>
    execFileSync("git", [...(trust ? ["-c", `safe.directory=${trusted}`] : []), ...args], { cwd: trusted, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  let sha: string;
  try {
    const toplevel = git("rev-parse", "--show-toplevel");
    if (realOr(toplevel) !== trusted) return { version: "0.0.0+unknown", fallback: `the git checkout is ${toplevel}, not Sergeant's ${trusted}` };
    sha = git("rev-parse", "--short=7", "HEAD");
  } catch (e) {
    const err = e as { code?: string; stderr?: Buffer };
    const reason = err.code === "ENOENT" ? "git is not installed" : (err.stderr?.toString().split("\n")[0]?.trim() ?? "");
    return { version: "0.0.0+unknown", fallback: `git cannot read the checkout: ${reason || "unknown error"}` };
  }
  try {
    // Prerelease or extra-dotted tags (v2.1.0-rc.1) are skipped so the nearest real vX.Y.Z is used.
    const described = git("describe", "--tags", "--long", "--abbrev=7", "--match", "v[0-9]*.[0-9]*.[0-9]*", "--exclude", "v*-*", "--exclude", "v*.*.*.*", "HEAD");
    const m = /^v(\d+)\.(\d+)\.(\d+)-(\d+)-g([0-9a-f]+)$/.exec(described);
    if (!m) return { version: `0.0.0+${sha}`, fallback: `unexpected git describe output: ${described}` };
    return { version: `${m[1]}.${m[2]}.${Number(m[3]) + Number(m[4])}+${m[5]}` };
  } catch {
    const shallow = git("rev-parse", "--is-shallow-repository") === "true";
    return { version: `0.0.0+${sha}`, fallback: shallow ? "shallow clone: no version tag in the fetched history" : "no vMAJOR.MINOR.PATCH tag" };
  }
}

/** `path` with symlinks resolved, or as given when it cannot be resolved. */
function realOr(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
