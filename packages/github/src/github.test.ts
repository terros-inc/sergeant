import { expect, test } from "vitest";
import { createGitHubPort } from "./github.ts";

const head = "a".repeat(40);
const repo = "trevorallred/canary";
const pr = {
  number: 7,
  html_url: `https://github.com/${repo}/pull/7`,
  user: { login: "sergeant-worker[bot]" },
  state: "open",
  draft: false,
  merged_at: null,
  mergeable: true,
  merge_commit_sha: null,
  head: { sha: head },
  base: { ref: "main", sha: "b".repeat(40) },
};

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, { status, ...(headers && { headers }) });
/** A PR's human-feedback lists are empty unless a test's `fetch` answers them. */
const noFeedback = (fetch: typeof globalThis.fetch): typeof globalThis.fetch => async (input, init) =>
  /\/(reviews|comments)\?per_page=100&page=1$/.test(String(input)) && !init?.method ? fetch(input, init).catch(() => json([])) : fetch(input, init);
const adapter = (fetch: typeof globalThis.fetch, observedChecksFallback = false) =>
  createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash", observedChecksFallback } }, fetch: noFeedback(fetch) });

// Treating observed checks as required cannot know a check that has not appeared yet, so a base
// with no declared required checks must yield none (M5 then refuses the merge), never whatever
// happened to report. Only an explicit per-repository flag turns the observed-checks fallback on.
test("with no declared required checks, nothing counts unless the observed fallback is enabled", async () => {
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/pulls/7")) return json(pr);
    if (path.includes("/check-runs")) {
      return json({
        total_count: 2,
        check_runs: [
          { name: "ci", status: "completed", conclusion: "success", app: { id: 1 } },
          { name: "lint", status: "completed", conclusion: "failure", app: { id: 1 } },
        ],
      });
    }
    if (path.endsWith("/status?per_page=100")) {
      return json({ state: "pending", total_count: 1, statuses: [{ context: "legacy", state: "pending" }] });
    }
    if (path.includes("/protection/")) return json({ message: "Not Found" }, 404);
    if (path.endsWith("/rules/branches/main?per_page=100")) return json([]);
    throw new Error(`unexpected request: ${path}`);
  };

  expect((await adapter(fetch).readPullRequest(repo, 7)).checks).toEqual({ sha: head, required: [] });
  expect((await adapter(fetch, true).readPullRequest(repo, 7)).checks.required).toEqual([
    { name: "ci", state: "passed" },
    { name: "lint", state: "failed" },
    { name: "legacy", state: "pending" },
  ]);
});

// A declared required check that never reported must be `missing`; an unrelated red check is not
// required and must not be substituted for the declared set. The control-plane App cannot read
// classic protection (403), so a ruleset is where the declared checks come from.
test("maps ruleset-declared required checks and reports an absent one as missing", async () => {
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/pulls/7")) return json(pr);
    if (path.includes("/check-runs")) {
      return json({
        total_count: 2,
        check_runs: [
          { name: "ci", status: "completed", conclusion: "success", app: { id: 1 } },
          { name: "optional", status: "completed", conclusion: "failure", app: { id: 1 } },
        ],
      });
    }
    if (path.endsWith("/status?per_page=100")) return json({ state: "pending", total_count: 0, statuses: [] });
    if (path.includes("/protection/")) return json({ message: "Resource not accessible by integration" }, 403);
    if (path.endsWith("/rules/branches/main?per_page=100")) {
      return json([
        { type: "pull_request" },
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }, { context: "deploy" }] } },
      ]);
    }
    throw new Error(`unexpected request: ${path}`);
  };

  expect((await adapter(fetch).readPullRequest(repo, 7)).checks.required).toEqual([
    { name: "ci", state: "passed" },
    { name: "deploy", state: "missing" },
  ]);
});

// The observed-checks fallback treats every classic status as required. A truncated page could omit the one
// red status and make M5 see an all-green head, so truncation must stop fact assembly entirely.
test("fails closed when GitHub truncates classic commit statuses", async () => {
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/pulls/7")) return json(pr);
    if (path.includes("/check-runs")) {
      return json({
        total_count: 1,
        check_runs: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 1 } }],
      });
    }
    if (path.endsWith("/status?per_page=100")) {
      return json({
        state: "failure",
        total_count: 31,
        statuses: Array.from({ length: 30 }, (_, index) => ({ context: `status-${index}`, state: "success" })),
      });
    }
    if (path.includes("/protection/")) return json({ message: "Not Found" }, 404);
    if (path.endsWith("/rules/branches/main?per_page=100")) return json([]);
    throw new Error(`unexpected request: ${path}`);
  };

  await expect(adapter(fetch).readPullRequest(repo, 7)).rejects.toThrow("commit-status page is truncated");
});

