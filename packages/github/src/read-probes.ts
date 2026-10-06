import type { RepoSlug } from "@terros/sergeant-contracts";
import { pullRequestReviewers } from "./schemas.ts";
import { readSquashMessage } from "./squash-message.ts";

// The post-deploy smoke check's GitHub reads (TECH-5279) that the port only makes on the way to a write:
// the squash message a merge sends (TECH-5085) and what a human handoff reads first (TECH-5244). Each
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
  const get = async (path: string): Promise<unknown> => {
    const res = await fetchFn(`${apiUrl}${path}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${await options.token()}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) throw new Error(`GitHub GET ${path} failed (${res.status})`);
    return res.json();
  };

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
      };
    },
  };
}
