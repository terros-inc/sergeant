import { expect, test } from "vitest";
import { createGitHubPort } from "./github.ts";

// TECH-5797: a PR that changes CI configuration is handed to a human whatever the repository's
// mergePolicy. The Gate and execute decide that from the live facts; the adapter's merge call checks it
// again, so a caller that bypasses them still gets neither an approval nor a merge, and a changed-file
// list it cannot read never passes for an empty one.

const head = "a".repeat(40);
const repo = "o/canary";
const merge = { repo, number: 7, expectedHeadSha: head, squash: { issueIdentifier: "TECH-1", closesIssue: true, builtBy: "Built by Sergeant" } };
const adapter = (fetch: typeof globalThis.fetch) =>
  createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "merge", mergePolicy: "sergeant" } }, fetch });

const T1_EVERYWHERE = 'tiers:\n  T1: ["**"]\n';
const file = (text: string) => Response.json({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") });

/**
 * A GitHub whose PR 7 changes `pages` of files (page n is pages[n-1]), with `tierMap` at its head (a
 * status for a failed read); it records every other call.
 */
function github(pages: ({ filename: string; previous_filename?: string }[] | number)[], tierMap: string | number = T1_EVERYWHERE) {
  const calls: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const path = String(input);
    if (path.endsWith(`/contents/.github/review-tiers.yml?ref=${head}`)) return typeof tierMap === "number" ? Response.json({ message: "x" }, { status: tierMap }) : file(tierMap);
    const page = /\/pulls\/7\/files\?per_page=100&page=(\d+)$/.exec(path);
    if (page) {
      const answer = pages[Number(page[1]) - 1] ?? [];
      return typeof answer === "number" ? Response.json({ message: "Server Error" }, { status: answer }) : Response.json(answer);
    }
    calls.push(path.replace(/^.*\/pulls\/7/, ""));
    return Response.json(path.endsWith("/merge") ? { sha: "b".repeat(40), merged: true, message: "merged" } : { id: 1 });
  };
  return { calls, port: adapter(fetch) };
}

const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ filename: `${prefix}/${i}.ts` }));

test.each([
  ["a workflow file", [[{ filename: "src/a.ts" }, { filename: ".github/workflows/deploy.yml" }]], ".github/workflows/deploy.yml"],
  ["a workflow renamed away", [[{ filename: "ci/deploy.yml", previous_filename: ".github/workflows/deploy.yml" }]], ".github/workflows/deploy.yml"],
  ["a Jenkinsfile on the second page", [many(100, "src"), [{ filename: "build/Jenkinsfile" }]], "build/Jenkinsfile"],
])("a sergeant-policy merge of a PR changing %s is refused before any approval", async (_, pages, file) => {
  const { calls, port } = github(pages);
  await expect(port.mergePullRequest(merge)).rejects.toThrow(`changes protected CI configuration (${file})`);
  expect(calls).toEqual([]);
});

test("a changed-file list that cannot be read refuses the merge, never counting as empty", async () => {
  const { calls, port } = github([many(100, "src"), 502]);
  await expect(port.mergePullRequest(merge)).rejects.toThrow("(502)");
  expect(calls).toEqual([]);
});

test("an ordinary PR is still approved and merged", async () => {
  const { calls, port } = github([[{ filename: "src/a.ts" }, { filename: ".github/CODEOWNERS" }]]);
  expect(await port.mergePullRequest(merge)).toEqual({ mergedSha: "b".repeat(40) });
  expect(calls).toEqual(["/reviews", "/merge"]);
});

// TECH-6553: the same defense for the head's review tier, from the map at that head. Whatever asked for
// the merge, a T3 or T4 head, or one whose tier the adapter cannot establish, gets no approval.
test.each([
  ["matches a T3 pattern", [{ filename: "infra/main.tf" }], 'tiers:\n  T1: ["**"]\n  T3: ["infra/**"]\n', "T3"],
  ["changes the tier map", [{ filename: ".github/review-tiers.yml" }], T1_EVERYWHERE, "T4"],
  ["has no tier map", [{ filename: "src/a.ts" }], 404, "T3"],
  ["has a map GitHub fails to return", [{ filename: "src/a.ts" }], 502, "T3"],
  ["has a map that is not valid YAML", [{ filename: "src/a.ts" }], "tiers: [unclosed", "T3"],
] as const)("a sergeant-policy merge of a PR that %s is refused before any approval", async (_, files, tierMap, tier) => {
  const { calls, port } = github([[...files]], tierMap);
  await expect(port.mergePullRequest(merge)).rejects.toThrow(`is review tier ${tier}`);
  expect(calls).toEqual([]);
});
