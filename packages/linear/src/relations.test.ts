import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";

const relation = (type: string, identifier: string, stateType: string) => ({ type, issue: { identifier, state: { type: stateType } } });
const related = (n: number) => Array.from({ length: n }, (_, i) => relation("related", `UNF-${i + 100}`, "started"));

// TECH-5066, TECH-5803: the listing reads an issue's first 20 relations and the rest page by page, so
// an issue with more is held back by its open blockers only, and starts once they all go.
test("delegatedIssues reads every page of an issue's relations", async () => {
  let blockerState = "started";
  const linear = createLinearPort({
    apiKey: "test",
    sergeantUserIds: [],
    fetch: async (_input, init) => {
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { id: string; after: string } };
      if (query.includes("SergeantInverseRelations")) {
        expect(variables).toEqual({ id: "UNF-5", after: "c1" });
        const inverseRelations = { nodes: [...related(30), relation("blocks", "UNF-2", blockerState)], pageInfo: { hasNextPage: false, endCursor: null } };
        return Response.json({ data: { issue: { inverseRelations } } });
      }
      const node = {
        identifier: "UNF-5",
        priority: 2,
        createdAt: "2026-10-01T00:00:00.000Z",
        state: { name: "Todo", type: "unstarted" },
        inverseRelations: { nodes: related(20), pageInfo: { hasNextPage: true, endCursor: "c1" } },
      };
      return Response.json({ data: { issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } } });
    },
  });
  expect((await linear.delegatedIssues("agent"))[0]?.blockedBy).toEqual(["UNF-2"]);
  blockerState = "completed";
  expect((await linear.delegatedIssues("agent"))[0]?.blockedBy).toEqual([]);
});
