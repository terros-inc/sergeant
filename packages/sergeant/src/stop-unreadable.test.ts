import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { driveCancel, recordCancel, taskDir } from "./cancel.ts";
import { startService } from "./service.ts";
import { fakes, head, issue, pr, repo, state } from "./stop-fixtures.ts";

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

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
  deps.runner.status = async (id) => (failures-- > 0 ? Promise.reject(new Error("runner unreachable")) : structuredClone(await status(id)));
  const task = taskDir(dir, "UNF-1");
  await mkdir(task, { recursive: true });
  await writeFile(join(task, "state.json"), state(["run_w1"]));
  await recordCancel(dir, "UNF-1", { reason: "wrong approach", by: "Ada" }, deps);
  return { deps, seen, live, task, drive: () => driveCancel(task, "UNF-1", deps, [repo], () => {}) };
}

async function ageStop(task: string) {
  const file = join(task, "cancel.json");
  const intent = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...intent, at: new Date(Date.now() - 16 * 60 * 1000).toISOString() }));
}

test("a stop whose run status read fails once reads it again after the cancel and closes the worker's unlinked PR", async () => {
  const { seen, drive } = await stopWithFlakyStatus(1);
  expect(await drive()).toEqual({ stopping: [], closedPullRequests: [{ repo, number: 9, url: pr(9).url }] });
  expect(seen.canceled).toEqual(["run_w1"]);
  expect(seen.closed).toEqual([{ number: 9, comment: "Closed: the task was canceled by Ada: wrong approach." }]);
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.stringContaining(`Closed [${repo}#9]`) }]);
});

test("a stop rereads a running run after cancel and closes the PR in its final report", async () => {
  const { seen, drive } = await stopWithFlakyStatus(0);
  expect(await drive()).toEqual({ stopping: [], closedPullRequests: [{ repo, number: 9, url: pr(9).url }] });
  expect(seen.canceled).toEqual(["run_w1"]);
  expect(seen.closed).toEqual([{ number: 9, comment: "Closed: the task was canceled by Ada: wrong approach." }]);
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.not.stringContaining("No open PR to close") }]);
});

test("a stop whose run status stays unreadable after the cancel stays pending, says nothing, and finishes once it reads", async () => {
  const { seen, task, drive } = await stopWithFlakyStatus(4);
  expect(await drive()).toEqual({ stopping: ["run_w1"], closedPullRequests: [] });
  const intent = await readFile(join(task, "cancel.json"), "utf8");
  expect(await drive()).toEqual({ stopping: ["run_w1"], closedPullRequests: [] });
  expect(await readFile(join(task, "cancel.json"), "utf8")).toBe(intent);
  expect(seen.closed).toEqual([]);
  expect(seen.comments).toEqual([]);
  expect(await readdir(task)).toEqual(expect.arrayContaining(["cancel.json", "state.json"]));
  // The next intake drives the same stop, and the run's status reads again.
  expect(await drive()).toEqual({ stopping: [], closedPullRequests: [{ repo, number: 9, url: pr(9).url }] });
  expect(seen.closed).toEqual([{ number: 9, comment: "Closed: the task was canceled by Ada: wrong approach." }]);
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.not.stringContaining("No open PR to close") }]);
  expect(await readdir(task)).not.toContain("cancel.json");
});

