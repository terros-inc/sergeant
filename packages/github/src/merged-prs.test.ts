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

test("reads every page of a PR's review edit times from GraphQL, and fails on a GraphQL error rather than reading none", async () => {
  const bodies: { variables: { after: string | null } }[] = [];
  let fail = false;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.github.com/graphql");
    const body = JSON.parse(String(init?.body)) as { variables: { owner: string; name: string; number: number; after: string | null } };
    expect(body.variables).toMatchObject({ owner: "o", name: "r", number: 7 });
    bodies.push(body);
    if (fail) return Response.json({ errors: [{ message: "rate limited" }] });
    const first = body.variables.after === null;
    const nodes = first ? [{ databaseId: 1, lastEditedAt: null }, { databaseId: 2, lastEditedAt: "2026-10-21T09:00:00Z" }] : [{ databaseId: 3, lastEditedAt: "2026-10-22T01:00:00Z" }];
    return Response.json({ data: { repository: { pullRequest: { reviews: { pageInfo: { hasNextPage: first, endCursor: first ? "c1" : null }, nodes } } } } });
  };
  const port = createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash" } }, fetch });

  expect(await port.reviewEdits?.(repo, 7)).toEqual({ "review:2": "2026-10-21T09:00:00.000Z", "review:3": "2026-10-22T01:00:00.000Z" });
  expect(bodies.map((b) => b.variables.after)).toEqual([null, "c1"]);
  fail = true;
  await expect(port.reviewEdits?.(repo, 7)).rejects.toThrow("rate limited");
});
