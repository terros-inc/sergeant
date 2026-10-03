import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { Conversation, RunRecord } from "@terros/sergeant-contracts";
import { driveCancel, taskDir } from "./cancel.ts";
import { runLoop } from "./loop.ts";
import { startService, type ServiceDeps } from "./service.ts";
import { fakes, head, issue, pr, repo, state } from "./stop-fixtures.ts";

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

test("a stop the loop could not finish and serve's intake finished is said once on the issue", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  await writeFile(join(dir, "state.json"), state(["run_w1"]));
  const live = { conversation: issue("backlog", "Backlog") };
  const { deps, seen } = fakes(live);
  // The runner refuses the loop's cancels; intake's drive, under the same task lock, goes through.
  let chain: Promise<unknown> = Promise.resolve();
  deps.exclusive = <T>(step: () => Promise<T>) => {
    const next = chain.then(step);
    chain = next.catch(() => {});
    return next;
  };
  let intake = false;
  let refusals = 0;
  const cancel = deps.runner.cancel;
  deps.runner.cancel = async (id) => (intake ? cancel(id) : (refusals++, Promise.reject(new Error("docker stop timed out"))));
  const loop = runLoop({ issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0.02, log: () => {} }, deps);
  await vi.waitFor(() => expect(refusals).toBeGreaterThan(0));
  await deps.exclusive(async () => {
    intake = true;
    return driveCancel(dir, "UNF-1", deps, [repo], () => {}).finally(() => (intake = false));
  });
  // The loop, still seeing Backlog, takes the stop as done rather than stopping the task again.
  expect(await loop).toMatchObject({ outcome: "stopped" });
  expect(seen.closed).toEqual([{ number: 7, comment: "Closed: the Linear issue was canceled or moved to Backlog." }]);
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.stringContaining(`moved to Backlog. Its runs are canceled. Closed [${repo}#7]`) }]);
  const files = await readdir(dir);
  expect(files).not.toContain("state.json");
  expect(files).not.toContain("cancel.json");
  expect(files.filter((f) => f.startsWith("state.stopped-"))).toHaveLength(1);
});

/** The next intake of UNF-1, back in Todo: it starts a fresh task, with nothing of the stopped one's. */
async function intakeStartsFresh(deps: ServiceDeps, seen: { starts: number }, live: { conversation: Conversation }) {
  live.conversation = issue("unstarted", "Todo");
  const service = await startService({ enrolledRepositories: [repo], stateDir: dir, intakeSeconds: 3600, pollSeconds: 3600, log: () => {} }, deps);
  try {
    await vi.waitFor(() => expect(seen.starts).toBe(1), { timeout: 5_000 });
  } finally {
    await service.stop();
  }
  const fresh = JSON.parse(await readFile(join(taskDir(dir, "UNF-1"), "state.json"), "utf8")) as { runIds: string[]; turns: number };
  expect(fresh.turns).toBe(1);
  expect(fresh.runIds).toHaveLength(1);
  expect(fresh.runIds).not.toContain("run_w1");
}

// The loop records a stop by state, and the human moves the issue back before it is done. The old task
// must not continue: its runs and budget are the stopped task's, and its state.json is set aside, so a
// run it started would have no id on disk for any later cancel or restart to find (UNF-728).
test.each([["Todo", "unstarted"], ["In Progress", "started"]])(
  "an issue moved back to %s while its stop is still pending only finishes the stop, and intake then starts a fresh task",
  async (name, stateType) => {
    dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
    const task = taskDir(dir, "UNF-1");
    await mkdir(task, { recursive: true });
    await writeFile(join(task, "state.json"), state(["run_w1"]));
    const live = { conversation: issue("backlog", "Backlog") };
    const { deps, seen } = fakes(live);
    // The runner refuses every cancel until the issue is back, and a few polls after.
    let refuse = true;
    let refusals = 0;
    const cancel = deps.runner.cancel;
    deps.runner.cancel = async (id) => (refuse ? (refusals++, Promise.reject(new Error("docker stop timed out"))) : cancel(id));
    const loop = runLoop({ issueId: "UNF-1", enrolledRepositories: [repo], dir: task, pollSeconds: 0.01, log: () => {} }, deps);
    await vi.waitFor(() => expect(refusals).toBeGreaterThan(0));
    live.conversation = issue(stateType, name);
    const seenBack = refusals;
    await vi.waitFor(() => expect(refusals).toBeGreaterThan(seenBack + 2));
    refuse = false;
    expect(await loop).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("Backlog") });
    expect(seen).toMatchObject({ turns: 0, starts: 0 });
    expect(seen.closed).toEqual([{ number: 7, comment: "Closed: the Linear issue was canceled or moved to Backlog." }]);
    expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.stringContaining("moved to Backlog") }]);
    expect(await readdir(task)).not.toContain("state.json");
    await intakeStartsFresh(deps, seen, live);
    expect(seen.closed).toHaveLength(1);
    expect(seen.comments).toHaveLength(1);
  },
);

