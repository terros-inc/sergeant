import type { LinearPerson, LinearPort, NoModelAccount, StartedRun, TaskOwnerCheck } from "@terros/sergeant-contracts";

// Who pays for a task's model usage (TECH-5179). A task belongs to one human: the issue's assignee,
// admitted only when Linear's history shows that same person most recently delegated it to Sergeant,
// so nobody can assign an issue to someone else and delegate it to spend that person's quota. The
// owner is recorded in the task's `state.json` on admission and never changes for that task: a
// reassignment while it runs moves no quota, and an issue stopped and delegated again is a new task
// that is checked afresh. Every worker and reviewer runs only on the owner's registered accounts
// (runner `accounts.ts`). Each refusal is said once on the issue per condition, keyed by what Linear
// showed, so a reconciliation poll never repeats it.

/** The task's owner as `state.json` records it: who, and when the task was admitted for them. */
export type TaskOwner = LinearPerson & { admittedAt: string };

/** What a refusal tells the humans on the issue, and the key that keeps it to one comment per condition. */
export function ownerRefusal(issueId: string, check: Exclude<TaskOwnerCheck, { owner: LinearPerson }>): { key: string; body: string } | undefined {
  const { refused, assignee, delegator, delegatedAt } = check;
  const key = `owner-refusal:${issueId}:${refused}:${assignee?.id ?? "-"}:${delegator?.id ?? "-"}:${delegatedAt ?? "-"}`;
  switch (refused) {
    case "not_delegated":
      return undefined;
    case "no_assignee":
      return { key, body: "Sergeant cannot start until this issue is assigned to a human. Assign it to the person whose model accounts should pay for it, and have them delegate it to Sergeant." };
    case "delegator_unknown":
      return {
        key,
        body: `Sergeant cannot start: Linear's history does not show ${assignee?.name ?? "the assignee"} delegating this issue to Sergeant, so it cannot spend their model quota. Have ${assignee?.name ?? "the assignee"} delegate it to Sergeant themselves.`,
      };
    case "delegator_differs": {
      const a = assignee?.name ?? "the assignee";
      const d = delegator?.name ?? "someone else";
      return {
        key,
        body: `Sergeant cannot spend ${a}'s model quota because ${d} delegated the issue. If you want Sergeant to run this work, assign the issue to yourself first, then delegate it to Sergeant; or have ${a} delegate it themselves.`,
      };
    }
  }
}

/**
 * The owner of a task being admitted, or why it is refused: then the refusal is said on the issue,
 * once per condition. Fails closed: Linear unreadable admits nobody.
 */
export async function admitOwner(issueId: string, deps: { linear: LinearPort; agentUserId: string }, log: (line: string) => void): Promise<TaskOwner | { refused: string }> {
  let check: TaskOwnerCheck;
  try {
    check = await deps.linear.readTaskOwner(issueId, deps.agentUserId);
  } catch (e) {
    return { refused: `not started: who delegated ${issueId} is unreadable: ${(e as Error).message}` };
  }
  if ("owner" in check) {
    log(`owned by ${check.owner.name} (${check.owner.id}), who assigned and delegated it: its runs use only their model accounts`);
    return { ...check.owner, admittedAt: new Date().toISOString() };
  }
  const refusal = ownerRefusal(issueId, check);
  if (refusal) {
    await deps.linear.postComment({ issueId, ...refusal }).catch((e: Error) => log(`could not post the ${check.refused} refusal: ${e.message}`));
  }
  return { refused: `not started: no owner (${check.refused})` };
}

/** What Sergeant says when the owner has no model account a run may use; one comment per condition. */
export function accountRefusal(issueId: string, owner: TaskOwner, e: NoModelAccount): { key: string; body: string } {
  const key = `owner-accounts:${issueId}:${owner.id}:${owner.admittedAt}:${e.kind}:${e.accountIds.join(",")}`;
  const wake = "then comment here, or run `sgt task wake`, so Sergeant tries again";
  if (e.kind === "none_registered") {
    return {
      key,
      body: `Sergeant needs one of ${owner.name}'s model accounts before it can start. ${owner.name}: register one with \`sgt account register claude-code-local\` (or \`codex-local\`), ${wake}.`,
    };
  }
  return {
    key,
    body: `Sergeant starts no new runs: ${e.message}. ${owner.name}: register or fix another model account with \`sgt account register <claude-code-local|codex-local>\`, ${wake}.`,
  };
}

/** The warning when a run starts on the owner's only usable account below the 5-hour floor; one per account per 5-hour window. */
export function lowQuotaWarning(issueId: string, owner: TaskOwner, low: NonNullable<StartedRun["lowQuota"]>, runId: string): { key: string; body: string } {
  const left = Math.round(low.fiveHourPercent * 10) / 10;
  const resets = low.resetsAt ? ` until it resets at ${low.resetsAt}` : "";
  return {
    key: `owner-low-quota:${issueId}:${low.accountId}:${low.resetsAt ?? runId}`,
    body: `Heads up, ${owner.name}: Sergeant is running this task on \`${low.accountId}\`, your only usable model account, with ${left}% of its 5-hour window left${resets}, so runs may stop short. Registering another account (\`sgt account register <claude-code-local|codex-local>\`) gives Sergeant one to switch to.`,
  };
}
