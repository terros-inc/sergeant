import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, dir, fakes, issue, start, underway } from "./slots-scenario.ts";

// TECH-5015: a task waiting, on a human, on CI, on a refused merge, or on a budget answer, must not keep
// its slot past the grace, nor lose it when the human answers within it.

afterEach(cleanup);

test("a task answered within the grace keeps its slot and continues without queueing", async () => {
  const f = fakes([issue("ASKS", "In Progress", 2, "2026-10-01T00:00:00.000Z"), issue("NEWER", "Todo", 1, "2026-10-03T00:00:00.000Z")]);
  f.asking.add("ASKS");
  const logs: string[] = [];
  // A grace of 1.2 seconds: the human answers well within it, and the test outlasts it.
  await start(f.deps, { maxTasks: 1, waitingGraceMinutes: 0.02 }, logs);
  await f.finish("ASKS");
  await vi.waitFor(() => expect(logs).toContainEqual(expect.stringContaining("ASKS: waiting: the question posted at")), { timeout: 5_000 });
  await sleep(100);
  expect(f.turns).toEqual(["ASKS"]);

  f.answer("ASKS");
  await vi.waitFor(() => expect(f.turns).toEqual(["ASKS", "ASKS"]), { timeout: 5_000 });
  // Its wait ended with the answer: the grace running out during its next turn frees nothing.
  await sleep(1_500);
  expect(f.turns).toEqual(["ASKS", "ASKS"]);
  expect(logs.filter((l) => l.startsWith("ASKS:") && /queued|past the grace/.test(l))).toEqual([]);
});

test("a task waiting past the grace frees its slot, and once answered is readmitted in order", async () => {
  const f = fakes([issue("ASKS", "In Progress", 2, "2026-10-01T00:00:00.000Z"), issue("NEWER", "Todo", 1, "2026-10-03T00:00:00.000Z")]);
  f.asking.add("ASKS");
  const logs: string[] = [];
  await start(f.deps, { maxTasks: 1, waitingGraceMinutes: 0 }, logs);
  await f.finish("ASKS");
  // Past the grace, the slot goes to the next task while the question stays unanswered.
  await vi.waitFor(() => expect(f.turns).toEqual(["ASKS", "NEWER"]), { timeout: 5_000 });
  expect(logs).toContainEqual("ASKS: waiting past the grace; its task slot is free until it has work again");

  // Answered while the slot is taken, the task queues; an In Review issue delegated meanwhile is ahead of it.
  f.answer("ASKS");
  await vi.waitFor(() => expect(logs).toContainEqual("ASKS: queued: waiting for a free task slot"), { timeout: 5_000 });
  await underway("REVIEW");
  f.delegated.push(issue("REVIEW", "In Review", 0, "2026-09-01T00:00:00.000Z"));
  await sleep(100);
  await f.finish("NEWER");
  await vi.waitFor(() => expect(f.turns).toEqual(["ASKS", "NEWER", "REVIEW"]), { timeout: 5_000 });
  await sleep(100);
  expect(f.turns).toHaveLength(3);
  await f.finish("REVIEW");
  await vi.waitFor(() => expect(f.turns).toEqual(["ASKS", "NEWER", "REVIEW", "ASKS"]), { timeout: 5_000 });
  expect(logs).toContainEqual("ASKS: has work again; admitted to a task slot");
  await f.finish("ASKS");
});

