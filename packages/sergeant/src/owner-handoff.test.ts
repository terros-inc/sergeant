import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { RunRecord, RunSpec, TaskOwnerCheck } from "@terros/sergeant-contracts";
import { runLoop } from "./loop.ts";
import { fakes, issue, repo } from "./stop-fixtures.ts";

// TECH-5179: an active issue reassigned or unassigned is handed off. The runs stop, so the previous
// owner's quota stops being spent; the PRs and branches stay; the issue goes back to Todo,
// undelegated, with one comment; and nothing resumes until the new assignee delegates it, which
// starts a fresh task on their accounts with the existing work there to continue.

const ann = { id: "user-ann", name: "Ann" };
const bob = { id: "user-bob", name: "Bob" };
const annDelegated = "2026-10-04T06:01:00.000Z";

/** UNF-1 in progress, Ann's task with worker run_w1 running and its PR #7 open; `extra` merges into state.json. */
async function activeTask(extra: Record<string, unknown> = { owner: { ...ann, admittedAt: annDelegated, delegatedAt: annDelegated } }) {
  const dir = await mkdtemp(join(tmpdir(), "sergeant-handoff-test-"));
  const live = { conversation: issue("started", "In Progress") };
  const { deps, seen } = fakes(live);
  const base = { issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds: ["run_w1"], recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] } };
  await writeFile(join(dir, "state.json"), JSON.stringify({ ...base, ...extra }));
  let check: () => TaskOwnerCheck = () => ({ owner: ann, delegatedAt: annDelegated });
  deps.linear.readTaskOwner = async () => check();
  const loop = (signal?: AbortSignal) => runLoop({ issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0.01, log: () => {}, ...(signal && { signal }) }, deps);
  return { dir, live, deps, seen, loop, owns: (next: () => TaskOwnerCheck) => void (check = next) };
}

test("a reassignment hands off: runs stop, PRs stay open, the issue is Todo and undelegated, and the new assignee's delegation starts a fresh task", async () => {
  const t = await activeTask();
  // Bob is made the assignee; Ann's delegation is the one Linear still shows.
  t.live.conversation.issue.assignee = bob;
  t.owns(() => ({ refused: "delegator_differs", assignee: bob, delegator: ann, delegatedAt: annDelegated }));
  expect(await t.loop()).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("reassigned from Ann to Bob") });

  expect(t.seen.canceled).toEqual(["run_w1"]);
  expect(t.seen.closed).toEqual([]);
  expect(t.live.conversation.issue).toMatchObject({ state: "Todo", stateType: "unstarted", delegate: null });
  expect(t.seen.comments).toHaveLength(1);
  const [comment] = t.seen.comments;
  expect(comment?.body).toContain("reassigned from Ann to Bob");
  expect(comment?.body).toContain("[o/r#7](https://github.com/o/r/pull/7)");
  expect(comment?.body).toContain("Bob can continue it personally, or delegate it to Sergeant");
  expect(existsSync(join(t.dir, "state.json"))).toBe(false);

  // Not delegated now: nothing resumes under Bob, and nothing more is said, however often it polls.
  t.owns(() => ({ refused: "not_delegated" }));
  await t.loop();
  await t.loop();
  expect(t.seen.starts).toBe(0);
  expect(t.seen.comments).toHaveLength(1);

  // Bob delegates it himself: a fresh task, paid only by Bob, with the existing PR in front of it.
  t.live.conversation.issue.delegate = { id: "agent-v2", name: "Sergeant" };
  t.owns(() => ({ owner: bob, delegatedAt: "2026-10-04T07:00:00.000Z" }));
  const abort = new AbortController();
  const specs: RunSpec[] = [];
  const start = t.deps.runner.start;
  t.deps.runner.start = async (spec) => (specs.push(spec), await start(spec), abort.abort());
  await t.loop(abort.signal);
  expect(specs.map((s) => s.owner)).toEqual([bob]);
  expect(specs[0]?.conversation.issue.linkedPullRequests).toEqual([{ repo, number: 7 }]);
  expect(t.seen.closed).toEqual([]);
});

test("a handoff driven after a newer human action leaves it: a newer delegation keeps its delegation, and a state a human chose stays", async () => {
  const t = await activeTask();
  // By the time the stop runs, Bob already delegated it himself and moved it to Todo.
  Object.assign(t.live.conversation.issue, { assignee: bob, state: "Todo", stateType: "unstarted" });
  t.owns(() => ({ owner: bob, delegatedAt: "2026-10-04T07:00:00.000Z" }));
  await t.loop();
  expect(t.seen.canceled).toEqual(["run_w1"]);
  expect(t.live.conversation.issue).toMatchObject({ state: "Todo", delegate: { id: "agent-v2" } });
  expect(t.seen.comments.map((c) => c.body)).toEqual([expect.stringContaining("A newer delegation to Sergeant is in place")]);
});

test("a task from before owners were recorded that is refused still has its runs canceled, its PRs kept", async () => {
  const t = await activeTask({});
  t.owns(() => ({ refused: "delegator_differs", assignee: ann, delegator: bob, delegatedAt: annDelegated }));
  expect(await t.loop()).toMatchObject({ outcome: "stopped" });
  expect(t.seen.canceled).toEqual(["run_w1"]);
  expect(t.seen.closed).toEqual([]);
  expect(t.seen.starts).toBe(0);
  expect(t.live.conversation.issue).toMatchObject({ state: "Todo", delegate: null });
  expect(existsSync(join(t.dir, "state.json"))).toBe(false);
});

test("reassigned while the merged task waits for Done, its audit stops promptly and the issue keeps its status", async () => {
  const audit: RunRecord = { runId: "run_audit-x", role: "reviewer", status: "running", provider: "p", model: "m", report: null };
  const merged = { repo, number: 7, headSha: "a".repeat(40), mergedSha: "b".repeat(40), at: new Date().toISOString(), auditDrawnAt: new Date().toISOString(), audit: { runId: audit.runId } };
  const t = await activeTask({ owner: { ...ann, admittedAt: annDelegated, delegatedAt: annDelegated }, runIds: [], merged });
  Object.assign(t.live.conversation.issue, { state: "In Review" });
  t.deps.runner = {
    start: async () => Promise.reject(new Error("nothing starts after the merge")),
    status: async (id) => (id === audit.runId ? audit : Promise.reject(new Error(`no ${id}`))),
    cancel: async (id) => void (t.seen.canceled.push(id), (audit.status = "canceled")),
  };
  let reads = 0;
  const read = t.deps.linear.readConversation;
  t.deps.linear.readConversation = async (id) => (reads++, read(id));
  const done = t.loop();
  // The loop is in the completion wait (Linear is never Done here) when Bob is made the assignee.
  await vi.waitFor(() => expect(reads).toBeGreaterThan(4));
  t.live.conversation.issue.assignee = bob;
  expect(await done).toMatchObject({ outcome: "stopped" });
  expect(t.seen.canceled).toEqual([audit.runId]);
  expect(t.live.conversation.issue).toMatchObject({ state: "In Review", delegate: { id: "agent-v2" } });
  expect(t.seen.comments.map((c) => c.body)).toEqual([expect.stringMatching(/reassigned from Ann to Bob.*already merged, so the issue is left as it is/)]);
});
