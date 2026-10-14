import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// The public-data workflows' trust boundary (TECH-5914): the customer-name denylist secret reaches only
// code from the default branch, never code a PR can change, and never a fork PR. A pull_request run takes
// its workflow file from the PR, so the secret may appear only in a pull_request_target workflow. This
// reads the YAML as text, so it needs no YAML parser.
const DIR = join(import.meta.dirname, "..", "..", "..", ".github", "workflows");
const read = (file: string) => readFileSync(join(DIR, file), "utf8");
const SECRET = "secrets.PUBLIC_DATA_DENYLIST";
const triggers = (workflow: string) => [...(/\non:\n((?: {2}.*\n)+)/.exec(workflow)?.[1] ?? "").matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]);

test("only the pull_request_target workflow, for same-repository PRs, gets the denylist secret", () => {
  const withSecret = readdirSync(DIR).filter((file) => read(file).includes(SECRET));
  expect(withSecret).toEqual(["public-data-trusted.yml"]);
  const trusted = read("public-data-trusted.yml");
  expect(triggers(trusted)).toEqual(["pull_request_target"]);
  expect(trusted.slice(trusted.indexOf("\njobs:\n")).match(/\n {2}[\w-]+:\n/g)).toEqual(["\n  public-data:\n"]);
  expect(trusted).toMatch(/\n {4}if: \$\{\{ github\.event\.pull_request\.head\.repo\.full_name == github\.repository \}\}\n/);
});

test("the secret-bearing job runs default-branch code and reads the PR head only as git objects", () => {
  const trusted = read("public-data-trusted.yml");
  const checkouts = trusted.split("uses: actions/checkout@").slice(1);
  expect(checkouts).toHaveLength(1);
  expect(checkouts[0] ?? "").toMatch(/\n {10}ref: \$\{\{ github\.event\.repository\.default_branch \}\}\n/);
  expect(checkouts[0] ?? "").toMatch(/\n {10}persist-credentials: false\n/);
  // No checkout, working directory, install or other action that would put PR files on disk or run them.
  expect(trusted).not.toMatch(/working-directory|pnpm|npm |npx|corepack|git (checkout|switch|reset|worktree|merge|cherry-pick)/);
  expect([...trusted.matchAll(/uses: ([^@\s]+)@/g)].map((m) => m[1])).toEqual(["actions/checkout", "actions/setup-node"]);
  // Every command is the fetch or the default branch's check script.
  const runs = [...trusted.matchAll(/\n {8}run: (.*)/g)].map((m) => m[1]);
  expect(runs).toEqual([
    'git fetch --no-tags --quiet origin "$BASE" "$HEAD"',
    'node packages/runner/container/check-public-data.mjs range "$BASE" "$HEAD"',
    expect.stringMatching(/^printf .* \| node packages\/runner\/container\/check-public-data\.mjs text "branch, PR title and body"$/),
  ]);
});

test("the pull_request workflow runs the PR's own check with no secret", () => {
  const untrusted = read("public-data.yml");
  expect(triggers(untrusted)).toEqual(["pull_request"]);
  expect(untrusted).not.toMatch(/secrets\./);
});