test("a task waiting on CI past the grace frees its slot quietly, and is readmitted ahead of new Todo work", async () => {
  const f = fakes([issue("WAITS", "In Progress", 3, "2026-09-01T00:00:00.000Z"), issue("TODO-OLD", "Todo", 3, "2026-10-01T00:00:00.000Z")], "WAITS");
  const logs: string[] = [];
  // No idle end: the wait on CI outlasts the grace.
  await start(f.deps, { maxTasks: 1, waitingGraceMinutes: 0, idleMinutes: 60 }, logs);
  await f.finish("WAITS");
  // CI stays pending: past the grace, the slot goes to the next task with nothing said in Linear.
  await vi.waitFor(() => expect(f.turns).toEqual(["WAITS", "TODO-OLD"]), { timeout: 5_000 });
  expect(logs).toContainEqual("WAITS: waiting past the grace; its task slot is free until it has work again");
  expect(f.posted).toEqual([]);

  // CI finishes while the slot is taken: the task queues, and goes ahead of an urgent Todo delegated meanwhile.
  f.ci.state = "passed";
  await vi.waitFor(() => expect(logs).toContainEqual("WAITS: queued: waiting for a free task slot"), { timeout: 5_000 });
  f.delegated.push(issue("TODO-URGENT", "Todo", 1, "2026-10-03T00:00:00.000Z"));
  await sleep(100);
  await f.finish("TODO-OLD");
  await vi.waitFor(() => expect(f.turns).toEqual(["WAITS", "TODO-OLD", "WAITS"]), { timeout: 5_000 });
  await f.finish("WAITS");
  await vi.waitFor(() => expect(f.turns).toEqual(["WAITS", "TODO-OLD", "WAITS", "TODO-URGENT"]), { timeout: 5_000 });
  expect(f.posted).toEqual([]);
});
test.each([
  ["a merge refused by GitHub", "refused"],
  ["human-requested changes", "changes"],
] as const)("%s is a quiet wait that releases its slot past the grace", async (_, kind) => {
  const f = fakes([
    issue("WAITS", "In Progress", 2, "2026-10-01T00:00:00.000Z"),
    issue("NEXT", "Todo", 1, "2026-10-03T00:00:00.000Z"),
  ], "WAITS");
  f.ci.state = "passed";
  const head = "a".repeat(40);
  if (kind === "changes") {
    f.feedback.push({ id: "review:1", kind: "review", author: "captain", state: "CHANGES_REQUESTED", body: "Please revise.", path: null, line: null, commitId: head, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), url: "https://github.com/o/r/pull/1#pullrequestreview-1" });
  }
  const logs: string[] = [];
  await start(f.deps, { maxTasks: 1, waitingGraceMinutes: 0, idleMinutes: 60 }, logs, async () => {
    if (kind !== "refused") return;
    const saved = JSON.parse(await readFile(join(dir, "tasks", "WAITS", "state.json"), "utf8"));
    saved.refusedMerges = [{
      repo: "o/r", number: 1, url: "https://github.com/o/r/pull/1", headSha: head,
      conversationRevision: "0".repeat(64), reason: "repository policy requires a human", at: new Date().toISOString(), commentPostedAt: new Date().toISOString(),
    }];
    await writeFile(join(dir, "tasks", "WAITS", "state.json"), JSON.stringify(saved));
  });
  await f.finish("WAITS");
  await vi.waitFor(() => expect(logs).toContainEqual("WAITS: waiting: nothing changed since the last turn"), { timeout: 5_000 });
  await vi.waitFor(() => expect(logs).toContainEqual("WAITS: waiting past the grace; its task slot is free until it has work again"), { timeout: 5_000 });
  await vi.waitFor(() => expect(f.turns).toEqual(["WAITS", "NEXT"]), { timeout: 5_000 });
  expect(logs.some((line) => line.includes("WAITS: loop ended idle"))).toBe(false);
});

