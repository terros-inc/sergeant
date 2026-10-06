import { expect, test } from "vitest";
import { createGitHubPort, type GitHubRepositoryConfig } from "./github.ts";

// TECH-5244: Sergeant approved and squash-merged a prod change in a repository only humans should
// merge. The port reads the repository's live policy before any approval or merge call and refuses
// in a `human` one, whatever decided to merge; one with no policy is `human`.

const head = "a".repeat(40);
const repo = "terros-inc/sales";
const merge = { repo, number: 7, expectedHeadSha: head, squash: { issueIdentifier: "TECH-1", closesIssue: true, builtBy: "Built by Sergeant" } };
const json = (value: unknown, status = 200) => Response.json(value, { status });

function port(config: GitHubRepositoryConfig, answer: (path: string, method: string, body: unknown) => Response) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const repositories: Record<string, GitHubRepositoryConfig> = { [repo]: config };
  const github = createGitHubPort({
    token: async () => "test",
    repositories,
    fetch: async (input, init) => {
      const call = { path: String(input).replace("https://api.github.com", ""), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return answer(call.path, call.method, call.body);
    },
  });
  return { github, calls, repositories };
}

test.each([
  ["human", { mergeMethod: "squash", mergePolicy: "human" }],
  ["unset", { mergeMethod: "squash" }],
] as const)("a %s-policy repository is never approved or merged: no GitHub call at all", async (_, config) => {
  const { github, calls } = port(config, () => json({ id: 1, sha: "b".repeat(40), merged: true, message: "merged" }));
  expect(github.mergePolicy?.(repo)).toBe("human");
  await expect(github.mergePullRequest(merge)).rejects.toThrow("human-merge repository");
  expect(calls).toEqual([]);
});

test("the policy is read live at the merge call: a repository set to human since refuses", async () => {
  const { github, calls, repositories } = port({ mergeMethod: "squash", mergePolicy: "sergeant" }, () => json({}));
  expect(github.mergePolicy?.(repo)).toBe("sergeant");
  repositories[repo] = { mergeMethod: "squash", mergePolicy: "human" };
  await expect(github.mergePullRequest(merge)).rejects.toThrow("human-merge repository");
  expect(calls).toEqual([]);
});

const livePr = (over: object) => ({ node_id: "PR_1", state: "open", draft: false, user: { login: "sergeant-worker[bot]" }, head: { sha: head }, requested_reviewers: [], requested_teams: [], ...over });
const handoff = { repo, number: 7, expectedHeadSha: head, reviewers: ["owner-login"], comment: "**Ready for a human to merge**" };

test("a handoff marks a draft ready, asks the assignee when GitHub asked nobody, and comments once; never approves or merges", async () => {
  let ready = false;
  const comments: string[] = [];
  const { github, calls } = port({ mergeMethod: "squash", mergePolicy: "human" }, (path, method, body) => {
    if (path === "/graphql") return (ready = true), json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    if (path.endsWith("/pulls/7") && method === "GET") return json(livePr({ draft: !ready }));
    if (path.endsWith("/requested_reviewers")) return json({}, 201);
    if (path.includes("/issues/7/comments") && method === "GET") return json(comments.map((c, id) => ({ id, body: c, user: { login: "x", type: "Bot" }, created_at: "", updated_at: "", html_url: "https://github.com/c" })));
    if (path.endsWith("/issues/7/comments")) return comments.push((body as { body: string }).body), json({ id: 1 }, 201);
    throw new Error(`unexpected ${method} ${path}`);
  });

  expect(await github.handToHuman?.(handoff)).toEqual({ requested: ["owner-login"] });
  expect(await github.handToHuman?.(handoff)).toEqual({ requested: ["owner-login"] });
  expect(comments).toEqual([handoff.comment]);
  expect(calls.filter((c) => c.path === "/graphql")).toHaveLength(1);
  expect(calls.find((c) => c.path.endsWith("/requested_reviewers"))?.body).toEqual({ reviewers: ["owner-login"] });
  expect(calls.some((c) => /\/reviews$|\/merge$/.test(c.path))).toBe(false);
});

test("a handoff leaves the code owners GitHub already asked, and refuses a moved head", async () => {
  const { github, calls } = port({ mergeMethod: "squash", mergePolicy: "human" }, (path, method) => {
    if (path.endsWith("/pulls/7")) return json(livePr({ requested_reviewers: [{ login: "codeowner" }], requested_teams: [{ slug: "platform" }] }));
    if (path.includes("/issues/7/comments")) return json(method === "GET" ? [] : { id: 1 });
    throw new Error(`unexpected ${method} ${path}`);
  });

  expect(await github.handToHuman?.(handoff)).toEqual({ requested: ["codeowner", "terros-inc/platform"] });
  expect(calls.some((c) => c.path.endsWith("/requested_reviewers"))).toBe(false);
  await expect(github.handToHuman?.({ ...handoff, expectedHeadSha: "c".repeat(40) })).rejects.toThrow("head moved");
});

test.each([
  ["mark ready", "/graphql", true],
  ["request reviewers", "/requested_reviewers", false],
] as const)("a handoff identifies a failed %s step", async (step, failedPath, draft) => {
  const { github } = port({ mergeMethod: "squash", mergePolicy: "human" }, (path, method) => {
    if (path.endsWith("/pulls/7")) return json(livePr({ draft }));
    if (path === failedPath || path.endsWith(failedPath)) throw new Error("GitHub was unavailable");
    if (path.includes("/issues/7/comments")) return json(method === "GET" ? [] : { id: 1 });
    throw new Error(`unexpected ${method} ${path}`);
  });

  await expect(github.handToHuman?.(handoff)).rejects.toMatchObject({ name: "HumanHandoffError", step, message: "GitHub was unavailable" });
});
