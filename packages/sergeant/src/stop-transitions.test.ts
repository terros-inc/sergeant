import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { RunRecord } from "@terros/sergeant-contracts";
import { driveCancel, recordCancel, recordStop, taskDir } from "./cancel.ts";
import { runLoop } from "./loop.ts";
import { startService } from "./service.ts";
import { fakes, head, issue, pr, repo, state, worker } from "./stop-fixtures.ts";

let dir = "";
afterEach(() => rm(dir, { recursive: true, force: true }));

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
  let finished = false;
  const status = deps.runner.status;
  deps.runner.status = async (id) => (finished ? { ...worker("succeeded"), runId: id } : status(id));
  deps.reasoner.turn = async () => {
    seen.turns++;
    // The worker finishes and a turn proposes another start; the human moves the issue while it decides.
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
  const events: string[] = [];
  const cancel = deps.runner.cancel;
  let refusals = 1;
  // The runner cannot confirm the first cancel; the PR stays open and nothing is said until it does.
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
  const readPullRequest = deps.github.readPullRequest;
  // Keep returning the closed head as open, as a stale/retried read may. The durable per-head effect
  // key, rather than GitHub's latest state, must keep the second drive from closing or commenting it.
  deps.github.readPullRequest = async (ownerRepo, number) => (number === 9 ? pr(9) : readPullRequest(ownerRepo, number));
  const task = taskDir(dir, "UNF-1");
  await mkdir(task, { recursive: true });
  await writeFile(join(task, "state.json"), state(["run_w1"]));
  expect(await recordCancel(dir, "UNF-1", { reason: "wrong approach", by: "Ada" }, deps)).toBe(true);

  const postComment = deps.linear.postComment;
  deps.linear.postComment = async () => Promise.reject(new Error("Linear is down"));
  // The first drive closes the PR but cannot tell Linear; the next drive still answers with that PR,
  // so `sgt task cancel` shows what the whole stop closed, not only what its last drive did.
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

// TECH-5230: a stop deletes the branch of each PR it closed, only after the close, and never touches a
// human's PR. The delete is tidiness: one that fails is logged, and the stop still finishes.
test.each([[false], [true]])("a stop deletes the branch of the PR it closed after closing it (delete fails: %s)", async (fails) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-stop-test-"));
  await writeFile(join(dir, "state.json"), state(["run_w1"]));
  const live = { conversation: issue("backlog", "Backlog") };
  live.conversation.issue.linkedPullRequests = [{ repo, number: 7 }, { repo, number: 8 }];
  const { deps } = fakes(live);
  const events: string[] = [];
  const close = deps.github.closePullRequest;
  deps.github.closePullRequest = async (req) => (events.push(`close #${req.number}`), close(req));
  deps.github.deletePullRequestBranch = async ({ number }) => {
    events.push(`delete #${number}`);
    if (fails) throw new Error("GitHub API request failed (422): Reference does not exist");
    return { deleted: `sergeant/unf-1-pr-${number}` };
  };
  const log: string[] = [];
  await recordStop(dir, "the Linear issue was canceled or moved to Backlog");

  expect(await driveCancel(dir, "UNF-1", deps, [repo], (line) => log.push(line))).toMatchObject({ stopping: [], closedPullRequests: [{ number: 7 }] });
  expect(events).toEqual(["close #7", "delete #7"]);
  expect(log).toContain(
    fails ? `UNF-1: could not delete the branch of ${pr(7).url}: GitHub API request failed (422): Reference does not exist` : `UNF-1: deleted branch sergeant/unf-1-pr-7 of ${pr(7).url}`,
  );
  expect(await readdir(dir)).not.toContain("cancel.json");
});
