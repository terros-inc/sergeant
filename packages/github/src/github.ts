import { PullRequestFacts, RepoSlug, Sha, type GitHubPort } from "@terros/sergeant-contracts";
import { z } from "zod";
import { hasComment, readHumanFeedback } from "./pr-feedback.ts";
import { branchRules, checkRun, checkRuns, commitStatus, gitRef, mergeResponse, protection, pullRequest, pullRequestHead, pullRequestList, repositoryConfig, requiredRule } from "./schemas.ts";
import { readSquashMessage } from "./squash-message.ts";

type CheckState = "passed" | "failed" | "pending" | "missing";
type ObservedCheck = { name: string; appId?: number; state: Exclude<CheckState, "missing"> };
type RequiredCheck = { name: string; appId?: number };
type RequestOptions = { allowStatuses?: number[]; failOnNextPage?: boolean };

export type GitHubRepositoryConfig = {
  mergeMethod: "merge" | "squash" | "rebase";
  /**
   * Off by default. Only for a repository with no declared required checks: treat every check
   * observed on the exact head as required. It cannot know a check that has not appeared yet, so a
   * repository Sergeant merges should declare its checks in a ruleset instead.
   */
  observedChecksFallback?: boolean;
};
export type GitHubAdapterOptions = {
  /** The control-plane App's installation token, fetched per request so it can be refreshed. */
  token: () => Promise<string>;
  /** Read at each call, so a repository enrolled or removed in place (TECH-5193) takes effect at once. */
  repositories: Readonly<Record<string, GitHubRepositoryConfig>>;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
};

/** The worker branch convention (08 §3): Sergeant deletes no branch outside it. */
const BRANCH_PREFIX = "sergeant/";

class GitHubHttpError extends Error {
  readonly status: number;
  /** GitHub's `message`, when the response carried one. */
  readonly detail: string | undefined;

