import { expect, test } from "vitest";
import { createGitHubPort } from "./github.ts";

// TECH-5230: after Sergeant closes a PR it deletes the PR's branch, and the adapter alone decides
// whether that is safe. Deleting the wrong branch loses someone's work or closes their open PR, so
// each guard keeps the branch and says why, and only one case reaches the DELETE.

const repo = "terros-inc/sergeant";
const ref = "sergeant/tech-1-slug";
const head = "a".repeat(40);
const closedPr = { state: "closed", merged_at: null, head: { ref, sha: head, repo: { full_name: repo } } };
type Live = { pr: unknown; openFrom?: number[]; openOnto?: number[]; tip?: string | null };

const json = (value: unknown, status = 200) => Response.json(value, { status });

function github(live: Live) {
  const requests: string[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace("https://api.github.com", "");
    requests.push(`${init?.method ?? "GET"} ${path}`);
    if (path === `/repos/${repo}/pulls/7`) return json(live.pr);
    const list = (numbers: number[] = []) => json(numbers.map((number) => ({ number })));
    if (path === `/repos/${repo}/pulls?state=open&head=terros-inc%3Asergeant%2Ftech-1-slug&per_page=100`) return list(live.openFrom);
    if (path === `/repos/${repo}/pulls?state=open&base=sergeant%2Ftech-1-slug&per_page=100`) return list(live.openOnto);
    if (path === `/repos/${repo}/git/ref/heads/sergeant/tech-1-slug`) {
      return live.tip === null ? json({ message: "Not Found" }, 404) : json({ object: { sha: live.tip ?? head } });
    }
    if (path === `/repos/${repo}/git/refs/heads/sergeant/tech-1-slug` && init?.method === "DELETE") return new Response(null, { status: 204 });
    throw new Error(`unexpected request: ${init?.method ?? "GET"} ${path}`);
  };
  const port = createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash" } }, fetch });
  return { port, requests };
}

const DELETE = `DELETE /repos/${repo}/git/refs/heads/${ref}`;

test("deletes the sergeant/ branch of a PR closed without merging, at the PR's head", async () => {
  const { port, requests } = github({ pr: closedPr, openFrom: [7] });
  expect(await port.deletePullRequestBranch?.({ repo, number: 7 })).toEqual({ deleted: ref });
  expect(requests).toContain(DELETE);
});

test.each<[string, Live, string]>([
  ["an open PR", { pr: { ...closedPr, state: "open" } }, "#7 is not closed without merging"],
  ["a merged PR", { pr: { ...closedPr, merged_at: "2026-10-04T00:00:00Z" } }, "#7 is not closed without merging"],
  ["a fork's branch", { pr: { ...closedPr, head: { ...closedPr.head, repo: { full_name: "someone/sergeant" } } } }, `#7's head is not a branch in ${repo}`],
  ["a deleted fork", { pr: { ...closedPr, head: { ...closedPr.head, repo: null } } }, `#7's head is not a branch in ${repo}`],
  ["a branch outside sergeant/", { pr: { ...closedPr, head: { ...closedPr.head, ref: "main" } } }, "main is not a sergeant/ branch"],
  ["a branch another open PR is from", { pr: closedPr, openFrom: [9] }, `${ref} is used by open PR #9`],
  ["a branch another open PR is onto", { pr: closedPr, openOnto: [10] }, `${ref} is used by open PR #10`],
  ["a branch pushed to after the close", { pr: closedPr, tip: "b".repeat(40) }, `${ref} moved past #7's head`],
  ["a branch already deleted", { pr: closedPr, tip: null }, `${ref} is already deleted`],
])("keeps %s", async (_case, live, kept) => {
  const { port, requests } = github(live);
  expect(await port.deletePullRequestBranch?.({ repo, number: 7 })).toEqual({ kept });
  expect(requests).not.toContain(DELETE);
});

test("refuses a repository that is not enrolled", async () => {
  const { port, requests } = github({ pr: closedPr });
  await expect(port.deletePullRequestBranch?.({ repo: "other/repo", number: 7 }) ?? Promise.resolve()).rejects.toThrow("not allowed");
  expect(requests).toEqual([]);
});
