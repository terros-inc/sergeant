import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";

const at = (minute: number) => `2026-10-02T06:${String(minute).padStart(2, "0")}:00.000Z`;

// TECH-4985: the post-merge feedback sweep reads only completed issues delegated to Sergeant within
// its lookback, and needs each candidate's state type and completion time.
test("completedIssues pages through completed delegated issues; issueProgress reads the state type and completedAt", async () => {
  const requests: { query: string; variables: Record<string, unknown> }[] = [];
  const linear = createLinearPort({
    apiKey: "test",
    sergeantUserIds: [],
    fetch: async (_i, init) => {
      const req = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      requests.push(req);
      if (req.query.includes("SergeantIssueProgress")) return Response.json({ data: { issue: { state: { type: "completed" }, completedAt: at(1) } } });
      const page = req.variables.after === null;
      const nodes = page ? [{ identifier: "UNF-3" }] : [{ identifier: "UNF-4" }];
      return Response.json({ data: { issues: { nodes, pageInfo: { hasNextPage: page, endCursor: page ? "c1" : null } } } });
    },
  });
  expect(await linear.completedIssues("agent", "2026-09-20T00:00:00.000Z")).toEqual(["UNF-3", "UNF-4"]);
  expect(requests[0]?.query).toContain('filter: { delegate: { id: { eq: $agent } }, state: { type: { eq: "completed" } }, completedAt: { gt: $since } }');
  expect(requests.map((r) => r.variables)).toEqual([
    { agent: "agent", since: "2026-09-20T00:00:00.000Z", after: null },
    { agent: "agent", since: "2026-09-20T00:00:00.000Z", after: "c1" },
  ]);
  expect(await linear.issueProgress("UNF-3")).toEqual({ stateType: "completed", completedAt: at(1) });
});
