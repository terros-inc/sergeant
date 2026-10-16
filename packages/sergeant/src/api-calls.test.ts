import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { apiCalls, withSource } from "./api-calls.ts";
import { routeTemplate } from "./api-endpoint.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "api-usage-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

// TECH-5942: the counts are only useful if each call lands on the source that made it, including calls
// made in parallel and in a nested source, and if a finished hour is logged so it can be read later.
test("API calls are counted per hour by the innermost source, and each finished hour is logged once", async () => {
  const clock = { now: Date.parse("2026-10-13T15:10:00Z") };
  const logs: string[] = [];
  const calls = apiCalls((line) => logs.push(line), () => clock.now);
  const answers = new Map([["https://api.github.com/a", 200], ["https://api.github.com/b", 304]]);
  const github = calls.counting("github", async (input) => new Response(null, { status: answers.get(String(input)) ?? 200 }));
  const linear = calls.counting("linear", async () => new Response("{}"));

  await withSource("task loop", async () => {
    await Promise.all([linear("https://api.linear.app/graphql"), withSource("task PR reads", () => Promise.all([github("https://api.github.com/a"), github("https://api.github.com/b")]))]);
    // An upload is not an API call.
    await linear("https://uploads.linear.app/x");
  });
  await github("https://api.github.com/a");
  expect(calls.status()).toEqual([
    { hour: "2026-10-13T15:00:00.000Z", provider: "github", source: "task PR reads", calls: 2, notModified: 1 },
    { hour: "2026-10-13T15:00:00.000Z", provider: "github", source: "other", calls: 1, notModified: 0 },
    { hour: "2026-10-13T15:00:00.000Z", provider: "linear", source: "task loop", calls: 1, notModified: 0 },
  ]);
  expect(logs).toEqual([]);

  clock.now += 3_600_000;
  await withSource("intake", () => linear("https://api.linear.app/graphql"));
  expect(logs).toEqual([
    "api calls github 2026-10-13T15:00:00.000Z: 3 (task PR reads 2 (304: 1), other 1)",
    "api calls linear 2026-10-13T15:00:00.000Z: 1 (task loop 1)",
  ]);
  expect(calls.status().map((c) => [c.hour.slice(11, 13), c.provider, c.source])).toEqual([
    ["15", "github", "task PR reads"], ["15", "github", "other"], ["15", "linear", "task loop"], ["16", "linear", "intake"],
  ]);
});

// TECH-6208: an endpoint per route, not per PR, sha, or branch, or the breakdown is thousands of rows of one.
test("calls are counted by route template and GraphQL operation", async () => {
  expect(routeTemplate("/repos/acme/app/pulls/225/reviews")).toBe("/repos/{o}/{r}/pulls/{n}/reviews");
  expect(routeTemplate(`/repos/acme/app/commits/${"a".repeat(40)}/check-runs`)).toBe("/repos/{o}/{r}/commits/{sha}/check-runs");
  expect(routeTemplate("/repos/acme/app/git/matching-refs/heads/sergeant/tech-1")).toBe("/repos/{o}/{r}/git/matching-refs/heads/{ref}");
  expect(routeTemplate("/repos/acme/app/branches/release%2Fv2/protection/required_status_checks")).toBe("/repos/{o}/{r}/branches/{branch}/protection/required_status_checks");

  const calls = apiCalls(() => {}, () => Date.parse("2026-10-13T15:10:00Z"));
  const github = calls.counting("github", async () => new Response(null, { status: 304 }));
  const linear = calls.counting("linear", async () => new Response("{}"));
  await github("https://api.github.com/repos/acme/app/pulls/7?per_page=100");
  await github("https://api.github.com/repos/acme/web/pulls/8");
  await github("https://api.github.com/graphql", { method: "POST", body: JSON.stringify({ query: "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }" }) });
  await linear("https://api.linear.app/graphql", { method: "POST", body: JSON.stringify({ query: "query SergeantIssue($id: String!) { issue(id: $id) { id } }" }) });
  expect(calls.usage(1).endpoints.map((e) => [e.provider, e.endpoint, e.calls, e.notModified])).toEqual([
    ["github", "GET /repos/{o}/{r}/pulls/{n}", 2, 2],
    ["github", "mutation markPullRequestReadyForReview", 1, 1],
    ["linear", "query SergeantIssue", 1, 0],
  ]);
});

const T0 = Date.parse("2026-10-16T17:13:00Z");
const RESET_S = T0 / 1000 + 3600;
const ratelimit = (remaining: number, reset = RESET_S, extra: Record<string, string> = {}) => ({
  headers: { "x-ratelimit-limit": "7300", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(reset), "x-ratelimit-resource": "core", ...extra },
});