test.each([["Todo", "unstarted"], ["In Progress", "started"]])(
  "an issue moved back to %s after intake finished the loop's stop ends the old loop, and intake then starts a fresh task",
  async (name, stateType) => {
    dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
    const task = taskDir(dir, "UNF-1");
    await mkdir(task, { recursive: true });
    await writeFile(join(task, "state.json"), state(["run_w1"]));
    const live = { conversation: issue("backlog", "Backlog") };
    const { deps, seen } = fakes(live);
    // The runner refuses the loop's cancels; intake's drive, under the same task lock, goes through, and
    // the human moves the issue back before the loop's next poll.
    let chain: Promise<unknown> = Promise.resolve();
    deps.exclusive = <T>(step: () => Promise<T>) => {
      const next = chain.then(step);
      chain = next.catch(() => {});
      return next;
    };
    let intake = false;
    let refusals = 0;
    const cancel = deps.runner.cancel;
    deps.runner.cancel = async (id) => (intake ? cancel(id) : (refusals++, Promise.reject(new Error("docker stop timed out"))));
    const loop = runLoop({ issueId: "UNF-1", enrolledRepositories: [repo], dir: task, pollSeconds: 0.02, log: () => {} }, deps);
    await vi.waitFor(() => expect(refusals).toBeGreaterThan(0));
    await deps.exclusive(async () => {
      intake = true;
      await driveCancel(task, "UNF-1", deps, [repo], () => {}).finally(() => (intake = false));
      live.conversation = issue(stateType, name);
    });
    expect(await loop).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("Backlog") });
    expect(seen).toMatchObject({ turns: 0, starts: 0 });
    expect(seen.closed).toEqual([{ number: 7, comment: "Closed: the Linear issue was canceled or moved to Backlog." }]);
    expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.stringContaining("moved to Backlog") }]);
    expect(await readdir(task)).not.toContain("state.json");
    await intakeStartsFresh(deps, seen, live);
    expect(seen.closed).toHaveLength(1);
    expect(seen.comments).toHaveLength(1);
  },
);

test.each([
  ["undelegated", (c: Conversation) => void (c.issue.delegate = null), "the Linear issue is no longer delegated to Sergeant"],
  ["moved to Backlog", (c: Conversation) => Object.assign(c.issue, { state: "Backlog", stateType: "backlog" }), "the Linear issue was canceled or moved to Backlog"],
])("a local task %s with no loop resumes at intake, though Linear no longer lists it as new work, and stops the same way", async (_, change, reason) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  const task = taskDir(dir, "UNF-1");
  await mkdir(task, { recursive: true });
  await writeFile(join(task, "state.json"), state(["run_w1"]));
  const live = { conversation: issue("started", "In Progress") };
  change(live.conversation);
  const { deps, seen } = fakes(live);
  if (!live.conversation.issue.delegate) deps.delegatedIssues = async () => [];
  const service = await startService({ enrolledRepositories: [repo], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 3600, maxTasks: 0, log: () => {} }, deps);
  try {
    // No task slot is free: a stop does not need one.
    await vi.waitFor(() => expect(seen.comments).toHaveLength(1), { timeout: 5_000 });
    await sleep(50);
  } finally {
    await service.stop();
  }
  expect(seen.turns).toBe(0);
  expect(seen.canceled).toEqual(["run_w1"]);
  expect(seen.closed).toEqual([{ number: 7, comment: `Closed: ${reason}.` }]);
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.stringContaining(`${reason}. Its runs are canceled. Closed [${repo}#7]`) }]);
  expect(await readdir(task)).not.toContain("state.json");
});

