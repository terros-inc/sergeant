import { HumanHandoffError, type GitHubPort } from "@terros/sergeant-contracts";
import { hasComment } from "./pr-feedback.ts";
import { graphqlErrors, pullRequestReviewers } from "./schemas.ts";

// TECH-5244: in a `human` repository Sergeant never approves or merges. Once a head passes the merge
// gate, it is handed to a human: marked ready for review, review requested, and the review summary
// posted on the PR. Every step is safe to repeat.

type Request = (path: string, init?: RequestInit, options?: { allowStatuses?: number[] }) => Promise<unknown>;
type HandToHuman = NonNullable<GitHubPort["handToHuman"]>;

const READY = "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }";

async function atStep<T>(step: HumanHandoffError["step"], operation: () => Promise<T>, context?: string): Promise<T> {
  try {
    return await operation();
  } catch (e) {
    throw new HumanHandoffError(step, `${context ?? ""}${(e as Error).message}`);
  }
}

export async function handToHuman(request: Request, { repo, number, expectedHeadSha, reviewers, comment }: Parameters<HandToHuman>[0]): ReturnType<HandToHuman> {
  const path = `/repos/${repo}/pulls/${number}`;
  const json = { method: "POST", headers: { "Content-Type": "application/json" } };
  let live = await atStep("read pull request", async () => pullRequestReviewers.parse(await request(path)));
  if (live.state !== "open") throw new Error(`${repo}#${number} is not open`);
  if (live.head.sha !== expectedHeadSha) throw new Error(`head moved: expected ${expectedHeadSha}, live ${live.head.sha}`);
  if (live.draft) {
    // REST cannot mark a PR ready, and GraphQL answers a failure with 200 and `errors`. GitHub requests
    // the code owners' review as the PR becomes ready, so it is read again.
    const answer = await atStep(
      "mark ready",
      async () => graphqlErrors.parse(await request("/graphql", { ...json, body: JSON.stringify({ query: READY, variables: { id: live.node_id } }) })),
      `could not mark ${repo}#${number} ready for review: `,
    );
    if (answer.errors?.length) throw new HumanHandoffError("mark ready", `could not mark ${repo}#${number} ready for review: ${answer.errors.map((e) => e.message).join("; ")}`);
    live = await atStep("re-read pull request", async () => pullRequestReviewers.parse(await request(path)));
  }
  const owner = repo.split("/")[0];
  const requested = [...live.requested_reviewers.map((u) => u.login), ...live.requested_teams.map((t) => `${owner}/${t.slug}`)];
  // Only when nobody is asked yet: the code owners GitHub requested come first.
  const asked = requested.length > 0 ? [] : reviewers.filter((r) => r.toLowerCase() !== live.user.login.toLowerCase());
  // 422: GitHub cannot request this login (not a collaborator, say); then nobody is named as asked.
  if (asked.length > 0) {
    if (await atStep("request reviewers", () => request(`${path}/requested_reviewers`, { ...json, body: JSON.stringify({ reviewers: asked }) }, { allowStatuses: [422] }))) requested.push(...asked);
  }
  await atStep("post review summary", async () => {
    if (!(await hasComment((p) => request(p), repo, number, comment))) {
      await request(`/repos/${repo}/issues/${number}/comments`, { ...json, body: JSON.stringify({ body: comment }) });
    }
  });
  return { requested };
}
