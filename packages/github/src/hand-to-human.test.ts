import { expect, test } from "vitest";
import { createGitHubPort, type GitHubRepositoryConfig } from "./github.ts";

// TECH-5244: Sergeant approved and squash-merged a prod change in a repository only humans should
// merge. The port reads the repository's live policy before any approval or merge call and refuses
// in a `human` one, whatever decided to merge; one with no policy is `human`.

const head = "a".repeat(40);
const repo = "terros-inc/sales";
const merge = { repo, number: 7, expectedHeadSha: head, squash: { issueIdentifier: "TECH-1", closesIssue: true, builtBy: "Built by Sergeant" } };
const json = (value: unknown, status = 200) => Response.json(value, { status });

function port(config: GitHubRepositoryConfig, answer: (path: string, method: string, body: unknown) => Response, appId?: number, log?: (line: string) => void) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const repositories: Record<string, GitHubRepositoryConfig> = { [repo]: config };
  const github = createGitHubPort({
    token: async () => "test",
    ...(appId !== undefined && { appId }),
    ...(log && { log }),
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
  ["mark ready", "/graphql", true, `could not mark ${repo}#7 ready for review: GitHub was unavailable`],
  ["request reviewers", "/requested_reviewers", false, "GitHub was unavailable"],
] as const)("a handoff identifies a failed %s step", async (step, failedPath, draft, expectedMessage) => {
  const { github } = port({ mergeMethod: "squash", mergePolicy: "human" }, (path, method) => {
    if (path.endsWith("/pulls/7")) return json(livePr({ draft }));
    if (path === failedPath || path.endsWith(failedPath)) throw new Error("GitHub was unavailable");
    if (path.includes("/issues/7/comments")) return json(method === "GET" ? [] : { id: 1 });
    throw new Error(`unexpected ${method} ${path}`);
  });

  await expect(github.handToHuman?.(handoff)).rejects.toMatchObject({ name: "HumanHandoffError", step, message: expectedMessage });
});

test.each([
  ["read pull request", false],
  ["re-read pull request", true],
] as const)("a handoff identifies a failed %s step", async (step, markReady) => {
  let reads = 0;
  const { github } = port({ mergeMethod: "squash", mergePolicy: "human" }, (path) => {
    if (path === "/graphql") return json({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    if (path.endsWith("/pulls/7") && ++reads === 1 && markReady) return json(livePr({ draft: true }));
    throw new Error("GitHub was unavailable");
  });

  await expect(github.handToHuman?.(handoff)).rejects.toMatchObject({ name: "HumanHandoffError", step, message: "GitHub was unavailable" });
});

test("a handoff identifies a failed post review summary step", async () => {
  const { github } = port({ mergeMethod: "squash", mergePolicy: "human" }, (path) => {
    if (path.endsWith("/pulls/7")) return json(livePr({ requested_reviewers: [{ login: "codeowner" }] }));
    if (path.includes("/issues/7/comments")) throw new Error("GitHub was unavailable");
    throw new Error(`unexpected path ${path}`);
  });

  await expect(github.handToHuman?.(handoff)).rejects.toMatchObject({ name: "HumanHandoffError", step: "post review summary", message: "GitHub was unavailable" });
});

// TECH-6374: each head's summary used to stay visible, so a PR handed over three times showed three
// "Ready" comments. Only the App's own earlier ones are hidden: a human's or another bot's never is,
// even one posted through this same App on a person's behalf or under a look-alike login.
test("a handoff minimizes only this App's own earlier comments as outdated, never the latest or anyone else's", async () => {
  const app = 42;
  const comment = (id: number, body: string, user: { login: string; type: string }, via: number | null) => ({
    id, node_id: `IC_${id}`, body, user, performed_via_github_app: via === null ? null : { id: via }, created_at: "", updated_at: "", html_url: `https://github.com/c/${id}`,
  });
  const self = { login: "acme-sergeant[bot]", type: "Bot" };
  const existing = [
    comment(1, "**Ready for a human to merge** (an earlier head)", self, app),
    comment(2, "Please hold this until Friday.", { login: "reviewer-login", type: "User" }, null),
    comment(3, "Posted by a person through the same App", { login: "reviewer-login", type: "User" }, app),
    comment(4, "**Ready for a human to merge** (another bot)", self, 99),
    comment(5, "Review complete: 0 findings", { login: "other-review-bot[bot]", type: "Bot" }, 7),
    comment(6, "**Ready for a human to merge** (an earlier head, the second)", self, app),
  ];
  const minimized: string[] = [];
  const logged: string[] = [];
  const { github } = port({ mergeMethod: "squash", mergePolicy: "human" }, (path, method, body) => {
    if (path.endsWith("/pulls/7")) return json(livePr({ requested_reviewers: [{ login: "codeowner" }] }));
    if (path.includes("/issues/7/comments") && method === "GET") return json(existing);
    if (path.endsWith("/issues/7/comments")) return existing.push(comment(8, (body as { body: string }).body, self, app)), json({ id: 8 }, 201);
    if (path === "/graphql") {
      const { query, variables } = body as { query: string; variables: { id: string } };
      expect(query).toContain("classifier: OUTDATED");
      minimized.push(variables.id);
      // GitHub answers a refused mutation with 200 and `errors`: logged, and the handoff still stands.
      return json(variables.id === "IC_6" ? { errors: [{ message: "refused" }] } : { data: {} });
    }
    throw new Error(`unexpected ${method} ${path}`);
  }, app, (line) => logged.push(line));

  expect(await github.handToHuman?.(handoff)).toEqual({ requested: ["codeowner"] });
  expect(minimized).toEqual(["IC_1", "IC_6"]);
  expect(logged).toEqual([expect.stringContaining("could not minimize outdated comment https://github.com/c/6: refused")]);

  // A retry at the same head posts nothing new and keeps its summary, the latest, visible.
  minimized.length = 0;
  expect(await github.handToHuman?.(handoff)).toEqual({ requested: ["codeowner"] });
  expect(existing.filter((c) => c.body === handoff.comment)).toHaveLength(1);
  expect(minimized).toEqual(["IC_1", "IC_6"]);
});
