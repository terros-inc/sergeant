import type { Conversation, PullRequestFacts } from "@terros/sergeant-contracts";
import type { Ports } from "./execute-types.ts";

// TECH-6428: every PR the worker opens for a task is assigned on GitHub to the task's requestor, its
// owner (owner.ts): the issue's assignee who delegated it. Their GitHub login is the one
// `linear.reviewerProfiles` maps their Linear profile to, as for a human-merge handoff's review request.
// Best effort: with no owner, no mapping, or an assignment GitHub refuses or drops (not a collaborator,
// say), the PR and the task go on and a warning is logged. Each PR is tried once per loop process, so a
// login GitHub cannot assign costs no call every poll; a restart tries again, which GitHub's additive,
// repeatable assignment makes harmless.

type Deps = Pick<Ports, "github" | "workerLogin" | "githubLoginForLinearProfile" | "owner">;

/** The requestor's GitHub login, or why there is none. */
function requestorLogin(issue: Conversation["issue"], deps: Deps): { login: string } | { missing: string } {
  const { owner } = deps;
  if (!owner) return { missing: "the task has no recorded owner" };
  // The owner's Linear profile is read from the live assignee, who is the owner while the task runs;
  // a reassigned issue stops the task (owner.ts), and its new assignee is never assigned meanwhile.
  if (issue.assignee?.id !== owner.id) return { missing: `the issue is no longer assigned to ${owner.name}` };
  const url = issue.assignee.url;
  if (!url) return { missing: `Linear shows no profile URL for ${owner.name}` };
  const login = deps.githubLoginForLinearProfile?.(url);
  return login ? { login } : { missing: `linear.reviewerProfiles maps no GitHub login to ${owner.name}'s Linear profile ${url}` };
}

/** Assigns each of the worker's open PRs not yet tried to the requestor; never throws. */
export function ownerAssignments(deps: Deps, log: (line: string) => void) {
  const tried = new Set<string>();
  return async (pullRequests: PullRequestFacts[], issue: Conversation["issue"]): Promise<void> => {
    const assign = deps.github.assignPullRequest?.bind(deps.github);
    if (!assign) return;
    for (const pr of pullRequests) {
      const key = `${pr.repo}#${pr.number}`;
      if (pr.state !== "open" || pr.author !== deps.workerLogin || tried.has(key)) continue;
      tried.add(key);
      const who = requestorLogin(issue, deps);
      if ("missing" in who) {
        log(`warning: ${key} not assigned to its requestor: ${who.missing}`);
        continue;
      }
      await assign({ repo: pr.repo, number: pr.number, assignee: who.login }).then(
        ({ assigned }) => log(assigned ? `${key}: assigned to ${who.login}` : `warning: ${key} not assigned to ${who.login}: GitHub cannot assign them (not a collaborator?)`),
        (e: Error) => log(`warning: ${key} not assigned to ${who.login}: ${e.message}`),
      );
    }
  };
}
