import { RepoSlug, type CiRerunPort } from "@terros/sergeant-contracts";
import { z } from "zod";
import type { GitHubApp } from "./app-auth.ts";

// TECH-5839: the rerun App, a separate GitHub App with Actions write that only the control plane holds.
// It does exactly two things: read one workflow run and ask GitHub to rerun its failed jobs. Each call
// mints a token for that one repository with only `actions` permission, so neither the key nor a token
// it mints ever reaches a run, and nothing else in Sergeant can use it for other Actions operations.

const workflowRun = z.object({
  id: z.number(),
  repository: z.object({ full_name: z.string() }),
  head_sha: z.string(),
  path: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  run_attempt: z.number().int().positive(),
  html_url: z.string(),
});

export type CiRerunOptions = {
  app: Pick<GitHubApp, "mint">;
  /** Read at each call, like the GitHub port's: a repository's `ciRerunWorkflows`, none when absent. */
  repositories: Readonly<Record<string, { ciRerunWorkflows?: string[] }>>;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
};

export function ciRerunner(options: CiRerunOptions): CiRerunPort {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const call = async (repo: RepoSlug, access: "read" | "write", method: "GET" | "POST", path: string) => {
    const { token } = await options.app.mint({ repositories: [RepoSlug.parse(repo)], permissions: { actions: access } });
    const res = await fetchFn(`${apiUrl}/repos/${repo}/actions/runs/${path}`, {
      method,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) {
      const detail = await res.json().then((b: { message?: unknown }) => (typeof b?.message === "string" ? `: ${b.message}` : ""), () => "");
      throw new Error(`GitHub ${method} ${repo} actions/runs/${path} failed (${res.status})${detail}`);
    }
    return res;
  };
  return {
    allowedWorkflows: (repo) => options.repositories[repo]?.ciRerunWorkflows ?? [],
    async readWorkflowRun(repo, id) {
      const run = workflowRun.parse(await (await call(repo, "read", "GET", String(id))).json());
      return {
        id: run.id,
        repo: run.repository.full_name,
        headSha: run.head_sha,
        path: run.path,
        status: run.status,
        conclusion: run.conclusion,
        attempt: run.run_attempt,
        url: run.html_url,
      };
    },
    async rerunFailedJobs(repo, id) {
      await call(repo, "write", "POST", `${id}/rerun-failed-jobs`);
    },
  };
}
