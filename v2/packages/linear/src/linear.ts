import { commentIdFor, Conversation, type LinearPort } from "@terros/sergeant-contracts";
import { z } from "zod";

const actor = z.object({ id: z.string().min(1), name: z.string() });
const comment = z.object({
  id: z.string().min(1),
  body: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  user: actor.nullable(),
  externalUser: actor.nullable(),
  botActor: z.object({ id: z.string().nullable(), type: z.string(), name: z.string().nullable() }).nullable(),
});
const issuePage = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  url: z.url(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.object({ name: z.string() }),
  delegate: actor.nullable(),
  attachments: z.object({ nodes: z.array(z.object({ url: z.string(), sourceType: z.string().nullable() })) }),
  comments: z.object({
    nodes: z.array(comment),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }),
});
const response = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const issueQuery = `
  query SergeantIssue($id: String!, $after: String) {
    issue(id: $id) {
      id identifier url title description
      state { name }
      delegate { id name }
      attachments(first: 100) { nodes { url sourceType } }
      comments(first: 50, after: $after) {
        nodes {
          id body createdAt updatedAt
          user { id name }
          externalUser { id name }
          botActor { id type name }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const createComment = `
  mutation SergeantComment($input: CommentCreateInput!) {
    commentCreate(input: $input) { success }
  }