  constructor(status: number, detail?: string) {
    super(`GitHub API request failed (${status})${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.detail = detail;
  }
}

const checkRunState = (run: z.infer<typeof checkRun>): ObservedCheck["state"] => {
  if (run.status !== "completed" || run.conclusion === null) return "pending";
  if (["success", "neutral", "skipped"].includes(run.conclusion)) return "passed";
  return "failed";
};

const statusState = (state: z.infer<typeof commitStatus>["state"]): ObservedCheck["state"] =>
  state === "success" ? "passed" : state === "pending" ? "pending" : "failed";

/** The control plane's live GitHub surface: fact reads, the SHA-guarded merge, and a canceled task's PR close and branch delete. */
export function createGitHubPort(options: GitHubAdapterOptions): GitHubPort {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");

  const request = async (path: string, init: RequestInit = {}, requestOptions: RequestOptions = {}): Promise<unknown | null> => {
    const res = await fetchFn(`${apiUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${await options.token()}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });
    if (requestOptions.allowStatuses?.includes(res.status)) return null;
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
      throw new GitHubHttpError(res.status, typeof body?.message === "string" ? body.message : undefined);
    }
    if (requestOptions.failOnNextPage && /rel="next"/.test(res.headers.get("link") ?? "")) {
      throw new Error("GitHub active-rules page is truncated; pagination is required");
    }
    return res.json();
  };

  const configFor = (repo: string) => {
    const parsed = RepoSlug.parse(repo);
    const config = Object.hasOwn(options.repositories, parsed) ? options.repositories[parsed] : undefined;
    if (!config) throw new Error(`GitHub repository is not allowed: ${parsed}`);
    return { repo: parsed, config: repositoryConfig.parse(config) };
  };

  const readRawPullRequest = async (repo: string, number: number) => {
    configFor(repo);
    return pullRequest.parse(await request(`/repos/${repo}/pulls/${number}`));
  };

  const readObservedChecks = async (repo: string, sha: string): Promise<ObservedCheck[]> => {
    const [runsPayload, statusesPayload] = await Promise.all([
      request(`/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
      request(`/repos/${repo}/commits/${sha}/status?per_page=100`),
    ]);
    const runs = checkRuns.parse(runsPayload);
    if (runs.total_count > runs.check_runs.length) throw new Error("GitHub returned more than 100 check runs; pagination is required");
    const statuses = commitStatus.parse(statusesPayload);
    if (statuses.total_count > statuses.statuses.length) {
      throw new Error("GitHub commit-status page is truncated; pagination is required");
    }
    const observedStatuses = statuses.statuses.map(
      (status): ObservedCheck => ({ name: status.context, state: statusState(status.state) }),
    );
    if (
      observedStatuses.length > 0 &&
      statusState(statuses.state) !== "passed" &&
      observedStatuses.every((status) => status.state === "passed")
    ) {
      throw new Error(`GitHub combined commit status is ${statuses.state} despite every returned status passing`);
    }
    return [
      ...runs.check_runs.map((run) => ({
        name: run.name,
        ...(run.app && { appId: run.app.id }),
        state: checkRunState(run),
      })),
      ...observedStatuses,
    ];
  };

  const readRequiredChecks = async (repo: string, baseRef: string): Promise<RequiredCheck[]> => {
    const branch = encodeURIComponent(baseRef);
    const [protectionPayload, rulesPayload] = await Promise.all([
      // Classic protection needs `administration: read`, which the control-plane App does not hold
      // (403). Unreadable protection only removes checks it declares, so this fails closed (M5),
      // and GitHub still enforces them at merge. Rulesets are readable with `metadata: read`.
      request(`/repos/${repo}/branches/${branch}/protection/required_status_checks`, {}, { allowStatuses: [403, 404] }),
      request(`/repos/${repo}/rules/branches/${branch}?per_page=100`, {}, { allowStatuses: [404], failOnNextPage: true }),
    ]);
    const required: RequiredCheck[] = [];
    if (protectionPayload) {
      const parsed = protection.parse(protectionPayload);
      const appBoundNames = new Set((parsed.checks ?? []).map((check) => check.context));
      required.push(...(parsed.contexts ?? []).filter((name) => !appBoundNames.has(name)).map((name) => ({ name })));
      required.push(
        ...(parsed.checks ?? []).map((check) => ({ name: check.context, ...(check.app_id !== null && { appId: check.app_id }) })),
      );
    }
    if (rulesPayload) {
      for (const rule of branchRules.parse(rulesPayload)) {
        if (rule.type !== "required_status_checks") continue;
        const parsed = requiredRule.parse(rule.parameters);
        required.push(
          ...parsed.required_status_checks.map((check) => ({
            name: check.context,
            ...(check.integration_id != null && { appId: check.integration_id }),
          })),
        );
      }
    }
    const exactNames = new Set(required.filter((check) => check.appId !== undefined).map((check) => check.name));
    return [
      ...new Map(
        required
          .filter((check) => check.appId !== undefined || !exactNames.has(check.name))
          .map((check) => [`${check.name}:${check.appId ?? "any"}`, check]),
      ).values(),
    ];
  };

  // A retry after a merge that did land: GitHub refuses both the approval and the merge of a merged
  // PR, so report the earlier merge of this exact head, or rethrow.
  const alreadyMerged = async (repo: string, number: number, expectedHeadSha: string, error: unknown) => {
    if (!(error instanceof GitHubHttpError)) throw error;
    const live = await readRawPullRequest(repo, number);
    if (!live.merged_at || live.head.sha !== expectedHeadSha || !live.merge_commit_sha) throw error;
    return { mergedSha: Sha.parse(live.merge_commit_sha) };
  };

  return {
    async readPullRequest(repo, number) {
      const { config } = configFor(repo);
      const live = await readRawPullRequest(repo, number);
      const headSha = Sha.parse(live.head.sha);
      const [observed, declared, humanFeedback] = await Promise.all([
        readObservedChecks(repo, headSha),
        readRequiredChecks(repo, live.base.ref),
        readHumanFeedback((path) => request(path), repo, number),
      ]);
      // Only the base branch's declared required checks count; one that never reported is
      // `missing`. With none declared the list is empty and M5 refuses the merge, unless this
      // repository explicitly opted into the observed-checks fallback.
      const required =
        declared.length > 0
          ? declared.map((check) => ({
              name: check.name,
              state:
                observed.find((item) => item.name === check.name && (check.appId === undefined || item.appId === check.appId))
                  ?.state ?? "missing",
            }))
          : config.observedChecksFallback
            ? observed.map(({ name, state }) => ({ name, state }))
            : [];

      return PullRequestFacts.parse({
        repo,
        number: live.number,
        url: live.html_url,
        author: live.user.login,
        state: live.merged_at ? "merged" : live.state,
        draft: live.draft,
        headSha,
        mergedSha: live.merged_at ? live.merge_commit_sha : null,
        mergedAt: live.merged_at ? new Date(live.merged_at).toISOString() : null,
        baseRef: live.base.ref,
        baseSha: live.base.sha,
        body: live.body ?? "",
        mergeable: live.mergeable,
        mergeableState: live.mergeable_state,
        checks: { sha: headSha, required },
        humanFeedback,
      });
    },

    async mergePullRequest({ repo, number, expectedHeadSha, squash }) {
      const { config } = configFor(repo);
      // The ruleset requires one approving review, which the worker App cannot give its own PR, so
      // only this approval (after every Gate check) lets the merge through. A failed approval must
      // never fall through to the merge. Approving again on a retry is harmless.
      try {
        await request(`/repos/${repo}/pulls/${number}/reviews`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commit_id: expectedHeadSha,
            event: "APPROVE",
            body: "Sergeant's merge gate passed on this exact head: required checks green and a fresh approving review or the worker's waiver.",
          }),
        });
      } catch (error) {
        return alreadyMerged(repo, number, expectedHeadSha, error);
      }
      // A squash's message is always Sergeant's own (TECH-5085), never GitHub's copy of the branch commits.
      const message = config.mergeMethod === "squash" ? await readSquashMessage(request, repo, number, squash) : {};
      try {
        const result = mergeResponse.parse(
          await request(`/repos/${repo}/pulls/${number}/merge`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sha: expectedHeadSha, merge_method: config.mergeMethod, ...message }),
          }),
        );
        if (!result.merged) return { refused: result.message };
        return { mergedSha: Sha.parse(result.sha) };
      } catch (error) {
        if (!(error instanceof GitHubHttpError) || error.status !== 405) throw error;
        // 405 is repository policy (a required review Sergeant cannot give, such as a code owner's)
        // unless this exact head already merged, or it is temporary: the base moved mid-merge, or
        // GitHub had not finished computing mergeability (TECH-4991). Those reject, so a turn once the
        // facts change (TECH-5062) retries rather than parking the PR for a human. A moved head is 409
        // and still rejects.
        try {
          return await alreadyMerged(repo, number, expectedHeadSha, error);
        } catch (e) {
          if (e !== error || /base branch was modified|pull request is not mergeable/i.test(error.detail ?? "")) throw e;
          return { refused: error.detail ?? "405 Method Not Allowed" };
        }
      }
    },

    async closePullRequest({ repo, number, comment }) {
      configFor(repo);
      const json = { method: "POST", headers: { "Content-Type": "application/json" } };
      // A close that failed after its comment is retried; the comment is not posted twice.
      if (!(await hasComment((path) => request(path), repo, number, comment))) {
        await request(`/repos/${repo}/issues/${number}/comments`, { ...json, body: JSON.stringify({ body: comment }) });
      }
      await request(`/repos/${repo}/pulls/${number}`, { ...json, method: "PATCH", body: JSON.stringify({ state: "closed" }) });
    },

    async deletePullRequestBranch({ repo, number }) {
      configFor(repo);
      const live = pullRequestHead.parse(await request(`/repos/${repo}/pulls/${number}`));
      const { ref, sha } = live.head;
      if (live.state !== "closed" || live.merged_at) return { kept: `#${number} is not closed without merging` };
      if (live.head.repo?.full_name !== repo) return { kept: `#${number}'s head is not a branch in ${repo}` };
      if (!ref.startsWith(BRANCH_PREFIX)) return { kept: `${ref} is not a ${BRANCH_PREFIX} branch` };
      // An open PR from or onto the branch still uses it; GitHub would close one based on it.
      const owner = repo.split("/")[0];
      const using = await Promise.all(
        [`head=${encodeURIComponent(`${owner}:${ref}`)}`, `base=${encodeURIComponent(ref)}`].map(async (filter) =>
          pullRequestList.parse(await request(`/repos/${repo}/pulls?state=open&${filter}&per_page=100`)),
        ),
      );
      const open = using.flat().filter((p) => p.number !== number);
      if (open.length > 0) return { kept: `${ref} is used by open PR #${open[0]?.number}` };
      const path = `/repos/${repo}/git/refs/heads/${ref.split("/").map(encodeURIComponent).join("/")}`;
      const tip = await request(path.replace("/git/refs/", "/git/ref/"), {}, { allowStatuses: [404] });
      if (!tip) return { kept: `${ref} is already deleted` };
      // A commit pushed after the close is not the PR's, and deleting the branch would hide it.
      if (gitRef.parse(tip).object.sha !== sha) return { kept: `${ref} moved past #${number}'s head` };
      await request(path, { method: "DELETE" }, { allowStatuses: [204] });
      return { deleted: ref };
    },
  };
}
