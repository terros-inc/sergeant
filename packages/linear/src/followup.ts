import { commentIdFor, type LinearPort } from "@terros/sergeant-contracts";
import { z } from "zod";
import { workflowState } from "./queries.ts";

const followupOrigin = `
  query SergeantFollowupOrigin($id: String!) {
    issue(id: $id) {
      id
      assignee { id }
      delegate { id }
      team { id states(first: 100) { nodes { id name type position } } }
      project { id }
    }
  }
`;
const followupOriginShape = z.object({
  issue: z.object({
    id: z.string(),
    assignee: z.object({ id: z.string() }).nullable(),
    delegate: z.object({ id: z.string() }).nullable(),
    team: z.object({ id: z.string(), states: z.object({ nodes: z.array(workflowState) }) }),
    project: z.object({ id: z.string() }).nullable(),
  }),
});
// The first 100 history entries in Linear's default order, which is not verified to be newest first:
// on a long-lived issue the delegation may be past this page, and the follow-up is then unassigned.
const delegationHistory = `
  query SergeantDelegationHistory($id: String!) {
    issue(id: $id) { history(first: 100) { nodes { createdAt actor { id } toDelegate { id } } } }
  }
`;
const delegationHistoryShape = z.object({
  issue: z.object({
    history: z.object({
      nodes: z.array(z.object({ createdAt: z.string(), actor: z.object({ id: z.string() }).nullable(), toDelegate: z.object({ id: z.string() }).nullable() })),
    }),
  }),
});
const createIssue = `
  mutation SergeantFollowup($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { identifier url } }
  }
`;
const issueById = `query SergeantIssueById($id: String!) { issue(id: $id) { identifier url } }`;
const createRelation = `
  mutation SergeantRelation($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) { success }
  }
`;
const relationById = `query SergeantRelationById($id: String!) { issueRelation(id: $id) { id } }`;
const issueRef = z.object({ identifier: z.string().min(1), url: z.url() });

/** What follow-up filing needs from the Linear adapter it runs inside. */
export type FollowupDeps = {
  request: <T>(query: string, variables: Record<string, unknown>, data: z.ZodType<T>) => Promise<T>;
  createOnce: <T>(create: () => Promise<T>, existing: () => Promise<T | null | undefined>) => Promise<T>;
  sergeantUsers: ReadonlySet<string>;
  log: (line: string) => void;
};

/** The adapter's `createFollowupIssue`: files a follow-up in Backlog, owned by the origin's owner. */
export function followupFiler({ request, createOnce, sergeantUsers, log }: FollowupDeps): LinearPort["createFollowupIssue"] {
  /**
   * The human who most recently delegated the issue to `delegateId`, when Linear's history shows one.
   * Best-effort: a failed or mismatched history query only leaves the follow-up unassigned, with a
   * warning, since the query's fields and ordering are unproven against live Linear (TECH-5004).
   */
  const delegator = async (issueId: string, delegateId: string | undefined) => {
    if (!delegateId) return undefined;
    const history = await request(delegationHistory, { id: issueId }, delegationHistoryShape).catch((e: Error) => {
      log(`warning: delegation history of ${issueId} unreadable, follow-up left unassigned: ${e.message}`);
      return undefined;
    });
    if (!history) return undefined;
    const { nodes } = history.issue.history;
    const delegation = nodes.filter((h) => h.toDelegate?.id === delegateId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const actorId = delegation?.actor?.id;
    if (actorId && !sergeantUsers.has(actorId)) return actorId;
    log(`warning: no human delegator of ${issueId} in its first ${nodes.length} history entries, follow-up left unassigned`);
    return undefined;
  };

  return async ({ originIssueId, title, description, relation, key }) => {
    const { issue: origin } = await request(followupOrigin, { id: originIssueId }, followupOriginShape);
    // Backlog, never Triage: the team's triage rotation would auto-assign it to whoever is on call,
    // and a Backlog issue never auto-starts; a human moves it to Todo and delegates it.
    const backlog = origin.team.states.nodes.filter((s) => s.type === "backlog").sort((a, b) => a.position - b.position)[0];
    if (!backlog) throw new Error("Linear team has no backlog state for a follow-up");
    // Never Sergeant itself: an origin assigned to a Sergeant user falls through to its delegator.
    const owner = origin.assignee && !sergeantUsers.has(origin.assignee.id) ? origin.assignee.id : undefined;
    const assigneeId = owner ?? (await delegator(origin.id, origin.delegate?.id));
    // No delegate: a human decides when Sergeant takes it.
    const id = commentIdFor(key);
    const issue = await createOnce(
      async () => {
        const input = {
          id,
          teamId: origin.team.id,
          ...(origin.project && { projectId: origin.project.id }),
          stateId: backlog.id,
          ...(assigneeId && { assigneeId }),
          title,
          description,
        };
        const { issueCreate } = await request(
          createIssue,
          { input },
          z.object({ issueCreate: z.object({ success: z.boolean(), issue: issueRef.nullable() }) }),
        );
        if (!issueCreate.success || !issueCreate.issue) throw new Error("Linear issueCreate did not succeed");
        return issueCreate.issue;
      },
      async () => (await request(issueById, { id }, z.object({ issue: issueRef.nullable() }))).issue,
    );
    // Linear has no "blocked by" type: the origin blocks a follow-up that must wait for it.
    const [issueId, relatedIssueId, type] = relation === "blocked_by" ? [origin.id, id, "blocks"] : [id, origin.id, "related"];
    const relationId = commentIdFor(`${key}:relation`);
    await createOnce(
      async () => {
        const { issueRelationCreate } = await request(
          createRelation,
          { input: { id: relationId, issueId, relatedIssueId, type } },
          z.object({ issueRelationCreate: z.object({ success: z.boolean() }) }),
        );
        if (!issueRelationCreate.success) throw new Error("Linear issueRelationCreate did not succeed");
        return true;
      },
      async () => (await request(relationById, { id: relationId }, z.object({ issueRelation: z.object({ id: z.string() }).nullable() }))).issueRelation?.id === relationId,
    );
    return issue;
  };
}
