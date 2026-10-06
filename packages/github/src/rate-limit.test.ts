import { GitHubRateLimitedError } from "@terros/sergeant-contracts";
import { expect, test } from "vitest";
import { createGitHubPort } from "./github.ts";

// TECH-5336: Sergeant's installation ran out of GitHub's hourly allowance and kept calling, hundreds of
// refused calls every ten minutes, so nothing recovered until the polling stopped by chance.

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
  updated_at: "2026-10-06T05:00:00Z",
  mergeable: true,
  merge_commit_sha: null,
  head: { sha: head },
  base: { ref: "main", sha: "b".repeat(40) },
};
const T0 = Date.parse("2026-10-06T05:10:00Z");
const RESET = T0 / 1000 + 1800;

type Answer = (path: string, headers: Headers) => Response;
/** A PR with no checks, rules, or feedback, unless `answer` says otherwise; every call is recorded. */
const github = (answer: Answer = () => new Response(null, { status: 599 })) => {
  const calls: { path: string; headers: Headers }[] = [];
  const logs: string[] = [];
  const clock = { now: T0 };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace("https://api.github.com", "");
    const headers = new Headers(init?.headers);
    calls.push({ path, headers });
    const answered = answer(path, headers);
    if (answered.status !== 599) return answered;
    if (path.endsWith("/pulls/7")) return Response.json(pr);
    if (path.includes("/check-runs")) return Response.json({ total_count: 0, check_runs: [] });
    if (path.endsWith("/status?per_page=100")) return Response.json({ state: "success", total_count: 0, statuses: [] });
    if (path.includes("/protection/")) return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    return Response.json([]);
  };
  const port = createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash" } }, fetch, log: (l) => logs.push(l), now: () => clock.now });
  return { port, calls, logs, clock };
};

test("a primary rate limit stops every GitHub call until its reset, logged once", async () => {
  let limited = true;
  const { port, calls, logs, clock } = github((path) =>
    limited && path.endsWith("/pulls/7")
      ? Response.json({ message: "API rate limit exceeded for installation ID 166985228." }, { status: 403, headers: { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET) } })
      : new Response(null, { status: 599 }),
  );
  const until = new Date(RESET * 1000).toISOString();

  const first = await port.readPullRequest(repo, 7).catch((e: unknown) => e);
  expect(first).toBeInstanceOf(GitHubRateLimitedError);
  expect((first as GitHubRateLimitedError).until).toBe(until);
  // Every later intake's reads fail at once, without reaching GitHub or logging again.
  clock.now = RESET * 1000 - 1000;
  await expect(port.readPullRequest(repo, 7)).rejects.toThrow(`no GitHub calls until ${until}`);
  await expect(port.closePullRequest({ repo, number: 7, comment: "x" })).rejects.toBeInstanceOf(GitHubRateLimitedError);
  expect(calls).toHaveLength(1);
  expect(logs).toEqual([`GitHub API primary rate limit: no GitHub calls until ${until} (HTTP 403, 5000 calls an hour)`]);
  expect(port.rateLimit?.()).toEqual({ limit: 5000, remaining: 0, resetAt: until, observedAt: new Date(T0).toISOString(), pausedUntil: until });

  limited = false;
  clock.now = RESET * 1000;
  expect((await port.readPullRequest(repo, 7)).headSha).toBe(head);
  expect(port.rateLimit?.()?.pausedUntil).toBeNull();
});

// Classic protection's 403 is an expected, allowed answer (the App cannot read it). A secondary
// limit's 403 on that same read must still pause, never pass for unreadable protection.
test("a secondary limit's retry-after pauses calls even where a 403 is otherwise allowed", async () => {
  let limited = true;
  const { port, calls, logs, clock } = github((path) =>
    limited && path.includes("/protection/")
      ? ((limited = false), Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403, headers: { "retry-after": "90" } }))
      : new Response(null, { status: 599 }),
  );

  await expect(port.readPullRequest(repo, 7)).rejects.toBeInstanceOf(GitHubRateLimitedError);
  const made = calls.length;
  clock.now = T0 + 89_000;
  await expect(port.readPullRequest(repo, 7)).rejects.toBeInstanceOf(GitHubRateLimitedError);
  expect(calls).toHaveLength(made);
  expect(logs).toEqual([`GitHub API secondary rate limit: no GitHub calls until ${new Date(T0 + 90_000).toISOString()} (HTTP 403)`]);
  clock.now = T0 + 90_000;
  await expect(port.readPullRequest(repo, 7)).resolves.toMatchObject({ headSha: head });
});

// A 304 does not count against the rate limit; it must still give the facts the 200 did, and an
// unchanged PR's reviews and comments, and its unreadable protection, are not asked again.
test("an unchanged PR is reread conditionally: a 304 answers with the earlier facts", async () => {
  const budget = { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4321", "x-ratelimit-reset": String(RESET) };
  const etagged = (path: string) => path.endsWith("/pulls/7") || path.includes("/check-runs") || path.endsWith("/status?per_page=100");
  const { port, calls } = github((path, headers) => {
    if (!etagged(path)) return new Response(null, { status: 599 });
    if (headers.get("if-none-match") === `"${path}"`) return new Response(null, { status: 304, headers: budget });
    const body = path.endsWith("/pulls/7") ? pr : path.includes("/check-runs") ? { total_count: 0, check_runs: [] } : { state: "success", total_count: 0, statuses: [] };
    return Response.json(body, { headers: { ...budget, etag: `"${path}"` } });
  });

  const before = await port.readPullRequest(repo, 7);
  const firstPass = calls.length;
  const after = await port.readPullRequest(repo, 7);

  expect(after).toEqual(before);
  const second = calls.slice(firstPass);
  expect(second.map((c) => c.path)).toEqual([`/repos/${repo}/pulls/7`, `/repos/${repo}/commits/${head}/check-runs?per_page=100`, `/repos/${repo}/commits/${head}/status?per_page=100`, `/repos/${repo}/rules/branches/main?per_page=100`]);
  expect(second.slice(0, 3).map((c) => c.headers.get("if-none-match"))).toEqual(second.slice(0, 3).map((c) => `"${c.path}"`));
  expect(port.rateLimit?.()).toMatchObject({ limit: 5000, remaining: 4321, pausedUntil: null });
});
