import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { Exec } from "./exec.ts";

// TECH-5253: a reviewer gets its checkouts with their dependencies installed, so it can run the tests
// it is judging. A worker installs its own in its container. The install runs the PR head's own
// package scripts, so it never runs on the host: it is a one-shot container from the run image, with
// the reviewer's network, only that checkout mounted, and no credential at all, finished before the
// reviewer starts. Mounting only the checkout keeps its scripts away from the rest of the run
// workspace (the brief, the other checkouts), which the host still writes to afterwards.

/** The frozen install for each lockfile a checkout may have, the first one found used. */
const INSTALLS: [lockfile: string, command: string[]][] = [
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["package-lock.json", ["npm", "ci"]],
];

const INSTALL_SECONDS = 600;

/** What the reviewer is told about a checkout's dependencies. */
export type Dependencies =
  | { state: "installed"; command: string }
  /** `output` is the tail of what the PR's own scripts printed: untrusted. */
  | { state: "failed"; command: string; detail: string; output: string }
  | { state: "none" };

/**
 * Installs the dependencies of the checkout at `/workspace/<rel>` (`<workspace>/<rel>` on the host).
 * Never fatal: a failed install is told to the reviewer, which still reviews.
 */
export async function installDependencies(
  exec: Exec,
  { image, workspace, rel, container }: { image: string; workspace: string; rel: string; container: string },
): Promise<Dependencies> {
  let install: string[] | undefined;
  for (const [lockfile, command] of INSTALLS) {
    if (await lstat(join(workspace, rel, lockfile)).then((s) => s.isFile(), () => false)) {
      install = command;
      break;
    }
  }
  if (!install) return { state: "none" };
  const command = install.join(" ");
  const args = [
    "run", "--rm", "--name", container, "--label", `sergeant.install=${container}`,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--volume", `${join(workspace, rel)}:/workspace/${rel}`, "--workdir", `/workspace/${rel}`,
    "--env", "CI=true", "--env", "COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
    image, "timeout", String(INSTALL_SECONDS), ...install,
  ];
  // Only the non-secret settings above are set, and with no `--env NAME`, nothing from the host's
  // environment reaches the container.
  // exec rejects only when docker cannot be launched or is killed by the host backstop timeout.
  const r = await exec("docker", args, { timeoutMs: (INSTALL_SECONDS + 60) * 1000 }).catch((e: Error) => ({
    code: /killed by/.test(e.message) ? 124 : -1,
    stdout: "",
    stderr: e.message,
  }));
  if (r.code === 0) return { state: "installed", command };
  // A docker CLI killed by its own timeout would leave the install running beside the reviewer.
  await exec("docker", ["rm", "-f", container]).catch(() => undefined);
  const why = r.code === 124 ? `timed out after ${INSTALL_SECONDS}s` : `exited ${r.code}`;
  return { state: "failed", command, detail: why, output: (r.stderr || r.stdout).trim().slice(-500) };
}
