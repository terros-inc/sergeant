import { expect, test } from "vitest";
import type { GitHubPort, PullRequestFacts } from "@terros/sergeant-contracts";
import { ownerAssignments } from "./assign-owner.ts";
import { conversation, pr } from "./execute-fixtures.ts";

// TECH-6428: the requestor is assigned to the worker's PRs, and nothing about that may stop a PR or a
// task. The regressions guarded: assigning someone other than the task's owner (a human's own PR, or a
// reassigned issue's new assignee), calling GitHub again every poll for a login it cannot assign, and
// a refused or failed assignment throwing out of the loop or passing silently.

const profile = "https://linear.app/x/profiles/ann";
const issue = { ...conversation.issue, assignee: { id: "user-ann", name: "Ann", url: profile } };
const owner = { id: "user-ann", name: "Ann", admittedAt: "2026-10-02T06:00:00.000Z" };
const lookup = (url: string) => (url === profile ? "ann-gh" : undefined);

function setup(assign: NonNullable<GitHubPort["assignPullRequest"]> = async () => ({ assigned: true }), over: { owner?: typeof owner; lookup?: typeof lookup } = { owner, lookup }) {
  const calls: unknown[] = [];
  const lines: string[] = [];
  const github = { assignPullRequest: async (req: Parameters<typeof assign>[0]) => (calls.push(req), assign(req)) } as unknown as GitHubPort;
  const run = ownerAssignments({ github, workerLogin: pr.author, ...(over.owner && { owner: over.owner }), ...(over.lookup && { githubLoginForLinearProfile: over.lookup }) }, (l) => lines.push(l));
  return { run, calls, lines };
}

test("assigns the owner's GitHub login to the worker's open PRs, once each across polls", async () => {
  const { run, calls, lines } = setup();
  const prs: PullRequestFacts[] = [pr, { ...pr, number: 8, author: "a-human" }, { ...pr, number: 9, state: "closed" }];
  await run(prs, issue);
  await run(prs, issue);
  expect(calls).toEqual([{ repo: pr.repo, number: 7, assignee: "ann-gh" }]);
  expect(lines).toEqual([`${pr.repo}#7: assigned to ann-gh`]);
});

test.each<[string, Parameters<typeof setup>, typeof issue, string]>([
  ["no reviewerProfiles mapping", [undefined, { owner }], issue, "linear.reviewerProfiles maps no GitHub login to Ann's Linear profile"],
  ["no recorded owner", [undefined, { lookup }], issue, "the task has no recorded owner"],
  ["an assignee who is not the owner", [undefined, { owner, lookup }], { ...issue, assignee: { id: "user-bo", name: "Bo", url: profile } }, "the issue is no longer assigned to Ann"],
])("with %s, assigns nobody and warns", async (_case, args, live, why) => {
  const { run, calls, lines } = setup(...args);
  await run([pr], live);
  expect(calls).toEqual([]);
  expect(lines).toEqual([expect.stringContaining(`warning: ${pr.repo}#7 not assigned to its requestor: ${why}`)]);
});

test.each<[string, NonNullable<GitHubPort["assignPullRequest"]>, string]>([
  ["drops the login", async () => ({ assigned: false }), "GitHub cannot assign them"],
  ["fails", async () => Promise.reject(new Error("403 Resource not accessible by integration")), "403 Resource not accessible by integration"],
])("an assignment GitHub %s warns without throwing, and is not retried", async (_case, assign, why) => {
  const { run, calls, lines } = setup(assign);
  await run([pr], issue);
  await run([pr], issue);
  expect(calls).toHaveLength(1);
  expect(lines).toEqual([expect.stringContaining(`warning: ${pr.repo}#7 not assigned to ann-gh: ${why}`)]);
});
