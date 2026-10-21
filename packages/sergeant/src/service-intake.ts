import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LinearPort } from "@terros/sergeant-contracts";
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

/**
 * TECH-6470: a delegated issue in a started state (In Progress, say) with no task under way never starts
 * (TECH-4989: only from the unstarted state), so whoever delegated it is told so once, rather than left to
 * think it is queued. Like the owner refusals (owner.ts), the comment is keyed by the delegation Linear's
 * history shows, so a restart repeats nothing and only a new delegation is told again. `noted` holds the
 * issues told and logged in this process; one listed no more as started (undelegated, or moved to Todo
 * and so started) is dropped, so its next delegation is read again. Backlog and Triage stay silent:
 * parking an issue there is deliberate. A failed read or post is retried at the next intake.
 */
export async function noteStarted(
  stateDir: string,
  listed: DelegatedIssue[],
  input: { noted: Set<string>; active: Map<string, Promise<void>> },
  deps: { linear: Pick<LinearPort, "readTaskOwner" | "postComment">; agentUserId: string },
  log: (line: string) => void,
): Promise<void> {
  const { noted, active } = input;
  const started = listed.filter((issue) => issue.state.type === "started");
  for (const id of noted) if (!started.some((issue) => issue.identifier === id)) noted.delete(id);
  for (const issue of started) {
    const ref = issue.identifier;
    if (noted.has(ref) || active.has(ref) || (await underWay(taskDir(stateDir, ref)))) continue;
    try {
      const check = await deps.linear.readTaskOwner(ref, deps.agentUserId);
      await deps.linear.postComment({
        issueId: ref,
        key: `not-unstarted:${ref}:${check.delegatedAt ?? "-"}`,
        body: `Sergeant has not started this issue: it is in ${issue.state.name}, and Sergeant starts work only from the team's unstarted state (normally Todo). To have Sergeant work on it, move it to Todo.`,
      });
    } catch (e) {
      log(`${ref}: could not say why it does not start, retrying next intake: ${(e as Error).message}`);
      continue;
    }
    noted.add(ref);
    log(`${ref} not started: delegated in ${issue.state.name}, not the unstarted state`);
  }
}

/** Whether `dir` holds a task under way: a stop not yet done, or a `state.json` not seen through after its merge. */
async function underWay(dir: string): Promise<boolean> {
  if (await cancelPending(dir)) return true;
  // An unreadable one is taken as under way: intake's resume reports it (resumableTasks).
  const task = await readTaskState(join(dir, "state.json")).catch(() => "unreadable" as const);
  return task === "unreadable" || (task !== undefined && !task.merged?.completedAt);
}
