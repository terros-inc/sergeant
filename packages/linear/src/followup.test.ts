import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";

const at = (minute: number) => `2026-10-02T06:${String(minute).padStart(2, "0")}:00.000Z`;
const workflow = [
  { id: "s-triage", name: "Triage", type: "triage", position: 0 },
  // Two backlog-type states: the lower position wins, regardless of input order.
  { id: "s-icebox", name: "Icebox", type: "backlog", position: 2 },
  { id: "s-backlog", name: "Backlog", type: "backlog", position: 1 },
  { id: "s-todo", name: "Todo", type: "unstarted", position: 3 },
  { id: "s-progress", name: "In Progress", type: "started", position: 4 },
];

// UNF-729: a follow-up must never be filed twice, even when the process dies between Linear creating
// the issue and linking it, and it must land in the origin's team and project, delegated to nobody.
// This fake keeps Linear's one behavior the adapter relies on: a create under an existing id fails.
test("createFollowupIssue files one issue per key in the origin's team and project, and links it after a crash", async () => {
  type Req = { query: string; variables: { id?: string; input?: Record<string, unknown> & { id: string } } };
  const issues = new Map<string, Record<string, unknown>>();
  const relations = new Map<string, Record<string, unknown>>();
  let relationOutage = true;
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as Req;
    const input = variables.input;
    if (query.includes("SergeantFollowupOrigin")) {
      return Response.json({ data: { issue: { id: "origin-1", assignee: { id: "owner" }, delegate: null, team: { id: "team-1", states: { nodes: workflow } }, project: { id: "project-1" } } } });
    }
    if (input && query.includes("issueCreate")) {
      if (issues.has(input.id)) return Response.json({ errors: [{ message: "duplicate id" }] });
      issues.set(input.id, input);
      return Response.json({ data: { issueCreate: { success: true, issue: { identifier: "UNF-2", url: "https://linear.app/x/issue/UNF-2" } } } });
    }
    if (query.includes("SergeantIssueById")) {
      return Response.json(issues.has(variables.id ?? "") ? { data: { issue: { identifier: "UNF-2", url: "https://linear.app/x/issue/UNF-2" } } } : { errors: [{ message: "Entity not found" }] });
    }
    if (input && query.includes("issueRelationCreate")) {
      if (relationOutage) return (relationOutage = false), new Response("unavailable", { status: 503 });
      if (relations.has(input.id)) return Response.json({ errors: [{ message: "duplicate id" }] });
      relations.set(input.id, input);
      return Response.json({ data: { issueRelationCreate: { success: true } } });
    }
    const id = variables.id ?? "";
    return Response.json(relations.has(id) ? { data: { issueRelation: { id } } } : { errors: [{ message: "Entity not found" }] });
  };
  const linear = createLinearPort({ apiKey: "test", sergeantUserIds: [], fetch });
  const req = { originIssueId: "UNF-1", title: "Add jitter", description: "Review f1.", relation: "blocked_by", key: "followup:t1:retry-jitter" } as const;

  await expect(linear.createFollowupIssue(req)).rejects.toThrow(/503/);
  expect(await linear.createFollowupIssue(req)).toEqual({ identifier: "UNF-2", url: "https://linear.app/x/issue/UNF-2" });
  expect(await linear.createFollowupIssue(req)).toMatchObject({ identifier: "UNF-2" });

  expect(issues.size).toBe(1);
  const [issueId, issue] = [...issues][0] ?? [];
  expect(issue).toEqual({ id: issueId, teamId: "team-1", projectId: "project-1", stateId: "s-backlog", assigneeId: "owner", title: "Add jitter", description: "Review f1." });
  // blocked_by: the origin blocks the follow-up.
  expect([...relations.values()]).toMatchObject([{ issueId: "origin-1", relatedIssueId: issueId, type: "blocks" }]);
});

