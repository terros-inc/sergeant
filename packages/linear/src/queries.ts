import { z } from "zod";

export const actor = z.object({ id: z.string().min(1), name: z.string() });
const comment = z.object({
  id: z.string().min(1),
  body: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  parentId: z.string().nullable(),
  user: actor.nullable(),
  externalUser: actor.nullable(),
  botActor: z.object({ id: z.string().nullable(), type: z.string(), name: z.string().nullable() }).nullable(),
});
export const issuePage = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  url: z.url(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.object({ name: z.string(), type: z.string() }),
  delegate: actor.nullable(),
  assignee: actor.nullable(),
  attachments: z.object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        url: z.string(),
        sourceType: z.string().nullable(),
        updatedAt: z.iso.datetime({ offset: true }),
        creator: actor.nullable(),
      }),
    ),
  }),
  comments: z.object({
    nodes: z.array(comment),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }),
});
export const response = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export const issueQuery = `
  query SergeantIssue($id: String!, $after: String) {
    issue(id: $id) {
      id identifier url title description
      state { name type }
      delegate { id name }
      assignee { id name }
      attachments(first: 100) { nodes { id title url sourceType updatedAt creator { id name } } }
      comments(first: 50, after: $after) {
        nodes {
          id body createdAt updatedAt parentId
          user { id name }
          externalUser { id name }
          botActor { id type name }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

export const linkedIssue = z.object({
  identifier: z.string().min(1),
  url: z.url(),
  title: z.string(),
  state: z.object({ name: z.string() }),
});
export const linkedIssueQuery = `
  query SergeantLinkedIssue($id: String!) {
    issue(id: $id) { identifier url title state { name } }
  }
`;

export const createComment = `
  mutation SergeantComment($input: CommentCreateInput!) {
    commentCreate(input: $input) { success }
  }
`;
export const commentById = `query SergeantCommentById($id: String!) { comment(id: $id) { id } }`;
// TECH-5052: a thread is resolved on its top comment, only when Sergeant wrote it.
export const commentThread = `query SergeantCommentThread($id: String!) { comment(id: $id) { id parentId resolvedAt user { id } } }`;
export const commentThreadShape = z.object({
  comment: z.object({ id: z.string(), parentId: z.string().nullable(), resolvedAt: z.string().nullable(), user: z.object({ id: z.string() }).nullable() }).nullable(),
});
export const resolveComment = `
  mutation SergeantResolveThread($id: String!) {
    commentResolve(id: $id) { success }
  }
`;
export const viewerQuery = `query SergeantViewer { viewer { id name organization { id } } }`;
export const clearDelegate = `
  mutation SergeantUndelegate($id: String!) {
    issueUpdate(id: $id, input: { delegateId: null }) { success }
  }
`;
// TECH-5066: the nested relations multiply the query's cost. Under Linear's complexity model (0.1 per
// field, 1 per object, a connection times its `first`) an issue costs about 1.3 + 1.2 (state) + 20 x 3.3
// (relations) + 2 (connection, pageInfo) ≈ 70, so a page of 50 costs about 3,500 of the 10,000 points
// a query may cost; 100 issues with 50 relations each would have cost about 17,000.
export const delegatedQuery = `
  query SergeantDelegated($agent: ID!, $after: String) {
    issues(first: 50, after: $after, filter: { delegate: { id: { eq: $agent } }, state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes {
        identifier priority createdAt state { name type }
        inverseRelations(first: 20) { nodes { type issue { identifier state { type } } } pageInfo { hasNextPage } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
/**
 * An open issue delegated to the agent, with what its admission order needs (TECH-5008) and the
 * issues blocking it that are neither completed nor canceled (TECH-5066). Linear stores "X blocked
 * by Y" as Y's `blocks` relation, so it is among X's inverse relations. An issue with more inverse
 * relations than one page holds is held back too, since an unread one could be an open blocker.
 */
export const DelegatedIssue = z
  .object({
    identifier: z.string().min(1),
    /** Linear's priority: 1 Urgent, 2 High, 3 Medium, 4 Low, 0 none. */
    priority: z.number(),
    createdAt: z.iso.datetime({ offset: true }),
    state: z.object({ name: z.string(), type: z.string() }),
    inverseRelations: z.object({
      nodes: z.array(z.object({ type: z.string(), issue: z.object({ identifier: z.string().min(1), state: z.object({ type: z.string() }) }) })),
      pageInfo: z.object({ hasNextPage: z.boolean() }),
    }),
  })
  .transform(({ inverseRelations, ...issue }) => ({
    ...issue,
    blockedBy: inverseRelations.nodes
      .filter((r) => r.type === "blocks" && r.issue.state.type !== "completed" && r.issue.state.type !== "canceled")
      .map((r) => r.issue.identifier)
      .concat(inverseRelations.pageInfo.hasNextPage ? ["relations past the first 20, unread"] : []),
  }));
export type DelegatedIssue = z.output<typeof DelegatedIssue>;
export const delegatedPage = z.object({
  issues: z.object({
    nodes: z.array(DelegatedIssue),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }),
});
// TECH-4985: issues delegated to the agent completed since a time, where post-merge feedback is swept.
export const completedQuery = `
  query SergeantCompleted($agent: ID!, $since: DateTimeOrDuration!, $after: String) {
    issues(first: 100, after: $after, filter: { delegate: { id: { eq: $agent } }, state: { type: { eq: "completed" } }, completedAt: { gt: $since } }) {
      nodes { identifier }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
export const completedPage = z.object({
  issues: z.object({
    nodes: z.array(z.object({ identifier: z.string().min(1) })),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }),
});
export const issueProgress = `query SergeantIssueProgress($id: String!) { issue(id: $id) { state { type } completedAt } }`;
export const issueProgressShape = z.object({
  issue: z.object({ state: z.object({ type: z.string() }), completedAt: z.iso.datetime({ offset: true }).nullable() }).nullable(),
});
export const workflowState = z.object({ id: z.string().min(1), name: z.string(), type: z.string(), position: z.number() });
export const issueWorkflow = `
  query SergeantIssueWorkflow($id: String!) {
    issue(id: $id) {
      state { name type }
      team { states(first: 100) { nodes { id name type position } } }
    }
  }
`;
export const moveState = `
  mutation SergeantMoveState($id: String!, $stateId: String!) {
    issueUpdate(id: $id, input: { stateId: $stateId }) { success }
  }
`;
export const issueWorkflowShape = z.object({
  issue: z
    .object({
      state: z.object({ name: z.string(), type: z.string() }),
      team: z.object({ states: z.object({ nodes: z.array(workflowState) }) }),
    })
    .nullable(),
});