// The closing PR merged after the task's loop ended (or before it saved the merge): the issue is Done
// and Linear lists it no more, but the resumed loop sees the merge and completes, and stops nothing.
test("an idle local task whose closing PR merged completes when resumed in Done: no stop, no stop comment, and no resume after", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  const task = taskDir(dir, "UNF-1");
  await mkdir(task, { recursive: true });
  await writeFile(join(task, "state.json"), state(["run_w1"]));
  const live = { conversation: issue("completed", "Done") };
  const { deps, seen } = fakes(live);
  deps.delegatedIssues = async () => [];
  const merged = { ...pr(7), state: "merged" as const, mergedSha: head };
  deps.github.readPullRequest = async () => merged;
  const done: RunRecord = {
    runId: "run_w1", role: "worker", status: "succeeded", provider: "p", model: "m",
    report: { reportVersion: "s2-worker-report/1", outcome: "completed", summary: "", pullRequests: [{ repo, number: 7, headSha: head, url: merged.url, closesIssue: true, review: { required: false, reason: "" } }], knownGaps: [], followups: [] },
  };
  deps.runner.status = async () => done;
  let reads = 0;
  const read = deps.linear.readConversation;
  deps.linear.readConversation = async (ref) => (reads++, read(ref));
  const service = await startService({ enrolledRepositories: [repo], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 0, maxTasks: 0, auditSampleRate: 0, log: () => {} }, deps);
  try {
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(task, "state.json"), "utf8"))).toMatchObject({ merged: { completedAt: expect.any(String) } }), { timeout: 5_000 });
    const after = reads;
    await sleep(100);
    expect(reads).toBe(after);
  } finally {
    await service.stop();
  }
  expect(seen.closed).toEqual([]);
  expect(seen.canceled).toEqual([]);
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^outcome:i1:/), body: expect.any(String) }]);
});

test("a local task whose Linear read fails holds up neither the other tasks nor new Todo work", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  const gone = taskDir(dir, "UNF-9");
  await mkdir(gone, { recursive: true });
  await writeFile(join(gone, "state.json"), state(["run_w9"]));
  const live = { conversation: issue("unstarted", "Todo") };
  const { deps, seen } = fakes(live);
  const read = deps.linear.readConversation;
  deps.linear.readConversation = async (ref) => (ref === "UNF-9" ? Promise.reject(new Error("Linear issue not found: UNF-9")) : read(ref));
  const service = await startService({ enrolledRepositories: [repo], stateDir: dir, intakeSeconds: 3600, pollSeconds: 3600, log: () => {} }, deps);
  try {
    await vi.waitFor(() => expect(seen.starts).toBe(1), { timeout: 5_000 });
  } finally {
    await service.stop();
  }
  expect(await readdir(gone)).toContain("state.json");
});

test("a task whose stop the runner has not confirmed frees its slot: with maxTasks 1, new Todo work starts", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  const first = taskDir(dir, "UNF-1");
  await mkdir(first, { recursive: true });
  await writeFile(join(first, "state.json"), state([]));
  const live = { conversation: issue("started", "In Progress") };
  const { deps, seen } = fakes(live);
  const second: Conversation = { ...issue("unstarted", "Todo"), issue: { ...issue("unstarted", "Todo").issue, id: "i2", identifier: "UNF-2", linkedPullRequests: [] } };
  const read = deps.linear.readConversation;
  deps.linear.readConversation = async (ref) => (ref === "UNF-2" || ref === "i2" ? structuredClone(second) : read(ref));
  const delegated = deps.delegatedIssues;
  let todo = false;
  deps.delegatedIssues = async () => [
    ...(await delegated()),
    ...(todo ? [{ identifier: "UNF-2", priority: 0, createdAt: "2026-10-02T00:00:00.000Z", state: { name: "Todo", type: "unstarted" }, blockedBy: [] }] : []),
  ];
  const service = await startService({ enrolledRepositories: [repo], stateDir: dir, intakeSeconds: 0.05, pollSeconds: 0.02, maxTasks: 1, log: () => {} }, deps);
  try {
    await vi.waitFor(() => expect(seen.starts).toBe(1), { timeout: 5_000 });
    // The runner never confirms UNF-1's cancel, so its stop stays pending.
    deps.runner.cancel = async () => Promise.reject(new Error("docker stop timed out"));
    Object.assign(live.conversation.issue, { state: "Backlog", stateType: "backlog" });
    todo = true;
    await vi.waitFor(async () => expect(await readdir(first)).toContain("cancel.json"), { timeout: 5_000 });
    await vi.waitFor(() => expect(seen.starts).toBe(2), { timeout: 5_000 });
    expect(await readdir(first)).toContain("cancel.json");
  } finally {
    await service.stop();
  }
});
