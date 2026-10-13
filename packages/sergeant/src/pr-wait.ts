import { commentIdFor, outstandingChangeRequests, type HumanComment, type HumanPullRequestFeedback, type PullRequestFacts, type SituationReport } from "@terros/sergeant-contracts";
import { handoffKey } from "./handoff.ts";
import { rereviewKey } from "./rereview.ts";

// TECH-5218: a required human PR action is a human wait, like a question (TECH-5059). Waiting on a
// human's merge or re-review spends nothing of the task's window, and a human's review of the task's PR
// opens a fresh window from the review, exactly as an answer does. Both are read from GitHub and Linear
// every poll; nothing new is stored.

/** Every human review or inline review comment: each may open a window without an escalation. */
export const humanPrFeedback = (pullRequests: PullRequestFacts[]): HumanPullRequestFeedback[] =>
  pullRequests.flatMap((p) => p.humanFeedback).filter((f) => f.kind !== "comment");

/** Human PR and issue feedback that opens a review window. Keep every reader of window starts here. */
export function reviewWindowFeedback(situation: Pick<SituationReport, "conversation" | "pullRequests" | "refusedMerges">): (HumanPullRequestFeedback | HumanComment)[] {
  const escalatedComments = situation.pullRequests.flatMap((pr) => {
    const escalations = escalationComments(situation, pr);
    const at = escalations.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1)?.createdAt;
    return at ? pr.humanFeedback.filter((f) => f.kind === "comment" && Date.parse(f.createdAt) > Date.parse(at)) : [];
  });
  const issueResponse = latestIssueResponseToPrWait(situation);
  return [...humanPrFeedback(situation.pullRequests), ...escalatedComments, ...(issueResponse ? [issueResponse] : [])];
}

function escalationComments(situation: Pick<SituationReport, "conversation" | "pullRequests" | "refusedMerges">, pr: PullRequestFacts) {
  const { issue, agentComments } = situation.conversation;
  // The handoff comment's key is durable even after changed conversation facts correctly drop the
  // refusal record that enforced M12. Keep using that head-keyed comment as the escalation anchor.
  const keys = [handoffKey(issue.id, pr), ...(outstandingChangeRequests(pr.humanFeedback).length > 0 ? [rereviewKey(issue.id, pr)] : [])];
  return keys.flatMap((key) => agentComments.filter((c) => c.id === commentIdFor(key)));
}

/** The newest issue comment after a head-keyed handoff or re-review request. */
function latestIssueResponseToPrWait(situation: Pick<SituationReport, "conversation" | "pullRequests" | "refusedMerges">): HumanComment | undefined {
  const { humanComments } = situation.conversation;
  const waits = situation.pullRequests.flatMap((pr) => escalationComments(situation, pr));
  const lastWait = waits.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1);
  if (!lastWait) return undefined;
  return humanComments.filter((c) => Date.parse(c.createdAt) > Date.parse(lastWait.createdAt)).toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).at(-1);
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
