import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { cancelPending, taskDir } from "./cancel.ts";
import { checkLive, type Ports } from "./execute.ts";
import { readTaskState } from "./loop.ts";

// TECH-4997: intake lists only issues still delegated to the V2 agent, and of those closed only the
// ones completed or canceled in the last week. A task whose issue was undelegated while no loop ran
// (across a restart, say), or closed before that week, is never listed, so nothing stops it and its
// worker PRs stay open. At startup `serve` reads each unmerged task's issue live once, and runs the
// loop of each whose issue is no longer Sergeant's to work on (A1 or A2). That loop stops the task
// the way it stops one undelegated or moved while it runs, through the task's cancel (cancel.ts): runs
// canceled, open worker PRs closed, the issue told. A Done issue whose worker's closing PR a human
// merged is that loop's normal end instead.

/**
 * The tasks under `stateDir` not merged, with no cancel already recorded (intake drives that), whose
 * issue Linear now says is undelegated or in Backlog, Canceled, or Done. An issue that cannot be read,
 * or no longer exists, is logged and left alone: a failed lookup never stops a task.
 */
export async function strandedTasks(stateDir: string, deps: Pick<Ports, "linear" | "agentUserId">, log: (line: string) => void): Promise<string[]> {
  const stranded: string[] = [];
  for (const ref of await readdir(join(stateDir, "tasks")).catch(() => [])) {
    const dir = taskDir(stateDir, ref);
    try {
      if (await cancelPending(dir)) continue;
      const task = await readTaskState(join(dir, "state.json"));
      if (!task || task.merged) continue;
      const { issue } = await deps.linear.readConversation(ref);
      const live = checkLive(issue, deps.agentUserId);
      if (live.allowed) continue;
      log(`${ref}: ${live.reason}; stopping its task`);
      stranded.push(ref);
    } catch (e) {
      log(`${ref}: startup check skipped: ${(e as Error).message}`);
    }
  }
  return stranded;
}
