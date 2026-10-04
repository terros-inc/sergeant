import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { NoModelAccount, type RunSpec, type TaskOwnerCheck } from "@terros/sergeant-contracts";
import { runLoop } from "./loop.ts";
import { redelegated } from "./owner.ts";
import { startService } from "./service.ts";
import { fakes, issue, repo } from "./stop-fixtures.ts";

// TECH-5179: a task spends only its owner's model quota. Its owner is the issue's human assignee, and
// only when Linear shows that same person delegated it: nobody can assign an issue to someone else and
// delegate it to spend their quota. Every refusal tells the humans what to do, once per condition,
// however often intake polls. The owner, once admitted, is the task's until it ends: the issue
// reassigned mid-task stops it as a handoff (owner-handoff.test.ts).

const ann = { id: "user-ann", name: "Ann" };
const bob = { id: "user-bob", name: "Bob" };
const succeeded = (runId: string) => ({ runId, role: "worker" as const, status: "succeeded" as const, provider: "p", model: "m", report: null });

async function task(check: () => TaskOwnerCheck, start: (spec: RunSpec) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "sergeant-owner-test-"));
  const live = { conversation: issue("unstarted", "Todo") };
  const { deps, seen } = fakes(live);
  let checks = 0;
  deps.linear.readTaskOwner = async () => (checks++, check());
  const starts: RunSpec[] = [];
  const ran = new Set<string>();
  let abort = new AbortController();
  deps.runner = {
    start: async (spec) => {
      starts.push(spec);
      await start(spec);
      ran.add(spec.runId);
      abort.abort();
    },
    status: async (id) => (ran.has(id) ? succeeded(id) : Promise.reject(new Error(`no run ${id}`))),
    cancel: async () => {},
  };
  const loop = (idleMinutes?: number) => {
    abort = new AbortController();
    return runLoop({ issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0.01, log: () => {}, signal: abort.signal, ...(idleMinutes !== undefined && { idleMinutes }) }, deps);
  };
  const saved = async () => JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { owner?: { id: string; name: string } };
  return { loop, live, seen, starts, saved, dir, deps, checks: () => checks };
}

test("someone delegating another person's issue is refused with one comment, however often intake retries", async () => {
  const t = await task(() => ({ refused: "delegator_differs", assignee: ann, delegator: bob, delegatedAt: "2026-10-04T06:07:00.000Z" }), async () => {});
  for (let poll = 0; poll < 3; poll++) expect(await t.loop()).toEqual({ outcome: "stopped", detail: "not started: no owner (delegator_differs)" });

  expect(t.seen.comments.map((c) => c.body)).toEqual([
    "Sergeant cannot spend Ann's model quota because Bob delegated the issue. If you want Sergeant to run this work, assign the issue to yourself first, then delegate it to Sergeant; or have Ann delegate it themselves.",
  ]);
  expect(new Set(t.seen.commentAttempts).size).toBe(1);
  // Nothing was admitted: no turn, no run, and no task on disk for intake to resume.
  expect(t.seen.turns).toBe(0);
  expect(t.starts).toEqual([]);
  expect(existsSync(join(t.dir, "state.json"))).toBe(false);
});

test("each refusal says what to do; a new delegation that is refused again is said again", async () => {
  let check: TaskOwnerCheck = { refused: "no_assignee", delegator: bob, delegatedAt: "2026-10-04T06:01:00.000Z" };
  const t = await task(() => check, async () => {});
  await t.loop();
  check = { refused: "delegator_unknown", assignee: ann, delegatedAt: "2026-10-04T06:02:00.000Z" };
  await t.loop();
  await t.loop();
  check = { refused: "delegator_unknown", assignee: ann, delegatedAt: "2026-10-04T06:09:00.000Z" };
  await t.loop();
  // Not delegated to Sergeant at all: nobody asked it to do anything, so it says nothing.
  check = { refused: "not_delegated" };
  await t.loop();
  expect(t.seen.comments.map((c) => c.body)).toEqual([
    "Sergeant cannot start until this issue is assigned to a human. Assign it to the person whose model accounts should pay for it, and have them delegate it to Sergeant.",
    "Sergeant cannot start: Linear's history does not show Ann delegating this issue to Sergeant, so it cannot spend their model quota. Have Ann delegate it to Sergeant themselves.",
    "Sergeant cannot start: Linear's history does not show Ann delegating this issue to Sergeant, so it cannot spend their model quota. Have Ann delegate it to Sergeant themselves.",
  ]);
  expect(t.starts).toEqual([]);
});

test("an unreadable Linear history admits nobody and says nothing", async () => {
  const t = await task(() => {
    throw new Error("Linear API request failed (503)");
  }, async () => {});
  expect(await t.loop()).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("(503)") });
  expect(t.seen.comments).toEqual([]);
  expect(existsSync(join(t.dir, "state.json"))).toBe(false);
});

