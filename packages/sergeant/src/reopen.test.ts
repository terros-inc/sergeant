import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { TaskOwnerCheck } from "@terros/sergeant-contracts";
import { startService } from "./service.ts";
import { fakes, issue, repo } from "./stop-fixtures.ts";

// TECH-5182: an issue whose task was merged and seen through, moved back to Todo and delegated again,
// is a new episode (07 §9). Intake sets the completed `state.json` aside, kept beside it, and the new
// task is admitted afresh: the TECH-5179 owner/delegator check runs again on Linear's latest delegation,
// and the budget window starts now. Intake polls Linear, so this needs no webhook. A task still under
// way, merged or not, is never set aside.

const ann = { id: "user-ann", name: "Ann" };
const bob = { id: "user-bob", name: "Bob" };
const merged = { repo, number: 7, headSha: "a".repeat(40), mergedSha: "b".repeat(40), at: "2026-10-03T00:00:00.000Z" };
// Long past its wall-clock budget and over its cost budget: reused, it could start nothing.
const spent = { issueId: "UNF-1", startedAt: "2026-10-02T00:00:00.000Z", turns: 3, turnCostUsd: 30, runIds: [], recentTurns: [], owner: { ...ann, admittedAt: "2026-10-02T00:00:00.000Z" } };

async function reopened(saved: object, check: () => TaskOwnerCheck) {
  const stateDir = await mkdtemp(join(tmpdir(), "sergeant-reopen-test-"));
  const dir = join(stateDir, "tasks", "UNF-1");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify(saved));
  const live = { conversation: issue("unstarted", "Todo") };
  const { deps, seen } = fakes(live);
  let checks = 0;
  deps.linear.readTaskOwner = async () => (checks++, check());
  let intakes = 0;
  const listed = deps.delegatedIssues;
  deps.delegatedIssues = () => (intakes++, listed());
  const owners: string[] = [];
  const start = deps.runner.start;
  deps.runner.start = async (spec) => (owners.push(spec.owner.id), start(spec));
  const lines: string[] = [];
  const service = await startService({ enrolledRepositories: [repo], stateDir, intakeSeconds: 0.01, pollSeconds: 0.01, port: 0, log: (l) => void lines.push(l) }, deps);
  const state = async () => JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as Record<string, unknown>;
  return { live, seen, dir, service, owners, lines, state, checks: () => checks, intakes: () => intakes };
}

test("a reopen after the merge is a new episode: the owner is checked again and the budget starts afresh", async () => {
  const t = await reopened({ ...spent, merged: { ...merged, completedAt: "2026-10-03T01:00:00.000Z" } }, () => ({ owner: bob, delegatedAt: "2026-10-04T06:00:00.000Z" }));
  t.live.conversation.issue.assignee = bob;
  await vi.waitFor(() => expect(t.owners).toEqual([bob.id]), { timeout: 5_000 });
  await t.service.stop();

  expect(t.checks()).toBeGreaterThanOrEqual(1);
  const now = await t.state();
  expect(now).toMatchObject({ owner: { ...bob, delegatedAt: "2026-10-04T06:00:00.000Z" }, turnCostUsd: 0, budget: { window: { wallMinutes: 120, costUsd: 25 } } });
  expect(Date.parse(now.startedAt as string)).toBeGreaterThan(Date.parse("2026-10-04T00:00:00.000Z"));
  expect(now.merged).toBeUndefined();
  // The old episode is kept, untouched, beside the new one.
  const old = JSON.parse(await readFile(join(t.dir, "state.completed-2026-10-03T01-00-00-000Z.json"), "utf8")) as unknown;
  expect(old).toMatchObject({ ...spent, merged: { completedAt: "2026-10-03T01:00:00.000Z" } });
  expect(t.lines).toContain("UNF-1: reopened after its task was seen through: a new task");
});

test("a reopen delegated by someone other than the assignee is refused once, however often intake polls", async () => {
  const t = await reopened({ ...spent, merged: { ...merged, completedAt: "2026-10-03T01:00:00.000Z" } }, () => ({
    refused: "delegator_differs",
    assignee: bob,
    delegator: ann,
    delegatedAt: "2026-10-04T06:00:00.000Z",
  }));
  t.live.conversation.issue.assignee = bob;
  await vi.waitFor(() => expect(t.checks()).toBeGreaterThanOrEqual(3), { timeout: 5_000 });
  await t.service.stop();

  expect(t.owners).toEqual([]);
  expect(t.seen.turns).toBe(0);
  expect(t.seen.comments.map((c) => c.body)).toEqual([
    "Sergeant cannot spend Bob's model quota because Ann delegated the issue. If you want Sergeant to run this work, assign the issue to yourself first, then delegate it to Sergeant; or have Bob delegate it themselves.",
  ]);
  // The completed task is not resumed for Ann either: it is set aside, and nothing new is on disk.
  expect(existsSync(join(t.dir, "state.json"))).toBe(false);
  expect(existsSync(join(t.dir, "state.completed-2026-10-03T01-00-00-000Z.json"))).toBe(true);
});

test.each([
  ["under way", {}],
  ["merged, not yet seen through", { merged }],
])("a task %s in Todo keeps its state, owner, and budget", async (_, extra) => {
  const saved = { ...spent, startedAt: new Date().toISOString(), turnCostUsd: 0, ...extra };
  const t = await reopened(saved, () => ({ owner: ann }));
  await vi.waitFor(() => expect(t.intakes()).toBeGreaterThanOrEqual(3), { timeout: 5_000 });
  await t.service.stop();

  expect(await t.state()).toMatchObject({ startedAt: saved.startedAt, owner: saved.owner, ...extra });
  expect((await readdir(t.dir)).filter((f) => f.startsWith("state.") && f !== "state.json")).toEqual([]);
  expect(t.owners.every((id) => id === ann.id)).toBe(true);
  expect(t.lines.some((l) => l.includes("reopened"))).toBe(false);
});
