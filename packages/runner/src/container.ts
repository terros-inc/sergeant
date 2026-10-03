import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/** The `claude -p` result line; everything else in it is ignored. */
export const AgentOutput = z.object({
  is_error: z.boolean(),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
});

// Runs inside the container.
export const AGENT_SCRIPT = `
wall="$1"; model="$2"; budget="$3"
exec timeout "$wall" claude -p "Read /workspace/sergeant-brief.md and do what it says. Your last step is writing /workspace/sergeant-report.md." \\
  --output-format json --model "$model" --max-budget-usd "$budget" --permission-mode bypassPermissions
`;

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
