import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";

// TECH-5278: a dependency is recorded as the blocker "blocks" the waiting issue, the relation intake
// reads (07 §5). Recording it again, after a crash or when a human already linked them, adds nothing.
test("recordBlockedBy links the blocker to the waiting issue once, and leaves an existing relation alone", async () => {
  type Req = { query: string; variables: { id?: string; input?: Record<string, unknown> & { id: string } } };
  const ids: Record<string, string> = { "UNF-1": "issue-1", "UNF-2": "issue-2", "UNF-3": "issue-3" };
  const relations = new Map<string, Record<string, unknown>>([["human", { issueId: "issue-3", relatedIssueId: "issue-1", type: "blocks" }]]);
  let outage = true;
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as Req;
    const input = variables.input;
    if (input && query.includes("issueRelationCreate")) {
      if (relations.has(input.id)) return Response.json({ errors: [{ message: "duplicate id" }] });
      relations.set(input.id, input);
      // The relation is made, but the answer is lost.
      if (outage) return (outage = false), new Response("unavailable", { status: 503 });
      return Response.json({ data: { issueRelationCreate: { success: true } } });
    }
    const id = variables.id ?? "";
    if (query.includes("SergeantBlockedByRelation")) return Response.json({ data: { issueRelation: relations.has(id) ? { id } : null } });
    const issue = ids[id];
    if (!issue) return Response.json({ data: { issue: null } });
    if (query.includes("SergeantIssueId")) return Response.json({ data: { issue: { id: issue } } });
    const blockers = [...relations.values()].filter((r) => r.relatedIssueId === issue).map((r) => ({ type: r.type, issue: { id: r.issueId } }));
    return Response.json({ data: { issue: { id: issue, inverseRelations: { nodes: blockers } } } });
  };
  const linear = createLinearPort({ apiKey: "test", sergeantUserIds: [], fetch });

  // The lost answer reads back as made, by its id; asking again finds it.
  expect(await linear.recordBlockedBy({ blocked: "UNF-1", blockedBy: "UNF-2" })).toEqual({ recorded: true });
  expect(await linear.recordBlockedBy({ blocked: "UNF-1", blockedBy: "UNF-2" })).toEqual({ recorded: false });
  expect([...relations.values()].filter((r) => r.issueId === "issue-2")).toMatchObject([{ issueId: "issue-2", relatedIssueId: "issue-1", type: "blocks" }]);
  // A human's relation already says it.
  expect(await linear.recordBlockedBy({ blocked: "UNF-1", blockedBy: "UNF-3" })).toEqual({ recorded: false });
  expect(relations.size).toBe(2);
  // The other direction is a new relation.
  expect(await linear.recordBlockedBy({ blocked: "UNF-2", blockedBy: "UNF-1" })).toEqual({ recorded: true });
  expect(relations.size).toBe(3);
  await expect(linear.recordBlockedBy({ blocked: "UNF-1", blockedBy: "UNF-9" })).rejects.toThrow(/not found: UNF-9/);
});
