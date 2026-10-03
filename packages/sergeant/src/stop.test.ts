import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { Conversation, PullRequestFacts, RunRecord } from "@terros/sergeant-contracts";
import { driveCancel, drivePendingCancels, recordCancel, taskDir } from "./cancel.ts";
import { runLoop } from "./loop.ts";
import { startService, type ServiceDeps } from "./service.ts";

// TECH-4989: Sergeant starts a delegated issue only from Todo, and a task either runs or is stopped.
// Backlog, Canceled, or Done without Sergeant's merge, an undelegation, and `sgt task cancel` all take
// the one stop: its runs stop, nothing new starts, its open PRs are closed with a comment, the issue is
// told once, and the task is set aside, so the issue back in Todo is a fresh task.

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

/**
 * Fakes for UNF-1 with a running worker whose PR #7 is open; `live` is what Linear says now. As the
 * real runner, a running run's status has no report, and a cancel keeps the one its worker `wrote`.
 */
function fakes(live: { conversation: Conversation }) {
  const runs = [worker("running")];
  const wrote = new Map<string, RunRecord["report"]>();
  const seen = { turns: 0, starts: 0, canceled: [] as string[], closed: [] as { number: number; comment: string }[], comments: [] as { key: string; body: string }[] };
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [{ identifier: "UNF-1", priority: 0, createdAt: "2026-10-01T00:00:00.000Z", state: { name: live.conversation.issue.state, type: live.conversation.issue.stateType }, blockedBy: [] }],
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
        if (run) Object.assign(run, { status: "canceled", report: wrote.get(id) ?? null });
      },
    },
    reasoner: {
      async turn() {
        seen.turns++;
        return { output: { summary: "start a worker", actions: [{ kind: "start_worker", objective: "Do UNF-1.", repositories: [repo] }] }, model: "m", promptVersion: "p" };
      },
    },
  };
  return { deps, seen, wrote };
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

test("a human's task cancel closes only its worker's PR, and a retry never closes the same head twice", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  const live = { conversation: issue("started", "In Progress") };
  live.conversation.issue.linkedPullRequests = [{ repo, number: 8 }];
  const { deps, seen } = fakes(live);
  // PR #9 is the worker's own, reported but not yet linked by Linear; #8 is a human's, linked.
  const reported: RunRecord = {
    runId: "run_w1", role: "worker", status: "running", provider: "p", model: "m",
    report: { reportVersion: "s2-worker-report/1", outcome: "partial", summary: "", pullRequests: [{ repo, number: 9, headSha: head, url: pr(9).url, closesIssue: true, review: { required: true, reason: "" } }], knownGaps: [], followups: [] },
  };
  deps.runner.status = async () => ({ ...reported, status: seen.canceled.length > 0 ? "canceled" : "running" });
  // Keep returning the closed head as open, as a stale/retried read may. The durable per-head effect
  // key, rather than GitHub's latest state, must keep the second drive from closing or commenting it.
  const readPullRequest = deps.github.readPullRequest;
  deps.github.readPullRequest = async (ownerRepo, number) => (number === 9 ? pr(9) : readPullRequest(ownerRepo, number));
  const task = taskDir(dir, "UNF-1");
  await mkdir(task, { recursive: true });
  await writeFile(join(task, "state.json"), state(["run_w1"]));
  expect(await recordCancel(dir, "UNF-1", { reason: "wrong approach", by: "Ada" }, deps)).toBe(true);

  // The first drive closes the PR but cannot tell Linear; the next drive still answers with that PR,
  // so `sgt task cancel` shows what the whole stop closed, not only what its last drive did.
  const postComment = deps.linear.postComment;
  deps.linear.postComment = async () => Promise.reject(new Error("Linear is down"));
  await expect(driveCancel(task, "UNF-1", deps, [repo], () => {})).rejects.toThrow("Linear is down");
  expect(JSON.parse(await readFile(join(task, "cancel.json"), "utf8")).prCloseKeys).toEqual([`close-pr:${repo}#9:${head}`]);
  deps.linear.postComment = postComment;
  expect(await driveCancel(task, "UNF-1", deps, [repo], () => {})).toEqual({ stopping: [], closedPullRequests: [{ repo, number: 9, url: pr(9).url }] });
  expect(seen.canceled).toEqual(["run_w1"]);
  // The retried turn saw the same PR and head as open, but performed no second GitHub effect.
  expect(seen.closed).toEqual([{ number: 9, comment: "Closed: the task was canceled by Ada: wrong approach." }]);
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.stringContaining(`the task was canceled by Ada: wrong approach. Its runs are canceled. Closed [${repo}#9]`) }]);
  // Like every stop, it sets the task aside: nothing resumes it.
  expect(await readFile(join(task, "state.json"), "utf8").catch(() => undefined)).toBeUndefined();
});

