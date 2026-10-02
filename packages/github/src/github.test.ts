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
  base: { ref: "main" },
};

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, { status, ...(headers && { headers }) });
const adapter = (fetch: typeof globalThis.fetch, observedChecksFallback = false) =>
  createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash", observedChecksFallback } }, fetch });

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
