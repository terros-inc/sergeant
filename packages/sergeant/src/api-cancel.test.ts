import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { RunRecord } from "@terros/sergeant-contracts";
import { call, fakes } from "./api-fixtures.ts";
import { startService, type Service, type ServiceDeps, type ServiceOptions } from "./service.ts";

// The client API's cancels (cancel.ts): a run cancel is the runner's, and a task cancel undelegates and
// cancels the task's runs until the runner confirms them, across a restart.

// Tests that wait get 30 s, so a slow CI runner never hits vitest's 5 s default before a 5 s wait ends.

let dir = "";
let service: Service | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await rm(dir, { recursive: true, force: true });
});

const exists = (file: string) => stat(file).then(() => true, () => false);

// Polls only when woken: an unwoken loop would sit out the hour.
const start = async (deps: ServiceDeps, opts: Partial<ServiceOptions> = { trustLoopback: true }) => {
  service = await startService({ enrolledRepositories: ["o/r"], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 3600, port: 0, log: () => {}, ...opts }, deps);
  return service.port ?? 0;
};

test("a run cancel notes it on the issue and cancels through the runner; a task cancel undelegates and cancels the rest", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const running = (runId: string, role: "worker" | "reviewer"): RunRecord => ({ runId, role, status: "running", provider: "p", model: "m", report: null });
  const f = fakes([running("run_w1", "worker"), running("run_r1", "reviewer")]);
  // The worker's PR #7, open and linked to the issue: the task cancel closes it and says so.
  const url = "https://github.com/o/r/pull/7";
  let prState: "open" | "closed" = "open";
  f.conversation.issue.linkedPullRequests = [{ repo: "o/r", number: 7 }];
  f.deps.github.readPullRequest = async (repo, number) => ({
    repo, number, url, author: "sergeant-worker[bot]", state: prState, draft: false, headSha: "a".repeat(40), mergedSha: null, baseRef: "main",
    body: "Fixes UNF-1", mergeable: true, mergeableState: "clean", checks: { sha: "a".repeat(40), required: [] }, humanFeedback: [],
  });
  f.deps.github.closePullRequest = async () => void (prState = "closed");
  // A task already under way: its loop resumes holding two running runs and waits on them.
  await mkdir(join(dir, "tasks", "UNF-1"), { recursive: true });
  const state = { issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds: ["run_w1", "run_r1"], recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 } } };
  await writeFile(join(dir, "tasks", "UNF-1", "state.json"), JSON.stringify(state));
  const port = await start(f.deps);
  await vi.waitFor(async () => expect((await call(port, "GET", "/v1/tasks/UNF-1")).json.task.status).toBe("active"), { timeout: 5_000 });

  expect(await call(port, "POST", "/v1/runs/run_r1/cancel", { reason: "reviewing the wrong head" })).toEqual({
    status: 200,
    json: { runId: "run_r1", task: "UNF-1", status: "canceled" },
  });
  expect(f.comments).toEqual([{ key: "cancel-run:run_r1", body: expect.stringContaining("reviewing the wrong head") }]);

  expect(await call(port, "POST", "/v1/tasks/UNF-1/cancel", {})).toMatchObject({ status: 400, json: { error: { code: "bad_request" } } });
  // Answered only once the runner confirms the task's runs stopped.
  expect(await call(port, "POST", "/v1/tasks/UNF-1/cancel", { reason: "wrong approach", requestId: "req-1" })).toEqual({
    status: 200,
    json: { ref: "UNF-1", undelegated: true, stopping: [], closedPullRequests: [{ repo: "o/r", number: 7, url }] },
  });
  expect(prState).toBe("closed");
  expect(f.conversation.issue.delegate).toBeNull();
  expect(f.canceled).toEqual(["run_r1", "run_w1"]);
  // The loop, polled at once, finds its task undelegated and ends.
  await vi.waitFor(async () => expect((await call(port, "GET", "/v1/tasks/UNF-1")).json.task.status).toBe("stopped"), { timeout: 5_000 });
  expect(f.canceled).toEqual(["run_r1", "run_w1"]);
  expect(f.turns()).toBe(0);

  // Repeating it changes nothing: no second comment.
  expect((await call(port, "POST", "/v1/tasks/UNF-1/cancel", { reason: "wrong approach" })).json).toEqual({ ref: "UNF-1", undelegated: false, stopping: [], closedPullRequests: [] });
  expect(f.comments.map((c) => c.key)).toEqual(["cancel-run:run_r1", "cancel:i-UNF-1:req-1"]);
}, 30_000);

