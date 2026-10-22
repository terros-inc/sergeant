import { expect, test } from "vitest";
import { createGitHubPort } from "./github.ts";

const repo = "example-org/example-app";
const h1 = "a".repeat(40);
const h2 = "b".repeat(40);
const json = (value: unknown, status = 200) => Response.json(value, { status });
const comment = (id: number, body: string, app = 42) => ({ id, node_id: `IC_${id}`, body, user: { login: "sergeant[bot]", type: "Bot" }, performed_via_github_app: { id: app }, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", html_url: `https://github.com/c/${id}` });

test("one immutable declaration is posted per head, and only other-head summaries are minimized", async () => {
  let head = h1;
  // TECH-6618: an audit comment this App posted on an earlier head is never minimized.
  const comments = [comment(1, "Unrelated status"), comment(2, `READY TO MERGE | SHA: ${h1}\n\nReason: first\n\nEvidence on this head:\n- recorded`), comment(4, `Post-merge audit (nonblocking): PASS | Found: NO | SHA: ${h1}`)];
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
  const req = (sha: string, reason: string) => ({ repo, number: 7, expectedHeadSha: sha, comment: `READY TO MERGE | SHA: ${sha}\n\nReason: ${reason}\n\nEvidence on this head:\n- recorded`, fallbackComment: `READY TO MERGE | SHA: ${sha}\n\nReason: Reason recorded in Sergeant's task record\n\nEvidence on this head:\n- recorded`, modelText: reason });
  expect(await github.declareReadiness?.(req(h1, "changed retry reason"))).toMatchObject({ id: 2 });
  expect(comments).toHaveLength(3);
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
  await github.declareReadiness?.({ repo, number: 7, expectedHeadSha: h1, comment: `READY TO MERGE | SHA: ${h1}\n\nReason: ${unsafe}\n\nEvidence on this head:\n- recorded\nSuggested, not acted on: ${unsafe}`, fallbackComment: `READY TO MERGE | SHA: ${h1}\n\nReason: Reason recorded in Sergeant's task record\n\nEvidence on this head:\n- recorded`, modelText: unsafe });
  expect(comments[0]?.body).toContain("Reason: Reason recorded in Sergeant's task record");
  expect(comments[0]?.body).not.toContain("Suggested, not acted on:");
});

test("ordinary public readiness text passes with the configured denylist", async () => {
  const comments: ReturnType<typeof comment>[] = [];
  const github = createGitHubPort({ token: async () => "test", appId: 42, publicDataDenylist: "Acme Solar", repositories: { [repo]: { mergeMethod: "squash" } }, fetch: async (input, init) => {
    const path = String(input).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    if (path.endsWith("/pulls/7")) return json({ node_id: "PR", state: "open", draft: false, user: { login: "worker[bot]" }, head: { sha: h1 }, requested_reviewers: [], requested_teams: [] });
    if (path === `/repos/${repo}`) return json({ visibility: "public" });
    if (path.includes("/issues/7/comments") && method === "GET") return json([]);
    if (path.endsWith("/issues/7/comments")) { const made = comment(1, JSON.parse(String(init?.body)).body); comments.push(made); return json(made, 201); }
    throw new Error(`unexpected ${method} ${path}`);
  }});
  const reason = "Required checks pass and the review found no blocking issues.";
  await github.declareReadiness?.({ repo, number: 7, expectedHeadSha: h1, comment: `READY TO MERGE | SHA: ${h1}\n\nReason: ${reason}\n\nEvidence on this head:\n- recorded`, fallbackComment: `READY TO MERGE | SHA: ${h1}\n\nReason: Reason recorded in Sergeant's task record\n\nEvidence on this head:\n- recorded`, modelText: reason });
  expect(comments[0]?.body).toContain(`Reason: ${reason}`);
});

test.each([
  ["reason delimiter injection", `rejected reason\n\nEvidence on this head:\nrejected trailing reason`, "ordinary suggestion"],
  ["multiline suggestion", "ordinary reason", "rejected suggestion\nrejected trailing suggestion"],
])("public readiness fallback cannot be bypassed by %s", async (_case, reason, suggestion) => {
  const comments: ReturnType<typeof comment>[] = [];
  const github = createGitHubPort({ token: async () => "test", appId: 42, repositories: { [repo]: { mergeMethod: "squash" } }, fetch: async (input, init) => {
    const path = String(input).replace("https://api.github.com", "");
    const method = init?.method ?? "GET";
    if (path.endsWith("/pulls/7")) return json({ node_id: "PR", state: "open", draft: false, user: { login: "worker[bot]" }, head: { sha: h1 }, requested_reviewers: [], requested_teams: [] });
    if (path === `/repos/${repo}`) return json({ visibility: "public" });
    if (path.includes("/issues/7/comments") && method === "GET") return json([]);
    if (path.endsWith("/issues/7/comments")) { const made = comment(1, JSON.parse(String(init?.body)).body); comments.push(made); return json(made, 201); }
    throw new Error(`unexpected ${method} ${path}`);
  }});
  const fallbackComment = `READY TO MERGE | SHA: ${h1}\n\nReason: Reason recorded in Sergeant's task record\n\nEvidence on this head:\n- recorded`;
  await github.declareReadiness?.({ repo, number: 7, expectedHeadSha: h1, comment: `READY TO MERGE | SHA: ${h1}\n\nReason: ${reason}\n\nEvidence on this head:\n- recorded\nSuggested, not acted on: ${suggestion}`, fallbackComment, modelText: `${reason}\n${suggestion}` });
  expect(comments).toHaveLength(1);
  expect(comments[0]?.body).not.toContain("rejected");
  expect(comments[0]?.body).toBe(fallbackComment);
});

// TECH-6613: the reread a classification is made from. A merge queue's own bot must not hide the human
// who queued the merge, and a missing comment, or one on another PR, must never pass as a declaration.
test("readReadiness reads the pre-merge head, reviews, the queuing human and the declaration from GitHub", async () => {
  const at = "2026-01-01T00:00:00Z";
  let commentPr = 7;
  let commentStatus = 200;
  const timeline = [
    { event: "added_to_merge_queue", actor: { login: "someone", type: "User" } },
    { event: "removed_from_merge_queue", actor: { login: "github-merge-queue[bot]", type: "Bot" } },
    { event: "commented", actor: { login: "example-dev", type: "User" } },
    { event: "added_to_merge_queue", actor: { login: "example-owner", type: "User" } },
    { event: "merged", actor: { login: "github-merge-queue[bot]", type: "Bot" } },
  ];
  const github = createGitHubPort({ token: async () => "test", appId: 42, repositories: { [repo]: { mergeMethod: "squash" } }, fetch: async (input) => {
    const path = String(input).replace("https://api.github.com", "");
    if (path === `/repos/${repo}/pulls/7`) return json({ state: "closed", merged_at: "2026-01-02T00:00:00Z", merged_by: { login: "github-merge-queue[bot]", type: "Bot" }, closed_at: "2026-01-02T00:00:00Z", head: { sha: h1 }, merge_commit_sha: h2 });
    if (path.startsWith(`/repos/${repo}/pulls/7/reviews`)) return json([
      { user: { login: "example-owner", type: "User" }, state: "APPROVED", commit_id: h1, submitted_at: "2026-01-01T12:00:00Z" },
      { user: null, state: "PENDING", commit_id: h1, submitted_at: null },
    ]);
    if (path === `/repos/${repo}/issues/comments/5`) return json({ ...comment(5, `READY TO MERGE | SHA: ${h1}\n\nReason: ready`), created_at: at, issue_url: `https://api.github.com/repos/${repo}/issues/${commentPr}` }, commentStatus);
    if (path.startsWith(`/repos/${repo}/issues/7/timeline`)) return json(timeline);
    throw new Error(`unexpected ${path}`);
  }});
  const read = () => github.readReadiness?.({ repo, number: 7, commentId: 5 });
  expect(await read()).toEqual({
    declaration: { id: "5", body: `READY TO MERGE | SHA: ${h1}\n\nReason: ready`, author: { login: "sergeant[bot]", type: "Bot" }, performedViaGitHubAppId: 42, sergeantAppId: 42, createdAt: at },
    facts: {
      state: "merged", headSha: h1, mergedAt: "2026-01-02T00:00:00Z", mergedBy: { login: "github-merge-queue[bot]", type: "Bot" }, closedAt: "2026-01-02T00:00:00Z",
      reviews: [{ author: { login: "example-owner", type: "User" }, state: "APPROVED", commitId: h1, submittedAt: "2026-01-01T12:00:00Z" }],
      mergedViaMergeQueue: true, addedToMergeQueueActor: { login: "example-owner", type: "User" },
    },
  });
  commentPr = 8;
  expect((await read())?.declaration).toBeNull();
  commentStatus = 404;
  expect((await read())?.declaration).toBeNull();
});
