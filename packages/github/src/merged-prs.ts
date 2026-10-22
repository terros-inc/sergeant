import { Sha } from "@terros/sergeant-contracts";
import { z } from "zod";
import { closedPullRequests } from "./schemas.ts";

// TECH-6617: what the merged-PR audit (06 §8) reads from GitHub: the PRs merged into a repository's
// default branch in its window, and the default branch just before a merge.

type Request = (path: string) => Promise<unknown>;

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
