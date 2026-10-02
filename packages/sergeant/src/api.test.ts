import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Conversation, RunRecord } from "@terros/sergeant-contracts";
import { startService, type Service, type ServiceDeps } from "./service.ts";

// The client API's actions must reach the task through the loop's own paths: a wake ends the loop's
// wait and owes it a turn, a cancel undelegates and cancels the runs until the runner confirms them,
// and a run cancel is the runner's. Without client auth, only a caller on the service's own host may use any of it.

const agent = { id: "agent-v2", name: "Sergeant" };

let dir = "";
let service: Service | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await rm(dir, { recursive: true, force: true });
});

function fakes(runs: RunRecord[] = []) {
  const conversation: Conversation = {
    issue: { id: "i-UNF-1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "Fix the login", description: "D", state: "In Progress", delegate: agent, linkedPullRequests: [] },
    humanComments: [],
    agentComments: [],
  };
  const comments: { key: string; body: string }[] = [];
  const canceled: string[] = [];
  let turns = 0;
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => (conversation.issue.delegate ? ["UNF-1"] : []),
    undelegate: async () => {
      conversation.issue.delegate = null;
    },
    linear: {
      readConversation: async (id) => (id === "UNF-1" ? conversation : Promise.reject(new Error(`no ${id}`))),
      postComment: async ({ key, body }) => void comments.push({ key, body }),
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
    },
    github: { readPullRequest: async () => Promise.reject(new Error("no PRs")), mergePullRequest: async () => Promise.reject(new Error("no PRs")) },
    runner: {
      start: async () => {},
      status: async (runId) => runs.find((r) => r.runId === runId) ?? Promise.reject(new Error(`no ${runId}`)),
      cancel: async (runId) => {
        canceled.push(runId);
        const run = runs.find((r) => r.runId === runId);
        if (run) run.status = "canceled";
      },
    },
    reasoner: {
      async turn() {
        turns++;
        return { output: { summary: `turn ${turns}: nothing to do yet`, actions: [] }, model: "m", promptVersion: "p" };
      },
    },
  };
  return { deps, conversation, comments, canceled, turns: () => turns };
}

const exists = (file: string) => stat(file).then(() => true, () => false);

// Polls only when woken: an unwoken loop would sit out the hour.
const start = async (deps: ServiceDeps) => {
  service = await startService({ enrolledRepositories: ["o/r"], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 3600, port: 0, log: () => {} }, deps);
  return service.port ?? 0;
};

function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...(body !== undefined && { "Content-Type": "application/json" }), ...headers } }, (res) => {
      let text = "";
      res.on("data", (d: Buffer) => (text += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body));
  });
}

test("a wake makes an unchanged task take a turn now, and a task without a delegation cannot be woken", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const f = fakes();
  const port = await start(f.deps);
  await vi.waitFor(() => expect(f.turns()).toBe(1), { timeout: 5_000 });

  expect(await call(port, "POST", "/v1/tasks/UNF-1/wake", { reason: "look again" })).toEqual({ status: 200, json: { ref: "UNF-1", woke: "active" } });
  await vi.waitFor(() => expect(f.turns()).toBe(2), { timeout: 5_000 });
  const { json } = await call(port, "GET", "/v1/tasks");
  expect(json.tasks).toEqual([expect.objectContaining({ ref: "UNF-1", status: "active", turns: 2, lastSummary: "turn 2: nothing to do yet" })]);

  expect(await call(port, "POST", "/v1/tasks/UNF-7/wake", {})).toMatchObject({ status: 409, json: { error: { code: "conflict" } } });
});

test("a run cancel notes it on the issue and cancels through the runner; a task cancel undelegates and cancels the rest", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const running = (runId: string, role: "worker" | "reviewer"): RunRecord => ({ runId, role, status: "running", provider: "p", model: "m", report: null });
  const f = fakes([running("run_w1", "worker"), running("run_r1", "reviewer")]);
  // A task already under way: its loop resumes holding two running runs and waits on them.
  await mkdir(join(dir, "tasks", "UNF-1"), { recursive: true });
  const state = { issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds: ["run_w1", "run_r1"], recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] } };
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
    json: { ref: "UNF-1", undelegated: true, stopping: [] },
  });
  expect(f.conversation.issue.delegate).toBeNull();
  expect(f.canceled).toEqual(["run_r1", "run_w1"]);
  // The loop, polled at once, finds its task undelegated and ends.
  await vi.waitFor(async () => expect((await call(port, "GET", "/v1/tasks/UNF-1")).json.task.status).toBe("stopped"), { timeout: 5_000 });
  expect(f.canceled).toEqual(["run_r1", "run_w1"]);
  expect(f.turns()).toBe(0);
  const { json: runs } = await call(port, "GET", "/v1/runs?task=UNF-1");
  expect(runs.runs.map((r: { runId: string; status: string }) => [r.runId, r.status])).toEqual([["run_w1", "canceled"], ["run_r1", "canceled"]]);

  // Repeating it changes nothing: no second comment.
  expect((await call(port, "POST", "/v1/tasks/UNF-1/cancel", { reason: "wrong approach" })).json).toEqual({ ref: "UNF-1", undelegated: false, stopping: [] });
  expect(f.comments.map((c) => c.key)).toEqual(["cancel-run:run_r1", "cancel:i-UNF-1:req-1"]);
});

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
  const state = { issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds: ["run_w1", "run_lost"], unconfirmedStarts: ["run_lost"], recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] } };
  await writeFile(join(task, "state.json"), JSON.stringify(state));
  await writeFile(join(task, "cancel.json"), JSON.stringify({ reason: "wrong approach", requestId: "req-1", at: new Date().toISOString(), ...recorded }));

  await start(f.deps);
  await vi.waitFor(async () => expect(await exists(join(task, "cancel.json"))).toBe(false), { timeout: 5_000 });
  expect(f.canceled.sort()).toEqual(["run_lost", "run_w1"]);
  expect(f.conversation.issue.delegate).toBeNull();
  expect(f.comments.map((c) => c.key)).toEqual(delegated ? ["cancel:i-UNF-1:req-1"] : []);
  expect(f.turns()).toBe(0);
});

// The hosted proxy forwards to loopback, and a browser page can rebind a name to 127.0.0.1 or post a
// form at it: none of them is an operator on the host.
test("the API refuses a proxied request, a foreign Host, and a non-JSON post, while /health still answers", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const f = fakes();
  const port = await start(f.deps);
  await vi.waitFor(() => expect(f.turns()).toBe(1), { timeout: 5_000 });

  expect((await call(port, "GET", "/v1/tasks", undefined, { "X-Forwarded-For": "203.0.113.9" })).status).toBe(403);
  expect((await call(port, "GET", "/v1/tasks", undefined, { Forwarded: "for=203.0.113.9" })).status).toBe(403);
  expect((await call(port, "GET", "/v1/tasks", undefined, { Host: "sergeant.example.com" })).status).toBe(403);
  expect(await call(port, "POST", "/v1/tasks/UNF-1/cancel", "reason=x", { "Content-Type": "text/plain" })).toMatchObject({ status: 400 });
  expect(f.conversation.issue.delegate).not.toBeNull();
  expect((await call(port, "GET", "/health")).status).toBe(200);
  expect((await call(port, "GET", "/v1/whoami")).json).toEqual({ user: null, auth: "loopback", enrolledRepositories: ["o/r"] });
});