// A required-status rule can sit on the omitted page. Falling back to observed checks after a
// truncated rules response would silently replace repository policy with the canary fallback.
test("fails closed when GitHub truncates active branch rules", async () => {
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/pulls/7")) return json(pr);
    if (path.includes("/check-runs")) {
      return json({
        total_count: 1,
        check_runs: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 1 } }],
      });
    }
    if (path.endsWith("/status?per_page=100")) return json({ state: "pending", total_count: 0, statuses: [] });
    if (path.includes("/protection/")) return json({ message: "Not Found" }, 404);
    if (path.endsWith("/rules/branches/main?per_page=100")) {
      return json(
        Array.from({ length: 100 }, () => ({ type: "creation" })),
        200,
        { Link: '<https://api.github.test/rules?page=2>; rel="next"' },
      );
    }
    throw new Error(`unexpected request: ${path}`);
  };

  await expect(adapter(fetch).readPullRequest(repo, 7)).rejects.toThrow("active-rules page is truncated");
});

// GitHub's `sha` field is the final moved-head guard. Dropping or renaming it could merge a commit
// different from the one the Gate approved. The ruleset's required approval comes only from this
// App's review of that exact head, so it must precede the merge, and a failed one must stop it.
test("approves the exact head, then merges with GitHub's expected-head guard", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.endsWith("/pulls/7/reviews")) return json({ id: 1 });
    expect(path).toContain("/pulls/7/merge");
    return json({ sha: "b".repeat(40), merged: true, message: "merged" });
  };

  expect(await adapter(fetch).mergePullRequest({ repo, number: 7, expectedHeadSha: head })).toEqual({
    mergedSha: "b".repeat(40),
  });
  expect(calls.map((call) => call.path.replace(/^.*\/pulls\/7/, ""))).toEqual(["/reviews", "/merge"]);
  expect(calls[0]?.body).toMatchObject({ commit_id: head, event: "APPROVE" });
  expect(calls[1]?.body).toEqual({ sha: head, merge_method: "squash" });
});

test("a failed approval prevents the merge", async () => {
  const paths: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    paths.push(path);
    if (path.endsWith("/pulls/7/reviews")) return json({ message: "Unprocessable" }, 422);
    if (path.endsWith("/pulls/7")) return json(pr);
    throw new Error(`unexpected ${path}`);
  };

  await expect(adapter(fetch).mergePullRequest({ repo, number: 7, expectedHeadSha: head })).rejects.toThrow("(422)");
  expect(paths.some((path) => path.includes("/merge"))).toBe(false);
});

// TECH-4987: the captain's "Request changes" and inline comments were invisible to Sergeant. Every
// human review and comment must reach the PR facts (M8 reads them), and a bot's, Sergeant's own
// approval included, must never pass for human input.
test("reads human reviews and comments on the PR, never a bot's", async () => {
  const human = { login: "captain", type: "User" };
  const bot = { login: "sergeant-control[bot]", type: "Bot" };
  const at = "2026-10-03T01:00:00Z";
  const url = `https://github.com/${repo}/pull/7`;
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/pulls/7")) return json(pr);
    if (path.includes("/check-runs")) return json({ total_count: 1, check_runs: [{ name: "ci", status: "completed", conclusion: "success", app: { id: 1 } }] });
    if (path.endsWith("/status?per_page=100")) return json({ state: "pending", total_count: 0, statuses: [] });
    if (path.includes("/protection/")) return json({ message: "Not Found" }, 404);
    if (path.endsWith("/rules/branches/main?per_page=100")) return json([{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "ci" }] } }]);
    if (path.endsWith("/pulls/7/reviews?per_page=100&page=1")) {
      return json([
        { id: 1, user: bot, state: "APPROVED", body: "gate passed", commit_id: head, submitted_at: at, html_url: `${url}#r1` },
        { id: 2, user: human, state: "CHANGES_REQUESTED", body: "remove references to terros-wiki", commit_id: head, submitted_at: "2026-10-03T02:00:00Z", html_url: `${url}#r2`, author_association: "MEMBER" },
        { id: 3, user: human, state: "PENDING", body: "draft", commit_id: head, submitted_at: null, html_url: `${url}#r3` },
      ]);
    }
    if (path.endsWith("/pulls/7/comments?per_page=100&page=1")) {
      return json([{ id: 4, user: human, body: "not here", path: "docs/a.md", line: 12, commit_id: head, created_at: "2026-10-03T01:59:00Z", updated_at: "2026-10-03T02:01:00Z", html_url: `${url}#c4` }]);
    }
    if (path.endsWith("/issues/7/comments?per_page=100&page=1")) {
      return json([
        { id: 5, user: bot, body: "CI summary", created_at: at, updated_at: at, html_url: `${url}#c5` },
        { id: 6, user: human, body: "see my review", created_at: "2026-10-03T02:05:00Z", updated_at: "2026-10-03T02:05:00Z", html_url: `${url}#c6` },
      ]);
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const { humanFeedback } = await adapter(fetch).readPullRequest(repo, 7);
  expect(humanFeedback.map((f) => [f.id, f.author, f.state, f.path, f.line])).toEqual([
    ["review_comment:4", "captain", null, "docs/a.md", 12],
    ["review:2", "captain", "CHANGES_REQUESTED", null, null],
    ["comment:6", "captain", null, null, null],
  ]);
  expect(humanFeedback[0]).toMatchObject({ body: "not here", updatedAt: "2026-10-03T02:01:00.000Z", commitId: head });
  // TECH-4985 turns only feedback from people with a role in the repository into follow-ups.
  expect(humanFeedback.map((f) => f.association)).toEqual([undefined, "MEMBER", undefined]);
});

