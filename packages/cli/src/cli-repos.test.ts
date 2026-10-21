import { expect, test } from "vitest";
import { fakeApi, sgt } from "./fake-api.ts";

test("repo list is any signed-in user's, and only adding and removing are under admin", async () => {
  const { api, seen } = await fakeApi({
    "GET /v1/repositories": { json: { repositories: [{ repo: "terros-inc/one", mergeMethod: "squash", mergePolicy: "sergeant" }] } },
    "POST /v1/repositories/add": { json: { repo: "terros-inc/two", changed: true, repositories: ["terros-inc/one", "terros-inc/two"] } },
  });
  expect(await sgt(api, "repo", "list")).toMatchObject({ code: 0, out: "terros-inc/one  squash  merged by sergeant  base worker\n" });
  expect((await sgt(api, "admin", "repo", "list")).code).toBe(2);
  expect(await sgt(api, "admin", "repo", "add", "terros-inc/two", "--merge-method", "rebase", "--merge-policy", "human", "--worker-profile", "android")).toMatchObject({ code: 0, out: expect.stringContaining("enrolled terros-inc/two") });
  expect(seen.map((s) => [s.method, s.url, s.body && JSON.parse(s.body)])).toEqual([
    ["GET", "/v1/repositories", ""],
    ["POST", "/v1/repositories/add", { repo: "terros-inc/two", mergeMethod: "rebase", mergePolicy: "human", workerProfile: "android" }],
  ]);
});

test("admin repo budget sends each flag given, default as a clear, and refuses a malformed number unsent", async () => {
  const { api, seen } = await fakeApi({
    "GET /v1/repositories": { json: { repositories: [{ repo: "terros-inc/one", mergeMethod: "squash", mergePolicy: "human", budget: { wallMinutes: 60, costUsd: 25 }, ownBudget: { wallMinutes: 60 } }] } },
    "POST /v1/repositories/budget": { json: { repo: "terros-inc/one", changed: true, ownBudget: { wallMinutes: 60 }, budget: { wallMinutes: 60, costUsd: 25 } } },
  });
  const set = await sgt(api, "admin", "repo", "budget", "terros-inc/one", "--wall-minutes", "60");
  expect(set).toMatchObject({ code: 0, out: expect.stringContaining("set terros-inc/one's budget window: 60 min (own), $25") });
  await sgt(api, "admin", "repo", "budget", "terros-inc/one", "--cost-usd", "default", "--wall-minutes", "45.5");
  // Refused before any request; 400 digits is Infinity, which JSON would send as null.
  for (const bad of ["abc", "0", "-3", "1e3", "9".repeat(400)]) expect((await sgt(api, "admin", "repo", "budget", "terros-inc/one", "--cost-usd", bad)).code).toBe(2);
  expect((await sgt(api, "admin", "repo", "budget", "terros-inc/one")).code).toBe(2);
  expect(await sgt(api, "repo", "list")).toMatchObject({ code: 0, out: "terros-inc/one  squash  merged by human  base worker  60 min (own), $25\n" });
  expect(seen.map((s) => [s.url, s.body && JSON.parse(s.body)])).toEqual([
    ["/v1/repositories/budget", { repo: "terros-inc/one", wallMinutes: 60 }],
    ["/v1/repositories/budget", { repo: "terros-inc/one", wallMinutes: 45.5, costUsd: "default" }],
    ["/v1/repositories", ""],
  ]);
});

// TECH-6617: a rate outside 0..1, or one JSON would send as null, must never reach serve as a rate.
test("admin repo audit-rate sends a rate from 0 to 1 and refuses anything else unsent", async () => {
  const { api, seen } = await fakeApi({ "POST /v1/repositories/audit-rate": { json: { repo: "terros-inc/one", changed: true, mergedAuditSampleRate: 0.1 } } });
  expect(await sgt(api, "admin", "repo", "audit-rate", "terros-inc/one", "0.1")).toMatchObject({ code: 0, out: expect.stringContaining("set terros-inc/one's merged-PR audit rate to 0.1") });
  for (const bad of ["1.5", "-0.1", "abc", "1e-1", "", "9".repeat(400)]) expect((await sgt(api, "admin", "repo", "audit-rate", "terros-inc/one", bad)).code).toBe(2);
  expect(seen.map((s) => [s.url, s.body && JSON.parse(s.body)])).toEqual([["/v1/repositories/audit-rate", { repo: "terros-inc/one", mergedAuditSampleRate: 0.1 }]]);
});
