import { expect, test } from "vitest";
import { fakeApi, sgt } from "./fake-api.ts";

// TECH-6613: the readiness rate is read by people deciding whether Sergeant may earn auto-merge, so it
// must always show its fraction, never count UNKNOWN in it, and never print a percentage of nothing.

const sha = "a".repeat(40);
const row = (number: number, cls: string, reason: string, declarationReason?: string) => ({
  task: "UNF-1", repo: "example-org/example-app", number, url: `https://github.com/example-org/example-app/pull/${number}`, commentUrl: `https://github.com/example-org/example-app/pull/${number}#issuecomment-1`,
  headSha: sha, at: "2026-10-01T00:00:00.000Z", class: cls, reason, ...(declarationReason && { declarationReason }),
});
const answer = {
  repo: "example-org/example-app", since: "2026-07-24T00:00:00.000Z", agreed: 41, differentHead: 5, rejected: 1, evaluated: 47,
  unknown: { pending: 3, closed_unmerged: 2, not_human_merge: 0, uninterpretable: 0 },
  mergers: [{ login: "example-owner", count: 30 }, { login: "example-dev", count: 11 }],
  declarations: [row(12, "AGREED", "same_head", "Reviewed and green"), row(13, "UNKNOWN", "pending")],
  newerField: "kept",
};

test("review readiness prints the fraction, each class and UNKNOWN reason, mergers, and with --list each declaration", async () => {
  const { api, seen } = await fakeApi({ "GET /v1/review-readiness?since=90d&repo=example-org%2Fexample-app": { json: answer } });
  const { code, out } = await sgt(api, "review", "readiness", "--since", "90d", "--repo", "example-org/example-app", "--list");
  expect(code).toBe(0);
  expect(seen.map((s) => s.url)).toEqual(["/v1/review-readiness?since=90d&repo=example-org%2Fexample-app"]);
  expect(out).toBe(
    [
      "Sergeant readiness, example-org/example-app, last 90 days",
      "  AGREED 41 / evaluated 47 = 87.2%   (DIFFERENT_HEAD 5, REJECTED 1)",
      "  UNKNOWN 5: pending 3, closed_unmerged 2",
      "  Mergers: example-owner 30, example-dev 11",
      "",
      `https://github.com/example-org/example-app/pull/12  ${sha}  AGREED             Reviewed and green`,
      `https://github.com/example-org/example-app/pull/13  ${sha}  UNKNOWN (pending)  -`,
      "",
    ].join("\n"),
  );
});

test("with nothing evaluated it prints the counts and no percentage; --json is the API's answer as sent", async () => {
  const none = { agreed: 0, differentHead: 0, rejected: 0, evaluated: 0, unknown: { pending: 2, closed_unmerged: 0, not_human_merge: 1, uninterpretable: 0 }, mergers: [], declarations: [] };
  const { api } = await fakeApi({ "GET /v1/review-readiness": { json: none }, "GET /v1/review-readiness?repo=example-org%2Fexample-app": { json: answer } });
  const { out } = await sgt(api, "review", "readiness");
  expect(out).toContain("all repositories, all time\n  AGREED 0 / evaluated 0   (DIFFERENT_HEAD 0, REJECTED 0)\n  UNKNOWN 3: pending 2, not_human_merge 1\n  Mergers: none\n");
  expect(out).not.toContain("%");

  const json = await sgt(api, "--json", "review", "readiness", "--repo", "example-org/example-app");
  expect(JSON.parse(json.out)).toEqual(answer);

  expect((await sgt(api, "review", "readiness", "--since", "3 months")).code).toBe(2);
});
