import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";

// TECH-5187: the retro reads only Sergeant's own feedback comments (a human quoting one is not one), and
// files its issues in the Sergeant project's Backlog with nobody assigned or delegated, once per key.

type Req = { query: string; variables: Record<string, unknown> & { input?: Record<string, unknown> } };

test("feedbackTasks keeps only Sergeant's feedback comments, across pages", async () => {
  const comment = (body: string, user: string, createdAt = "2026-10-06T00:00:00.000Z") => ({ body, createdAt, user: { id: user } });
  const pages = [
    { nodes: [{ identifier: "TECH-1", title: "One", url: "https://linear.app/t/issue/TECH-1", comments: { nodes: [comment("**Sergeant feedback:** later", "agent", "2026-10-07T00:00:00.000Z"), comment("**Sergeant feedback:** first", "agent"), comment("thanks", "agent")] } }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    { nodes: [{ identifier: "TECH-2", title: "Two", url: "https://linear.app/t/issue/TECH-2", comments: { nodes: [comment("**Sergeant feedback:** quoted by a human", "human")] } }], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  const seen: Req["variables"][] = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const { variables } = JSON.parse(String(init?.body)) as Req;
    seen.push(variables);
    return Response.json({ data: { issues: pages[variables.after ? 1 : 0] } });
  };
  const linear = createLinearPort({ apiKey: "test", sergeantUserIds: ["agent"], fetch });
  expect(await linear.retro.feedbackTasks("2026-10-05T00:00:00.000Z")).toEqual([
    { identifier: "TECH-1", title: "One", url: "https://linear.app/t/issue/TECH-1", feedback: ["**Sergeant feedback:** first", "**Sergeant feedback:** later"] },
  ]);
  expect(seen).toEqual([
    { label: "sergeant-feedback", since: "2026-10-05T00:00:00.000Z", after: null },
    { label: "sergeant-feedback", since: "2026-10-05T00:00:00.000Z", after: "c1" },
  ]);
});

test("fileIssue files in the team's first Backlog state and the project, unassigned, and once per key", async () => {
  const created = new Map<string, Record<string, unknown>>();
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as Req;
    if (query.includes("SergeantRetroTeam")) {
      const states = [{ id: "s-triage", name: "Triage", type: "triage", position: 0 }, { id: "s-later", name: "Later", type: "backlog", position: 2 }, { id: "s-backlog", name: "Backlog", type: "backlog", position: 1 }];
      return Response.json({ data: { team: { states: { nodes: states } } } });
    }
    if (query.includes("SergeantRetroIssueCreate")) {
      const input = variables.input ?? {};
      if (created.has(String(input.id))) return Response.json({ errors: [{ message: "duplicate id" }] });
      created.set(String(input.id), input);
      return Response.json({ data: { issueCreate: { success: true, issue: { identifier: "TECH-9", url: "https://linear.app/t/issue/TECH-9" } } } });
    }
    const id = String(variables.id);
    return Response.json({ data: { issue: created.has(id) ? { identifier: "TECH-9", url: "https://linear.app/t/issue/TECH-9" } : null } });
  };
  const linear = createLinearPort({ apiKey: "test", sergeantUserIds: ["agent"], fetch });
  const input = { teamId: "team-1", projectId: "project-1", title: "Narrow checks", description: "Why.", key: "retro:2026-10-05:narrow-checks" };
  expect(await linear.retro.fileIssue(input)).toEqual({ identifier: "TECH-9", url: "https://linear.app/t/issue/TECH-9" });
  // A retry after a lost response finds the issue the first attempt made.
  expect(await linear.retro.fileIssue(input)).toEqual({ identifier: "TECH-9", url: "https://linear.app/t/issue/TECH-9" });
  expect([...created.values()]).toEqual([{ id: expect.any(String), teamId: "team-1", projectId: "project-1", stateId: "s-backlog", title: "Narrow checks", description: "Why." }]);
});