test("an unreadable status past the grace finishes with one note and the issue restarts on Todo", async () => {
  const { deps, seen, live, task, drive } = await stopWithFlakyStatus(99);
  live.conversation.issue.linkedPullRequests = [{ repo, number: 7 }];
  expect(await drive()).toEqual({ stopping: ["run_w1"], closedPullRequests: [] });
  expect(seen.comments).toEqual([]);
  await ageStop(task);
  expect(await drive()).toEqual({ stopping: [], closedPullRequests: [{ repo, number: 7, url: pr(7).url }] });
  expect(seen.closed).toEqual([{ number: 7, comment: "Closed: the task was canceled by Ada: wrong approach." }]);
  expect(seen.comments).toEqual([{
    key: expect.stringMatching(/^cancel:i1:/),
    body: expect.stringMatching(/run `run_w1` could not be read.*Closed \[o\/r#7\]/),
  }]);
  expect(await readdir(task)).not.toContain("cancel.json");

  live.conversation = issue("unstarted", "Todo");
  const service = await startService({ enrolledRepositories: [repo], stateDir: dir, intakeSeconds: 3600, pollSeconds: 3600, log: () => {} }, deps);
  try {
    await expect.poll(() => seen.starts, { timeout: 5_000 }).toBe(1);
  } finally {
    await service.stop();
  }
  expect(seen.comments).toHaveLength(1);
  const fresh = JSON.parse(await readFile(join(task, "state.json"), "utf8")) as { runIds: string[] };
  expect(fresh.runIds).toHaveLength(1);
  expect(fresh.runIds).not.toContain("run_w1");
});

test.each(["unreadable status and failed cancel", "readable running status and failed cancel"])("a stop with %s is surfaced", async (failure) => {
  const { deps, seen, task, drive } = await stopWithFlakyStatus(failure.startsWith("unreadable") ? 99 : 0);
  deps.runner.cancel = async () => Promise.reject(new Error("Docker unavailable"));
  await ageStop(task);
  expect(await drive()).toEqual({ stopping: ["run_w1"], closedPullRequests: [] });
  expect(seen.comments[0]).toMatchObject({ key: expect.stringMatching(/^cancel-stalled:i1:/), body: expect.stringContaining("for over 16 minutes") });
});

test("a warning failure is retried without failing the stop and reuses its idempotency key", async () => {
  const { deps, seen, task, drive } = await stopWithFlakyStatus(99);
  deps.runner.cancel = async () => Promise.reject(new Error("Docker unavailable"));
  await ageStop(task);
  const post = deps.linear.postComment;
  deps.linear.postComment = async (comment) => {
    await post(comment);
    deps.linear.postComment = post;
    throw new Error("connection lost after Linear accepted comment");
  };
  await expect(drive()).resolves.toMatchObject({ stopping: ["run_w1"] });
  await expect(drive()).resolves.toMatchObject({ stopping: ["run_w1"] });
  expect(seen.commentAttempts).toHaveLength(2);
  expect(new Set(seen.commentAttempts).size).toBe(1);
  expect(seen.comments).toHaveLength(1);
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

// TECH-5114: a start never confirmed that a drive read running did start, so its report may name
// a PR Linear has not linked: a failed reread after its cancel holds the stop like any other run's.
test("an unconfirmed start read running before its cancel holds the stop when its reread fails", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  const { deps, seen } = fakes({ conversation: issue("started", "In Progress") });
  const status = deps.runner.status;
  let reads = 0;
  deps.runner.status = async (id) => (reads++ > 0 ? Promise.reject(new Error("runner unreachable")) : status(id));
  const task = taskDir(dir, "UNF-1");
  await mkdir(task, { recursive: true });
  await writeFile(join(task, "state.json"), JSON.stringify({ ...JSON.parse(state(["run_w1"])), unconfirmedStarts: ["run_w1"] }));
  await recordCancel(dir, "UNF-1", { reason: "wrong approach", by: "Ada" }, deps);
  const drive = () => driveCancel(task, "UNF-1", deps, [repo], () => {});
  expect(await drive()).toEqual({ stopping: ["run_w1"], closedPullRequests: [] });
  expect(seen.canceled).toEqual(["run_w1"]);
  expect(seen.comments).toEqual([]);
  expect(await readdir(task)).toContain("cancel.json");
  // Past the grace it finishes, saying that run's report could not be read.
  await ageStop(task);
  expect(await drive()).toEqual({ stopping: [], closedPullRequests: [{ repo, number: 7, url: pr(7).url }] });
  expect(seen.comments).toEqual([{ key: expect.stringMatching(/^cancel:i1:/), body: expect.stringContaining("run `run_w1` could not be read") }]);
});
