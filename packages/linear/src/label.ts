import type { LinearPort } from "@terros/sergeant-contracts";
import { z } from "zod";
import type { FollowupDeps } from "./followup.ts";

const issueLabelsQuery = `
  query SergeantIssueLabels($id: String!) {
    issue(id: $id) { id team { id } labels(first: 100) { nodes { id name } } }
  }
`;
const issueLabelsShape = z.object({
  issue: z.object({ id: z.string(), team: z.object({ id: z.string() }), labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }) }).nullable(),
});
const labelsByName = `
  query SergeantLabelsByName($name: String!) {
    issueLabels(first: 50, filter: { name: { eqIgnoreCase: $name } }) { nodes { id team { id } } }
  }
`;
const labelsByNameShape = z.object({ issueLabels: z.object({ nodes: z.array(z.object({ id: z.string(), team: z.object({ id: z.string() }).nullable() })) }) });
const addLabels = `
  mutation SergeantAddLabel($id: String!, $labelIds: [String!]!) {
    issueUpdate(id: $id, input: { addedLabelIds: $labelIds }) { success }
  }
`;

/**
 * The adapter's `addLabel` (TECH-5186): the workspace label of that name, else the issue team's. The
 * label is provisioned by a human; a missing one fails, so the caller retries rather than losing it.
 */
export function labeler({ request }: Pick<FollowupDeps, "request">): NonNullable<LinearPort["addLabel"]> {
  return async (issueId, name) => {
    const { issue } = await request(issueLabelsQuery, { id: issueId }, issueLabelsShape);
    if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
    if (issue.labels.nodes.some((l) => l.name.toLowerCase() === name.toLowerCase())) return;
    const { nodes } = (await request(labelsByName, { name }, labelsByNameShape)).issueLabels;
    const labelId = (nodes.find((l) => l.team === null) ?? nodes.find((l) => l.team?.id === issue.team.id))?.id;
    if (!labelId) throw new Error(`Linear has no "${name}" label in the workspace or the issue's team`);
    const { issueUpdate } = await request(addLabels, { id: issue.id, labelIds: [labelId] }, z.object({ issueUpdate: z.object({ success: z.boolean() }) }));
    if (!issueUpdate.success) throw new Error("Linear issueUpdate did not succeed");
  };
}
