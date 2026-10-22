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

// TECH-6619: audit yield and FAIL rate are printed as fractions, unknown Found beside the yield and never
// in it, and --found shows every finding behind each Found: YES (a public PR shows only some).
const counts = (completed: number, found: number, foundKnown: number, fail: number) => ({ completed, found, foundKnown, foundUnknown: completed - foundKnown, fail });
const audits = {
  repo: "example-org/example-app", since: "2026-09-22T00:00:00.000Z", ...counts(22, 3, 20, 4), incomplete: 1,
  byRepo: [{ repo: "example-org/example-app", ...counts(22, 3, 20, 4) }],
  bySergeant: { agreed: counts(10, 1, 10, 1), sergeant_merged: counts(4, 0, 4, 0), other: counts(8, 2, 6, 3) },
  audits: [
    { runId: "run_audit-1", issue: "UNF-1", repo: "example-org/example-app", number: 12, url: "https://github.com/example-org/example-app/pull/12", headSha: sha, at: "2026-10-01T00:00:00.000Z", verdict: "changes_requested", found: true, group: "other",
      summary: "One requirement is unmet.", findings: [{ id: "f1", severity: "blocking", category: "acceptance", location: "src/export.ts:12", description: "Archived rows are skipped." }, { id: "f2", severity: "nit", description: "Rename `tmp`." }] },
    { runId: "run_audit-2", issue: "UNF-2", repo: "example-org/example-app", number: 13, url: "https://github.com/example-org/example-app/pull/13", headSha: sha, at: "2026-10-02T00:00:00.000Z", verdict: "approve", found: false, group: "agreed" },
    { runId: "run_audit-3", issue: "UNF-3", repo: "example-org/example-app", number: 14, url: "https://github.com/example-org/example-app/pull/14", headSha: sha, at: "2026-10-03T00:00:00.000Z", verdict: "changes_requested", found: true, group: "other" },
  ],
  newerField: "kept",
};

test("review audits prints yield and FAIL fractions, --by sergeant's split, and --found rows with every finding", async () => {
  const { api, seen } = await fakeApi({ "GET /v1/review-audits?since=30d&repo=example-org%2Fexample-app": { json: audits } });
  const { code, out } = await sgt(api, "review", "audits", "--since", "30d", "--repo", "example-org/example-app", "--by", "sergeant", "--found");
  expect(code).toBe(0);
  expect(seen.map((s) => s.url)).toEqual(["/v1/review-audits?since=30d&repo=example-org%2Fexample-app"]);
  expect(out).toBe(
    [
      "Post-merge audits, example-org/example-app, last 30 days",
      "  Found YES 3 / known 20 = 15.0%   (Found unknown 2)",
      "  FAIL 4 / completed 22 = 18.2%",
      "  Not completed 1",
      "",
      "  AGREED heads     Found YES 1 / known 10 = 10.0%  (Found unknown 0)  FAIL 1 / completed 10 = 10.0%",
      "  Sergeant-merged  Found YES 0 / known 4 = 0.0%    (Found unknown 0)  FAIL 0 / completed 4 = 0.0%",
      "  Other PRs        Found YES 2 / known 6 = 33.3%   (Found unknown 2)  FAIL 3 / completed 8 = 37.5%",
      "",
      `https://github.com/example-org/example-app/pull/12  ${sha}  FAIL  UNF-1  run_audit-1`,
      "  One requirement is unmet.",
      "  - [blocking, acceptance] src/export.ts:12: Archived rows are skipped.",
      "  - [nit] Rename `tmp`.",
      "",
      `https://github.com/example-org/example-app/pull/14  ${sha}  FAIL  UNF-3  run_audit-3`,
      "  findings unavailable",
      "",
    ].join("\n"),
  );
});

test("review audits with nothing completed prints fractions without a percentage; --json is the API's answer as sent", async () => {
  const none = { ...counts(0, 0, 0, 0), incomplete: 0, byRepo: [], bySergeant: { agreed: counts(0, 0, 0, 0), sergeant_merged: counts(0, 0, 0, 0), other: counts(0, 0, 0, 0) }, audits: [] };
  const { api } = await fakeApi({ "GET /v1/review-audits": { json: none }, "GET /v1/review-audits?repo=example-org%2Fexample-app": { json: audits } });
  const { out } = await sgt(api, "review", "audits");
  expect(out).toBe("Post-merge audits, all repositories, all time\n  Found YES 0 / known 0   (Found unknown 0)\n  FAIL 0 / completed 0\n");

  const json = await sgt(api, "--json", "review", "audits", "--repo", "example-org/example-app");
  expect(JSON.parse(json.out)).toEqual(audits);

  expect((await sgt(api, "review", "audits", "--by", "team")).code).toBe(2);
});
