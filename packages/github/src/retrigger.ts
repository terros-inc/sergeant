import type { GitHubPort } from "@terros/sergeant-contracts";
import { graphqlErrors, pullRequestReviewers } from "./schemas.ts";

// TECH-6489: GitHub deletes a workflow run, and its check results with it, once the repository's Actions
// retention passes, and an expired run cannot be rerun. A required check that had passed then reads as
// never reported. Converting the PR to draft and back to ready for review sends `ready_for_review`, which
// fires the PR's CI again on the same head, so the head and its approvals stay as they are. A new commit
// would also re-trigger CI, but would change the head and void its reviews, so it is never pushed.

type Request = (path: string, init?: RequestInit) => Promise<unknown>;
type Retrigger = NonNullable<GitHubPort["retriggerChecks"]>;

const DRAFT = "mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { isDraft } } }";
const READY = "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }";

export async function retriggerChecks(request: Request, { repo, number, expectedHeadSha }: Parameters<Retrigger>[0]): ReturnType<Retrigger> {
  const live = pullRequestReviewers.parse(await request(`/repos/${repo}/pulls/${number}`));
  if (live.state !== "open") throw new Error(`${repo}#${number} is not open`);
  if (live.head.sha !== expectedHeadSha) throw new Error(`head moved: expected ${expectedHeadSha}, live ${live.head.sha}`);
  // A draft is not Sergeant's to make ready here: whoever made it one meant it.
  if (live.draft) throw new Error(`${repo}#${number} is a draft`);
  // GraphQL answers a failure with 200 and `errors`.
  const mutate = async (query: string) => {
    const answer = graphqlErrors.parse(
      await request("/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables: { id: live.node_id } }) }),
    );
    if (answer.errors?.length) throw new Error(answer.errors.map((e) => e.message).join("; "));
  };
  try {
    await mutate(DRAFT);
  } catch (e) {
    throw new Error(`could not convert ${repo}#${number} to draft: ${(e as Error).message}`);
  }
  try {
    await mutate(READY);
  } catch (e) {
    throw new Error(`converted ${repo}#${number} to draft but could not mark it ready for review again, so it may be left a draft: ${(e as Error).message}`);
  }
}
