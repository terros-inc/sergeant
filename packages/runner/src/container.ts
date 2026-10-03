import { lstat } from "node:fs/promises";
import { join } from "node:path";

/** Docker's definite answer that a container does not exist; any other failure is unknown. */
export const isGone = (r: { code: number; stderr: string }) => r.code !== 0 && /no such (container|object)/i.test(r.stderr);

/**
 * The path of a regular file the agent wrote, refusing symlinks anywhere below the workspace: a
 * link planted in the container would otherwise make this host process read a host file.
 */
export async function agentFile(workspace: string, ...parts: string[]): Promise<string | undefined> {
  let path = workspace;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    const st = await lstat(path).catch(() => undefined);
    if (!st || st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : !st.isFile())) return undefined;
  }
  return path;
}

export const gitIdentityEnv = ({ name, email }: { name: string; email: string }) =>
  [`GIT_AUTHOR_NAME=${name}`, `GIT_AUTHOR_EMAIL=${email}`, `GIT_COMMITTER_NAME=${name}`, `GIT_COMMITTER_EMAIL=${email}`].flatMap(
    (v) => ["--env", v],
  );
