import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, dir, fakes, issue, start } from "./slots-scenario.ts";

// TECH-5008, TECH-5015: with more delegated issues than slots, finishing work must beat starting it and
// an older high-priority task must never be starved by newer work; a waiting task, on a human or on CI,
// must not keep its slot past the grace, nor lose it when the human answers within it.

afterEach(cleanup);

test("free slots go to In Review, then In Progress, then Todo; then by priority; then newest first", async () => {
  const f = fakes([
    issue("TODO-URGENT-NEW", "Todo", 1, "2026-10-03T00:00:00.000Z"),
    issue("TODO-NONE", "Todo", 0, "2026-10-02T00:00:00.000Z"),
    issue("PROGRESS-HIGH-OLD", "In Progress", 2, "2026-09-01T00:00:00.000Z"),
    issue("PROGRESS-LOW-NEW", "In Progress", 4, "2026-10-02T00:00:00.000Z"),
    issue("PROGRESS-HIGH-NEW", "In Progress", 2, "2026-09-20T00:00:00.000Z"),
    issue("REVIEW-NONE-OLD", "In Review", 0, "2026-08-01T00:00:00.000Z"),
  ]);
  await start(f.deps, { maxTasks: 3 });
  await vi.waitFor(() => expect(f.turns).toHaveLength(3), { timeout: 5_000 });
  await sleep(100);
  expect(new Set(f.turns)).toEqual(new Set(["REVIEW-NONE-OLD", "PROGRESS-HIGH-NEW", "PROGRESS-HIGH-OLD"]));

  // Each slot that frees goes to the next in order: the low-priority In Progress task before the urgent
  // Todo, and the urgent Todo before the one with no priority, at the next periodic intake.
  for (const [n, id] of ["REVIEW-NONE-OLD", "PROGRESS-HIGH-NEW", "PROGRESS-HIGH-OLD"].entries()) {
    f.complete(id);
    await f.finish(id);
    await vi.waitFor(() => expect(f.turns).toHaveLength(4 + n), { timeout: 5_000 });
  }
  expect(f.turns.slice(3)).toEqual(["PROGRESS-LOW-NEW", "TODO-URGENT-NEW", "TODO-NONE"]);
});

// TECH-5066: a delegated Todo issue blocked by an unfinished Linear issue must not start, nor take a
// slot from work that can start; once its last blocker finishes it starts in its usual place in order.
test("a Todo issue waits while a blocker is unfinished, then is admitted in its usual order", async () => {
  const f = fakes([
    { ...issue("BLOCKED-URGENT", "Todo", 1, "2026-10-03T00:00:00.000Z"), blockedBy: ["TECH-1"] },
    issue("FREE-HIGH", "Todo", 2, "2026-10-01T00:00:00.000Z"),
    issue("LATER-NONE", "Todo", 0, "2026-10-02T00:00:00.000Z"),
  ]);
  const logs: string[] = [];
  await start(f.deps, { maxTasks: 1 }, logs);
  await vi.waitFor(() => expect(f.turns).toEqual(["FREE-HIGH"]), { timeout: 5_000 });
  // Many intakes later it still waits, and says so once.
  await sleep(100);
  expect(logs.filter((l) => l.includes("waiting on blocker"))).toEqual(["BLOCKED-URGENT waiting on blocker TECH-1"]);

  // The blocker is Done: Linear lists it no more among the unfinished ones. The urgent issue now goes
  // ahead of the one with no priority, as if it had never been blocked.
  f.delegated[0] = { ...f.delegated[0]!, blockedBy: [] };
  await sleep(100);
  f.complete("FREE-HIGH");
  await f.finish("FREE-HIGH");
  await vi.waitFor(() => expect(f.turns).toEqual(["FREE-HIGH", "BLOCKED-URGENT"]), { timeout: 5_000 });
  f.complete("BLOCKED-URGENT");
  await f.finish("BLOCKED-URGENT");
  await vi.waitFor(() => expect(f.turns).toEqual(["FREE-HIGH", "BLOCKED-URGENT", "LATER-NONE"]), { timeout: 5_000 });
});
test("a just-ended Todo task is not readmitted until the next periodic intake", async () => {
  const f = fakes([issue("TODO", "Todo", 1, "2026-10-03T00:00:00.000Z")]);
  await start(f.deps, { maxTasks: 1, intakeSeconds: 3_600 });
  await vi.waitFor(() => expect(f.turns).toEqual(["TODO"]), { timeout: 5_000 });

  // It remains listed in Linear, but ending its loop does not trigger an immediate intake that
  // readmits it, ends it again, and repeats without the configured intake delay.
  await f.finish("TODO");
  await sleep(100);
  expect(f.turns).toEqual(["TODO"]);
});

test("post-merge effects wait for a task slot", async () => {
  const f = fakes([issue("HOLDS", "In Progress", 1, "2026-10-03T00:00:00.000Z")]);
  const logs: string[] = [];
  const at = new Date().toISOString();
  await start(f.deps, { maxTasks: 1, intakeSeconds: 3_600 }, logs, async () => {
    await mkdir(join(dir, "tasks", "MERGED"), { recursive: true });
    await writeFile(join(dir, "tasks", "MERGED", "state.json"), JSON.stringify({
      issueId: "MERGED",
      startedAt: at,
      turns: 1,
      runIds: [],
      recentTurns: [],
      budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] },
      merged: { repo: "o/r", number: 1, headSha: "a".repeat(40), mergedSha: "b".repeat(40), at, outcome: "Merged." },
    }));
  });
  await vi.waitFor(() => expect(f.turns).toEqual(["HOLDS"]), { timeout: 5_000 });
  await vi.waitFor(() => expect(logs).toContainEqual("MERGED: queued: waiting for a free task slot"), { timeout: 5_000 });
  expect(f.posted).toEqual([]);

  await f.finish("HOLDS");
  await vi.waitFor(() => expect(logs).toContainEqual("MERGED: has work again; admitted to a task slot"), { timeout: 5_000 });
  await vi.waitFor(() => expect(f.posted.join("\n")).toContain("Merged."), { timeout: 5_000 });
});

test("a merged task with its outcome posted and audit drawn ends without asking for a slot", async () => {
  // TECH-5127: intake resumes a merged task whose issue never reaches Done (canceled after the merge,
  // say) every time. With nothing left to post or draw, it must not queue ahead of fresh work.
  const f = fakes([issue("HOLDS", "In Progress", 1, "2026-10-03T00:00:00.000Z")]);
  const logs: string[] = [];
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await start(f.deps, { maxTasks: 1, intakeSeconds: 3_600 }, logs, async () => {
    await mkdir(join(dir, "tasks", "MERGED"), { recursive: true });
    await writeFile(join(dir, "tasks", "MERGED", "state.json"), JSON.stringify({
      issueId: "MERGED",
      startedAt: at,
      turns: 1,
      runIds: [],
      recentTurns: [],
      budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] },
      merged: { repo: "o/r", number: 1, headSha: "a".repeat(40), mergedSha: "b".repeat(40), at, outcome: "Merged.", outcomePostedAt: at, auditDrawnAt: at },
    }));
  });
  await vi.waitFor(() => expect(f.turns).toEqual(["HOLDS"]), { timeout: 5_000 });
  await vi.waitFor(() => expect(logs.some((l) => l.startsWith("MERGED: loop ended merged_not_done"))).toBe(true), { timeout: 5_000 });
  expect(logs.filter((l) => l.startsWith("MERGED: ") && /queued|admitted/.test(l))).toEqual([]);
  expect(f.posted).toEqual([]);
});
