import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { DEFAULT_BUDGET } from "./budget.ts";
import { loadState } from "./task-state.ts";

// TECH-5163: a key this release does not know is a newer release's, and must survive a rollback to it.
// TECH-5136's `state.accepted` was dropped this way by older code, which saved `state.json` without it,
// so a task caught mid accepted-ending, its accepting turn's fingerprint committed, sat idle for good.

let dir: string | undefined;
afterEach(() => dir && rm(dir, { recursive: true, force: true }));

test("a task's state keeps the keys a newer release saved, and the loop's save writes them back", async () => {
  dir = await mkdtemp(join(tmpdir(), "task-state-"));
  const file = join(dir, "state.json");
  const at = "2026-10-01T00:00:00.000Z";
  const sha = "a".repeat(40);
  const stored = {
    issueId: "i1",
    startedAt: at,
    turns: 3,
    lastFingerprint: "fp",
    runIds: [],
    recentTurns: [],
    budget: { window: DEFAULT_BUDGET, newerBudgetKey: 1 },
    merged: { repo: "terros-inc/sergeant", number: 1, headSha: sha, mergedSha: sha, at, newerMergedKey: true },
    accepted: { at, comment: "Sergeant has stopped.", newerAcceptedKey: "x" },
    newerEnding: { at, replyId: "c1" },
  };
  await writeFile(file, JSON.stringify(stored));

  const state = await loadState(file, "i1", DEFAULT_BUDGET);
  // What the loop's save writes (loop.ts).
  const written = JSON.parse(JSON.stringify(state)) as typeof stored;

  expect(written.newerEnding).toEqual(stored.newerEnding);
  expect(written.budget.newerBudgetKey).toBe(1);
  expect(written.merged.newerMergedKey).toBe(true);
  expect(written.accepted.newerAcceptedKey).toBe("x");
});
