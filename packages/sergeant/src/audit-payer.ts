import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { LinearPerson, PullRequestFacts } from "@terros/sergeant-contracts";
import type { Ports } from "./execute-types.ts";
import { isTaskStateFile, landings, readTaskState, type TaskState } from "./task-state.ts";

// TECH-6625: whose registered model accounts run a merged-PR audit outside a task (06 §8). First the
// person the PR belongs to: for a PR Sergeant's worker App opened, the owner of the task it was for, whose
// accounts ran that task; for a human's, its author when `linear.reviewerProfiles` maps their GitHub login
// to a Linear user. Then `review.auditOwner`, the fallback. The runner picks among that person's accounts
// and refuses with `NoModelAccount` when none is usable, which moves the audit on to the next person.

/** Whose accounts ran an audit; `fallback` when they are `review.auditOwner`'s because the PR's owner had none usable or there was none. */
export type AuditPayer = LinearPerson & { fallback?: true };

export type PayerDeps = Pick<Ports, "linear" | "workerLogin" | "linearProfileForGitHubLogin">;

/** The person the merged PR belongs to, or why there is none. */
export async function prOwner(pr: PullRequestFacts, issue: string | undefined, stateDir: string, deps: PayerDeps): Promise<LinearPerson | { none: string }> {
  if (pr.author.toLowerCase() === deps.workerLogin.toLowerCase()) {
    if (!issue) return { none: "a Sergeant PR naming no issue, so no task" };
    const owner = await taskOwner(join(stateDir, "tasks", issue), pr);
    return owner ? { id: owner.id, name: owner.name } : { none: `Sergeant's PR for ${issue}, whose task has no recorded owner here` };
  }
  const profile = deps.linearProfileForGitHubLogin?.(pr.author);
  if (!profile) return { none: `linear.reviewerProfiles maps no Linear user to its author ${pr.author}` };
  if (!deps.linear.userByProfile) return { none: `Linear cannot look up ${pr.author}'s profile` };
  const person = await deps.linear.userByProfile(profile);
  return person ?? { none: `no active Linear user has ${pr.author}'s profile ${profile}` };
}

/** `review.auditOwner` as a person, named when Linear knows them. */
export async function auditOwnerPerson(id: string, deps: Pick<Ports, "linear">): Promise<AuditPayer> {
  const name = (await deps.linear.userNames?.([id]).catch(() => undefined))?.[0];
  return { id, name: name ?? "the audit owner", fallback: true };
}

/**
 * The owner of the task episode that merged or worked on this PR; with none naming it, the current
 * episode's. Every state file of the issue is read, an episode set aside included.
 */
async function taskOwner(dir: string, pr: Pick<PullRequestFacts, "repo" | "number">): Promise<TaskState["owner"]> {
  const files = (await readdir(dir).catch(() => [])).filter(isTaskStateFile);
  const states = await Promise.all(files.map(async (f) => ({ f, state: await readTaskState(join(dir, f)).catch(() => undefined) })));
  const isPr = (h: { repo: string; number: number }) => h.repo.toLowerCase() === pr.repo.toLowerCase() && h.number === pr.number;
  const names = (s: TaskState) => landings(s).some(isPr) || s.passedChecks.some(isPr);
  const owned = states.filter((s) => s.state?.owner);
  return (owned.find((s) => names(s.state!)) ?? owned.find((s) => s.f === "state.json"))?.state?.owner;
}
