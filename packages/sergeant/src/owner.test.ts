import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { NoModelAccount, type RunSpec, type StartedRun, type TaskOwnerCheck } from "@terros/sergeant-contracts";
import { runLoop } from "./loop.ts";
import { fakes, issue, repo } from "./stop-fixtures.ts";

// TECH-5179: a task spends only its owner's model quota. Its owner is the issue's human assignee, and
// only when Linear shows that same person delegated it: nobody can assign an issue to someone else and
// delegate it to spend their quota. Every refusal tells the humans what to do, once per condition,
// however often intake polls; the owner, once admitted, holds for the task whatever happens to the
// issue's assignee.

const ann = { id: "user-ann", name: "Ann" };
const bob = { id: "user-bob", name: "Bob" };
const succeeded = (runId: string) => ({ runId, role: "worker" as const, status: "succeeded" as const, provider: "p", model: "m", report: null });

async function task(check: () => TaskOwnerCheck, start: (spec: RunSpec) => Promise<StartedRun | void>) {
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
      const started = await start(spec);
      ran.add(spec.runId);
      abort.abort();
      return started;
    },
    status: async (id) => (ran.has(id) ? succeeded(id) : Promise.reject(new Error(`no run ${id}`))),
    cancel: async () => {},
  };
  const loop = (idleMinutes?: number) => {
    abort = new AbortController();
    return runLoop({ issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0.01, log: () => {}, signal: abort.signal, ...(idleMinutes !== undefined && { idleMinutes }) }, deps);
  };
  const saved = async () => JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { owner?: { id: string; name: string } };
  return { loop, seen, starts, saved, dir, checks: () => checks };
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

test("the admitted owner pays for every run of the task, and a reassignment while it runs moves nothing", async () => {
  let check: TaskOwnerCheck = { owner: ann };
  const t = await task(() => check, async () => {});
  expect(await t.loop()).toMatchObject({ outcome: "stopped" });
  expect((await t.saved()).owner).toMatchObject(ann);
  expect(t.starts.map((s) => s.owner)).toEqual([ann]);

  // Bob is now the assignee and delegated it himself: this task is still Ann's, and is not checked again.
  check = { owner: bob };
  await t.loop();
  expect(t.starts.map((s) => s.owner)).toEqual([ann, ann]);
  expect(t.checks()).toBe(1);
});

test("an owner with no usable account starts nothing and is told what to fix, once", async () => {
  const t = await task(
    () => ({ owner: ann }),
    async (spec) => {
      throw new NoModelAccount(spec.owner, "none_registered", [], "Ann has no model account registered for a provider this Sergeant runs");
    },
  );
  expect(await t.loop(0)).toMatchObject({ outcome: "idle" });
  expect(t.seen.comments.map((c) => c.body)).toEqual([
    "Sergeant needs one of Ann's model accounts before it can start. Ann: register one with `sgt account register claude-code-local` (or `codex-local`), then comment here, or run `sgt task wake`, so Sergeant tries again.",
  ]);
  const { runIds } = JSON.parse(await readFile(join(t.dir, "state.json"), "utf8")) as { runIds: string[] };
  expect(runIds).toEqual([]);
});

test("a run on the owner's only usable account below the 5-hour floor goes ahead, and the owner is warned", async () => {
  const lowQuota = { accountId: "person:user-ann:codex-local", adapter: "codex-local", fiveHourPercent: 12.34, resetsAt: "2026-10-04T15:00:00.000Z" };
  const t = await task(() => ({ owner: ann }), async () => ({ lowQuota }));
  await t.loop();
  expect(t.starts).toHaveLength(1);
  expect(t.seen.comments.map((c) => c.body)).toEqual([
    "Heads up, Ann: Sergeant is running this task on `person:user-ann:codex-local`, your only usable model account, with 12.3% of its 5-hour window left until it resets at 2026-10-04T15:00:00.000Z, so runs may stop short. Registering another account (`sgt account register <claude-code-local|codex-local>`) gives Sergeant one to switch to.",
  ]);
});
