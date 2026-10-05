import { commentIdFor, type LinearPort } from "@terros/sergeant-contracts";
import { z } from "zod";
import { conversationReader } from "./conversation.ts";
import { taskOwnerReader } from "./delegation.ts";
import { followupFiler, followupFinder } from "./followup.ts";
import { labeler } from "./label.ts";
import { retroLinear, type RetroLinear } from "./retro.ts";
import {
  actor,
  clearDelegate,
  commentById,
  commentThread,
  commentThreadShape,
  completedPage,
  completedQuery,
  createComment,
  DelegatedIssue,
  delegatedPage,
  delegatedQuery,
  issueProgress,
  issueProgressShape,
  issueWorkflow,
  issueWorkflowShape,
  moveState,
  resolveComment,
  response,
  usersQuery,
  viewerQuery,
} from "./queries.ts";

export { DelegatedIssue } from "./queries.ts";
export { linearUser, type LinearUser } from "./linear-user.ts";

export type LinearAdapterOptions = {
  apiKey: string;
  /** User ids that act for Sergeant but might not have Linear's `botActor` marker. */
  sergeantUserIds: readonly string[];
  /**
   * Linear app ids (`botActor.id`) trusted to delegate or create an issue for the user they act for,
   * matched to the assignee by display name (TECH-5192). Any other app's delegation is not the assignee's.
   */
  delegatingAppIds?: readonly string[];
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** Where the adapter's warnings go; defaults to the console, timestamped like the service's log. */
  log?: (line: string) => void;
};

