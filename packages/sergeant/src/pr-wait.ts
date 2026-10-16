import { commentIdFor, outstandingChangeRequests, type HumanComment, type HumanPullRequestFeedback, type SituationReport } from "@terros/sergeant-contracts";
import { handoffKey } from "./handoff.ts";
import { rereviewKey } from "./rereview.ts";

// TECH-5218: a required human PR action is a human wait, like a question (TECH-5059). TECH-6165: the
// budget counts only active time (budget.ts), so the wait spends none of the task's window, and any human
// direction on the issue or its PRs opens a fresh window from it. Both are read from GitHub and Linear
// every poll; nothing new is stored.

/**
 * Every human direction that opens a fresh window: each human comment on the issue (answers included),
 * and each human review, inline comment or comment on the task's PRs. Bots' and apps' never are: the
 * Linear adapter keeps them out of `humanComments` (a comment posted through a person's own account, by
 * their assistant say, is that person's), and the GitHub adapter out of `humanFeedback`. Keep every
 * reader of window starts here.
 */
export function humanDirection(situation: Pick<SituationReport, "conversation" | "pullRequests">): (HumanPullRequestFeedback | HumanComment)[] {
  return [...situation.pullRequests.flatMap((p) => p.humanFeedback), ...situation.conversation.humanComments];
}

/**
 * TECH-6165: the latest time Sergeant handed a now merged or closed PR to a human, to merge or to
 * re-review. Its end is reconciled in a turn (poll-checks.ts `reconcileDue`), but it is not direction:
 * GitHub's PR facts do not say who merged or closed it, so it opens no window.
 */
export function endedHandoff(situation: Pick<SituationReport, "conversation" | "pullRequests">): { pr: string; state: string; askedAt: string } | undefined {
  const { issue, agentComments } = situation.conversation;
  const ended = situation.pullRequests.filter((p) => p.state !== "open").flatMap((pr) => {
    const keys = [handoffKey(issue.id, pr), rereviewKey(issue.id, pr)].map(commentIdFor);
    return agentComments.filter((c) => keys.includes(c.id)).map((c) => ({ pr: `${pr.repo}#${pr.number}`, state: pr.state, askedAt: c.createdAt }));
  });
  return ended.toSorted((a, b) => Date.parse(a.askedAt) - Date.parse(b.askedAt)).at(-1);
}

/**
 * The human PR action Sergeant is waiting on, if that is all it waits on: an open PR at the head it told
 * the issue is ready for a human to merge (a required review it cannot give, such as a code owner's,
 * TECH-4987), or at the head it asked a human who requested changes to re-review or dismiss (TECH-4992).
 * Both are read from Sergeant's own comments on the issue, keyed by the PR's head.
 */
export function awaitedHumanPrAction(situation: SituationReport): string | undefined {
  const { issue, agentComments } = situation.conversation;
  const posted = (key: string) => agentComments.some((c) => c.id === commentIdFor(key));
  for (const pr of situation.pullRequests.filter((p) => p.state === "open")) {
    if (posted(handoffKey(issue.id, pr))) return `a human to merge ${pr.repo}#${pr.number}`;
    const reviewers = outstandingChangeRequests(pr.humanFeedback);
    if (reviewers.length > 0 && posted(rereviewKey(issue.id, pr))) return `${reviewers.join(", ")} to re-review ${pr.repo}#${pr.number}`;
  }
  return undefined;
}
