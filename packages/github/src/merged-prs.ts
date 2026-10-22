import { Sha } from "@terros/sergeant-contracts";
import { z } from "zod";
import { closedPullRequests, graphqlErrors } from "./schemas.ts";

// TECH-6617: what the merged-PR audit (06 §8) reads from GitHub: the PRs merged into a repository's
// default branch in its window, the default branch just before a merge, and when a PR's reviews were
// last edited.

type Request = (path: string, init?: RequestInit) => Promise<unknown>;

/** Pages GitHub's closed PRs into the default branch, newest updated first, until one was last updated before `since`. */
export async function mergedPullRequests(request: Request, repo: string, since: Date) {
  const { default_branch: branch } = z.object({ default_branch: z.string().min(1) }).parse(await request(`/repos/${repo}`));
  const merged: { number: number; title: string; headSha: Sha; mergedSha: Sha; mergedAt: string }[] = [];
  for (let page = 1; ; page += 1) {
    const query = `state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=100&page=${page}`;
    const batch = closedPullRequests.parse(await request(`/repos/${repo}/pulls?${query}`));
    for (const pr of batch) {
      if (pr.merged_at && pr.merge_commit_sha && Date.parse(pr.merged_at) >= since.getTime()) {
        merged.push({ number: pr.number, title: pr.title, headSha: Sha.parse(pr.head.sha), mergedSha: Sha.parse(pr.merge_commit_sha), mergedAt: new Date(pr.merged_at).toISOString() });
      }
    }
    // A PR merges no later than its last update, so once one was last updated before `since`, every
    // PR after it on this ordering merged before `since` too.
    const last = batch.at(-1);
    if (batch.length < 100 || !last || Date.parse(last.updated_at) < since.getTime()) return merged;
    if (page === 30) throw new Error("GitHub's merged PR list exceeds 3000 PRs in the window");
  }
}

export async function firstParent(request: Request, repo: string, sha: Sha): Promise<Sha> {
  const commit = z.object({ parents: z.array(z.object({ sha: Sha })).min(1) }).parse(await request(`/repos/${repo}/git/commits/${sha}`));
  return commit.parents[0]!.sha;
}

const REVIEW_EDITS = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviews(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { databaseId lastEditedAt } }
  } }
}`;
const reviewPage = graphqlErrors.extend({
  data: z
    .object({
      repository: z.object({
        pullRequest: z.object({
          reviews: z.object({
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
            nodes: z.array(z.object({ databaseId: z.number().int().nullable(), lastEditedAt: z.string().nullable() }).nullable()),
          }),
        }),
      }),
    })
    .nullish(),
});

/**
 * When each of a PR's edited reviews was last edited, by its feedback id (`review:<id>`). GitHub's REST
 * API gives a review only its submission time, though its body can be edited later; GraphQL has the edit.
 */
export async function reviewEdits(request: Request, repo: string, number: number): Promise<Record<string, string>> {
  const [owner, name] = repo.split("/");
  const edits: Record<string, string> = {};
  let after: string | null = null;
  for (let page = 1; page <= 10; page++) {
    const body = JSON.stringify({ query: REVIEW_EDITS, variables: { owner, name, number, after } });
    // GraphQL answers a failure with 200 and `errors`.
    const answer = reviewPage.parse(await request("/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
    if (answer.errors?.length || !answer.data) throw new Error(answer.errors?.map((e) => e.message).join("; ") || `no reviews for ${repo}#${number}`);
    const reviews = answer.data.repository.pullRequest.reviews;
    for (const r of reviews.nodes) if (r?.databaseId != null && r.lastEditedAt) edits[`review:${r.databaseId}`] = new Date(r.lastEditedAt).toISOString();
    if (!reviews.pageInfo.hasNextPage) return edits;
    after = reviews.pageInfo.endCursor;
  }
  throw new Error(`more than 1000 reviews on ${repo}#${number}`);
}
