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

test("a task's state keeps the keys a newer release saved, nested ones included, and the loop's save writes them back", async () => {
  dir = await mkdtemp(join(tmpdir(), "task-state-"));
  const file = join(dir, "state.json");
  const at = "2026-10-01T00:00:00.000Z";
  const sha = "a".repeat(40);
  const refused = {
    repo: "terros-inc/sergeant",
    number: 2,
    url: "https://github.com/terros-inc/sergeant/pull/2",
    headSha: sha,
    conversationRevision: "b".repeat(64),
    reason: "Waiting on code owner review.",
    at,
    fingerprint: "fp",
  };
  // Every object in `state.json` carries a key this release does not know (TECH-5174).
  const stored = {
    issueId: "i1",
    startedAt: at,
    owner: { id: "u1", name: "Owner", admittedAt: at, newer: "owner" },
    turns: 3,
    lastFingerprint: "fp",
    seen: { revision: "c".repeat(64), issue: "rev", newer: "seen" },
    runIds: [],
    followups: [{ key: "k", title: "T", identifier: "TECH-1", url: "https://linear.app/x/issue/TECH-1", newer: "followup" }],
    recentTurns: [{ at, summary: "s", outcomes: [], newer: "turn" }],
    budget: { window: { ...DEFAULT_BUDGET, newer: "window" }, newer: "budget" },
    merged: { repo: "terros-inc/sergeant", number: 1, headSha: sha, mergedSha: sha, at, audit: { runId: "run_1", newer: "audit" }, newer: "merged" },
    accepted: { at, comment: "Sergeant has stopped.", newer: "accepted" },
    refusedMerges: [{ ...refused, newer: "refused" }],
    mergeRetries: [{ ...refused, newer: "retry" }],
    newerEnding: { at, replyId: "c1" },
  };
  await writeFile(file, JSON.stringify(stored));

  const state = await loadState(file, "i1", DEFAULT_BUDGET);
  // What the loop's save writes (loop.ts).
  const written: unknown = JSON.parse(JSON.stringify(state));

  expect(written).toMatchObject(stored);
});
