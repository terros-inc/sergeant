import { commentIdFor, issueRevision, rereviewRequests, type LinearPort, type PullRequestFacts, type SituationReport } from "@terros/sergeant-contracts";

// TECH-4992: a human's requested changes block the merge (M8) until that human approves or someone
// dismisses the review. Once a successor's head has addressed them and the merge gate would pass it but
// for M8, nothing else is left for Sergeant to do, so it asks the human once, on the issue, to re-review or dismiss.
// "Would merge" is the executor's own merge preflight (TECH-5065): the live checks (A1, A2) and the
// budget (B1) as well as the merge gate, so an exhausted budget or a stopped issue asks no one.

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
  situation: SituationReport,
  owner: { workerLogin: string; agentUserId: string },
  linear: Pick<LinearPort, "postComment">,
  log: (line: string) => void,
): Promise<void> {
  const { issue, agentComments } = situation.conversation;
  // The merge preflight's facts as of this poll, for a merge proposed from this very situation.
  const facts = { ...situation, ...owner, agentComments, issue, linkedPullRequests: issue.linkedPullRequests, issueIdentifier: issue.identifier, now: new Date() };
  const live = { liveConversationRevision: situation.conversationRevision, liveIssueRevision: issueRevision(issue) };
  for (const pr of situation.pullRequests) {
    const reviewers = rereviewRequests({ ...facts, ...live, pr });
    const key = rereviewKey(issue.id, pr);
    if (reviewers.length === 0 || agentComments.some((c) => c.id === commentIdFor(key))) continue;
    await linear.postComment({ issueId: issue.id, body: rereviewComment(pr, reviewers), key }).then(
      () => log(`${pr.repo}#${pr.number}: asked ${reviewers.join(", ")} to re-review or dismiss`),
      (e: Error) => log(`${pr.repo}#${pr.number}: re-review request not posted: ${e.message}`),
    );
  }
}
