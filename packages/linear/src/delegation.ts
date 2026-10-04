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
        nodes { createdAt actor { id name } toDelegate { id } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const delegationHistoryShape = z.object({
  issue: z.object({
    history: z.object({
      nodes: z.array(z.object({ createdAt: z.string(), actor: actor.nullable(), toDelegate: z.object({ id: z.string() }).nullable() })),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  }),
});
/** More history than this is not read: the proof fails closed rather than paging without end. */
const MAX_HISTORY_PAGES = 20;

const issueOwnership = `query SergeantIssueOwnership($id: String!) { issue(id: $id) { id assignee { id name } delegate { id name } } }`;
const issueOwnershipShape = z.object({ issue: z.object({ id: z.string(), assignee: actor.nullable(), delegate: actor.nullable() }).nullable() });

/**
 * The latest delegation of the issue to `delegateId` in Linear's history, and who made it: `by` is
 * absent when no user did (an automation or integration). Undefined when the history has none.
 * Throws when the history cannot be read in full.
 */
export async function latestDelegation(request: Request, issueId: string, delegateId: string): Promise<{ at: string; by?: LinearPerson } | undefined> {
  const delegations: { createdAt: string; actor: LinearPerson | null }[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const { history }: z.infer<typeof delegationHistoryShape>["issue"] = (await request(delegationHistory, { id: issueId, after }, delegationHistoryShape)).issue;
    delegations.push(...history.nodes.filter((h) => h.toDelegate?.id === delegateId));
    if (history.pageInfo.hasNextPage && !history.pageInfo.endCursor) throw new Error(`the history of ${issueId} has a next page but no cursor`);
    after = history.pageInfo.hasNextPage ? history.pageInfo.endCursor : null;
    if (!after) {
      const latest = delegations.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return latest && { at: latest.createdAt, ...(latest.actor && { by: latest.actor }) };
    }
  }
  throw new Error(`the history of ${issueId} is longer than ${MAX_HISTORY_PAGES * 100} entries`);
}

/**
 * The adapter's `readTaskOwner` (TECH-5179): the issue's assignee owns the task only when they are a
 * human and are the one who most recently delegated it to `agentUserId`. Fails closed: anything
 * Linear's history cannot prove is a refusal, and an unreadable history throws.
 */
export function taskOwnerReader(request: Request, sergeantUsers: ReadonlySet<string>) {
  return async (issueId: string, agentUserId: string): Promise<TaskOwnerCheck> => {
    const { issue } = await request(issueOwnership, { id: issueId }, issueOwnershipShape);
    if (!issue) throw new Error(`Linear issue not found: ${issueId}`);
    if (issue.delegate?.id !== agentUserId) return { refused: "not_delegated" };
    const delegation = await latestDelegation(request, issue.id, agentUserId);
    const human = (p: LinearPerson | null | undefined) => (p && !sergeantUsers.has(p.id) ? p : undefined);
    const assignee = human(issue.assignee);
    const delegator = human(delegation?.by);
    const facts = { ...(assignee && { assignee }), ...(delegator && { delegator }), ...(delegation && { delegatedAt: delegation.at }) };
    if (!assignee) return { refused: "no_assignee", ...facts };
    if (!delegator) return { refused: "delegator_unknown", ...facts };
    if (delegator.id !== assignee.id) return { refused: "delegator_differs", ...facts };
    return { owner: assignee, ...(delegation && { delegatedAt: delegation.at }) };
  };
}
