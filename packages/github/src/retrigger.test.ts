import { expect, test } from "vitest";
import { createGitHubPort, type GitHubRepositoryConfig } from "./github.ts";

// TECH-6489: re-running CI whose workflow run GitHub expired must keep the PR's head, so its approvals
// stay valid: a draft and ready toggle on the live head, in that order, and nothing that could push.

const head = "a".repeat(40);
const repo = "o/canary";
const req = { repo, number: 7, expectedHeadSha: head };
const json = (value: unknown) => Response.json(value);
const livePr = (over: object = {}) => ({ node_id: "PR_1", state: "open", draft: false, user: { login: "sergeant-worker[bot]" }, head: { sha: head }, ...over });

function port(answer: (path: string, body: { query?: string } | undefined) => Response, config: GitHubRepositoryConfig = { mergeMethod: "squash" }, now?: number) {
  const calls: { path: string; method: string; query?: string | undefined }[] = [];
  const github = createGitHubPort({
    token: async () => "test",
    repositories: { [repo]: config },
    ...(now !== undefined && { now: () => now }),
    fetch: async (input, init) => {
      const path = String(input).replace("https://api.github.com", "");
      const body = init?.body ? (JSON.parse(String(init.body)) as { query?: string }) : undefined;
      calls.push({ path, method: init?.method ?? "GET", ...(body?.query && { query: body.query.match(/\{ (\w+)\(/)?.[1] }) });
      return answer(path, body);
    },
  });
  return { github, calls };
}

test("a re-trigger converts the PR to draft and then marks it ready again, on the live head, and touches nothing else", async () => {
  const { github, calls } = port((path) => (path === "/graphql" ? json({ data: {} }) : json(livePr())));
  await github.retriggerChecks?.(req);
  expect(calls).toEqual([
    { path: `/repos/${repo}/pulls/7`, method: "GET" },
    { path: "/graphql", method: "POST", query: "convertPullRequestToDraft" },
    { path: "/graphql", method: "POST", query: "markPullRequestReadyForReview" },
  ]);
});

test.each([
  ["a moved head", livePr({ head: { sha: "b".repeat(40) } }), /head moved/],
  ["a draft", livePr({ draft: true }), /is a draft/],
  ["a closed PR", livePr({ state: "closed" }), /is not open/],
])("a re-trigger refuses %s before any mutation", async (_, live, message) => {
  const { github, calls } = port(() => json(live));
  await expect(github.retriggerChecks?.(req)).rejects.toThrow(message);
  expect(calls.filter((c) => c.path === "/graphql")).toEqual([]);
});

test("a ready step GitHub refuses says the PR may be left a draft", async () => {
  const { github } = port((path, body) =>
    path !== "/graphql" ? json(livePr()) : json(body?.query?.includes("markPullRequestReadyForReview") ? { errors: [{ message: "Something went wrong" }] } : { data: {} }),
  );
  await expect(github.retriggerChecks?.(req)).rejects.toThrow(/may be left a draft: Something went wrong/);
});

test("a head outlives the configured Actions retention, or GitHub's default of 90 days without one", async () => {
  const now = Date.parse("2026-10-21T00:00:00Z");
  const committed = (days: number) => () => json({ committer: { date: new Date(now - days * 86_400_000).toISOString() } });
  expect(await port(committed(8), { mergeMethod: "squash", actionsRetentionDays: 7 }, now).github.outlivedActionsRetention?.(repo, head)).toBe(true);
  expect(await port(committed(6), { mergeMethod: "squash", actionsRetentionDays: 7 }, now).github.outlivedActionsRetention?.(repo, head)).toBe(false);
  expect(await port(committed(30), { mergeMethod: "squash" }, now).github.outlivedActionsRetention?.(repo, head)).toBe(false);
  expect(await port(committed(91), { mergeMethod: "squash" }, now).github.outlivedActionsRetention?.(repo, head)).toBe(true);
});