// TECH-4987: on a repository that requires a code owner's review, GitHub refuses the merge (405) after
// Sergeant's own approval. That is repository policy, not a fault to retry, and must come back as a
// refusal with GitHub's words rather than an error.
test("a merge GitHub refuses by repository policy resolves to refused", async () => {
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/pulls/7/reviews")) return json({ id: 1 });
    if (path.endsWith("/pulls/7/merge")) return json({ message: "Waiting on code owner review from terros-inc/owners." }, 405);
    if (path.endsWith("/pulls/7")) return json(pr);
    throw new Error(`unexpected ${path}`);
  };

  expect(await adapter(fetch).mergePullRequest({ repo, number: 7, expectedHeadSha: head })).toEqual({
    refused: "Waiting on code owner review from terros-inc/owners.",
  });
});

// TECH-4991: only a 405 GitHub means as policy parks a PR for a human (M12). A temporary 405 must
// reject so a later turn retries; a 405 on a head that did merge is that merge; a moved head (409)
// is never a refusal.
test.each([
  ["the base moved mid-merge", 405, "Base branch was modified. Review and try the merge again."],
  ["GitHub is still computing mergeability", 405, "Pull Request is not mergeable"],
  ["the head moved", 409, "Head branch was modified. Review and try the merge again."],
])("a merge that fails because %s rejects rather than resolving to refused", async (_, status, message) => {
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/pulls/7/reviews")) return json({ id: 1 });
    if (path.endsWith("/pulls/7/merge")) return json({ message }, status);
    if (path.endsWith("/pulls/7")) return json(pr);
    throw new Error(`unexpected ${path}`);
  };

  await expect(adapter(fetch).mergePullRequest({ repo, number: 7, expectedHeadSha: head })).rejects.toThrow(`(${status}): ${message}`);
});

test("a 405 on a head that already merged resolves to that merge", async () => {
  const merged = { ...pr, state: "closed", merged_at: "2026-10-03T01:00:00Z", merge_commit_sha: "c".repeat(40) };
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith("/pulls/7/reviews")) return json({ id: 1 });
    if (path.endsWith("/pulls/7/merge")) return json({ message: "Pull Request is not mergeable" }, 405);
    if (path.endsWith("/pulls/7")) return json(merged);
    throw new Error(`unexpected ${path}`);
  };

  expect(await adapter(fetch).mergePullRequest({ repo, number: 7, expectedHeadSha: head })).toEqual({ mergedSha: "c".repeat(40) });
});

// TECH-4989: a canceled task's PR is commented on, then closed. A close that fails is retried by the
// next drive, which must not post the "Closed: ..." comment a second time.
test("closing a PR comments once, and a retry after a failed close does not comment again", async () => {
  const comment = "Closed: the Linear issue was canceled or moved to Backlog.";
  const comments: string[] = [];
  let closeFails = true;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/issues/7/comments?per_page=100&page=1")) {
      return json(comments.map((body, i) => ({ id: i, user: { login: "sergeant-control[bot]", type: "Bot" }, body, created_at: "2026-10-03T01:00:00Z", updated_at: "2026-10-03T01:00:00Z", html_url: `https://github.com/${repo}/pull/7#c${i}` })));
    }
    if (path.endsWith("/issues/7/comments") && init?.method === "POST") return (comments.push(JSON.parse(String(init.body)).body), json({ id: 1 }));
    if (path.endsWith("/pulls/7") && init?.method === "PATCH") return closeFails ? ((closeFails = false), json({ message: "Server Error" }, 502)) : json(pr);
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${path}`);
  };
  const github = adapter(fetch);

  await expect(github.closePullRequest({ repo, number: 7, comment })).rejects.toThrow("(502)");
  await github.closePullRequest({ repo, number: 7, comment });
  expect(comments).toEqual([comment]);
});
