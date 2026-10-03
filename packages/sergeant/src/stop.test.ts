import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { Conversation, PullRequestFacts, RunRecord } from "@terros/sergeant-contracts";
import { driveCancel, recordCancel, taskDir } from "./cancel.ts";
import { runLoop } from "./loop.ts";
import { startService, type ServiceDeps } from "./service.ts";

// TECH-4989: Sergeant starts a delegated issue only from Todo, and a human moving a running task's
// issue to Backlog, Canceled, or Done (without Sergeant's merge) cancels it like an undelegation: its
// runs stop, nothing new starts, its open PRs are closed with a comment, and the issue is told once.
// Every cancel path closes the task's open PRs, a human's `sgt task cancel` included.

const agent = { id: "agent-v2", name: "Sergeant" };
const repo = "o/r";
const head = "a".repeat(40);
const pr = (number: number, author = "sergeant-worker[bot]"): PullRequestFacts => ({
  repo,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  author,
  state: "open",
  draft: false,
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true,
  checks: { sha: head, required: [{ name: "validate", state: "pending" }] },
  humanFeedback: [],
});
const issue = (stateType: string, state: string): Conversation => ({
  issue: { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state, stateType, delegate: agent, linkedPullRequests: [{ repo, number: 7 }] },
  humanComments: [],
  agentComments: [],
});
const worker = (status: RunRecord["status"]): RunRecord => ({ runId: "run_w1", role: "worker", status, provider: "p", model: "m", report: null });

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

/** Fakes for UNF-1 with a running worker whose PR #7 is open; `live` is what Linear says now. */
function fakes(live: { conversation: Conversation }) {
  const runs = [worker("running")];
  const seen = { turns: 0, starts: 0, canceled: [] as string[], closed: [] as { number: number; comment: string }[], comments: [] as { key: string; body: string }[] };
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [{ identifier: "UNF-1", stateType: live.conversation.issue.stateType }],
    undelegate: async () => void (live.conversation.issue.delegate = null),
    linear: {
      readConversation: async () => structuredClone(live.conversation),
      moveIssueToStarted: async () => ({ moved: false as const }),
      postComment: async ({ key, body }) => void seen.comments.push({ key, body }),
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
    },
    github: {
      readPullRequest: async (_repo, number) => {
        const closed = seen.closed.some((c) => c.number === number);
        return { ...pr(number, number === 8 ? "a-human" : undefined), state: closed ? "closed" : "open" };
      },
      mergePullRequest: async () => Promise.reject(new Error("no merge after a stop")),
      closePullRequest: async ({ number, comment }) => void seen.closed.push({ number, comment }),
    },
    runner: {
      start: async (spec) => (seen.starts++, void runs.push({ ...worker("running"), runId: spec.runId })),
      status: async (id) => runs.find((r) => r.runId === id) ?? Promise.reject(new Error(`no ${id}`)),
      cancel: async (id) => {
        seen.canceled.push(id);
        const run = runs.find((r) => r.runId === id);
        if (run) run.status = "canceled";
      },
    },
    reasoner: {
      async turn() {
        seen.turns++;
        return { output: { summary: "start a worker", actions: [{ kind: "start_worker", objective: "Do UNF-1.", repositories: [repo] }] }, model: "m", promptVersion: "p" };
      },
    },
  };
  return { deps, seen };
}

const state = (runIds: string[]) =>
  JSON.stringify({ issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds, recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] } });

test("a delegated Backlog issue never starts, and starts within one intake of moving to Todo", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  const live = { conversation: issue("backlog", "Backlog") };
  const { deps, seen } = fakes(live);
  const service = await startService({ enrolledRepositories: [repo], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 3600, log: () => {} }, deps);
  try {
    // Many intakes see it in Backlog, then In Progress though nobody started it: neither starts a task.
    await sleep(100);
    live.conversation = issue("started", "In Progress");
    await sleep(100);
    expect(seen.turns).toBe(0);
    expect(await readdir(join(dir, "tasks")).catch(() => [])).toEqual([]);

    live.conversation = issue("unstarted", "Todo");
    await vi.waitFor(() => expect(seen.starts).toBe(1), { timeout: 5_000 });
  } finally {
    await service.stop();
  }
});

