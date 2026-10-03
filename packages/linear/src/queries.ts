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
  state: z.object({ name: z.string() }),
  delegate: actor.nullable(),
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
      state { name }
      delegate { id name }
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
export const delegatedQuery = `
  query SergeantDelegated($agent: ID!, $after: String) {
    issues(first: 100, after: $after, filter: { delegate: { id: { eq: $agent } }, state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { identifier priority createdAt state { name type } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
/** An open issue delegated to the agent, with what its admission order needs (TECH-5008). */
export const DelegatedIssue = z.object({
  identifier: z.string().min(1),
  /** Linear's priority: 1 Urgent, 2 High, 3 Medium, 4 Low, 0 none. */
  priority: z.number(),
  createdAt: z.iso.datetime({ offset: true }),
  state: z.object({ name: z.string(), type: z.string() }),
});
export type DelegatedIssue = z.infer<typeof DelegatedIssue>;
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

/** State types that a delegated issue may still be sitting in before its first worker starts. */
export const unstartedTypes = new Set(["triage", "backlog", "unstarted"]);
