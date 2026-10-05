import { expect, test } from "vitest";
import { createGitHubPort } from "./github.ts";

const head = "a".repeat(40);
const repo = "trevorallred/canary";
const pr = {
  number: 7,
  html_url: `https://github.com/${repo}/pull/7`,
  user: { login: "sergeant-worker[bot]" },
  body: "Fixes TECH-1",
  state: "open",
  draft: false,
  merged_at: null,
  mergeable: true,
  merge_commit_sha: null,
  head: { sha: head },
  base: { ref: "main", sha: "b".repeat(40) },
};

const read = (live: Record<string, unknown>) => {
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/pulls/7")) return Response.json({ ...pr, ...live });
    if (path.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/status?per_page=100")) return Response.json({ state: "success", total_count: 0, statuses: [] });
    if (path.includes("/protection/")) return Response.json({ message: "Not Found" }, { status: 404 });
    if (/\/rules\/branches\/main\?|\/(reviews|comments)\?per_page=100&page=1$/.test(path)) return Response.json([]);
    throw new Error(`unexpected request: ${path}`);
  };
  return createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash" } }, fetch }).readPullRequest(repo, 7);
};

// M7 reads mergeable_state (TECH-5013). A value GitHub adds later, or one it leaves out, must read as
// still computing, so M7 waits rather than merging or failing the poll that reads it.
test.each(["clean", "unstable", "behind", "blocked", "dirty", "draft", "has_hooks", "unknown"])("reads mergeable_state %s", async (state) => {
  expect(await read({ mergeable_state: state })).toMatchObject({ mergeable: true, mergeableState: state });
});

test.each([
  ["missing", {}],
  ["null", { mergeable_state: null }],
  ["one GitHub adds later", { mergeable_state: "queued" }],
])("reads a %s mergeable_state as unknown", async (_, live) => {
  expect((await read(live)).mergeableState).toBe("unknown");
});