test.each([
  ["Backlog", "backlog"],
  ["Canceled", "canceled"],
  ["Done", "completed"],
])("a running task moved to %s stops its runs, closes its open PR, says so once, and starts nothing more", async (name, stateType) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  await writeFile(join(dir, "state.json"), state(["run_w1"]));
  const live = { conversation: issue("started", "In Progress") };
  const { deps, seen } = fakes(live);
  // The worker finishes and a turn proposes another start; the human moves the issue while it decides.
  let finished = false;
  const status = deps.runner.status;
  deps.runner.status = async (id) => (finished ? { ...worker("succeeded"), runId: id } : status(id));
  deps.reasoner.turn = async () => {
    seen.turns++;
    live.conversation = issue(stateType, name);
    return { output: { summary: "start", actions: [{ kind: "start_worker", objective: "Do UNF-1.", repositories: [repo] }] }, model: "m", promptVersion: "p" };
  };
  const logs: string[] = [];
  const loop = runLoop({ issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, log: (l) => logs.push(l) }, deps);
  await sleep(20);
  finished = true;
  const result = await loop;

  // The start was refused by the live read (A2), and the next poll stopped the task.
  expect(seen.turns).toBe(1);
  expect(seen.starts).toBe(0);
  expect(logs).toContainEqual(expect.stringMatching(/start_worker: denied by A2/));
  expect(result).toMatchObject({ outcome: "stopped", detail: expect.stringContaining(name) });
  // The worker's open PR is closed with a comment; a human's PR linked to the issue is not touched.
  expect(seen.closed).toEqual([{ number: 7, comment: `Closed: the Linear issue was canceled or moved to ${name}.` }]);
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.stringContaining(`moved to ${name}. Its runs are canceled. Closed [${repo}#7]`) }]);
  // The task is set aside: back in Todo it is a fresh task, with nothing of this one's to resume.
  const files = await readdir(dir);
  expect(files).not.toContain("state.json");
  expect(files).not.toContain("cancel.json");
  expect(files.filter((f) => f.startsWith("state.stopped-"))).toHaveLength(1);
});

test("a running task's runs are canceled within one poll of the move, and the stop waits for the runner to confirm", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  await writeFile(join(dir, "state.json"), state(["run_w1"]));
  const live = { conversation: issue("backlog", "Backlog") };
  const { deps, seen } = fakes(live);
  // The runner cannot confirm the first cancel; the PR stays open and nothing is said until it does.
  const events: string[] = [];
  const cancel = deps.runner.cancel;
  let refusals = 1;
  deps.runner.cancel = async (id) => {
    if (refusals-- > 0) return (events.push(`cancel ${id} refused`), Promise.reject(new Error("docker stop timed out")));
    events.push(`cancel ${id}`);
    return cancel(id);
  };
  const close = deps.github.closePullRequest;
  deps.github.closePullRequest = async (req) => (events.push(`close #${req.number}`), close(req));
  const postComment = deps.linear.postComment;
  deps.linear.postComment = async (c) => (events.push("comment"), postComment(c));

  const result = await runLoop({ issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, log: () => {} }, deps);
  expect(result.outcome).toBe("stopped");
  expect(events).toEqual(["cancel run_w1 refused", "cancel run_w1", "close #7", "comment"]);
  expect(seen).toMatchObject({ turns: 0, starts: 0, canceled: ["run_w1"] });
});

test("a human's task cancel closes the PR its worker reported, and only Sergeant's own", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  const live = { conversation: issue("started", "In Progress") };
  live.conversation.issue.linkedPullRequests = [{ repo, number: 8 }];
  const { deps, seen } = fakes(live);
  // PR #9 is the worker's own, reported but not yet linked by Linear; #8 is a human's, linked.
  const reported: RunRecord = {
    runId: "run_w1", role: "worker", status: "running", provider: "p", model: "m",
    report: { reportVersion: "s2-worker-report/1", outcome: "partial", summary: "", pullRequests: [{ repo, number: 9, headSha: head, url: pr(9).url, closesIssue: true, review: { required: true, reason: "" } }], knownGaps: [], followups: [] },
  };
  deps.runner.status = async () => reported;
  const task = taskDir(dir, "UNF-1");
  await recordCancel(dir, "UNF-1", { reason: "wrong approach", by: "Ada" }, deps);
  await writeFile(join(task, "state.json"), state(["run_w1"]));

  expect(await driveCancel(task, "UNF-1", deps, [repo], () => {})).toEqual({ undelegated: true, stopping: [] });
  expect(seen.canceled).toEqual(["run_w1"]);
  expect(seen.closed).toEqual([{ number: 9, comment: "Closed: Sergeant's task was canceled by Ada: wrong approach" }]);
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.stringContaining(`at the request of Ada: wrong approach. Its runs are canceled. Closed [${repo}#9]`) }]);
  // A cancel through the API keeps the task to resume: only a stop by state sets it aside.
  expect(JSON.parse(await readFile(join(task, "state.json"), "utf8"))).toMatchObject({ runIds: ["run_w1"] });
});

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
test.each([
  ["Todo", "unstarted"],
  ["In Progress", "started"],
])("an issue moved back to %s while its stop is still pending only finishes the stop, and intake then starts a fresh task", async (name, stateType) => {
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
});

test.each([
  ["Todo", "unstarted"],
  ["In Progress", "started"],
])("an issue moved back to %s after intake finished the loop's stop ends the old loop, and intake then starts a fresh task", async (name, stateType) => {
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
});
