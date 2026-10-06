import { commentIdFor, type LinearPort } from "@terros/sergeant-contracts";
import { z } from "zod";
import type { FollowupDeps } from "./followup.ts";

// `issue(id:)` takes an identifier too. `inverseRelations` are the relations naming this issue as the
// related one, so a "blocks" among them is an issue that blocks it.
export const blockedIssue = `
  query SergeantBlockedIssue($id: String!) {
    issue(id: $id) { id inverseRelations(first: 250) { nodes { type issue { id } } } }
  }
`;
export const blockedIssueShape = z.object({
  issue: z
    .object({ id: z.string(), inverseRelations: z.object({ nodes: z.array(z.object({ type: z.string(), issue: z.object({ id: z.string() }) })) }) })
    .nullable(),
});
export const issueId = `query SergeantIssueId($id: String!) { issue(id: $id) { id } }`;
const createRelation = `
  mutation SergeantBlockedBy($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) { success }
  }
`;
export const relationById = `query SergeantBlockedByRelation($id: String!) { issueRelation(id: $id) { id } }`;

/** The adapter's `recordBlockedBy` (TECH-5278): Linear has no "blocked by" type, so the blocker blocks it. */
export function blockedByRecorder({ request, createOnce }: Pick<FollowupDeps, "request" | "createOnce">): NonNullable<LinearPort["recordBlockedBy"]> {
  return async ({ blocked, blockedBy }) => {
    const { issue: waiting } = await request(blockedIssue, { id: blocked }, blockedIssueShape);
    if (!waiting) throw new Error(`Linear issue not found: ${blocked}`);
    const { issue: blocker } = await request(issueId, { id: blockedBy }, z.object({ issue: z.object({ id: z.string() }).nullable() }));
    if (!blocker) throw new Error(`Linear issue not found: ${blockedBy}`);
    if (waiting.inverseRelations.nodes.some((r) => r.type === "blocks" && r.issue.id === blocker.id)) return { recorded: false };
    const id = commentIdFor(`blocked-by:${waiting.id}:${blocker.id}`);
    await createOnce(
      async () => {
        const { issueRelationCreate } = await request(
          createRelation,
          { input: { id, issueId: blocker.id, relatedIssueId: waiting.id, type: "blocks" } },
          z.object({ issueRelationCreate: z.object({ success: z.boolean() }) }),
        );
        if (!issueRelationCreate.success) throw new Error("Linear issueRelationCreate did not succeed");
        return true;
      },
      async () => (await request(relationById, { id }, z.object({ issueRelation: z.object({ id: z.string() }).nullable() }))).issueRelation?.id === id,
    );
    return { recorded: true };
  };
}
