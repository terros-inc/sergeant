import type { GitHubPort, RepoSlug } from "@terros/sergeant-contracts";

/**
 * The line a filed follow-up records (TECH-5258): each repository's default-branch commit it was
 * written against, read when it is filed. Other work lands before someone picks it up, so the worker
 * that does checks its paths and scope against the default branch then. A read that fails says so and
 * never stops the filing. Empty with no repository, or a GitHub port that cannot read the head.
 */
export async function writtenAgainst(github: Pick<GitHubPort, "defaultBranchHead">, repos: RepoSlug[]): Promise<string> {
  const read = github.defaultBranchHead?.bind(github);
  if (!read || repos.length === 0) return "";
  const heads = await Promise.all(
    [...new Set(repos)].map(async (repo) => {
      try {
        const { branch, sha } = await read(repo);
        return `\`${repo}\` ${branch} at \`${sha}\``;
      } catch (e) {
        return `\`${repo}\` (not recorded: ${(e as Error).message.slice(0, 200)})`;
      }
    }),
  );
  return `**Written against:** ${heads.join(", ")}. Its file paths, line numbers and scope are as of then: check them against the current default branch first.`;
}
