import { expect, test } from "vitest";
import { createLinearPort } from "./linear.ts";

// TECH-5179: a task spends only its owner's model quota, and its owner is the issue's human assignee
// only when Linear's history proves that person most recently delegated it to Sergeant. Anyone
// assigning an issue to someone else and delegating it themselves must be refused, and anything the
// history cannot prove fails closed.

const agent = { id: "agent-v2", name: "Sergeant" };
const ann = { id: "ann", name: "Ann" };
const bob = { id: "bob", name: "Bob" };
const at = (minute: number) => `2026-10-04T06:${String(minute).padStart(2, "0")}:00.000Z`;
type Entry = { createdAt: string; actor: { id: string; name: string } | null; toDelegate: { id: string } | null; fromDelegate?: { id: string } | null };
const delegated = (actor: Entry["actor"], minute: number, to = agent): Entry => ({ createdAt: at(minute), actor, toDelegate: { id: to.id } });

type Issue = { assignee: { id: string; name: string } | null; delegate: { id: string; name: string } | null; creator?: { id: string; name: string } | null };
function linear({ creator = null, ...issue }: Issue, pages: Entry[][] | Response) {
  const reads: (string | null)[] = [];
  const port = createLinearPort({
    apiKey: "test",
    sergeantUserIds: [agent.id, "agent-v1"],
    fetch: async (_i, init) => {
      const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { after?: string | null } };
      if (query.includes("SergeantIssueOwnership")) return Response.json({ data: { issue: { id: "issue-1", createdAt: at(0), creator, ...issue } } });
      if (pages instanceof Response) return pages;
      reads.push(variables.after ?? null);
      const n = variables.after ? Number(variables.after) : 0;
      const more = n + 1 < pages.length;
      return Response.json({ data: { issue: { history: { nodes: pages[n] ?? [], pageInfo: { hasNextPage: more, endCursor: more ? String(n + 1) : null } } } } });
    },
  });
  return { check: () => port.readTaskOwner("UNF-1", agent.id), reads };
}

test("the assignee who most recently delegated the issue owns it, read across every history page in any order", async () => {
  // Bob delegated first; Ann undelegated it and delegated it again later, on the second page.
  const pages = [[delegated(ann, 9), delegated(bob, 2)], [{ createdAt: at(5), actor: ann, toDelegate: null }, delegated(bob, 1)]];
  const read = linear({ assignee: ann, delegate: agent }, pages);
  expect(await read.check()).toEqual({ owner: ann, delegatedAt: at(9) });
  expect(read.reads).toEqual([null, "1"]);
});

test("someone delegating another person's issue is refused, whoever delegated before them", async () => {
  // Ann delegated it once; Bob's later delegation is the one that counts.
  const read = linear({ assignee: ann, delegate: agent }, [[delegated(ann, 1), delegated(bob, 7)]]);
  expect(await read.check()).toEqual({ refused: "delegator_differs", assignee: ann, delegator: bob, delegatedAt: at(7) });
});

test("an issue with no human assignee is refused", async () => {
  for (const assignee of [null, { id: "agent-v1", name: "Sergeant V1" }]) {
    expect(await linear({ assignee, delegate: agent }, [[delegated(ann, 1)]]).check()).toEqual({ refused: "no_assignee", delegator: ann, delegatedAt: at(1) });
  }
});

test("a delegation the history cannot attribute to a human fails closed", async () => {
  // None at all, on an issue created by an integration; the latest by an automation, though Ann delegated earlier; by Sergeant's own user; only to another agent.
  const histories: Entry[][] = [[], [delegated(ann, 1), delegated(null, 4)], [delegated({ id: "agent-v1", name: "V1" }, 2)], [delegated(ann, 3, { id: "agent-v1", name: "V1" })]];
  for (const history of histories) {
    const result = await linear({ assignee: ann, delegate: agent }, [history]).check();
    expect(result).toMatchObject({ refused: "delegator_unknown", assignee: ann });
    expect(result).not.toHaveProperty("delegator");
  }
});

test("an issue created already delegated is delegated by its creator, only while its history shows no delegation", async () => {
  // TECH-5192: Linear's history has no delegation entry for a delegate set at creation.
  expect(await linear({ assignee: ann, delegate: agent, creator: ann }, [[]]).check()).toEqual({ owner: ann, delegatedAt: at(0) });
  expect(await linear({ assignee: ann, delegate: agent, creator: bob }, [[]]).check()).toEqual({ refused: "delegator_differs", assignee: ann, delegator: bob, delegatedAt: at(0) });
  // Once the history shows Sergeant delegated or undelegated, the creator no longer counts.
  const undelegated: Entry = { createdAt: at(3), actor: ann, toDelegate: null, fromDelegate: { id: agent.id } };
  for (const history of [[delegated(null, 2)], [undelegated]]) {
    expect(await linear({ assignee: ann, delegate: agent, creator: ann }, [history]).check()).toMatchObject({ refused: "delegator_unknown" });
  }
});

test("an issue not delegated to Sergeant has no owner, and its history is not read", async () => {
  const read = linear({ assignee: ann, delegate: null }, [[delegated(ann, 1)]]);
  expect(await read.check()).toEqual({ refused: "not_delegated" });
  expect(read.reads).toEqual([]);
});

test("an unreadable history throws instead of admitting", async () => {
  await expect(linear({ assignee: ann, delegate: agent }, Response.json({ errors: [{ message: "Cannot query field 'toDelegate'" }] })).check()).rejects.toThrow(/toDelegate/);
  await expect(linear({ assignee: ann, delegate: agent }, new Response("unavailable", { status: 503 })).check()).rejects.toThrow(/503/);
});

test("a history page that claims more but gives no cursor fails closed instead of admitting from part of it", async () => {
  const page = { data: { issue: { history: { nodes: [delegated(ann, 1)], pageInfo: { hasNextPage: true, endCursor: null } } } } };
  await expect(linear({ assignee: ann, delegate: agent }, Response.json(page)).check()).rejects.toThrow(/no cursor/);
});