test("an unanswered budget question releases its slot and is never ended by the idle guard", async () => {
  const f = fakes([
    issue("BUDGET", "In Progress", 2, "2026-10-01T00:00:00.000Z"),
    issue("NEXT", "Todo", 1, "2026-10-03T00:00:00.000Z"),
  ]);
  const logs: string[] = [];
  await start(f.deps, { maxTasks: 1, waitingGraceMinutes: 0, idleMinutes: 0 }, logs, async () => {
    const startedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    await writeFile(join(dir, "tasks", "BUDGET", "state.json"), JSON.stringify({
      issueId: "BUDGET",
      startedAt,
      turns: 0,
      runIds: [],
      recentTurns: [],
      budget: { window: { wallMinutes: 1, costUsd: 25 }, grants: [] },
    }));
  });
  await vi.waitFor(() => expect(f.turns).toEqual(["NEXT"]), { timeout: 5_000 });
  expect(f.posted.join("\n")).toContain("budget is exhausted");
  expect(logs).toContainEqual("BUDGET: waiting past the grace; its task slot is free until it has work again");
  expect(logs.some((line) => line.includes("BUDGET: loop ended idle"))).toBe(false);
});

// TECH-5104: after the merge the loop polls Linear for Done for up to `completionWaitMinutes` (10). It
// waits on no question, so it keeps its slot only for the grace from the merge, like any other wait.
const mergedTwoMinutesAgo = async () => {
  const at = new Date(Date.now() - 2 * 60_000).toISOString();
  await mkdir(join(dir, "tasks", "MERGED"), { recursive: true });
  await writeFile(join(dir, "tasks", "MERGED", "state.json"), JSON.stringify({
    issueId: "MERGED",
    startedAt: at,
    turns: 1,
    runIds: [],
    recentTurns: [],
    budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] },
    merged: { repo: "o/r", number: 1, headSha: "a".repeat(40), mergedSha: "b".repeat(40), at, outcome: "Merged.", auditDrawnAt: at },
  }));
};

test("the post-merge Done poll frees its slot once a grace shorter than the poll has passed", async () => {
  const f = fakes([issue("MERGED", "In Progress", 1, "2026-09-01T00:00:00.000Z"), issue("NEXT", "Todo", 3, "2026-10-03T00:00:00.000Z")]);
  const logs: string[] = [];
  // A one-minute grace, below the ten-minute Done poll, already past two minutes after the merge.
  await start(f.deps, { maxTasks: 1, waitingGraceMinutes: 1 }, logs, mergedTwoMinutesAgo);
  // Posting the outcome is work, done in the slot; the Done poll that follows gives the slot back.
  await vi.waitFor(() => expect(f.posted.join("\n")).toContain("Merged."), { timeout: 5_000 });
  await vi.waitFor(() => expect(f.turns).toEqual(["NEXT"]), { timeout: 5_000 });
  expect(logs).toContainEqual("MERGED: waiting past the grace; its task slot is free until it has work again");
  expect(logs.some((l) => l.startsWith("MERGED: loop ended"))).toBe(false);

  // The poll still sees Done and ends the task.
  f.complete("MERGED");
  await vi.waitFor(() => expect(logs.some((l) => l.startsWith("MERGED: loop ended done"))).toBe(true), { timeout: 5_000 });
});

test("with the default grace the post-merge Done poll keeps its slot until the issue is Done", async () => {
  const f = fakes([issue("MERGED", "In Progress", 1, "2026-09-01T00:00:00.000Z"), issue("NEXT", "Todo", 3, "2026-10-03T00:00:00.000Z")]);
  const logs: string[] = [];
  await start(f.deps, { maxTasks: 1 }, logs, mergedTwoMinutesAgo);
  await vi.waitFor(() => expect(logs).toContainEqual("MERGED: after merge: MERGED is In Progress"), { timeout: 5_000 });
  await sleep(200);
  // Within the default 15-minute grace, the slot stays with the merged task.
  expect(f.turns).toEqual([]);
  expect(logs.filter((l) => l.startsWith("MERGED: ") && /past the grace/.test(l))).toEqual([]);

  f.complete("MERGED");
  await vi.waitFor(() => expect(logs.some((l) => l.startsWith("MERGED: loop ended done"))).toBe(true), { timeout: 5_000 });
  await vi.waitFor(() => expect(f.turns).toEqual(["NEXT"]), { timeout: 5_000 });
});
