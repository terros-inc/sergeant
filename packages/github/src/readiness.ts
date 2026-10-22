import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { type GitHubAccount, type GitHubPort, type ReadinessReview, Sha } from "@terros/sergeant-contracts";
import { z } from "zod";
import { issueComment, readAll } from "./pr-feedback.ts";
import { graphqlErrors, pullRequestReviewers } from "./schemas.ts";

type Request = (path: string, init?: RequestInit, options?: { allowStatuses?: number[] }) => Promise<unknown>;
type Declare = NonNullable<GitHubPort["declareReadiness"]>;
const MINIMIZE = "mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } } }";
const lineFor = (sha: string) => `READY TO MERGE | SHA: ${sha}`;
const summaryHead = (body: string) => body.match(/^READY TO MERGE \| SHA: ([0-9a-f]{40}|[0-9a-f]{64})$/m)?.[1];
const legacySummary = (body: string) => body.startsWith("**Ready for a human to merge**");
export async function declareReadiness(
  request: Request,
  req: Parameters<Declare>[0],
  context: { appId?: number; publicDataDenylist?: string; log: (line: string) => void },
): ReturnType<Declare> {
  const path = `/repos/${req.repo}/pulls/${req.number}`;
  const live = pullRequestReviewers.parse(await request(path));
  if (live.state !== "open") throw new Error(`${req.repo}#${req.number} is not open`);
  if (live.head.sha !== req.expectedHeadSha) throw new Error(`head moved: expected ${req.expectedHeadSha}, live ${live.head.sha}`);
  const comments = await readAll((p) => request(p), `/repos/${req.repo}/issues/${req.number}/comments`, issueComment);
  const own = comments.filter((comment) => context.appId !== undefined && comment.user?.type === "Bot" && comment.performed_via_github_app?.id === context.appId);
  const existing = own.find((comment) => comment.body?.split("\n", 1)[0] === lineFor(req.expectedHeadSha));
  if (existing) return { id: existing.id, url: existing.html_url, comment: existing.body ?? req.comment };

  let body = req.comment;
  const visibility = z.object({ visibility: z.enum(["public", "private", "internal"]) }).safeParse(await request(`/repos/${req.repo}`));
  if (!visibility.success || visibility.data.visibility === "public") {
    const script = join(import.meta.dirname, "../../runner/container/check-public-data.mjs");
    const checked = context.publicDataDenylist
      ? spawnSync(process.execPath, [script, "text", "readiness text"], { input: req.modelText, env: { ...process.env, PUBLIC_DATA_DENYLIST: context.publicDataDenylist } })
      : undefined;
    if (!checked || checked.status !== 0) body = req.fallbackComment;
  }
  const created = issueComment.parse(await request(`/repos/${req.repo}/issues/${req.number}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) }));
  const confirmed = context.appId !== undefined && created.user?.type === "Bot" && created.performed_via_github_app?.id === context.appId;
  if (confirmed) {
    for (const comment of own.filter((candidate) => candidate.node_id && candidate.id !== created.id && (legacySummary(candidate.body ?? "") || (summaryHead(candidate.body ?? "") !== undefined && summaryHead(candidate.body ?? "") !== req.expectedHeadSha)))) {
      try {
        const answer = graphqlErrors.parse(await request("/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: MINIMIZE, variables: { id: comment.node_id } }) }));
        if (answer.errors?.length) throw new Error(answer.errors.map((error) => error.message).join("; "));
      } catch (error) {
        context.log(`${req.repo}#${req.number}: could not minimize outdated comment ${comment.html_url}: ${(error as Error).message}`);
      }
    }
  }
  return { id: created.id, url: created.html_url, comment: body };
}

type ReadReadiness = NonNullable<GitHubPort["readReadiness"]>;
const account = z.object({ login: z.string().min(1), type: z.string() }).nullable();
/** A deleted account (`null`) is GitHub's `ghost`, a person; only `Bot` is a bot. */
const accountOf = (u: z.infer<typeof account>): GitHubAccount => (u === null ? { login: "ghost", type: "User" } : { login: u.login, type: u.type === "Bot" ? "Bot" : "User" });
const declaredPullRequest = z.object({
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  merged_by: account.optional(),
  closed_at: z.string().nullish(),
  head: z.object({ sha: Sha }),
});
const review = z.object({ user: account, state: z.string(), commit_id: z.string().nullable(), submitted_at: z.string().nullish() });
const timelineEvent = z.looseObject({ event: z.string().optional(), actor: account.optional() });
const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]);

/** TECH-6613: the facts `classifyReadiness` needs for one declaration (design 16 §5.2), read, never kept. */
export async function readReadiness(request: Request, req: Parameters<ReadReadiness>[0], appId: number | undefined): ReturnType<ReadReadiness> {
  if (appId === undefined) throw new Error("no control-plane App id is configured, so Sergeant's own declarations cannot be told apart");
  const get = (path: string) => request(path);
  const [pr, reviews, comment] = await Promise.all([
    request(`/repos/${req.repo}/pulls/${req.number}`).then((body) => declaredPullRequest.parse(body)),
    readAll(get, `/repos/${req.repo}/pulls/${req.number}/reviews`, review),
    request(`/repos/${req.repo}/issues/comments/${req.commentId}`, {}, { allowStatuses: [404] }).then((body) => (body === null ? null : issueComment.extend({ issue_url: z.string() }).parse(body))),
  ]);
  const merged = pr.merged_at !== null;
  // Only a merge can have gone through a merge queue: the timeline says whether it did and who queued it.
  const queue = merged
    ? (await readAll(get, `/repos/${req.repo}/issues/${req.number}/timeline`, timelineEvent)).filter((e) => e.event === "added_to_merge_queue" || e.event === "removed_from_merge_queue").at(-1)
    : undefined;
  const onThisPr = comment !== null && comment.issue_url.endsWith(`/repos/${req.repo}/issues/${req.number}`);
  return {
    declaration: onThisPr
      ? { id: String(comment.id), body: comment.body ?? "", author: accountOf(comment.user), performedViaGitHubAppId: comment.performed_via_github_app?.id ?? null, sergeantAppId: appId, createdAt: comment.created_at }
      : null,
    facts: {
      state: merged ? "merged" : pr.state,
      headSha: pr.head.sha,
      mergedAt: pr.merged_at,
      mergedBy: merged && pr.merged_by ? accountOf(pr.merged_by) : null,
      closedAt: pr.closed_at ?? null,
      reviews: reviews.flatMap((r) => {
        const commitId = Sha.safeParse(r.commit_id);
        return r.submitted_at && commitId.success && REVIEW_STATES.has(r.state)
          ? [{ author: accountOf(r.user), state: r.state as ReadinessReview["state"], commitId: commitId.data, submittedAt: r.submitted_at }]
          : [];
      }),
      mergedViaMergeQueue: queue?.event === "added_to_merge_queue",
      addedToMergeQueueActor: queue?.event === "added_to_merge_queue" && queue.actor ? accountOf(queue.actor) : null,
    },
  };
}
