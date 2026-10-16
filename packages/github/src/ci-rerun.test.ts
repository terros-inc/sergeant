import { expect, test } from "vitest";
import { ciRerunner } from "./ci-rerun.ts";

// TECH-5839: the rerun App holds Actions write. If a call minted an unscoped token, or this port called
// anything but the one rerun endpoint, Sergeant's narrow operation would be a general Actions client.

test("the rerun App mints a one-repository, actions-only token for each call and calls only the run and its rerun endpoint", async () => {
  const mints: unknown[] = [];
  const calls: string[] = [];
  const app = {
    mint: async (scope: unknown) => {
      mints.push(scope);
      return { token: `ghs_${mints.length}`, expiresAt: "2026-10-16T18:00:00Z", permissions: {}, repositories: [] };
    },
  };
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method} ${String(input)} ${new Headers(init?.headers).get("authorization")}`);
    if (init?.method === "POST") return new Response(null, { status: 201 });
    return Response.json({
      id: 101, repository: { full_name: "o/canary" }, head_sha: "a".repeat(40), path: ".github/workflows/ci.yml",
      status: "completed", conclusion: "failure", run_attempt: 2, html_url: "https://github.com/o/canary/actions/runs/101",
    });
  };
  const port = ciRerunner({ app, repositories: { "o/canary": { ciRerunWorkflows: [".github/workflows/ci.yml"] } }, fetch });

  expect(port.allowedWorkflows("o/canary")).toEqual([".github/workflows/ci.yml"]);
  expect(port.allowedWorkflows("o/other")).toEqual([]);
  expect(await port.readWorkflowRun("o/canary", 101)).toMatchObject({ repo: "o/canary", path: ".github/workflows/ci.yml", conclusion: "failure", attempt: 2 });
  await port.rerunFailedJobs("o/canary", 101);

  expect(mints).toEqual([
    { repositories: ["o/canary"], permissions: { actions: "read" } },
    { repositories: ["o/canary"], permissions: { actions: "write" } },
  ]);
  expect(calls).toEqual([
    "GET https://api.github.com/repos/o/canary/actions/runs/101 Bearer ghs_1",
    "POST https://api.github.com/repos/o/canary/actions/runs/101/rerun-failed-jobs Bearer ghs_2",
  ]);
});

test("a refused rerun rejects with GitHub's message", async () => {
  const app = { mint: async () => ({ token: "ghs_1", expiresAt: "2026-10-16T18:00:00Z", permissions: {}, repositories: [] }) };
  const fetch = async () => Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
  await expect(ciRerunner({ app, repositories: {}, fetch }).rerunFailedJobs("o/canary", 101)).rejects.toThrow(/\(403\): Resource not accessible by integration/);
});
