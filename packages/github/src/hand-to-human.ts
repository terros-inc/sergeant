import { HumanHandoffError, type GitHubPort } from "@terros/sergeant-contracts";
import { issueComment, readAll } from "./pr-feedback.ts";
import { graphqlErrors, pullRequestReviewers } from "./schemas.ts";

// TECH-5244: in a `human` repository Sergeant never approves or merges. Once a head passes the merge
// gate, it is handed to a human: marked ready for review, review requested, and the review summary
// posted on the PR. Every step is safe to repeat.

// TECH-6374: once the latest summary is on the PR, the control-plane App's own earlier comments there
// (earlier heads' summaries) are minimized as outdated, so only the latest status shows. "Own" is
// GitHub's record of who posted it: a bot account, through this App's ID (`performed_via_github_app`),
// never a login a human or another App could resemble. Without `appId`, or when it is not confirmed
// as the App that posted the latest summary, nothing is hidden.
export type HandoffContext = { appId?: number; log: (line: string) => void };

type Request = (path: string, init?: RequestInit, options?: { allowStatuses?: number[] }) => Promise<unknown>;
type HandToHuman = NonNullable<GitHubPort["handToHuman"]>;

const READY = "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }";
const MINIMIZE = "mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } } }";

async function atStep<T>(step: HumanHandoffError["step"], operation: () => Promise<T>, context?: string): Promise<T> {
  try {
    return await operation();
  } catch (e) {
    throw new HumanHandoffError(step, `${context ?? ""}${(e as Error).message}`);
  }
}

export async function handToHuman(
  request: Request,
  { repo, number, expectedHeadSha, reviewers, comment }: Parameters<HandToHuman>[0],
  { appId, log }: HandoffContext,
): ReturnType<HandToHuman> {
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
  const { comments, latest } = await atStep("post review summary", async () => {
    const all = await readAll((p) => request(p), `/repos/${repo}/issues/${number}/comments`, issueComment);
    const posted = all.filter((c) => c.body === comment);
    if (posted.length > 0) return { comments: all, latest: posted };
    const created = issueComment.safeParse(await request(`/repos/${repo}/issues/${number}/comments`, { ...json, body: JSON.stringify({ body: comment }) }));
    return { comments: all, latest: created.success ? [created.data] : [] };
  });
  // Fail closed: `appId` is configuration, and if it named another App, matching on it alone would hide
  // that App's comments. So it must be the App GitHub records on the summary this token just posted (or,
  // on a retry, every comment already carrying it); otherwise nothing is hidden.
  const confirmed = appId !== undefined && latest.length > 0 && latest.every((c) => c.user?.type === "Bot" && c.performed_via_github_app?.id === appId);
  if (appId !== undefined && !confirmed) {
    log(`${repo}#${number}: hid no outdated comments: could not confirm the configured App ID ${appId} posted the latest summary`);
  }
  const own = confirmed ? comments.filter((c) => c.user?.type === "Bot" && c.performed_via_github_app?.id === appId) : [];
  // REST does not say whether a comment is already minimized, so an earlier one is asked again.
  for (const c of own.filter((c) => c.body !== comment && c.node_id)) {
    // Best effort: an earlier summary left visible is untidy, while failing here would undo a handoff
    // whose summary is already posted.
    try {
      const answer = graphqlErrors.parse(await request("/graphql", { ...json, body: JSON.stringify({ query: MINIMIZE, variables: { id: c.node_id } }) }));
      if (answer.errors?.length) throw new Error(answer.errors.map((e) => e.message).join("; "));
    } catch (e) {
      log(`${repo}#${number}: could not minimize outdated comment ${c.html_url}: ${(e as Error).message}`);
    }
  }
  return { requested };
}
