import { expect, test } from "vitest";
import { fakeApi, sgt } from "./fake-api.ts";

test("repo list is any signed-in user's, and only adding and removing are under admin", async () => {
  const { api, seen } = await fakeApi({
    "GET /v1/repositories": { json: { repositories: [{ repo: "terros-inc/one", mergeMethod: "squash", mergePolicy: "sergeant" }] } },
    "POST /v1/repositories/add": { json: { repo: "terros-inc/two", changed: true, repositories: ["terros-inc/one", "terros-inc/two"] } },
  });
  expect(await sgt(api, "repo", "list")).toMatchObject({ code: 0, out: "terros-inc/one  squash  merged by sergeant\n" });
  expect((await sgt(api, "admin", "repo", "list")).code).toBe(2);
  expect(await sgt(api, "admin", "repo", "add", "terros-inc/two", "--merge-method", "rebase", "--merge-policy", "human")).toMatchObject({ code: 0, out: expect.stringContaining("enrolled terros-inc/two") });
  expect(seen.map((s) => [s.method, s.url, s.body && JSON.parse(s.body)])).toEqual([
    ["GET", "/v1/repositories", ""],
    ["POST", "/v1/repositories/add", { repo: "terros-inc/two", mergeMethod: "rebase", mergePolicy: "human" }],
  ]);
});
