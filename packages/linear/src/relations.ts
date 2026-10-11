import { z } from "zod";
import type { FollowupDeps } from "./followup.ts";

/** Linear stores "X blocked by Y" as Y's `blocks` relation, so it is among X's inverse relations. */
export const inverseRelations = z.object({
  nodes: z.array(z.object({ type: z.string(), issue: z.object({ identifier: z.string().min(1), state: z.object({ type: z.string() }) }) })),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});
export type InverseRelations = z.infer<typeof inverseRelations>;

const relationsQuery = `
  query SergeantInverseRelations($id: String!, $after: String) {
    issue(id: $id) {
      inverseRelations(first: 100, after: $after) { nodes { type issue { identifier state { type } } } pageInfo { hasNextPage endCursor } }
    }
  }
`;

/** One page of the issue's inverse relations, from `after` (null: the first). */
export async function relationsPage(request: FollowupDeps["request"], issueId: string, after: string | null): Promise<InverseRelations> {
  const { issue } = await request(relationsQuery, { id: issueId, after }, z.object({ issue: z.object({ inverseRelations }).nullable() }));
  if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
  return issue.inverseRelations;
}

/**
 * The issues blocking `issueId` that are neither completed nor canceled (TECH-5066). `first` is the
 * page an issue query already read; any further pages are read here, so an issue with many relations
 * is judged on all of them (TECH-5803): an unread one could be an open blocker, and a stand-in for it
 * would never go, so the task could never be unblocked.
 */
export async function openBlockers(request: FollowupDeps["request"], issueId: string, first: InverseRelations): Promise<string[]> {
  const nodes = [...first.nodes];
  for (let page = first; page.pageInfo.hasNextPage; ) {
    const after = page.pageInfo.endCursor;
    if (!after) throw new Error(`the relations of ${issueId} have a next page but no cursor`);
    page = await relationsPage(request, issueId, after);
    nodes.push(...page.nodes);
  }
  return nodes
    .filter((r) => r.type === "blocks" && r.issue.state.type !== "completed" && r.issue.state.type !== "canceled")
    .map((r) => r.issue.identifier);
}
