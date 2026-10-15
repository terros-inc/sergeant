import { expect, test } from "vitest";
import { createGitHubPort } from "./github.ts";

// TECH-6106: a worker that quit without its report may have pushed its work; its retry is report-only
// when the issue's branch has a head committed since the run started. Reading another issue's branch
// (`tech-10` for `tech-1`) would send a retry to report on work that is not its own.

const repo = "terros-inc/sergeant";
const ref = (branch: string, sha: string) => ({ ref: `refs/heads/${branch}`, object: { sha, type: "commit" } });

test("lists only the issue's own sergeant branches, each with when its head was committed", async () => {
  const requests: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const path = String(input).replace("https://api.github.com", "");
    requests.push(path);
    if (path === `/repos/${repo}/git/matching-refs/heads/sergeant/tech-1`) {
      return Response.json([ref("sergeant/tech-1", "1".repeat(40)), ref("sergeant/tech-1-paginate", "2".repeat(40)), ref("sergeant/tech-10-other", "3".repeat(40))]);
    }
    if (path === `/repos/${repo}/git/commits/${"1".repeat(40)}`) return Response.json({ committer: { date: "2026-10-15T01:00:00Z" } });
    if (path === `/repos/${repo}/git/commits/${"2".repeat(40)}`) return Response.json({ committer: { date: "2026-10-15T02:00:00Z" } });
    throw new Error(`unexpected request: ${path}`);
  };
  const port = createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash" } }, fetch });
  expect(await port.issueBranches?.(repo, "TECH-1")).toEqual([
    { branch: "sergeant/tech-1", sha: "1".repeat(40), committedAt: "2026-10-15T01:00:00Z" },
    { branch: "sergeant/tech-1-paginate", sha: "2".repeat(40), committedAt: "2026-10-15T02:00:00Z" },
  ]);
  await expect(port.issueBranches?.("someone/else", "TECH-1")).rejects.toThrow("GitHub repository is not allowed: someone/else");
  expect(requests).not.toContain(`/repos/${repo}/git/commits/${"3".repeat(40)}`);
});