`;
const commentById = `query SergeantCommentById($id: String!) { comment(id: $id) { id } }`;
const viewerQuery = `query SergeantViewer { viewer { id name } }`;
const delegatedQuery = `
  query SergeantDelegated($agent: ID!, $after: String) {
    issues(first: 100, after: $after, filter: { delegate: { id: { eq: $agent } }, state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes { identifier }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const delegatedPage = z.object({
  issues: z.object({
    nodes: z.array(z.object({ identifier: z.string().min(1) })),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
  }),
});
const followupOrigin = `query SergeantFollowupOrigin($id: String!) { issue(id: $id) { id team { id } project { id } } }`;
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

const pullRequestUrl = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/;

/**
 * The PRs Linear's GitHub integration attached to the issue: only `github`-sourced attachments, which
 * the integration creates for a real PR, never a plain link anyone could add. A missed attachment only
 * refuses a review or merge (G3, M2), so this fails closed.
 */
function linkedPullRequests(attachments: { url: string; sourceType: string | null }[]) {
  return attachments.flatMap(({ url, sourceType }) => {
    const match = sourceType === "github" ? pullRequestUrl.exec(url) : null;
    return match ? [{ repo: match[1], number: Number(match[2]) }] : [];
  });
}

export type LinearAdapterOptions = {
  apiKey: string;
  /** User ids that act for Sergeant but might not have Linear's `botActor` marker. */
  sergeantUserIds: readonly string[];
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
};

/** The minimal live Linear surface for the walking skeleton, as the token's own identity. */
export function createLinearPort(options: LinearAdapterOptions): LinearPort & {
  viewer(): Promise<{ id: string; name: string }>;
  /** Identifiers of the open issues (not completed or canceled) delegated to `agentUserId`. */
  delegatedIssues(agentUserId: string): Promise<string[]>;
} {
  if (!options.apiKey) throw new Error("Linear API key is required");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiUrl = options.apiUrl ?? "https://api.linear.app/graphql";
  const sergeantUsers = new Set(options.sergeantUserIds);

  const request = async <T>(query: string, variables: Record<string, unknown>, data: z.ZodType<T>): Promise<T> => {
    const res = await fetchFn(apiUrl, {
      method: "POST",
      headers: { Authorization: options.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Linear API request failed (${res.status})`);
    const parsed = response.parse(await res.json());
    if (parsed.errors?.length) throw new Error(`Linear API error: ${parsed.errors.map((e) => e.message).join("; ")}`);
    return data.parse(parsed.data);
  };

  /**
   * Runs a create under a client-supplied id (`commentIdFor`; issues and relations take one too, like
   * comments). Linear refuses a second entity with the same id, so when
   * the create fails but `existing` finds the entity, an earlier attempt made it; otherwise the
   * failure is real.
   */
  const createOnce = async <T>(create: () => Promise<T>, existing: () => Promise<T | null | undefined>): Promise<T> => {
    try {
      return await create();
    } catch (e) {
      const found = await existing().catch(() => undefined);
      if (found) return found;
      throw e;
    }
  };

  const readPage = async (issueId: string, after: string | null) => {
    const { issue } = await request(issueQuery, { id: issueId, after }, z.object({ issue: issuePage.nullable() }));
    if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
    return issue;
  };

  return {
    async readConversation(issueId) {
      let page = await readPage(issueId, null);
      const first = page;
      const comments = [...page.comments.nodes];
      while (page.comments.pageInfo.hasNextPage) {
        const cursor = page.comments.pageInfo.endCursor;
        if (!cursor) throw new Error("Linear returned hasNextPage without an endCursor");
        page = await readPage(issueId, cursor);
        comments.push(...page.comments.nodes);
      }

      // Bots, integrations, and Sergeant's own agents are context (`agentComments`), never human input.
      const humanAuthor = (item: (typeof comments)[number]) => {
        const author = item.botActor ? null : (item.user ?? item.externalUser);
        return author && !sergeantUsers.has(author.id) ? author : null;
      };
      const byTime = (a: { id: string; createdAt: string }, b: { id: string; createdAt: string }) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      const humanComments = comments.flatMap((item) => {
        const author = humanAuthor(item);
        return author ? [{ id: item.id, author, createdAt: item.createdAt, updatedAt: item.updatedAt, body: item.body }] : [];
      });
      const agentComments = comments.filter((item) => !humanAuthor(item)).map(({ id, createdAt, body }) => ({ id, createdAt, body }));

      return Conversation.parse({
        issue: {
          id: first.id,
          identifier: first.identifier,
          url: first.url,
          title: first.title,
          description: first.description ?? "",
          state: first.state.name,
          delegate: first.delegate,
          linkedPullRequests: linkedPullRequests(first.attachments.nodes),
        },
        humanComments: humanComments.sort(byTime),
        agentComments: agentComments.sort(byTime),
      });
    },

    async postComment({ issueId, body, key }) {
      const id = commentIdFor(key);
      await createOnce(
        async () => {
          const { commentCreate } = await request(
            createComment,
            { input: { id, issueId, body } },
            z.object({ commentCreate: z.object({ success: z.boolean() }) }),
          );
          if (!commentCreate.success) throw new Error("Linear commentCreate did not succeed");
          return true;
        },
        async () => (await request(commentById, { id }, z.object({ comment: z.object({ id: z.string() }).nullable() }))).comment?.id === id,
      );
    },

    async createFollowupIssue({ originIssueId, title, description, relation, key }) {
      const { issue: origin } = await request(
        followupOrigin,
        { id: originIssueId },
        z.object({ issue: z.object({ id: z.string(), team: z.object({ id: z.string() }), project: z.object({ id: z.string() }).nullable() }) }),
      );
      // No delegate and no assignee: a follow-up waits for human triage.
      const id = commentIdFor(key);
      const issue = await createOnce(
        async () => {
          const input = { id, teamId: origin.team.id, ...(origin.project && { projectId: origin.project.id }), title, description };
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
    },

    async viewer() {
      const { viewer } = await request(viewerQuery, {}, z.object({ viewer: actor }));
      return viewer;
    },

    async delegatedIssues(agentUserId) {
      const identifiers: string[] = [];
      let after: string | null = null;
      do {
        const { issues }: z.infer<typeof delegatedPage> = await request(delegatedQuery, { agent: agentUserId, after }, delegatedPage);
        identifiers.push(...issues.nodes.map((n) => n.identifier));
        after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
      } while (after);
      return identifiers;
    },
  };
}
