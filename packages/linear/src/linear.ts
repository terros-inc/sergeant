import { commentIdFor, Conversation, type LinearPort } from "@terros/sergeant-contracts";
import { z } from "zod";
import {
  actor,
  clearDelegate,
  commentById,
  createComment,
  createIssue,
  createRelation,
  DelegatedIssue,
  delegatedPage,
  delegatedQuery,
  delegationHistory,
  delegationHistoryShape,
  followupOrigin,
  followupOriginShape,
  issueById,
  issuePage,
  issueQuery,
  issueRef,
  issueWorkflow,
  issueWorkflowShape,
  moveState,
  relationById,
  response,
  unstartedTypes,
  viewerQuery,
} from "./queries.ts";

export { DelegatedIssue } from "./queries.ts";
export { linearUser, type LinearUser } from "./linear-user.ts";

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
  /** The token's own user and the Linear workspace (organization) it is in. */
  viewer(): Promise<{ id: string; name: string; organizationId: string }>;
  /** The open issues (not completed or canceled) delegated to `agentUserId`. */
  delegatedIssues(agentUserId: string): Promise<DelegatedIssue[]>;
  /**
   * Fetches a Linear upload (`https://uploads.linear.app/...`) with the agent token, on the control
   * plane: runs get the file, never the token (TECH-4994). Any other URL is refused.
   */
  fetchUpload(url: string, init?: { signal?: AbortSignal }): Promise<Response>;
  /** Removes the issue's delegate: a human's cancel (`sgt task cancel`). Idempotent. */
  undelegate(issueId: string): Promise<void>;
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

  /**
   * The human who most recently delegated the issue to `delegateId`, when Linear's history shows one.
   * Best-effort: a failed or mismatched history query only leaves the follow-up unassigned.
   */
  const delegator = async (issueId: string, delegateId: string | undefined) => {
    if (!delegateId) return undefined;
    const history = await request(delegationHistory, { id: issueId }, delegationHistoryShape).catch(() => undefined);
    if (!history) return undefined;
    const { issue } = history;
    const delegation = issue.history.nodes
      .filter((h) => h.toDelegate?.id === delegateId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const actorId = delegation?.actor?.id;
    return actorId && !sergeantUsers.has(actorId) ? actorId : undefined;
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
          // Only a human's: Sergeant's own, and an integration's with no creator, are not human input.
          attachments: first.attachments.nodes
            .filter((a) => a.creator && !sergeantUsers.has(a.creator.id))
            .map(({ id, title, sourceType, url, updatedAt }) => ({ id, title, source: sourceType, url, updatedAt })),
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
    },

    async moveIssueToStarted(issueId) {
      const { issue } = await request(issueWorkflow, { id: issueId }, issueWorkflowShape);
      if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
      // Only ever move forward out of an unstarted-like state: already started, completed, or canceled
      // issues (and teams with no started state) are left exactly as they are.
      if (!unstartedTypes.has(issue.state.type)) return { moved: false };
      const target = issue.team.states.nodes
        .filter((s) => s.type === "started")
        .sort((a, b) => a.position - b.position)[0];
      if (!target) return { moved: false };
      const { issueUpdate } = await request(moveState, { id: issueId, stateId: target.id }, z.object({ issueUpdate: z.object({ success: z.boolean() }) }));
      if (!issueUpdate.success) throw new Error("Linear issueUpdate did not succeed");
      return { moved: true, from: issue.state.name, to: target.name };
    },

    async viewer() {
      const { viewer } = await request(viewerQuery, {}, z.object({ viewer: actor.extend({ organization: z.object({ id: z.string().min(1) }) }) }));
      return { id: viewer.id, name: viewer.name, organizationId: viewer.organization.id };
    },

    async delegatedIssues(agentUserId) {
      const delegated: DelegatedIssue[] = [];
      let after: string | null = null;
      do {
        const { issues }: z.infer<typeof delegatedPage> = await request(delegatedQuery, { agent: agentUserId, after }, delegatedPage);
        delegated.push(...issues.nodes);
        after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
      } while (after);
      return delegated;
    },

    async fetchUpload(url, init) {
      const origin = "https://uploads.linear.app";
      if (new URL(url).origin !== origin) throw new Error(`not a Linear upload: ${url}`);
      // Redirects are followed by hand so the token goes only to Linear's upload origin: a hop
      // elsewhere (signed storage) is fetched without it, and only over https.
      let next = url;
      for (let hop = 0; hop < 5; hop++) {
        const own = new URL(next).origin === origin;
        const res = await fetchFn(next, {
          redirect: "manual",
          ...(own && { headers: { Authorization: options.apiKey } }),
          ...(init?.signal && { signal: init.signal }),
        });
        const location = res.headers.get("location");
        if (res.status < 300 || res.status >= 400 || !location) return res;
        await res.body?.cancel();
        next = new URL(location, next).href;
        if (!next.startsWith("https://")) throw new Error("Linear upload redirected off https");
      }
      throw new Error("too many redirects fetching a Linear upload");
    },

    async undelegate(issueId) {
      const { issueUpdate } = await request(clearDelegate, { id: issueId }, z.object({ issueUpdate: z.object({ success: z.boolean() }) }));
      if (!issueUpdate.success) throw new Error("Linear issueUpdate did not succeed");
    },
  };
}