// TECH-6208: a release restart threw away every count just before the budget ran out, so nobody could
// say what spent it. Everything recorded must be there after a restart, and the window's gap must
// show calls serve did not make.
test("usage, budget samples, windows, rate-limit events, and paused tasks survive a restart", async () => {
  const file = join(dir, "api-usage.json");
  const clock = { now: T0 };
  const logs: string[] = [];
  const before = apiCalls((l) => logs.push(l), () => clock.now, file);
  await before.load();
  let answer = () => Response.json({}, ratelimit(7000));
  const github = before.counting("github", async () => answer());
  const linear = before.counting("linear", async () =>
    Response.json({}, { headers: { "x-ratelimit-requests-limit": "1500", "x-ratelimit-requests-remaining": "1400", "x-ratelimit-requests-reset": String(T0 + 3_600_000) } }),
  );

  await withSource("task loop", () => github("https://api.github.com/repos/acme/app/pulls/7"));
  await linear("https://api.linear.app/graphql");
  clock.now += 60_000;
  // Serve counted one more call, but GitHub's remaining fell by 1,000: something else spent 999.
  answer = () => Response.json({}, ratelimit(6000));
  await github("https://api.github.com/repos/acme/app/pulls/7");
  clock.now += 60_000;
  answer = () => Response.json({ message: "You have exceeded a secondary rate limit." }, { status: 403, headers: { "retry-after": "60" } });
  await github("https://api.github.com/repos/acme/app/pulls/7");
  await github("https://api.github.com/repos/acme/app/pulls/8");
  before.taskPaused("github", "TECH-1");
  before.taskPaused("github", "TECH-2");
  before.taskPaused("github", "TECH-1");
  await before.save();
  const saved = before.usage(24);
  expect(saved.windows).toEqual([
    { provider: "github", resource: "core", resetAt: new Date(RESET_S * 1000).toISOString(), limit: 7300, firstAt: new Date(T0).toISOString(), firstRemaining: 7000, lastAt: new Date(T0 + 60_000).toISOString(), lowestRemaining: 6000, counted: 1 },
  ]);
  expect(saved.events).toEqual([
    { provider: "github", kind: "secondary", status: 403, startedAt: new Date(T0 + 120_000).toISOString(), until: new Date(T0 + 180_000).toISOString(), endedAt: null, refusals: 2, tasks: ["TECH-1", "TECH-2"] },
  ]);
  expect(saved.samples.map((s) => [s.provider, s.resource, s.remaining])).toEqual([["github", "core", 6000], ["linear", "requests", 1400]]);

  // A new process reads it all back and goes on counting into the same hour and the same event.
  clock.now += 120_000;
  const after = apiCalls((l) => logs.push(l), () => clock.now, file);
  await after.load();
  expect(after.usage(24)).toEqual(saved);
  await after.counting("github", async () => Response.json({}, ratelimit(5900)))("https://api.github.com/repos/acme/app/pulls/7");
  const resumed = after.usage(24);
  expect(resumed.sources.find((c) => c.provider === "github")).toMatchObject({ source: "other", calls: 4 });
  expect(resumed.endpoints.find((c) => c.provider === "github")).toMatchObject({ endpoint: "GET /repos/{o}/{r}/pulls/{n}", calls: 5 });
  expect(resumed.events[0]?.endedAt).toBe(new Date(clock.now).toISOString());
  expect(resumed.windows[0]).toMatchObject({ lowestRemaining: 5900, counted: 2 });

  // Kept for 7 days, then dropped.
  clock.now += 8 * 24 * 3_600_000;
  await after.save();
  const later = apiCalls(() => {}, () => clock.now, file);
  await later.load();
  expect(later.usage(168)).toMatchObject({ sources: [], endpoints: [], samples: [], windows: [], events: [] });
});

// TECH-6208: the warning must come before the budget runs out, and once per window: a warning on every
// call below the line would bury the log as the repeated rate-limit errors did.
test("a budget falling below 15% before its reset is warned about once per window, across a restart too", async () => {
  const file = join(dir, "api-usage.json");
  const clock = { now: T0 };
  const logs: string[] = [];
  let calls = apiCalls((l) => logs.push(l), () => clock.now, file);
  let remaining = 2000;
  const call = () => calls.counting("github", async () => Response.json({}, ratelimit(remaining)))("https://api.github.com/repos/acme/app/pulls/7");
  const warnings = () => logs.filter((l) => l.startsWith("WARNING:"));

  for (; remaining > 0; remaining -= 250) {
    await call();
    clock.now += 60_000;
  }
  expect(warnings()).toEqual([`WARNING: github core API budget low: 1000 of 7300 left (14%) until its reset at ${new Date(RESET_S * 1000).toISOString()}`]);

  await calls.save();
  calls = apiCalls((l) => logs.push(l), () => clock.now, file);
  await calls.load();
  remaining = 10;
  await call();
  expect(warnings()).toHaveLength(1);

  // The next window warns again.
  clock.now = RESET_S * 1000 + 60_000;
  remaining = 500;
  await calls.counting("github", async () => Response.json({}, ratelimit(remaining, RESET_S + 3600)))("https://api.github.com/repos/acme/app/pulls/7");
  expect(warnings()).toHaveLength(2);
  expect(calls.usage(24).alerts.map((a) => a.remaining)).toEqual([1000, 500]);
});

test("an unreadable record is set aside and counting starts afresh", async () => {
  const file = join(dir, "api-usage.json");
  await writeFile(file, "{not json");
  const logs: string[] = [];
  const calls = apiCalls((l) => logs.push(l), () => T0, file);
  await calls.load();
  expect(logs[0]).toMatch(/^api-usage\.json is unreadable .*; moved to .*, and API usage is recorded afresh$/);
  expect((await readdir(dir)).filter((f) => f.startsWith("api-usage.json.unreadable-"))).toHaveLength(1);
  expect(calls.usage(24).sources).toEqual([]);
});
