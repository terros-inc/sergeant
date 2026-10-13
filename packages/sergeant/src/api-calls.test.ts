import { expect, test } from "vitest";
import { apiCalls, withSource } from "./api-calls.ts";

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
