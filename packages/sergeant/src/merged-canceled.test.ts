import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { TaskState } from "./task-state.ts";
import { cleanup, dir, fakes, start } from "./slots-scenario.ts";

// TECH-5132: intake resumes a merged task until it is seen through. Canceled after the merge is
// terminal like Done, so the task is seen through and resumed no more; reopened and delegated again it
// is a new task (TECH-5182, reopen.test.ts). Any other state keeps it resumed, so a later move to Done
// is still seen.

afterEach(cleanup);

test.each([
  ["Canceled", "canceled", true],
  ["In Review", "started", false],
  ["Done", "completed", true],
])("a merged task whose issue is %s (%s) after the merge is seen through: %s", async (state, stateType, seenThrough) => {
  const f = fakes([]);
  const reads = vi.fn();
  const read = f.deps.linear.readConversation;
  f.deps.linear.readConversation = async (id) => {
    const c = await read(id);
    if (id !== "MERGED") return c;
    reads();
    return { ...c, issue: { ...c.issue, state, stateType } };
  };
  let intakes = 0;
  f.deps.delegatedIssues = async () => (intakes++, []);
  const logs: string[] = [];
  // Its completion wait long over, with nothing left to post or draw.
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const file = () => join(dir, "tasks", "MERGED", "state.json");
  await start(f.deps, { maxTasks: 1, intakeSeconds: 0.02 }, logs, async () => {
    await mkdir(join(dir, "tasks", "MERGED"), { recursive: true });
    await writeFile(file(), JSON.stringify({
      issueId: "MERGED",
      startedAt: at,
      turns: 1,
      runIds: [],
      recentTurns: [],
      budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] },
      merged: { repo: "o/r", number: 1, headSha: "a".repeat(40), mergedSha: "b".repeat(40), at, outcome: "Merged.", outcomePostedAt: at, auditDrawnAt: at },
    }));
  });
  await vi.waitFor(() => expect(logs.some((l) => l.startsWith("MERGED: loop ended"))).toBe(true), { timeout: 5_000 });
  await vi.waitFor(() => expect(intakes).toBeGreaterThan(1), { timeout: 5_000 });
  const ended = reads.mock.calls.length;
  const after = intakes;
  await vi.waitFor(() => expect(intakes).toBeGreaterThan(after + 3), { timeout: 5_000 });

  const saved = JSON.parse(await readFile(file(), "utf8")) as TaskState;
  expect(logs).toContainEqual(expect.stringMatching(`^MERGED: loop ended ${stateType === "completed" ? "done" : "merged_not_done"}: .* MERGED is ${state}$`));
  expect(f.posted).toEqual([]);
  if (seenThrough) {
    expect(saved.merged?.completedAt).toBeTypeOf("string");
    expect(reads.mock.calls.length).toBe(ended);
  } else {
    expect(saved.merged?.completedAt).toBeUndefined();
    expect(reads.mock.calls.length).toBeGreaterThan(ended);
  }
});
