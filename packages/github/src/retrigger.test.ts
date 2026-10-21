import { expect, test } from "vitest";
import { createGitHubPort, type GitHubRepositoryConfig } from "./github.ts";

// TECH-6489: re-running CI whose workflow run GitHub expired must keep the PR's head, so its approvals
// stay valid: a draft and ready toggle on the live head, in that order, and nothing that could push.

const head = "a".repeat(40);
const repo = "o/canary";
const req = { repo, number: 7, expectedHeadSha: head };
const json = (value: unknown) => Response.json(value);
const livePr = (over: object = {}) => ({ node_id: "PR_1", state: "open", draft: false, user: { login: "sergeant-worker[bot]" }, head: { sha: head }, ...over });

function port(answer: (path: string, body: { query?: string } | undefined) => Response, config: GitHubRepositoryConfig = { mergeMethod: "squash" }) {
  const calls: { path: string; method: string; query?: string | undefined }[] = [];
  const github = createGitHubPort({
    token: async () => "test",
    repositories: { [repo]: config },
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

test("the Actions retention is the configured days, or GitHub's default of 90 without one", () => {
  expect(port(() => json({}), { mergeMethod: "squash", actionsRetentionDays: 7 }).github.actionsRetentionDays?.(repo)).toBe(7);
  expect(port(() => json({})).github.actionsRetentionDays?.(repo)).toBe(90);
});
