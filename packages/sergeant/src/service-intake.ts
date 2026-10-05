import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { DelegatedIssue } from "@terros/sergeant-linear";
import { heldAcceptances } from "./accepted.ts";
import { cancelPending, taskDir } from "./cancel.ts";
import { readTaskState } from "./loop.ts";
import { setAsideCompleted } from "./task-state.ts";

// What an intake (service.ts) finds to run: the tasks under way locally with no loop, and the new work
// Linear lists.

/** Tasks under way locally with no loop in `active`, not yet seen through after their merge. */
export async function resumableTasks(stateDir: string, active: Map<string, Promise<void>>, log: (line: string) => void): Promise<string[]> {
  const resumable: string[] = [];
  for (const ref of await readdir(join(stateDir, "tasks")).catch(() => [])) {
    if (active.has(ref)) continue;
    const task = await readTaskState(join(taskDir(stateDir, ref), "state.json")).catch((e: Error) => log(`${ref}: not resumed: ${e.message}`));
    if (task && !task.merged?.completedAt) resumable.push(ref);
  }
  return resumable;
}

/**
 * The delegated issues intake may start, in `listed`'s order. `blocked` holds each Todo issue a blocker
 * held up at the last intake, and the line logged for it; it is refilled with this intake's.
 */
export async function newWork(
  stateDir: string,
  listed: DelegatedIssue[] | undefined,
  input: { blocked: Map<string, string>; active: Map<string, Promise<void>>; woken: (ref: string) => boolean },
  log: (line: string) => void,
): Promise<DelegatedIssue[]> {
  const { blocked, active } = input;
  // New work: a delegated issue in Todo, not one whose stop is still under way, one a human accepted
  // as it is and has not touched since (accepted.ts, TECH-5118), nor one a Linear "blocked by" issue
  // still holds up (TECH-5066); it starts at the first intake after its last blocker is completed or
  // canceled. A task already under way resumes first (resumableTasks), blocked or not.
  const accepted = await heldAcceptances(stateDir, listed ?? [], input.woken, log);
  const loggedBefore = new Map(blocked);
  blocked.clear();
  const todo = (listed ?? []).filter((issue) => {
    if (issue.state.type !== "unstarted" || accepted.has(issue.identifier)) return false;
    if (issue.blockedBy.length === 0) return true;
    const line = `${issue.identifier} waiting on blocker ${issue.blockedBy.join(", ")}`;
    if (loggedBefore.get(issue.identifier) !== line) log(line);
    blocked.set(issue.identifier, line);
    return false;
  });
  const issues = await Promise.all(
    todo.map(async (issue) => {
      const dir = taskDir(stateDir, issue.identifier);
      if (await cancelPending(dir)) return [];
      if (!active.has(issue.identifier) && (await setAsideCompleted(dir))) log(`${issue.identifier}: reopened after its task was seen through: a new task`);
      return [issue];
    }),
  );
  return issues.flat();
}