// TECH-4998: a follow-up filed in Triage was auto-assigned to whoever was on the PagerDuty rotation.
// It must land in Backlog with the origin's owner: its assignee, else the human who delegated it to
// Sergeant, else nobody — never Sergeant itself. TECH-5004: falling back to nobody logs a warning
// naming the origin, so a history query that is wrong against live Linear is visible.
test("createFollowupIssue files in Backlog, assigned to the origin's owner, and falls back to unassigned", async () => {
  type Origin = { assignee: { id: string } | null; delegate: { id: string } | null };
  const logs: string[] = [];
  const fileFor = async (origin: Origin, history: unknown[] | Response = []) => {
    const created: Record<string, unknown>[] = [];
    const linear = createLinearPort({
      apiKey: "test",
      sergeantUserIds: ["sergeant-user"],
      log: (line) => logs.push(line),
      fetch: async (_i, init) => {
        const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { input?: Record<string, unknown> } };
        if (query.includes("SergeantFollowupOrigin")) {
          return Response.json({ data: { issue: { id: "origin-1", ...origin, team: { id: "team-1", states: { nodes: workflow } }, project: null } } });
        }
        if (query.includes("SergeantDelegationHistory")) {
          return history instanceof Response ? history : Response.json({ data: { issue: { history: { nodes: history, pageInfo: { hasNextPage: false, endCursor: null } } } } });
        }
        if (query.includes("issueCreate")) {
          created.push(variables.input ?? {});
          return Response.json({ data: { issueCreate: { success: true, issue: { identifier: "UNF-2", url: "https://linear.app/x/issue/UNF-2" } } } });
        }
        return Response.json({ data: { issueRelationCreate: { success: true } } });
      },
    });
    await linear.createFollowupIssue({ originIssueId: "UNF-1", title: "t", description: "d", relation: "related", key: "followup:t1:k" });
    return created[0];
  };
  const sergeant = { id: "sergeant-user" };
  const delegatedBy = (actor: { id: string } | null, minute: number) => ({ createdAt: at(minute), actor: actor && { name: actor.id, ...actor }, toDelegate: sergeant });

  // Assigned to X: Backlog, assigned to X, even when someone else delegated it.
  expect(await fileFor({ assignee: { id: "x" }, delegate: sergeant }, [delegatedBy({ id: "d" }, 1)])).toMatchObject({ stateId: "s-backlog", assigneeId: "x" });
  // No assignee: the human whose delegation to Sergeant is the latest.
  const history = [delegatedBy({ id: "earlier" }, 1), delegatedBy({ id: "d" }, 3), { createdAt: at(4), actor: { id: "other", name: "Other" }, toDelegate: null }];
  expect(await fileFor({ assignee: null, delegate: sergeant }, history)).toMatchObject({ stateId: "s-backlog", assigneeId: "d" });
  expect(logs).toEqual([]);
  // No assignee and no human delegator (none in history, an automation, or Sergeant itself): unassigned, still Backlog.
  for (const h of [[], [delegatedBy(null, 1)], [delegatedBy(sergeant, 1)]]) {
    const filed = await fileFor({ assignee: null, delegate: sergeant }, h);
    expect(filed).toMatchObject({ stateId: "s-backlog" });
    expect(filed).not.toHaveProperty("assigneeId");
    expect(logs.splice(0)).toEqual(["warning: no human delegator of origin-1 in its history, follow-up left unassigned"]);
  }
  // Not delegated at all: there is no delegator to look for, so nothing to warn about.
  expect(await fileFor({ assignee: null, delegate: null })).not.toHaveProperty("assigneeId");
  expect(logs).toEqual([]);
  // Assigned to Sergeant itself: falls through to the human delegator.
  expect(await fileFor({ assignee: sergeant, delegate: sergeant }, history)).toMatchObject({ stateId: "s-backlog", assigneeId: "d" });
  // The history lookup is best-effort: an error or a schema mismatch still files the follow-up, unassigned in Backlog.
  // Each failure is logged with the origin and the error.
  const brokenHistory = [
    [Response.json({ errors: [{ message: "Cannot query field 'toDelegate' on type 'IssueHistory'." }] }), /Cannot query field 'toDelegate'/],
    [new Response("unavailable", { status: 503 }), /\(503\)/],
    [Response.json({ data: { issue: { history: null } } }), /history/],
  ] as const;
  for (const [h, error] of brokenHistory) {
    const filed = await fileFor({ assignee: null, delegate: sergeant }, h);
    expect(filed).toMatchObject({ stateId: "s-backlog" });
    expect(filed).not.toHaveProperty("assigneeId");
    const [warning, ...rest] = logs.splice(0);
    expect(rest).toEqual([]);
    expect(warning).toMatch(/^warning: delegation history of origin-1 unreadable, follow-up left unassigned: /);
    expect(warning).toMatch(error);
  }
});
