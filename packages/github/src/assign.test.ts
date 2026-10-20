import { expect, test } from "vitest";
import { createGitHubPort } from "./github.ts";

// TECH-6428: GitHub answers an assignment it cannot make (the login is not a collaborator, say) with
// 201 all the same, leaving the login out of the assignees. Reading only the status would report the
// requestor assigned when they are not, and nobody would see the warning.

const repo = "terros-inc/sergeant";

function github(assignees: string[]) {
  const requests: { path: string; body: unknown }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace("https://api.github.com", "");
    requests.push({ path: `${init?.method ?? "GET"} ${path}`, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Response.json({ number: 7, assignees: assignees.map((login) => ({ login })) }, { status: 201 });
  };
  const port = createGitHubPort({ token: async () => "test", repositories: { [repo]: { mergeMethod: "squash" } }, fetch });
  return { port, requests };
}

test.each([
  ["lists the login, in any case", ["someone-else", "Octo-Cat"], true],
  ["silently drops it", ["someone-else"], false],
])("an assignment GitHub %s resolves to assigned: %s", async (_case, assignees, assigned) => {
  const { port, requests } = github(assignees);
  expect(await port.assignPullRequest?.({ repo, number: 7, assignee: "octo-cat" })).toEqual({ assigned });
  expect(requests).toEqual([{ path: `POST /repos/${repo}/issues/7/assignees`, body: { assignees: ["octo-cat"] } }]);
});

test("refuses a repository that is not enrolled", async () => {
  const { port, requests } = github([]);
  await expect(port.assignPullRequest?.({ repo: "someone/else", number: 7, assignee: "octo-cat" })).rejects.toThrow("not allowed");
  expect(requests).toEqual([]);
});
