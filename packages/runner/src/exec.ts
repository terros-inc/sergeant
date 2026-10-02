import { spawn } from "node:child_process";

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
/** Runs a host command to completion. Injected in tests, so no real process is launched. */
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Rejects only when the command cannot be launched or times out. */
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeoutMs ?? 600_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      code === null ? reject(new Error(`${cmd} killed by ${signal}`)) : resolve({ code, stdout, stderr }),
    );
  });

/** `run`, but a nonzero exit is an error carrying the command's own output. */
export const checked =
  (run: Exec) =>
  async (cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> => {
    const r = await run(cmd, args, opts);
    if (r.code !== 0) throw new Error(`${cmd} ${args[0] ?? ""} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
    return r.stdout;
  };

export const execOk = checked(exec);

/**
 * git flags making the run's GitHub token, read from `SERGEANT_RUN_GITHUB_TOKEN` in that one
 * command's environment, the only credential helper. As `-c` flags they are never written into a
 * repository's config, and the token is never on a command line.
 */
export const TOKEN_CREDENTIAL = [
  "-c",
  "credential.helper=",
  "-c",
  'credential.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$SERGEANT_RUN_GITHUB_TOKEN"; }; f',
];
