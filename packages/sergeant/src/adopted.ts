import type { Conversation, GitHubPort, LinearPort, PullRequestFacts, RepoSlug } from "@terros/sergeant-contracts";
import { issueBranches } from "@terros/sergeant-runner";

// TECH-6164: a worker takes over the issue's branch or PR a human or another agent started, and pushes to
// it. The issue says which, in Sergeant's first comment for that work: the notice is decided and posted when
// the worker is started (execute.ts), before the run starts and so before any comment about its work. Such
// a PR gets no review round (its author is not the worker App, so G3 keeps Sergeant's reviewer off it).

/** Once per adopted set: the comment's id is derived from this key, so a later worker start posts nothing twice. */
export const adoptedKey = (issueId: string, items: string[]) => `adopted:${issueId}:${items.join(",")}`;

/**
 * What a worker starting on `repositories` takes over: the open PRs linked to the issue that the worker App
 * did not open, and the branches whose name holds the identifier exactly (`issueBranches`) that are not
 * Sergeant's own `sergeant/` ones. An unreadable branch list names only the PRs.
 */
export async function adoptions(
  issue: Pick<Conversation["issue"], "identifier" | "linkedPullRequests">,
  repositories: RepoSlug[],
  pullRequests: PullRequestFacts[],
  ports: { github: Pick<GitHubPort, "branches">; workerLogin: string; log?: (line: string) => void },
): Promise<string[]> {
  const prs = pullRequests.filter(
    (pr) =>
      repositories.includes(pr.repo) &&
      pr.state === "open" &&
      pr.author !== ports.workerLogin &&
      issue.linkedPullRequests.some((l) => l.repo === pr.repo && l.number === pr.number),
  );
  const branches = await Promise.all(
    repositories.map(async (repo) => {
      const names = await ports.github.branches?.(repo).catch((e: Error) => (ports.log?.(`${repo}: branches not read: ${e.message}`), []));
      // `issueBranches` reads `<repo>: <branch>`, as the worker's brief lists them.
      const own = issueBranches(issue.identifier, (names ?? []).filter((b) => !b.startsWith("sergeant/")).map((b) => `${repo}: ${b}`));
      return own.map((b) => `branch \`${b.slice(repo.length + 2)}\` in ${repo}`);
    }),
  );
  return [
    ...prs.map((pr) => `[${pr.repo}#${pr.number}](${pr.url}), which ${pr.author} opened`),
    ...branches.flat(),
  ].sort();
}

export type AdoptionNotice = { key: string; body: string };

/**
 * Posts the takeover notice, if any. A failed post never blocks the start: it is kept (`deferAdoption`)
 * and the loop posts it again every poll until Linear confirms it (`retryAdoptions`).
 */
export async function postAdoptions(
  issueId: string,
  items: string[],
  ports: { linear: Pick<LinearPort, "postComment">; deferAdoption?: (notice: AdoptionNotice) => Promise<void> },
  log: (line: string) => void,
): Promise<void> {
  if (items.length === 0) return;
  const notice = {
    key: adoptedKey(issueId, items),
    body:
      `Sergeant took over ${items.join("; ")}, and its worker continues there. ` +
      "Sergeant reviews and merges only PRs its own worker opened, so a human reviews and merges a PR taken over.",
  };
  await ports.linear.postComment({ issueId, ...notice }).then(
    () => log(`told the issue the worker takes over ${items.join("; ")}`),
    async (e: Error) => {
      log(`takeover comment not posted; the next poll tries again: ${e.message}`);
      await ports.deferAdoption?.(notice);
    },
  );
}

/**
 * Posts each kept notice again, under its own key, so Linear shows it at most once however often it is
 * tried, and drops each Linear confirms. The loop calls it every poll before anything that may comment,
 * so a notice that failed at the start still comes before a later comment that does post.
 */
export async function retryAdoptions(
  issueId: string,
  state: { unpostedAdoptions: AdoptionNotice[] },
  linear: Pick<LinearPort, "postComment">,
  log: (line: string) => void,
  save: () => Promise<void>,
): Promise<void> {
  for (const notice of [...state.unpostedAdoptions]) {
    const posted = await linear.postComment({ issueId, ...notice }).then(
      () => true,
      (e: Error) => (log(`takeover comment still not posted: ${e.message}`), false),
    );
    if (!posted) continue;
    state.unpostedAdoptions = state.unpostedAdoptions.filter((n) => n.key !== notice.key);
    await save();
    log(`posted the takeover comment ${notice.key}`);
  }
}