test("an issue reopened in Todo after its task was seen through is a new task, admitted for its owner now", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "sergeant-owner-reopen-test-"));
  const live = { conversation: issue("unstarted", "Todo") };
  live.conversation.issue.assignee = bob;
  const { deps } = fakes(live);
  deps.linear.readTaskOwner = async () => ({ owner: bob });
  const owners: string[] = [];
  const start = deps.runner.start;
  deps.runner.start = async (spec) => (owners.push(spec.owner.id), start(spec));
  const dir = join(stateDir, "tasks", "UNF-1");
  await mkdir(dir, { recursive: true });
  const merged = { repo, number: 7, headSha: "a".repeat(40), mergedSha: "b".repeat(40), at: "2026-10-03T00:00:00.000Z", completedAt: "2026-10-03T01:00:00.000Z" };
  await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", startedAt: "2026-10-02T00:00:00.000Z", turns: 3, runIds: [], recentTurns: [], owner: { ...ann, admittedAt: "2026-10-02T00:00:00.000Z" }, merged }));

  const service = await startService({ enrolledRepositories: [repo], stateDir, intakeSeconds: 0.01, pollSeconds: 0.01, port: 0, log: () => {} }, deps);
  await vi.waitFor(() => expect(owners).toEqual([bob.id]), { timeout: 5_000 });
  await service.stop();
  expect(JSON.parse(await readFile(join(dir, "state.json"), "utf8"))).toMatchObject({ owner: bob });
  expect(existsSync(join(dir, "state.completed-2026-10-03T01-00-00-000Z.json"))).toBe(true);
});

test("an unassigned issue stops its task before anything more starts", async () => {
  const t = await task(() => ({ owner: ann }), async () => {});
  await t.loop();
  t.live.conversation.issue.assignee = null;
  expect(await t.loop()).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("unassigned from Ann") });
  expect(t.starts).toHaveLength(1);
});

test("an owner with no usable account starts nothing and is told what to fix, once, retried until Linear accepts it", async () => {
  const t = await task(
    () => ({ owner: ann }),
    async (spec) => {
      throw new NoModelAccount(spec.owner, "none_registered", [], "Ann has no model account registered for a provider this Sergeant runs");
    },
  );
  const post = t.deps.linear.postComment;
  let failures = 2;
  t.deps.linear.postComment = async (c) => (failures-- > 0 ? Promise.reject(new Error("Linear unavailable")) : post(c));
  expect(await t.loop(0)).toMatchObject({ outcome: "idle" });
  expect(failures).toBeLessThan(0);
  expect(t.seen.comments.map((c) => c.body)).toEqual([
    "Sergeant needs one of Ann's model accounts before it can start. Ann: register one with `sgt account register claude-code-local` (or `codex-local`), then comment here, or run `sgt task wake`, so Sergeant tries again.",
  ]);
  const { runIds } = JSON.parse(await readFile(join(t.dir, "state.json"), "utf8")) as { runIds: string[] };
  expect(runIds).toEqual([]);
});

test("an undelegation and redelegation missed between polls, even by the owner, stops the task: a new episode is checked afresh", async () => {
  let check: TaskOwnerCheck = { owner: ann, delegatedAt: "2026-10-04T06:01:00.000Z" };
  const t = await task(() => check, async () => {});
  await t.loop();
  expect(t.starts.map((s) => s.owner)).toEqual([ann]);

  // No webhook seen: the assignee is unchanged, but Linear's history shows a newer delegation.
  check = { owner: ann, delegatedAt: "2026-10-04T06:09:00.000Z" };
  expect(await t.loop()).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("delegated to Sergeant again") });
  expect(t.starts).toHaveLength(1);
  expect(existsSync(join(t.dir, "state.json"))).toBe(false);
});

test("an active task's owner proof is reread: someone else delegating stops it, and unreadable history throws so nothing starts", async () => {
  const owner = { ...ann, admittedAt: "2026-10-04T06:00:00.000Z", delegatedAt: "2026-10-04T06:01:00.000Z" };
  const deps = (check: () => Promise<TaskOwnerCheck>) => ({ agentUserId: "agent-v2", linear: { readTaskOwner: check } }) as unknown as Parameters<typeof redelegated>[2];
  expect(await redelegated(owner, "UNF-1", deps(async () => ({ owner: ann, delegatedAt: owner.delegatedAt })))).toBeUndefined();
  expect(await redelegated(owner, "UNF-1", deps(async () => ({ refused: "delegator_differs", assignee: ann, delegator: bob })))).toMatch(/delegator_differs/);
  await expect(redelegated(owner, "UNF-1", deps(async () => Promise.reject(new Error("Linear API request failed (503)"))))).rejects.toThrow(/503/);
});