/** The minimal live Linear surface for the walking skeleton, as the token's own identity. */
export function createLinearPort(options: LinearAdapterOptions): LinearPort & {
  /** The token's own user and the Linear workspace (organization) it is in. */
  viewer(): Promise<{ id: string; name: string; organizationId: string }>;
  /** The names of the users with these ids, in their order; an id Linear does not know is left out. */
  userNames(ids: readonly string[]): Promise<string[]>;
  /** The open issues (not completed or canceled) delegated to `agentUserId`. */
  delegatedIssues(agentUserId: string): Promise<DelegatedIssue[]>;
  /**
   * Fetches a Linear upload (`https://uploads.linear.app/...`) with the agent token, on the control
   * plane: runs get the file, never the token (TECH-4994). Any other URL is refused.
   */
  fetchUpload(url: string, init?: { signal?: AbortSignal }): Promise<Response>;
  /** Identifiers of the issues delegated to `agentUserId` that reached a completed state after `since`. */
  completedIssues(agentUserId: string, since: string): Promise<string[]>;
  /** The issue's state type and, while it is completed, when it completed. */
  issueProgress(issueId: string): Promise<{ stateType: string; completedAt: string | null }>;
  /** Removes the issue's delegate: a human's cancel (`sgt task cancel`) or a handoff. Idempotent. */
  undelegate(issueId: string): Promise<void>;
  moveIssueToTodo(issueId: string): Promise<{ moved: false } | { moved: true; from: string; to: string }>;
  addLabel: NonNullable<LinearPort["addLabel"]>;
  findFollowupIssue: NonNullable<LinearPort["findFollowupIssue"]>;
  /** The retro's reads and writes (TECH-5187, retro.ts). */
  retro: RetroLinear;
} {
  if (!options.apiKey) throw new Error("Linear API key is required");
  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiUrl = options.apiUrl ?? "https://api.linear.app/graphql";
  const sergeantUsers = new Set(options.sergeantUserIds);
  const log = options.log ?? ((line: string) => console.log(`[${new Date().toISOString()}] ${line}`));

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

  return {
    readConversation: conversationReader({ request, sergeantUsers, log }),

    async postComment({ issueId, body, key, parentId }) {
      const id = commentIdFor(key);
      await createOnce(
        async () => {
          const { commentCreate } = await request(
            createComment,
            { input: { id, issueId, body, ...(parentId && { parentId }) } },
            z.object({ commentCreate: z.object({ success: z.boolean() }) }),
          );
          if (!commentCreate.success) throw new Error("Linear commentCreate did not succeed");
          return true;
        },
        async () => (await request(commentById, { id }, z.object({ comment: z.object({ id: z.string() }).nullable() }))).comment?.id === id,
      );
    },

    async resolveThread(commentId) {
      const read = async (id: string) => {
        const { comment } = await request(commentThread, { id }, commentThreadShape);
        if (!comment) throw new Error(`Linear comment not found: ${id}`);
        return comment;
      };
      const named = await read(commentId);
      const top = named.parentId ? await read(named.parentId) : named;
      // Never a human's thread, nor another bot's.
      if (!top.user || !sergeantUsers.has(top.user.id)) return "not_sergeants";
      if (top.resolvedAt) return "already_resolved";
      const { commentResolve } = await request(resolveComment, { id: top.id }, z.object({ commentResolve: z.object({ success: z.boolean() }) }));
      if (!commentResolve.success) throw new Error("Linear commentResolve did not succeed");
      return "resolved";
    },

    readTaskOwner: taskOwnerReader(request, sergeantUsers, new Set(options.delegatingAppIds)),

    createFollowupIssue: followupFiler({ request, createOnce, sergeantUsers, log }),

    findFollowupIssue: followupFinder({ request }),

    addLabel: labeler({ request }),

    retro: retroLinear({ request, createOnce, sergeantUsers }),

    async moveIssueToStarted(issueId) {
      const { issue } = await request(issueWorkflow, { id: issueId }, issueWorkflowShape);
      if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
      // Only ever Todo to In Progress (TECH-4989): an issue in Triage or Backlog, or already started,
      // completed, or canceled (and a team with no started state) is left exactly as it is.
      if (issue.state.type !== "unstarted") return { moved: false };
      const target = issue.team.states.nodes
        .filter((s) => s.type === "started")
        .sort((a, b) => a.position - b.position)[0];
      if (!target) return { moved: false };
      const { issueUpdate } = await request(moveState, { id: issueId, stateId: target.id }, z.object({ issueUpdate: z.object({ success: z.boolean() }) }));
      if (!issueUpdate.success) throw new Error("Linear issueUpdate did not succeed");
      return { moved: true, from: issue.state.name, to: target.name };
    },

    async moveIssueToTodo(issueId) {
      const { issue } = await request(issueWorkflow, { id: issueId }, issueWorkflowShape);
      if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
      if (issue.state.type !== "started") return { moved: false };
      const target = issue.team.states.nodes
        .filter((s) => s.type === "unstarted")
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

    async userNames(ids) {
      if (ids.length === 0) return [];
      const { users } = await request(usersQuery, { ids }, z.object({ users: z.object({ nodes: z.array(actor) }) }));
      return ids.flatMap((id) => users.nodes.find((u) => u.id === id)?.name ?? []);
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

    async completedIssues(agentUserId, since) {
      const completed: string[] = [];
      let after: string | null = null;
      do {
        const { issues }: z.infer<typeof completedPage> = await request(completedQuery, { agent: agentUserId, since, after }, completedPage);
        completed.push(...issues.nodes.map((n) => n.identifier));
        after = issues.pageInfo.hasNextPage ? issues.pageInfo.endCursor : null;
      } while (after);
      return completed;
    },

    async issueProgress(issueId) {
      const { issue } = await request(issueProgress, { id: issueId }, issueProgressShape);
      if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
      return { stateType: issue.state.type, completedAt: issue.completedAt };
    },

    async undelegate(issueId) {
      const { issueUpdate } = await request(clearDelegate, { id: issueId }, z.object({ issueUpdate: z.object({ success: z.boolean() }) }));
      if (!issueUpdate.success) throw new Error("Linear issueUpdate did not succeed");
    },
  };
}