// TECH-5070: a worker's PR Linear has not linked yet is known only from its run's report, so a stop
// whose run status read failed must not finish without it, or that PR stays open.
async function stopWithFlakyStatus(failures: number) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  const live = { conversation: issue("started", "In Progress") };
  live.conversation.issue.linkedPullRequests = [];
  const { deps, seen, wrote } = fakes(live);
  // The worker has exited with its report written, not yet finalized, when its status read fails.
  wrote.set("run_w1", { reportVersion: "s2-worker-report/1", outcome: "partial", summary: "", pullRequests: [{ repo, number: 9, headSha: head, url: pr(9).url, closesIssue: true, review: { required: true, reason: "" } }], knownGaps: [], followups: [] });
  const status = deps.runner.status;
  let statusReads = 0;
  deps.runner.status = async (id) => (statusReads++, failures-- > 0 ? Promise.reject(new Error("runner unreachable")) : status(id));
  const task = taskDir(dir, "UNF-1");
  await mkdir(task, { recursive: true });
  await writeFile(join(task, "state.json"), state(["run_w1"]));
  await recordCancel(dir, "UNF-1", { reason: "wrong approach", by: "Ada" }, deps);
  const retryNow = async () => {
    const name = (await readdir(task)).find((file) => file === "cancel.json" || file.startsWith("cancel.pending-"));
    if (!name) throw new Error("no pending stop");
    const file = join(task, name);
    const intent = JSON.parse(await readFile(file, "utf8"));
    intent.retryAt = new Date(0).toISOString();
    await writeFile(file, JSON.stringify(intent));
  };
  return { deps, seen, live, task, retryNow, statusReads: () => statusReads, drive: () => driveCancel(task, "UNF-1", deps, [repo], () => {}) };
}

test("a stop whose run status read fails once reads it again after the cancel and closes the worker's unlinked PR", async () => {
  const { seen, drive } = await stopWithFlakyStatus(1);
  expect(await drive()).toEqual({ stopping: [], closedPullRequests: [{ repo, number: 9, url: pr(9).url }] });
  expect(seen.canceled).toEqual(["run_w1"]);
  expect(seen.closed).toEqual([{ number: 9, comment: "Closed: the task was canceled by Ada: wrong approach." }]);
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.stringContaining(`Closed [${repo}#9]`) }]);
});

test("a confirmed stop stays pending inside the status-read limit and does not retry before it is due", async () => {
  const { seen, task, retryNow, statusReads, drive } = await stopWithFlakyStatus(20);
  expect(await drive()).toEqual({ stopping: ["run_w1"], closedPullRequests: [] });
  expect(statusReads()).toBe(2);
  expect(seen.canceled).toEqual(["run_w1"]);

  // A poll or intake inside the backoff reads only the intent, without another runner call or cancel.
  expect(await drive()).toEqual({ stopping: ["run_w1"], closedPullRequests: [] });
  expect(statusReads()).toBe(2);
  expect(seen.canceled).toEqual(["run_w1"]);
  await retryNow();
  expect(await drive()).toEqual({ stopping: ["run_w1"], closedPullRequests: [] });
  expect(statusReads()).toBe(3);
  expect(seen.closed).toEqual([]);
  expect(seen.comments).toEqual([]);
  expect(await readdir(task)).toEqual(expect.arrayContaining(["cancel.json", "state.json"]));
});

