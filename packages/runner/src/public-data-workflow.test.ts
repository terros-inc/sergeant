import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

// The public-data workflow's trust boundary (TECH-5914): the customer-name denylist secret reaches only
// code from the default branch, never code a PR can change, and never a fork PR. A pull_request run takes
// its workflow file from the PR, so the secret may appear only in a pull_request_target job. This reads
// the YAML as text, job by job, so it needs no YAML parser.
const WORKFLOW = readFileSync(join(import.meta.dirname, "..", "..", "..", ".github", "workflows", "public-data.yml"), "utf8");
const SECRET = "secrets.PUBLIC_DATA_DENYLIST";

function jobs(): Map<string, string> {
  const body = WORKFLOW.slice(WORKFLOW.indexOf("\njobs:\n"));
  return new Map(body.split(/\n(?=  [\w-]+:\n)/).slice(1).map((block) => [/^ {2}([\w-]+):/.exec(block)?.[1] ?? "", block]));
}

function job(name: string): string {
  const block = jobs().get(name);
  if (block === undefined) throw new Error(`no job ${name}`);
  return block;
}

test("only a same-repository pull_request_target job gets the denylist secret", () => {
  expect([...jobs()].filter(([, block]) => block.includes(SECRET)).map(([name]) => name)).toEqual(["public-data"]);
  const trusted = job("public-data");
  expect(trusted).toMatch(/\n {4}if: \$\{\{ github\.event_name == 'pull_request_target' && github\.event\.pull_request\.head\.repo\.full_name == github\.repository \}\}\n/);
  // Nothing outside the jobs (env, defaults) passes the secret on.
  expect(WORKFLOW.split(SECRET).length).toBe(trusted.split(SECRET).length);
});

test("the secret-bearing job runs default-branch code and reads the PR head only as git objects", () => {
  const trusted = job("public-data");
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

test("the pull_request job runs the PR's own check with no secret", () => {
  const untrusted = job("pr-code");
  expect(untrusted).toMatch(/\n {4}if: \$\{\{ github\.event_name == 'pull_request' \}\}\n/);
  expect(untrusted).not.toMatch(/secrets\./);
});
