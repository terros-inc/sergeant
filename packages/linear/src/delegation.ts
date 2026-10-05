import type { LinearPerson, TaskOwnerCheck } from "@terros/sergeant-contracts";
import { z } from "zod";
import { actor } from "./queries.ts";

// Who delegated an issue to Sergeant, from Linear's durable issue history (TECH-5179). Admission reads
// it on every attempt, so a missed webhook or downtime cannot let a task start without the proof.

/** What the history readers need from the Linear adapter they run inside. */
export type Request = <T>(query: string, variables: Record<string, unknown>, data: z.ZodType<T>) => Promise<T>;

// Every page, newest first by our own sort: Linear's default order is not relied on.
const delegationHistory = `
  query SergeantDelegationHistory($id: String!, $after: String) {
    issue(id: $id) {
      history(first: 100, after: $after) {
        nodes { createdAt actor { id name } botActor { id userDisplayName } toDelegate { id } fromDelegate { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
/** The app an entry was made through, and the user Linear records it acting for: a name, never an id. */
const botActor = z.object({ id: z.string().nullable(), userDisplayName: z.string().nullable() }).nullish();
const delegationHistoryShape = z.object({
  issue: z.object({
    history: z.object({
      nodes: z.array(
        z.object({
          createdAt: z.string(),
          actor: actor.nullable(),
          botActor,
          toDelegate: z.object({ id: z.string() }).nullable(),
          fromDelegate: z.object({ id: z.string() }).nullish(),
        }),
      ),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  }),
});
/** More history than this is not read: the proof fails closed rather than paging without end. */
const MAX_HISTORY_PAGES = 20;

const issueOwnership = `query SergeantIssueOwnership($id: String!) { issue(id: $id) { id createdAt creator { id name } botActor { id userDisplayName } assignee { id name displayName } delegate { id name } } }`;
const issueOwnershipShape = z.object({
  issue: z
    .object({
      id: z.string(),
      createdAt: z.string(),
      creator: actor.nullable(),
      botActor,
      assignee: actor.extend({ displayName: z.string() }).nullable(),
      delegate: actor.nullable(),
    })
    .nullable(),
});

/**
 * The latest delegation of the issue to `delegateId` in Linear's history, and who made it: `by` is
 * absent when no user did (an automation or integration). Undefined when the history has none.
 * Throws when the history cannot be read in full.
 */
export async function latestDelegation(request: Request, issueId: string, delegateId: string): Promise<{ at: string; by?: LinearPerson } | undefined> {
  const latest = (await delegationsTo(request, issueId, delegateId)).latest;
  return latest && { at: latest.at, ...(latest.by && { by: latest.by }) };
}

/**
 * `latestDelegation`, and whether the history shows the issue delegated to or from `delegateId` at
 * all: when it never does, the delegate was set when the issue was created (TECH-5192).
 */
async function delegationsTo(request: Request, issueId: string, delegateId: string) {
  const delegations: { createdAt: string; actor: LinearPerson | null; botActor?: z.infer<typeof botActor> }[] = [];
  let undelegated = false;
  let after: string | null = null;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const { history }: z.infer<typeof delegationHistoryShape>["issue"] = (await request(delegationHistory, { id: issueId, after }, delegationHistoryShape)).issue;
    delegations.push(...history.nodes.filter((h) => h.toDelegate?.id === delegateId));
    undelegated ||= history.nodes.some((h) => h.fromDelegate?.id === delegateId);
    if (history.pageInfo.hasNextPage && !history.pageInfo.endCursor) throw new Error(`the history of ${issueId} has a next page but no cursor`);
    after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    if (!after) {
      const latest = delegations.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return { latest: latest && { at: latest.createdAt, ...(latest.actor && { by: latest.actor }), bot: latest.botActor }, mentioned: !!latest || undelegated };
    }
  }
  throw new Error(`the history of ${issueId} is longer than ${MAX_HISTORY_PAGES * 100} entries`);
}

/**
 * The adapter's `readTaskOwner` (TECH-5179): the issue's assignee owns the task only when they are a
 * human and are the one who most recently delegated it to `agentUserId`, or created it already
 * delegated (TECH-5192). A delegation or creation made through an app counts as the assignee's own only
 * when the app is in `delegatingAppIds` and acted for a user with the assignee's display name (TECH-5192);
 * any other app's stays what it was. Fails closed: anything Linear's history cannot prove is a refusal, and an
 * unreadable history throws.
 */
export function taskOwnerReader(request: Request, sergeantUsers: ReadonlySet<string>, delegatingAppIds: ReadonlySet<string> = new Set()) {
  return async (issueId: string, agentUserId: string): Promise<TaskOwnerCheck> => {
    const { issue } = await request(issueOwnership, { id: issueId }, issueOwnershipShape);
    if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
    if (issue.delegate?.id !== agentUserId) return { refused: "not_delegated" };
    const history = await delegationsTo(request, issue.id, agentUserId);
    // An issue created already delegated has no delegation in its history: its creator delegated it.
    const made = history.mentioned ? history.latest : { at: issue.createdAt, ...(issue.creator && { by: issue.creator }), bot: issue.botActor };
    const human = (p: LinearPerson | null | undefined) => (p && !sergeantUsers.has(p.id) ? { id: p.id, name: p.name } : undefined);
    const assignee = human(issue.assignee);
    // Linear names the user an app acted for only by display name, so only allowlisted apps are trusted with it.
    const actedForAssignee = !!made?.bot?.id && delegatingAppIds.has(made.bot.id) && made.bot.userDisplayName === issue.assignee?.displayName;
    const delegation = made && { at: made.at, by: assignee && actedForAssignee ? assignee : made.by };
    const delegator = human(delegation?.by);
    const facts = { ...(assignee && { assignee }), ...(delegator && { delegator }), ...(delegation && { delegatedAt: delegation.at }) };
    if (!assignee) return { refused: "no_assignee", ...facts };
    if (!delegator) return { refused: "delegator_unknown", ...facts };
    if (delegator.id !== assignee.id) return { refused: "delegator_differs", ...facts };
    return { owner: assignee, ...(delegation && { delegatedAt: delegation.at }) };
  };
}
