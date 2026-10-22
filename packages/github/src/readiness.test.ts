import { expect, test } from "vitest";
import { createGitHubPort } from "./github.ts";

const repo = "example-org/example-app";
const h1 = "a".repeat(40);
const h2 = "b".repeat(40);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const comment = (id: number, body: string, app = 42) => ({ id, node_id: `IC_${id}`, body, user: { login: "sergeant[bot]", type: "Bot" }, performed_via_github_app: { id: app }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", html_url: `https://github.com/c/${id}` });

test("one immutable declaration is posted per head, and only other-head summaries are minimized", async () => {
  let head = h1;
  const comments = [comment(1, "Unrelated status"), comment(2, `READY TO MERGE | SHA: ${h1}\n\nReason: first\n\nEvidence on this head:\n- recorded`)];
  const minimized: string[] = [];
  const github = createGitHubPort({ token: async () => "test", appId: 42, publicDataDenylist: "Acme Solar", repositories: { [repo]: { mergeMethod: "squash" } }, fetch: async (input, init) => {
    const path = String(input).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    if (path.endsWith("/pulls/7")) return json({ node_id: "PR", state: "open", draft: false, user: { login: "worker[bot]" }, head: { sha: head }, requested_reviewers: [], requested_teams: [] });
    if (path === `/repos/${repo}`) return json({ visibility: "private" });
    if (path.includes("/issues/7/comments") && method === "GET") return json(comments);
    if (path.endsWith("/issues/7/comments")) { const body = JSON.parse(String(init?.body)).body; const made = comment(3, body); comments.push(made); return json(made, 201); }
    if (path === "/graphql") { minimized.push(JSON.parse(String(init?.body)).variables.id); return json({ data: {} }); }
    throw new Error(`unexpected ${method} ${path}`);
  }});
  const req = (sha: string, reason: string) => ({ repo, number: 7, expectedHeadSha: sha, comment: `READY TO MERGE | SHA: ${sha}\n\nReason: ${reason}\n\nEvidence on this head:\n- recorded`, modelText: reason });
  expect(await github.declareReadiness?.(req(h1, "changed retry reason"))).toMatchObject({ id: 2 });
  expect(comments).toHaveLength(2);
  head = h2;
  expect(await github.declareReadiness?.(req(h2, "second head"))).toMatchObject({ id: 3 });
  expect(minimized).toEqual(["IC_2"]);
  expect(comments[0]?.body).toBe("Unrelated status");
});

test.each([undefined, "Acme Solar"])("public readiness text fails closed when the denylist/check is unavailable or rejects it", async (denylist) => {
  const comments: ReturnType<typeof comment>[] = [];
  const github = createGitHubPort({ token: async () => "test", appId: 42, ...(denylist && { publicDataDenylist: denylist }), repositories: { [repo]: { mergeMethod: "squash" } }, fetch: async (input, init) => {
    const path = String(input).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    if (path.endsWith("/pulls/7")) return json({ node_id: "PR", state: "open", draft: false, user: { login: "worker[bot]" }, head: { sha: h1 }, requested_reviewers: [], requested_teams: [] });
    if (path === `/repos/${repo}`) return json({ visibility: "public" });
    if (path.includes("/issues/7/comments") && method === "GET") return json([]);
    if (path.endsWith("/issues/7/comments")) { const made = comment(1, JSON.parse(String(init?.body)).body); comments.push(made); return json(made, 201); }
    throw new Error(`unexpected ${method} ${path}`);
  }});
  const unsafe = denylist ? `${["C", "Ab12"].join(".")} should be inspected` : "safe but unchecked";
  await github.declareReadiness?.({ repo, number: 7, expectedHeadSha: h1, comment: `READY TO MERGE | SHA: ${h1}\n\nReason: ${unsafe}\n\nEvidence on this head:\n- recorded\nSuggested, not acted on: ${unsafe}`, modelText: unsafe });
  expect(comments[0]?.body).toContain("Reason: Reason recorded in Sergeant's task record");
  expect(comments[0]?.body).not.toContain("Suggested, not acted on:");
});
