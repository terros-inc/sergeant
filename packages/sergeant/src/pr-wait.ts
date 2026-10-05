import { commentIdFor, outstandingChangeRequests, type BudgetStatus, type HumanPullRequestFeedback, type PullRequestFacts, type SituationReport } from "@terros/sergeant-contracts";
import { handoffKey } from "./handoff.ts";
import { rereviewKey } from "./rereview.ts";

// TECH-5218: a required human PR action is a human wait, like a question (TECH-5059). Waiting on a
// human's merge or re-review spends nothing of the task's window, and a human's review of the task's PR
// opens a fresh window from the review, exactly as an answer does. Both are read from GitHub and Linear
// every poll; nothing new is stored.

/** The newest human review or inline review comment on the task's PRs: what opens a fresh window. */
export function latestHumanReview(pullRequests: PullRequestFacts[]): HumanPullRequestFeedback | undefined {
  return pullRequests
    .flatMap((p) => p.humanFeedback)
    .filter((f) => f.kind === "review" || f.kind === "review_comment")
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .at(-1);
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
    const refused = situation.refusedMerges.find((r) => r.repo === pr.repo && r.number === pr.number && r.headSha === pr.headSha);
    if (refused && posted(handoffKey(issue.id, refused))) return `a human to merge ${pr.repo}#${pr.number}`;
    const reviewers = outstandingChangeRequests(pr.humanFeedback);
    if (reviewers.length > 0 && posted(rereviewKey(issue.id, pr))) return `${reviewers.join(", ")} to re-review ${pr.repo}#${pr.number}`;
  }
  return undefined;
}

/** Whether only the wall time is exhausted: spend is never a human wait. */
export const onlyWallTimeExhausted = (budget: BudgetStatus, now: Date) =>
  now.getTime() >= Date.parse(budget.wallDeadline) && budget.spentUsd < budget.costLimitUsd;