// A task cancel's success must not depend on this process surviving: a restart finds the recorded
// cancel and finishes it, though the issue is no longer delegated and intake would never admit it,
// and keeps at it while the runner cannot confirm a run stopped.
test.each([
  ["after the cancel was recorded", { delegated: true, recorded: {} }],
  ["after the delegation was removed", { delegated: false, recorded: { runIds: ["run_w1", "run_lost"] } }],
])("a restart %s still cancels the task's live and unknown runs", async (_, { delegated, recorded }) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const f = fakes([{ runId: "run_w1", role: "worker", status: "running", provider: "p", model: "m", report: null }]);
  if (!delegated) f.conversation.issue.delegate = null;
  // Sergeant moved it to In Progress when it started: once stopped, it is not started again.
  Object.assign(f.conversation.issue, { state: "In Progress", stateType: "started" });
  // The runner cannot confirm the first cancel of each run.
  const cancel = f.deps.runner.cancel;
  const refused = new Set<string>();
  f.deps.runner.cancel = async (runId) => {
    if (!refused.has(runId)) {
      refused.add(runId);
      throw new Error("docker stop timed out");
    }
    await cancel(runId);
  };
  const task = join(dir, "tasks", "UNF-1");
  await mkdir(task, { recursive: true });
  // `run_lost` was saved before its start was confirmed: the runner does not know it, so it is unknown.
  const state = { issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds: ["run_w1", "run_lost"], unconfirmedStarts: ["run_lost"], recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 } } };
  await writeFile(join(task, "state.json"), JSON.stringify(state));
  await writeFile(join(task, "cancel.json"), JSON.stringify({ reason: "wrong approach", requestId: "req-1", at: new Date().toISOString(), ...recorded }));

  await start(f.deps);
  await vi.waitFor(async () => expect(await exists(join(task, "cancel.json"))).toBe(false), { timeout: 5_000 });
  expect(f.canceled.sort()).toEqual(["run_lost", "run_w1"]);
  // Said once the runs are stopped, under the cancel's key: a cancel recorded before the restart
  // that had already said it posts nothing new.
  expect(f.comments.map((c) => c.key)).toEqual(["cancel:i-UNF-1:req-1"]);
  expect(f.turns()).toBe(0);
}, 30_000);

// A start already past its delegation check when a task cancel begins must not escape it: the
// cancel waits for that start and stops its run, so nothing is left running across a restart.
test("a task cancel stops a run whose start had already passed the delegation check", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const runs: RunRecord[] = [];
  const f = fakes(runs);
  f.deps.runner.start = async (spec) => void runs.push({ runId: spec.runId, role: spec.role, status: "running", provider: "p", model: "m", report: null });
  let proposed = false;
  f.deps.reasoner.turn = async () => {
    const actions = proposed ? [] : [{ kind: "start_worker" as const, objective: "Do UNF-1.", repositories: ["o/r"] }];
    proposed = true;
    return { output: { summary: "start a worker", actions }, model: "m", promptVersion: "p" };
  };
  // The start's live read (by the issue's id) still sees the delegation, then is held until released.
  let release = () => {};
  let paused = false;
  const read = f.deps.linear.readConversation;
  f.deps.linear.readConversation = async (id) => {
    if (id !== "i-UNF-1") return read(id);
    const seen = structuredClone(f.conversation);
    paused = true;
    await new Promise<void>((resolve) => (release = resolve));
    return seen;
  };
  const port = await start(f.deps);
  await vi.waitFor(() => expect(paused).toBe(true), { timeout: 5_000 });

  const canceling = call(port, "POST", "/v1/tasks/UNF-1/cancel", { reason: "wrong approach" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  expect((await canceling).json).toEqual({ ref: "UNF-1", undelegated: true, stopping: [], closedPullRequests: [] });
  expect(runs).toEqual([expect.objectContaining({ status: "canceled" })]);

  await service?.stop();
  await start(f.deps);
  expect(await exists(join(dir, "tasks", "UNF-1", "cancel.json"))).toBe(false);
  expect(runs).toEqual([expect.objectContaining({ status: "canceled" })]);
}, 30_000);

