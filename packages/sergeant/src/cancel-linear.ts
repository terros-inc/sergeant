import type { Conversation, PullRequestFacts, RunId } from "@terros/sergeant-contracts";
import type { CancelIntent, Handoff } from "./cancel-intent.ts";
import type { Ports } from "./execute.ts";

// A stop's Linear side (cancel.ts): a handoff's issue changes, and the comments a stop posts.

/**
 * A handoff's Linear effects, decided on the issue as it is now, reread once the runs are stopped, so a
 * stop driven late never undoes a newer human action. A completed issue, or a task whose work already
 * merged, keeps its status and its delegation. Otherwise Sergeant's delegation is removed unless Linear shows a newer valid delegation
 * than the stopped owner's (the new assignee already delegated it: that is the next task), and an issue
 * in progress goes back to Todo; one a human moved anywhere else stays there. Safe to repeat.
 */
export async function handOff(issue: Conversation["issue"], handoff: Handoff, deps: Ports, log: (line: string) => void): Promise<{ completed: boolean; undelegated: boolean; newer: boolean; todo: boolean }> {
  if (handoff.merged || issue.stateType === "completed") return { completed: true, undelegated: false, newer: false, todo: false };
  let undelegated = false;
  let newer = false;
  if (issue.delegate?.id === deps.agentUserId) {
    const check = await deps.linear.readTaskOwner(issue.id, deps.agentUserId);
    newer = "owner" in check && check.delegatedAt !== handoff.delegatedAt;
    if (!newer) {
      if (!deps.linear.undelegate) throw new Error("this Sergeant cannot remove a delegation");
      await deps.linear.undelegate(issue.id);
      undelegated = true;
      log(`${issue.identifier}: handoff: Sergeant's delegation removed`);
    }
  }
  if (!deps.linear.moveIssueToTodo) throw new Error("this Sergeant cannot move an issue back to Todo");
  const moved = await deps.linear.moveIssueToTodo(issue.id);
  if (moved.moved) log(`${issue.identifier}: handoff: moved from ${moved.from} to ${moved.to}`);
  return { completed: false, undelegated, newer, todo: moved.moved || issue.stateType === "unstarted" };
}

export function handoffComment(
  reason: string,
  issue: Conversation["issue"],
  prs: PullRequestFacts[],
  done: { completed: boolean; undelegated: boolean; newer: boolean; todo: boolean },
  unreadable: RunId[],
): string {
  const kept = prs.length > 0
    ? `Its PRs and branches are kept: ${prs.map((p) => `[${p.repo}#${p.number}](${p.url})${p.state === "open" ? "" : ` (${p.state})`}`).join(", ")}.`
    : "Its branches are kept; it has no PR.";
  const missing = unreadable.length > 0 ? ` The final report for ${unreadable.map((id) => `run \`${id}\``).join(", ")} could not be read.` : "";
  const stopped = `Sergeant stopped working on this issue: ${reason}. Its runs are canceled, so they spend no more of the previous owner's model quota.${missing}`;
  if (done.completed) return `${stopped} Its work is already merged, so the issue is left as it is.`;
  const linear = [done.todo && "back in Todo", done.undelegated && "no longer delegated to Sergeant"].filter(Boolean).join(" and ");
  const who = issue.assignee?.name ?? "Whoever is assigned next";
  const next = done.newer
    ? `A newer delegation to Sergeant is in place, so it starts a fresh task on its delegator's own model accounts, with this work available.`
    : `${who} can continue it personally, or delegate it to Sergeant, which then starts a fresh task paid only by their own model accounts, with this work available.`;
  return `${stopped} ${kept}${linear ? ` The issue is ${linear}.` : ""}\n\n${next}`;
}

export function stopComment(intent: CancelIntent, unreadable: RunId[]): string {
  const closed = intent.closed.length > 0 ? `Closed ${intent.closed.map((p) => `[${p.repo}#${p.number}](${p.url})`).join(", ")}.` : "No open PR to close.";
  const missing = unreadable.length > 0
    ? ` The final report for ${unreadable.map((id) => `run \`${id}\``).join(", ")} could not be read; a human may need to close any PR Sergeant could not see.`
    : "";
  return `Sergeant stopped working on this issue: ${intent.reason}. Its runs are canceled.${missing} ${closed}\n\nTo start again, delegate it to Sergeant and move it to Todo: it starts as a fresh task.`;
}

export function stalledStopComment(runIds: RunId[], stalledForMinutes: number, handoff: boolean): string {
  const prs = handoff
    ? "The stop remains pending until every run is confirmed stopped; its PRs and branches are kept"
    : "Its PRs stay open and the stop remains pending until every run is confirmed stopped, so none can push to a PR after Sergeant closes it";
  return `Sergeant has been trying to stop this task for over ${stalledForMinutes} minutes, but the runner has not confirmed the cancellation of ${runIds.map((id) => `run \`${id}\``).join(", ")}. ${prs}, and Sergeant will not restart this issue while it is pending. To clear it, make sure the runner can cancel those runs; Sergeant will keep retrying automatically.`;
}