test("an unreadable confirmed stop is deferred after the limit, lets the issue restart, and later closes the old worker's PR", async () => {
  const { deps, seen, live, task, retryNow, drive } = await stopWithFlakyStatus(4);
  expect(await drive()).toMatchObject({ stopping: ["run_w1"] });
  await retryNow();
  expect(await drive()).toMatchObject({ stopping: ["run_w1"] });
  await retryNow();
  expect(await drive()).toMatchObject({ stopping: ["run_w1"] });

  const deferred = (await readdir(task)).filter((file) => file.startsWith("cancel.pending-"));
  expect(deferred).toHaveLength(1);
  expect(await readdir(task)).not.toContain("cancel.json");
  expect(await readdir(task)).not.toContain("state.json");
  expect(seen.canceled).toEqual(["run_w1"]);

  // The old stop remains durable, but no longer excludes this Todo issue from intake.
  await intakeStartsFresh(deps, seen, live);
  const fresh = await readFile(join(task, "state.json"), "utf8");

  // Its slower retry eventually reads the worker report and closes its unlinked PR, without setting
  // aside the fresh task's state.
  await retryNow();
  expect(await drivePendingCancels(task, "UNF-1", deps, [repo], () => {})).toEqual({ stopping: [], closedPullRequests: [{ repo, number: 9, url: pr(9).url }] });
  expect(seen.closed).toEqual([{ number: 9, comment: "Closed: the task was canceled by Ada: wrong approach." }]);
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.not.stringContaining("No open PR to close") }]);
  expect(await readdir(task)).not.toContain(deferred[0]);
  expect(await readFile(join(task, "state.json"), "utf8")).toBe(fresh);
});

// A start the runner never confirmed and still does not know never started, so it does not hold the
// stop. That is in the intent, so it holds after a crash once `state.json` is set aside.
test("a stop's never-started run does not hold it pending once state.json is set aside", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  const { deps, seen } = fakes({ conversation: issue("started", "In Progress") });
  const task = taskDir(dir, "UNF-1");
  await mkdir(task, { recursive: true });
  await writeFile(join(task, "state.json"), JSON.stringify({ ...JSON.parse(state(["run_w1", "run_lost"])), unconfirmedStarts: ["run_lost"] }));
  await recordCancel(dir, "UNF-1", { reason: "wrong approach", by: "Ada" }, deps);
  const postComment = deps.linear.postComment;
  deps.linear.postComment = async () => Promise.reject(new Error("Linear unreachable"));
  await expect(driveCancel(task, "UNF-1", deps, [repo], () => {})).rejects.toThrow(/Linear/);

  deps.linear.postComment = postComment;
  await rm(join(task, "state.json"));
  expect(await driveCancel(task, "UNF-1", deps, [repo], () => {})).toEqual({ stopping: [], closedPullRequests: [{ repo, number: 7, url: pr(7).url }] });
  expect(seen.comments).toHaveLength(1);
  expect(await readdir(task)).not.toContain("cancel.json");
});

// A stop recorded before the intent kept its unconfirmed starts, that crashed once `state.json` was
// set aside, does not wait forever on a run that never started.
test("a legacy stop with state.json set aside does not hold pending on a never-started run", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  const { deps, seen } = fakes({ conversation: issue("started", "In Progress") });
  const task = taskDir(dir, "UNF-1");
  await mkdir(task, { recursive: true });
  // The old code's drive already closed PR #7 and said so before it set state.json aside.
  const closed = [{ repo, number: 7, url: pr(7).url }];
  seen.closed.push({ number: 7, comment: "Closed: wrong approach." });
  await writeFile(join(task, "cancel.json"), JSON.stringify({ reason: "wrong approach", requestId: "r1", at: new Date().toISOString(), runIds: ["run_w1", "run_lost"], closed }));
  expect(await driveCancel(task, "UNF-1", deps, [repo], () => {})).toEqual({ stopping: [], closedPullRequests: closed });
  expect(seen.canceled).toEqual(["run_w1", "run_lost"]);
  expect(seen.comments).toHaveLength(1);
  expect(await readdir(task)).not.toContain("cancel.json");
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
