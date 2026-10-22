import { expect, test } from "vitest";
import { createGitHubPort } from "./github.ts";

// TECH-6617: the merged-PR audit lists what merged into the default branch in its window. Stopping a
// page too early would silently leave merged PRs out of the sample; never stopping would read a busy
// repository's whole history every day; and a closed-unmerged PR, or one merged before the window but
// commented on since, must never be drawn.

const repo = "o/r";
const since = new Date("2026-10-19T00:00:00Z");
const sha = (n: number) => n.toString(16).padStart(40, "0");
const pr = (number: number, updated: string, merged: string | null) => ({
  number,
  title: `PR ${number}`,
  updated_at: updated,
  merged_at: merged,
  merge_commit_sha: merged ? sha(1000 + number) : null,
  head: { sha: sha(number) },
});

test("pages closed PRs into the default branch, newest updated first, until one is older than the window", async () => {
  const pages: Record<number, unknown[]> = {
    // A full page: 98 merged in the window, one closed without merging, one merged before the window but
    // commented on since, so it was updated inside it.
    1: [
      ...Array.from({ length: 98 }, (_, i) => pr(i + 1, "2026-10-21T00:00:00Z", "2026-10-20T00:00:00Z")),
      pr(99, "2026-10-20T00:00:00Z", null),
      pr(100, "2026-10-19T12:00:00Z", "2026-10-15T00:00:00Z"),
    ],
    // Its last PR was last updated before the window: nothing after it can have merged inside it.
    2: [pr(101, "2026-10-19T01:00:00Z", "2026-10-19T00:30:00Z"), ...Array.from({ length: 99 }, (_, i) => pr(200 + i, "2026-10-18T00:00:00Z", "2026-10-17T00:00:00Z"))],
  };
  const requests: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const path = String(input).replace("https://api.github.com", "");
    requests.push(path);
    if (path === `/repos/${repo}`) return Response.json({ default_branch: "trunk" });
    const page = /^\/repos\/o\/r\/pulls\?state=closed&base=trunk&sort=updated&direction=desc&per_page=100&page=(\d+)$/.exec(path);
    if (page) return Response.json(pages[Number(page[1])] ?? []);
    throw new Error(`unexpected request: ${path}`);
  };
  const port = createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash" } }, fetch });

  const merged = await port.mergedPullRequests?.(repo, since);

  expect(merged?.map((m) => m.number)).toEqual([...Array.from({ length: 98 }, (_, i) => i + 1), 101]);
  expect(merged?.[0]).toEqual({ number: 1, title: "PR 1", headSha: sha(1), mergedSha: sha(1001), mergedAt: "2026-10-20T00:00:00.000Z" });
  // Page 3 is never read.
  expect(requests.filter((r) => r.includes("/pulls?"))).toHaveLength(2);
  await expect(port.mergedPullRequests?.("someone/else", since)).rejects.toThrow("GitHub repository is not allowed");
});
