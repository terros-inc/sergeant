import { expect, test } from "vitest";
import { classifyTier, globToRegExp, TIER_MAP_PATH, type TierMapRead } from "./review-tiers.ts";

// TECH-6553: a PR's tier decides whether Sergeant may merge it at all. A classification that came out
// lower than the map says, or lower than T3 when Sergeant cannot tell, would let Sergeant self-merge a
// sensitive change.

const map = (tiers: Record<string, string[]>, humanTeam?: string): TierMapRead => ({ kind: "parsed", document: { ...(humanTeam && { humanTeam }), tiers } });
const sales = map(
  {
    T0: ["**/*.md", "docs/**"],
    T1: ["apps/web/**", "**/AGENTS.md"],
    T2: ["package.json", "packages/api-*/**"],
    T3: ["apps/infra/**", "packages/api-auth/**"],
    T4: [".github/CODEOWNERS"],
  },
  "reviewers",
);

test("the highest tier of any changed file wins, and a file matching several patterns takes the highest", () => {
  expect(classifyTier(["docs/a.md"], sales)).toEqual({ tier: "T0", rule: "`docs/a.md` matches T0 pattern `**/*.md`", humanTeam: "reviewers" });
  expect(classifyTier(["docs/a.md", "apps/web/x.tsx"], sales)).toMatchObject({ tier: "T1", rule: "`apps/web/x.tsx` matches T1 pattern `apps/web/**`" });
  // T0 by `**/*.md`, T1 by `**/AGENTS.md`: pattern order never matters.
  expect(classifyTier(["apps/web/AGENTS.md"], sales)).toMatchObject({ tier: "T1" });
  // T2 by `packages/api-*/**`, T3 by `packages/api-auth/**`.
  expect(classifyTier(["apps/web/x.tsx", "packages/api-auth/login.ts"], sales)).toMatchObject({ tier: "T3", rule: "`packages/api-auth/login.ts` matches T3 pattern `packages/api-auth/**`" });
  expect(classifyTier([".github/CODEOWNERS", "docs/a.md"], sales)).toMatchObject({ tier: "T4" });
});

test("a path the map does not list is T2", () => {
  expect(classifyTier(["docs/a.md", "scripts/run.sh"], sales)).toMatchObject({ tier: "T2", rule: "`scripts/run.sh` is not listed in the tier map, so it is T2" });
});

test("no map, an unreadable or invalid map, or an unreadable file list is T3", () => {
  expect(classifyTier(["docs/a.md"], { kind: "absent" })).toEqual({ tier: "T3", rule: `the repository has no tier map (\`${TIER_MAP_PATH}\`) at the PR head` });
  expect(classifyTier(["docs/a.md"], { kind: "unreadable", reason: "GitHub returned 502" })).toMatchObject({ tier: "T3", rule: expect.stringContaining("502") });
  expect(classifyTier(undefined, sales)).toMatchObject({ tier: "T3", rule: "the PR's changed files could not be read, so it fails closed" });
  for (const document of [
    "not a map",
    { tiers: { T0: "**/*.md" } },
    // A lowercase tier name is a typo, not a rule to ignore: its paths would otherwise fall to T2.
    { tiers: { t3: ["apps/infra/**"] } },
    { tiers: { T3: ["apps/{infra,deploy}/**"] } },
    { tiers: { T3: ["/apps/infra/**"] } },
    { humanTeam: "x", tiers: {}, owners: [] },
  ]) {
    expect(classifyTier(["docs/a.md"], { kind: "parsed", document })).toMatchObject({ tier: "T3", rule: expect.stringContaining("the tier map is invalid") });
  }
});

test("a change to the map itself is T4, even where the map lists it lower or there is none yet", () => {
  const permissive = map({ T0: ["**"] });
  expect(classifyTier([TIER_MAP_PATH], permissive)).toMatchObject({ tier: "T4", rule: `the PR changes the tier map \`${TIER_MAP_PATH}\`` });
  expect(classifyTier(["src/a.ts", TIER_MAP_PATH], { kind: "absent" })).toMatchObject({ tier: "T4" });
});

test("protected CI configuration is at least T3 even where the map says lower", () => {
  const permissive = map({ T0: ["**"] });
  expect(classifyTier([".github/workflows/ci.yml"], permissive)).toMatchObject({ tier: "T3", rule: expect.stringContaining("protected CI") });
  expect(classifyTier(["build/Jenkinsfile", "README.md"], permissive)).toMatchObject({ tier: "T3" });
  expect(classifyTier([".github/workflows/ci.yml"], map({ T4: [".github/**"] }))).toMatchObject({ tier: "T4" });
});

test("globs: `**` spans directories, possibly none; `*` and `?` stay within one; the whole path must match", () => {
  const cases: [string, string, boolean][] = [
    ["**/*.md", "README.md", true],
    ["**/*.md", "a/b/c.md", true],
    ["*.md", "a/README.md", false],
    ["docs/**", "docs/a/b.ts", true],
    ["docs/**", "documents/a.ts", false],
    ["packages/api-*/**", "packages/api-auth/src/a.ts", true],
    ["packages/api-*/**", "packages/api/a/b.ts", false],
    ["packages/*/src/migration/**", "packages/db/src/migration/001.sql", true],
    ["sst.config.ts", "sst.config.ts", true],
    ["sst.config.ts", "sstxconfig.ts", false],
    ["sst.config.ts", "apps/sst.config.ts", false],
    ["a?.ts", "ab.ts", true],
    ["a?.ts", "a/.ts", false],
  ];
  for (const [glob, path, matches] of cases) expect([glob, path, globToRegExp(glob).test(path)]).toEqual([glob, path, matches]);
});
