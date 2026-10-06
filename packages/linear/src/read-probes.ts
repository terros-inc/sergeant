import { commentIdFor } from "@terros/sergeant-contracts";
import { z } from "zod";
import { blockedIssue, blockedIssueShape, issueId, relationById as blockedByRelation } from "./blocked-by.ts";
import { type FollowupDeps, followupOrigin, followupOriginShape, issueById, issueRef, relationById } from "./followup.ts";
import { issueLabelsQuery, issueLabelsShape, labelsByName, labelsByNameShape } from "./label.ts";
import { commentById, commentThread, commentThreadShape, issueWorkflow, issueWorkflowShape, workflowState } from "./queries.ts";
import { documentById, filedIssue, oneIssue, teamStates } from "./retro.ts";

// The post-deploy smoke check's Linear reads (TECH-5279) that the port only makes on the way to a write:
// the reads before a label, a blocked-by relation, a thread resolve, a state move, a follow-up, or a
// retro issue. Each is the production query and parser, with nothing written after it.

/**
 * An id lookup a create's retry makes (`createOnce`) for an entity that was never made, under an id
 * nothing was created with: Linear answers null or "not found", both meaning the query works.
 */
async function absent(read: () => Promise<unknown>): Promise<"absent"> {
  try {
    const found = await read();
    if (found) throw new Error(`an entity exists under the smoke check's never-created id: ${JSON.stringify(found)}`);
  } catch (e) {
    if (!/not found/i.test((e as Error).message)) throw e;
  }
  return "absent";
}

export function linearReadProbes({ request }: Pick<FollowupDeps, "request">) {
  const neverCreated = (what: string) => commentIdFor(`sergeant-smoke-check:${what}`);
  const team = async (issue: string) => {
    const { issue: found } = await request(issueLabelsQuery, { id: issue }, issueLabelsShape);
    if (!found) throw new Error(`Linear issue not found: ${issue}`);
    return found;
  };
  return {
    /** What `addLabel` reads first (TECH-5186): the issue's team and labels, and the label by name. */
    async labels(issue: string, name: string) {
      const found = await team(issue);
      const { nodes } = (await request(labelsByName, { name }, labelsByNameShape)).issueLabels;
      return { labels: found.labels.nodes.map((l) => l.name), [name]: { workspace: nodes.some((l) => l.team === null), team: nodes.some((l) => l.team?.id === found.team.id) } };
    },
    /** What `recordBlockedBy` reads (TECH-5278): the issue's blocking relations, the blocker's id, a relation by id. */
    async blockedBy(issue: string) {
      const { issue: waiting } = await request(blockedIssue, { id: issue }, blockedIssueShape);
      if (!waiting) throw new Error(`Linear issue not found: ${issue}`);
      const { issue: same } = await request(issueId, { id: issue }, z.object({ issue: z.object({ id: z.string() }).nullable() }));
      const relation = await absent(async () => (await request(blockedByRelation, { id: neverCreated("blocked-by") }, z.object({ issueRelation: z.object({ id: z.string() }).nullable() }))).issueRelation);
      return { blockedBy: waiting.inverseRelations.nodes.filter((r) => r.type === "blocks").length, sameIssue: same?.id === waiting.id, relation };
    },
    /** What a state move or close reads (TECH-4947): the issue's state and its team's workflow. */
    async workflow(issue: string) {
      const { issue: found } = await request(issueWorkflow, { id: issue }, issueWorkflowShape);
      if (!found) throw new Error(`Linear issue not found: ${issue}`);
      return { state: found.state.name, stateType: found.state.type, teamStates: found.team.states.nodes.length };
    },
    /** What `resolveThread` and a comment's retry read (TECH-5052): a comment's thread, and a comment by id. */
    async comments(commentId: string | undefined) {
      const lookup = async (id: string) => (await request(commentById, { id }, z.object({ comment: z.object({ id: z.string() }).nullable() }))).comment;
      const retry = await absent(() => lookup(neverCreated("comment")));
      if (commentId === undefined) return { retry, thread: "no comment on the issue to read" };
      const { comment } = await request(commentThread, { id: commentId }, commentThreadShape);
      if (!comment || (await lookup(commentId))?.id !== commentId) throw new Error(`Linear comment not found: ${commentId}`);
      return { retry, thread: { topLevel: comment.parentId === null, resolved: comment.resolvedAt !== null, byUser: comment.user !== null } };
    },
    /** What a follow-up and a retro issue read before they file (TECH-5049, TECH-5187): the origin, the team's states, an issue and a relation or document by id. */
    async followupAndRetro(issue: string) {
      const { issue: origin } = await request(followupOrigin, { id: issue }, followupOriginShape);
      const { issue: ref } = await request(issueById, { id: issue }, z.object({ issue: issueRef.nullable() }));
      const { issue: filed } = await request(oneIssue, { id: issue }, z.object({ issue: filedIssue.nullable() }));
      const { team: teamFound } = await request(teamStates, { id: origin.team.id }, z.object({ team: z.object({ states: z.object({ nodes: z.array(workflowState) }) }).nullable() }));
      const relation = await absent(async () => (await request(relationById, { id: neverCreated("relation") }, z.object({ issueRelation: z.object({ id: z.string() }).nullable() }))).issueRelation);
      const document = await absent(async () => (await request(documentById, { id: neverCreated("document") }, z.object({ document: z.object({ url: z.string() }).nullable() }))).document);
      return { issue: ref?.identifier ?? null, state: filed?.state.name ?? null, teamStates: teamFound?.states.nodes.length ?? 0, project: origin.project !== null, relation, document };
    },
  };
}
