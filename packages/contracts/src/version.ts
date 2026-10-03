import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Sergeant's version, from git rather than package.json: the nearest `vMAJOR.MINOR.PATCH` tag, the
 * commits since it as the patch number, and the short SHA. Tag `v2.0.0` plus 37 commits at `aad6046`
 * is `2.0.37+aad6046`; a commit on the tag is `2.0.0+<sha>`. Without a tag or enough history (a shallow
 * clone) or without git, it is `0.0.0+<sha>` (or `0.0.0+unknown`) and `fallback` says why. */
export function sergeantVersion(cwd = fileURLToPath(new URL(".", import.meta.url))): { version: string; fallback?: string } {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  let sha: string;
  try {
    sha = git("rev-parse", "--short=7", "HEAD");
  } catch {
    return { version: "0.0.0+unknown", fallback: "no git checkout" };
  }
  try {
    const described = git("describe", "--tags", "--long", "--abbrev=7", "--match", "v[0-9]*.[0-9]*.[0-9]*", "HEAD");
    const m = /^v(\d+)\.(\d+)\.(\d+)-(\d+)-g([0-9a-f]+)$/.exec(described);
    if (!m) return { version: `0.0.0+${sha}`, fallback: `unexpected git describe output: ${described}` };
    return { version: `${m[1]}.${m[2]}.${Number(m[3]) + Number(m[4])}+${m[5]}` };
  } catch {
    const shallow = git("rev-parse", "--is-shallow-repository") === "true";
    return { version: `0.0.0+${sha}`, fallback: shallow ? "shallow clone: no version tag in the fetched history" : "no vMAJOR.MINOR.PATCH tag" };
  }
}
