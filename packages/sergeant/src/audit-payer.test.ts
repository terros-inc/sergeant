import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { PullRequestFacts } from "@terros/sergeant-contracts";
import { type PayerDeps, prOwner } from "./audit-payer.ts";

// TECH-6625: a reopened issue keeps one state file per episode, each with its own owner. The owner of a
// Sergeant PR must be the episode that merged it whatever order the directory lists the files in, or an
// audit spends an earlier or later owner's accounts.

const order = vi.hoisted(() => ({ reversed: false }));
vi.mock("node:fs/promises", async (actual) => {
  const fs = await actual<typeof import("node:fs/promises")>();
  const readdir = async (dir: string) => {
    const names = (await fs.readdir(dir)).sort();
    return order.reversed ? names.reverse() : names;
  };
  return { ...fs, readdir };
});

const repo = "o/r";
const sha = (n: number) => n.toString(16).padStart(40, "0");
const pr = { repo, number: 7, author: "sergeant-worker[bot]" } as PullRequestFacts;
const deps = { workerLogin: "sergeant-worker[bot]" } as PayerDeps;
const merge = (number: number, at: string) => ({ repo, number, headSha: sha(number), mergedSha: sha(100 + number), at });
const passed = (number: number, since: string) => ({ repo, number, headSha: sha(number), since, checks: ["v2"] });

/** Writes each episode's state file, by file name, with its owner and the PR records given. */
async function episodes(files: Record<string, { owner: string; merged?: object; reopened?: object[]; passedChecks?: object[] }>) {
  const stateDir = await mkdtemp(join(tmpdir(), "sergeant-audit-payer-"));
  const dir = join(stateDir, "tasks", "UNF-9");
  await mkdir(dir, { recursive: true });
  for (const [f, { owner, ...rest }] of Object.entries(files)) {
    const state = { issueId: "UNF-9", startedAt: "2026-10-01T00:00:00.000Z", turns: 1, runIds: [], recentTurns: [], owner: { id: owner, name: owner, admittedAt: "2026-10-01T00:00:00.000Z" }, ...rest };
    await writeFile(join(dir, f), JSON.stringify(state));
  }
  return stateDir;
}

async function ownerInBothOrders(stateDir: string) {
  const seen = [];
  for (const reversed of [false, true]) {
    order.reversed = reversed;
    seen.push(await prOwner(pr, "UNF-9", stateDir, deps));
  }
  return seen;
}

test("the episode that merged the PR is charged over one that only saw its checks pass, in either file order", async () => {
  const stateDir = await episodes({
    "state.completed-2026-10-05T00-00-00-000Z.json": { owner: "ann", merged: merge(7, "2026-10-04T00:00:00.000Z") },
    // The next episode saw PR 7's checks pass later, but merged another PR.
    "state.json": { owner: "bob", merged: merge(8, "2026-10-09T00:00:00.000Z"), passedChecks: [passed(7, "2026-10-08T00:00:00.000Z")] },
  });
  expect(await ownerInBothOrders(stateDir)).toEqual([{ id: "ann", name: "ann" }, { id: "ann", name: "ann" }]);
});

test("among episodes alike, the latest merge or passed check is charged, in either file order", async () => {
  const merges = await episodes({
    "state.completed-2026-10-05T00-00-00-000Z.json": { owner: "ann", merged: merge(8, "2026-10-04T00:00:00.000Z"), reopened: [merge(7, "2026-10-02T00:00:00.000Z")] },
    "state.completed-2026-10-12T00-00-00-000Z.json": { owner: "bob", merged: merge(7, "2026-10-11T00:00:00.000Z") },
    "state.json": { owner: "cy" },
  });
  expect(await ownerInBothOrders(merges)).toEqual([{ id: "bob", name: "bob" }, { id: "bob", name: "bob" }]);

  const checks = await episodes({
    "state.stopped-2026-10-05T00-00-00-000Z.json": { owner: "ann", passedChecks: [passed(7, "2026-10-09T00:00:00.000Z")] },
    "state.stopped-2026-10-03T00-00-00-000Z.json": { owner: "bob", passedChecks: [passed(7, "2026-10-02T00:00:00.000Z")] },
    "state.json": { owner: "cy" },
  });
  expect(await ownerInBothOrders(checks)).toEqual([{ id: "ann", name: "ann" }, { id: "ann", name: "ann" }]);
});

test("with no episode naming the PR, the current episode's owner is charged", async () => {
  const stateDir = await episodes({
    "state.completed-2026-10-05T00-00-00-000Z.json": { owner: "ann", merged: merge(8, "2026-10-04T00:00:00.000Z") },
    "state.json": { owner: "bob" },
  });
  expect(await ownerInBothOrders(stateDir)).toEqual([{ id: "bob", name: "bob" }, { id: "bob", name: "bob" }]);
});
