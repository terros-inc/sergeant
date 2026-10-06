import type { RepoSlug } from "@terros/sergeant-contracts";
import { hasComment } from "./pr-feedback.ts";
import { gitRef, pullRequestHead, pullRequestList, pullRequestReviewers } from "./schemas.ts";
import { readSquashMessage } from "./squash-message.ts";

// The post-deploy smoke check's GitHub reads (TECH-5279) that the port only makes on the way to a write:
// the squash message a merge sends (TECH-5085), what a human handoff and a close read first (TECH-5244),
// and what deleting a closed PR's branch reads first (TECH-5230). Each
// is the production read and parser, with nothing written after it.

export type GitHubReadProbeOptions = {
  /** The control-plane App's installation token. */
  token: () => Promise<string>;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export function githubReadProbes(options: GitHubReadProbeOptions) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const read = async (path: string, allowStatuses: number[] = []): Promise<unknown> => {
    const res = await fetchFn(`${apiUrl}${path}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${await options.token()}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (allowStatuses.includes(res.status)) return undefined;
    if (!res.ok) throw new Error(`GitHub GET ${path} failed (${res.status})`);
    return res.json();
  };
  const get = (path: string) => read(path);

  return {
    /** The squash message `mergePullRequest` would send for this PR, built from its live title, body, and commits. */
    squashMessage: (repo: RepoSlug, number: number, squash: Parameters<typeof readSquashMessage>[3]) => readSquashMessage(get, repo, number, squash),
    /** The PR as `handToHuman` reads it before any step: draft, author, head, and requested reviewers and teams. */
    async handoffRead(repo: RepoSlug, number: number) {
      const live = pullRequestReviewers.parse(await get(`/repos/${repo}/pulls/${number}`));
      return {
        state: live.state,
        draft: live.draft,
        author: live.user.login,
        headSha: live.head.sha,
        requested: [...live.requested_reviewers.map((u) => u.login), ...live.requested_teams.map((t) => t.slug)],
        // What a handoff and a close read before posting their comment, so a retry never posts it twice.
        summaryPosted: await hasComment(get, repo, number, "sergeant-smoke-check: never posted"),
      };
    },
    /** What `deletePullRequestBranch` reads before any delete: the PR's head, the open PRs using its branch, and the branch tip. */
    async branchDeleteRead(repo: RepoSlug, number: number) {
      const live = pullRequestHead.parse(await get(`/repos/${repo}/pulls/${number}`));
      const { ref, sha } = live.head;
      const owner = repo.split("/")[0];
      const using = await Promise.all(
        [`head=${encodeURIComponent(`${owner}:${ref}`)}`, `base=${encodeURIComponent(ref)}`].map(async (filter) =>
          pullRequestList.parse(await get(`/repos/${repo}/pulls?state=open&${filter}&per_page=100`)),
        ),
      );
      const tip = await read(`/repos/${repo}/git/ref/heads/${ref.split("/").map(encodeURIComponent).join("/")}`, [404]);
      return { ref, openPullRequestsUsingIt: using.flat().filter((p) => p.number !== number).length, branch: tip ? (gitRef.parse(tip).object.sha === sha ? "at the PR head" : "moved") : "deleted" };
    },
  };
}
