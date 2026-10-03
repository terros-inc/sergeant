import { commentIdFor, rereviewRequests, type Conversation, type LinearPort, type PullRequestFacts, type RunRecord } from "@terros/sergeant-contracts";

// TECH-4992: a human's requested changes block the merge (M8) until that human approves or someone
// dismisses the review. Once a successor's head has addressed them, is reviewed, mergeable, and green,
// nothing else is left for Sergeant to do, so it asks the human once, on the issue, to re-review or dismiss.

/** Once per PR head: the comment's id is derived from this key, so Linear shows whether it was posted. */
export const rereviewKey = (issueId: string, pr: PullRequestFacts) => `rereview:${issueId}:${pr.repo}#${pr.number}:${pr.headSha}`;

export function rereviewComment(pr: PullRequestFacts, reviewers: string[]): string {
  const who = reviewers.map((r) => `@${r}`).join(", ");
  return [
    "**Re-review needed**",
    "",
    `${who} on GitHub: your requested changes on [${pr.repo}#${pr.number}](${pr.url}) have been addressed at head \`${pr.headSha}\`, which is reviewed, mergeable, and has green required checks.`,
    "",
    "Merging waits on your review. Please re-review it, or dismiss your review.",
  ].join("\n");
}

/**
 * Posts each PR's re-review request that Linear does not show yet. Rereading the issue's comments is
 * the record: a failed post is tried again next poll, and the key posts nothing new however often.
 */
export async function postRereviewRequests(
  conversation: Conversation,
  pullRequests: PullRequestFacts[],
  runs: RunRecord[],
  linear: Pick<LinearPort, "postComment">,
  log: (line: string) => void,
): Promise<void> {
  const issueId = conversation.issue.id;
  for (const pr of pullRequests) {
    const reviewers = rereviewRequests(pr, runs);
    const key = rereviewKey(issueId, pr);
    if (reviewers.length === 0 || conversation.agentComments.some((c) => c.id === commentIdFor(key))) continue;
    await linear.postComment({ issueId, body: rereviewComment(pr, reviewers), key }).then(
      () => log(`${pr.repo}#${pr.number}: asked ${reviewers.join(", ")} to re-review or dismiss`),
      (e: Error) => log(`${pr.repo}#${pr.number}: re-review request not posted: ${e.message}`),
    );
  }
}
