import { commentIdFor, type LinearPort, type SituationReport } from "@terros/sergeant-contracts";

// TECH-6164: a worker takes over the issue's PR a human or another agent started, and pushes to it. The
// issue then says which PR was taken over, once per PR, as soon as a worker's report names it: such a PR
// gets no review round (its author is not the worker App, so G3 keeps Sergeant's reviewer off it), and so
// no progress comment (progress.ts) that would quote the worker's summary.

/** Once per adopted PR: the comment's id is derived from this key, so Linear shows whether it was posted. */
export const adoptedKey = (issueId: string, pr: { repo: string; number: number }) => `adopted:${issueId}:${pr.repo}#${pr.number}`;

/** The open PRs a worker reported pushing to that the worker App did not open, not yet told on the issue. */
export function pendingAdoptions(situation: Pick<SituationReport, "conversation" | "runs" | "pullRequests">, workerLogin: string) {
  const { conversation, runs, pullRequests } = situation;
  const reported = runs.flatMap((r) => (r.role === "worker" && r.report ? r.report.pullRequests : []));
  return pullRequests.filter(
    (pr) =>
      pr.state === "open" &&
      pr.author !== workerLogin &&
      reported.some((p) => p.repo === pr.repo && p.number === pr.number) &&
      !conversation.agentComments.some((c) => c.id === commentIdFor(adoptedKey(conversation.issue.id, pr))),
  );
}

/** Posts each pending adoption; a failed post is tried again next poll, and the key posts nothing twice. */
export async function postAdoptions(
  situation: Pick<SituationReport, "conversation" | "runs" | "pullRequests">,
  workerLogin: string,
  linear: Pick<LinearPort, "postComment">,
  log: (line: string) => void,
): Promise<void> {
  const issueId = situation.conversation.issue.id;
  for (const pr of pendingAdoptions(situation, workerLogin)) {
    const body =
      `Sergeant took over [${pr.repo}#${pr.number}](${pr.url}), which ${pr.author} opened, and continues on its branch. ` +
      "Sergeant reviews and merges only PRs its own worker opened, so a human reviews and merges this one.";
    await linear.postComment({ issueId, body, key: adoptedKey(issueId, pr) }).then(
      () => log(`${pr.repo}#${pr.number}: told the issue the worker took it over`),
      (e: Error) => log(`${pr.repo}#${pr.number}: takeover comment not posted: ${e.message}`),
    );
  }
}
