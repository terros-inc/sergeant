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
  let query = "";
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const { variables, ...req } = JSON.parse(String(init?.body)) as Req;
    seen.push(variables);
    query = req.query;
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
  // A page must stay under Linear's 10,000-point query cost (TECH-5066): about 2.3 points a comment.
  const [issues, comments] = [...query.matchAll(/first: (\d+)/g)].map((m) => Number(m[1]));
  expect((issues ?? 0) * (comments ?? 0) * 2.3).toBeLessThan(5_000);
});

test("lastRetro is the newest document titled exactly 'Sergeant retro YYYY-MM-DD'", async () => {
  const doc = (title: string, createdAt: string) => ({ id: title, title, content: "", createdAt });
  const nodes = [doc("Sergeant retro 2026-10-01", "2026-10-01T09:00:00.000Z"), doc("Sergeant retro notes", "2026-10-03T00:00:00.000Z"), doc("Sergeant retro 2026-10-01 (draft)", "2026-10-04T00:00:00.000Z")];
  const fetch = async () => Response.json({ data: { documents: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
  const linear = createLinearPort({ apiKey: "test", sergeantUserIds: ["agent"], fetch });
  expect(await linear.retro.lastRetro("project-1")).toEqual({ title: "Sergeant retro 2026-10-01", content: "", createdAt: "2026-10-01T09:00:00.000Z" });
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
