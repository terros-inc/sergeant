import { expect, test } from "vitest";
import { createGitHubPort } from "./github.ts";

// TECH-5258: a filed follow-up records the default-branch commit it was written against. A wrong read
// would record a commit that is not the default branch's head, or none, and hide how stale it is.

const repo = "terros-inc/sergeant";
const sha = "d".repeat(40);

test("reads the repository's default branch, whatever its name, and that branch's head commit", async () => {
  const requests: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const path = String(input).replace("https://api.github.com", "");
    requests.push(path);
    if (path === `/repos/${repo}`) return Response.json({ default_branch: "release/v2" });
    if (path === `/repos/${repo}/branches/release%2Fv2`) return Response.json({ commit: { sha } });
    throw new Error(`unexpected request: ${path}`);
  };
  const port = createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash" } }, fetch });
  expect(await port.defaultBranchHead?.(repo)).toEqual({ branch: "release/v2", sha });
  await expect(port.defaultBranchHead?.("someone/else")).rejects.toThrow("GitHub repository is not allowed: someone/else");
  expect(requests).toEqual([`/repos/${repo}`, `/repos/${repo}/branches/release%2Fv2`]);
});
