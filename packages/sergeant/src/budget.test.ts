import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import {
  commentIdFor,
  type Conversation,
  type HumanComment,
  type MergePr,
  type ProposedAction,
  type PullRequestFacts,
  type RunRecord,
  type RunnerPort,
} from "@terros/sergeant-contracts";
import type { Reasoner } from "@terros/sergeant-reasoning";
import { budgetQuestionKey } from "./budget.ts";
import { runLoop, type LoopOptions } from "./loop.ts";

// UNF-728: runaway time is a material harm Sergeant must prevent. An exhausted task budget, or a human
// undelegating the issue, must cancel running work for real (an unconfirmed cancel is retried, never
// taken as stopped), and an exhausted budget must refuse every new effect until a human's reply to the
// one budget question grants another window. These hold across a crash at any point and a restart.

const head = "a".repeat(40);
const repo = "o/canary";
const agent = { id: "agent-v2", name: "Sergeant" };
const pr: PullRequestFacts = {
  repo,
  number: 7,
  url: `https://github.com/${repo}/pull/7`,
  author: "sergeant-worker[bot]",
  state: "open",
  draft: false,
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true,
  checks: { sha: head, required: [{ name: "validate", state: "passed" }] },
  humanFeedback: [],
};
const worker = (status: RunRecord["status"], costUsd?: number): RunRecord => ({
  runId: "run_w",
  role: "worker",
  status,
  provider: "p",
  model: "m",
  ...(costUsd !== undefined && { costUsd }),
  report: null,
});
const review: RunRecord = {
  runId: "run_review",
  role: "reviewer",
  status: "succeeded",
  provider: "p",
  model: "m",
  costUsd: 10,
  report: { reportVersion: "s2-review-report/1", reviewed: [{ repo, number: 7, headSha: head }], verdict: "approve", findings: [], summary: "" },
};
const merge: MergePr = { kind: "merge_pr", repo, number: 7, expectedHeadSha: head, reviewStanding: { kind: "reviewed", reviewRunId: "run_review" } };
const start: ProposedAction = { kind: "start_worker", objective: "finish", repositories: [repo] };
const human = (id: string, at: string, body: string): HumanComment => ({ id, author: { id: "u1", name: "Human" }, createdAt: at, updatedAt: at, body });

const issue = { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "In Progress", delegate: agent, linkedPullRequests: [{ repo, number: 7 }] };
const turnOf = (actions: ProposedAction[], costUsd?: number) => ({ output: { summary: "s", actions }, model: "m", promptVersion: "p", ...(costUsd !== undefined && { costUsd }) });

let dir = "";
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
  dir = "";
});

/**
 * A loop over fakes: Linear keeps one comment per key, as it does; `onPoll` acts as the human or
 * operator. `state` seeds `state.json`; omitted, the task is new (or continues an earlier `scenario`).
 */
async function scenario(opts: {
  state?: Record<string, unknown>;
  conversation?: Partial<Conversation>;
  runner: RunnerPort;
  reasoner: Reasoner["turn"];
  onPoll: (poll: number, live: Conversation) => Promise<Conversation> | Conversation;
  loop?: Partial<LoopOptions>;
}) {
  dir ||= await mkdtemp(join(tmpdir(), "sergeant-budget-test-"));
  if (opts.state) await writeFile(join(dir, "state.json"), JSON.stringify({ issueId: "UNF-1", turns: 1, recentTurns: [], ...opts.state }));
  let live: Conversation = { issue, humanComments: [], agentComments: [], ...opts.conversation };
  const posted: string[] = [];
  const merged: unknown[] = [];
  let polls = 0;
  const result = await runLoop(
    { issueId: "UNF-1", enrolledRepositories: [repo], dir, pollSeconds: 0, idleMinutes: 0, budget: { wallMinutes: 120, costUsd: 25 }, log: () => {}, ...opts.loop },
    {
      agentUserId: agent.id,
      workerLogin: "sergeant-worker[bot]",
      linear: {
        readConversation: async () => (live = await opts.onPoll(++polls, live)),
      moveIssueToStarted: async () => ({ moved: false as const }),
        async postComment({ key, body }) {
          posted.push(body);
          const id = commentIdFor(key);
          if (live.agentComments.some((c) => c.id === id)) return;
          live = { ...live, agentComments: [...live.agentComments, { id, createdAt: new Date().toISOString(), body }] };
        },
        createFollowupIssue: async () => { throw new Error("unused"); },
      },
      github: { readPullRequest: async () => pr, mergePullRequest: async (req) => (merged.push(req), { mergedSha: "c".repeat(40) }) },
      runner: opts.runner,
      reasoner: { turn: opts.reasoner },
    },
  );
  return { result, posted, merged };
}

type Saved = { runIds: string[]; budget: { window: unknown; grants: unknown[] }; recentTurns: { outcomes: string[] }[] };
const saved = async () => JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as Saved;
const stopAfter = (n: number) => async (poll: number, live: Conversation) => {
  if (poll >= n) await writeFile(join(dir, "STOP"), "");
  return live;
};

test("exhausted wall time cancels the running worker, asks once, refuses effects, and a reply grants one more window", async () => {
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
  const before = human("c0", threeHoursAgo, "Please go ahead.");
  let w = worker("running");
  let cancels = 0;
  const started: string[] = [];
  const decisions: string[][] = [];
  let stopAt = Infinity;

  const { result, posted, merged } = await scenario({
    state: { startedAt: threeHoursAgo, runIds: ["run_w"] },
    conversation: { humanComments: [before] },
    runner: {
      start: async (spec) => void started.push(spec.runId),
      status: async (id) => (id === "run_w" ? w : worker("running")),
      // The first attempt is not confirmed: the run is not stopped until the runner says so.
      cancel: async () => {
        if (++cancels === 1) throw new Error("docker did not answer");
        w = worker("canceled");
      },
    },
    reasoner: async (situation) => {
      decisions.push(situation.conversation.humanComments.map((c) => c.id));
      // An old comment cannot grant; the reply to the question can, once. Nothing else happens in
      // the turn that grants, and the next turn works in the new window.
      return situation.budget.grants.length === 0
        ? turnOf([{ kind: "grant_budget", commentId: "c0" }, { kind: "grant_budget", commentId: "c1" }, { kind: "grant_budget", commentId: "c1" }, merge])
        : turnOf([start]);
    },
    onPoll: async (poll, live) => {
      if (poll >= stopAt) await writeFile(join(dir, "STOP"), "");
      if (started.length > 0) stopAt = Math.min(stopAt, poll + 1);
      // A human answers some polls after the question appears.
      if (live.agentComments.length > 0 && live.humanComments.length === 1 && poll > 6) {
        const at = new Date(Date.parse(live.agentComments[0]?.createdAt ?? "") + 1_000).toISOString();
        return { ...live, humanComments: [before, human("c1", at, "Extend, one more window.")] };
      }
      return live;
    },
  });

  expect(result.outcome).toBe("stopped");
  expect(cancels).toBe(2);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatch(/budget is exhausted \(wall time exhausted at /);
  expect(posted[0]).toContain("worker canceled");
  expect(posted[0]).toContain("Extend: one more window (120 more minutes and $25 more)");
  // No turn until the human replied; then one that grants, and one in the new window that starts.
  expect(decisions).toEqual([["c0", "c1"], ["c0", "c1"]]);
  const { budget, recentTurns } = await saved();
  expect(recentTurns[0]?.outcomes).toEqual([
    expect.stringMatching(/^grant_budget: denied by K3/),
    expect.stringMatching(/^grant_budget: done/),
    expect.stringMatching(/^grant_budget: denied by K4/),
    expect.stringMatching(/^merge_pr .*denied by K4/),
  ]);
  expect(budget.grants).toHaveLength(1);
  expect(merged).toEqual([]);
  expect(started).toHaveLength(1);
});

test("observed spend at the limit refuses an otherwise allowed merge and asks instead", async () => {
  let turns = 0;
  const { result, posted, merged } = await scenario({
    state: { startedAt: new Date().toISOString(), runIds: ["run_w", "run_review"], turnCostUsd: 1.5 },
    runner: {
      start: async () => {},
      status: async (id) => (id === "run_w" ? worker("succeeded", 13.5) : review),
      cancel: async () => {},
    },
    reasoner: async () => (turns++, turnOf([merge])),
    onPoll: stopAfter(3),
  });

  expect(result.outcome).toBe("stopped");
  expect(turns).toBe(0);
  expect(merged).toEqual([]);
  expect(posted).toHaveLength(1);
  expect(posted[0]).toContain("spent $25.00 of $25.00");
});

test("a reasoning turn's own cost counts before its proposals run", async () => {
  const started: string[] = [];
  const { posted } = await scenario({
    state: { startedAt: new Date().toISOString(), runIds: [], turnCostUsd: 24.5 },
    runner: { start: async (spec) => void started.push(spec.runId), status: async () => worker("running"), cancel: async () => {} },
    reasoner: async () => turnOf([start], 1),
    onPoll: stopAfter(4),
  });

  expect(started).toEqual([]);
  expect((await saved()).recentTurns[0]?.outcomes[0]).toMatch(/^start_worker: denied by B1 \(spent \$25\.50 of \$25\.00\)/);
  expect(posted[0]).toContain("spent $25.50 of $25.00");
});

test("a deadline that passes during the live reads before a start refuses the start", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const started: string[] = [];
  let turned = false;
  await scenario({
    state: { startedAt: new Date().toISOString(), runIds: [] },
    runner: { start: async (spec) => void started.push(spec.runId), status: async () => worker("running"), cancel: async () => {} },
    reasoner: async () => ((turned = true), turnOf([start])),
    onPoll: async (poll, live) => {
      // The executor's live Linear read, after the turn, takes until past the deadline.
      if (turned) {
        vi.setSystemTime(Date.now() + 3 * 3_600_000);
        turned = false;
      }
      return stopAfter(4)(poll, live);
    },
  });

  expect(started).toEqual([]);
  expect((await saved()).recentTurns[0]?.outcomes[0]).toMatch(/^start_worker: denied by B1 \(wall time exhausted/);
});

test("a start whose runner call fails after starting the run lets no other start through in its turn", async () => {
  const started: string[] = [];
  let turns = 0;
  await scenario({
    state: { startedAt: new Date().toISOString(), runIds: [] },
    runner: {
      // The run starts, but its response is lost: the run may be running.
      start: async (spec) => {
        started.push(spec.runId);
        throw new Error("response lost");
      },
      status: async (id) => ({ ...worker("running"), runId: id }),
      cancel: async () => {},
    },
    reasoner: async () => turnOf(turns++ === 0 ? [start, start] : []),
    onPoll: stopAfter(3),
  });

  expect(started).toHaveLength(1);
  const state = await saved();
  expect(state.runIds).toEqual(started);
  expect(state.recentTurns[0]?.outcomes).toEqual([
    "start_worker: failed (response lost)",
    expect.stringMatching(/^start_worker: denied by R4 /),
  ]);
});

test("a restart keeps the task's stored budget window whatever the options say", async () => {
  let turns = 0;
  const { posted } = await scenario({
    state: { startedAt: new Date(Date.now() - 10 * 60_000).toISOString(), runIds: [], budget: { window: { wallMinutes: 5, costUsd: 1 }, grants: [] } },
    runner: { start: async () => {}, status: async () => worker("running"), cancel: async () => {} },
    reasoner: async () => (turns++, turnOf([start])),
    onPoll: stopAfter(3),
    loop: { budget: { wallMinutes: 120, costUsd: 25 } },
  });

  expect(turns).toBe(0);
  expect(posted[0]).toMatch(/budget is exhausted \(wall time exhausted at /);
  expect((await saved()).budget.window).toEqual({ wallMinutes: 5, costUsd: 1 });
});

test.each([
  ["Extend, one more window.", 1],
  ["Accept as-is.", 0],
])("a budget question posted before a crash is found again, never asked twice, and its reply %j is honored", async (reply, grants) => {
  const asked = new Date(Date.now() - 60_000).toISOString();
  const question = { id: commentIdFor(budgetQuestionKey(issue.id, 0)), createdAt: asked, body: "**Question for you** ... Continue?" };
  const { result, posted } = await scenario({
    // The question is on Linear, but nothing about it reached state.json.
    state: { startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), runIds: [] },
    conversation: { agentComments: [question], humanComments: [human("c1", new Date(Date.parse(asked) + 1_000).toISOString(), reply)] },
    runner: { start: async () => {}, status: async () => worker("running"), cancel: async () => {} },
    reasoner: async (situation) =>
      turnOf(situation.budget.grants.length === 0 && reply.startsWith("Extend") ? [{ kind: "grant_budget", commentId: "c1" }] : []),
    onPoll: (_poll, live) => live,
  });

  expect(result.outcome).toBe("idle");
  expect(posted).toEqual([]);
  expect((await saved()).budget.grants).toHaveLength(grants);
});

test("a run started just before a crash is still canceled when the human undelegates after the restart", async () => {
  const running = new Map<string, RunRecord>();
  const canceled: string[] = [];
  const runner: RunnerPort = {
    start: async (spec) => void running.set(spec.runId, { ...worker("running"), runId: spec.runId }),
    status: async (id) => running.get(id) ?? Promise.reject(new Error(`no run ${id}`)),
    cancel: async (id) => {
      canceled.push(id);
      const run = running.get(id);
      if (run) running.set(id, { ...run, status: "canceled" });
    },
  };
  // The process dies after the runner started the worker, before the turn's save.
  const crash = await scenario({
    runner,
    reasoner: async () => turnOf([start]),
    onPoll: (_poll, live) => live,
    loop: { log: (line) => { if (line.startsWith("turn 1 (")) throw new Error("process killed"); } },
  }).catch((e: Error) => e.message);
  expect(crash).toBe("process killed");
  const [runId] = running.keys();

  const { result } = await scenario({
    conversation: { issue: { ...issue, delegate: null } },
    runner,
    reasoner: async () => { throw new Error("an undelegated issue gets no turn"); },
    onPoll: (_poll, live) => live,
  });

  expect(result).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("not delegated") });
  expect(canceled).toEqual([runId]);
  expect(running.get(runId ?? "")?.status).toBe("canceled");
});

test("undelegation stops the loop only once the runner confirms the running run canceled", async () => {
  let w = worker("running");
  let statusReads = 0;
  let cancels = 0;
  const { result } = await scenario({
    state: { startedAt: new Date().toISOString(), runIds: ["run_w"] },
    conversation: { issue: { ...issue, delegate: null } },
    runner: {
      start: async () => {},
      // The runner cannot say at first: unknown is not stopped.
      status: async () => {
        if (++statusReads === 1) throw new Error("docker unavailable");
        return w;
      },
      cancel: async () => {
        if (++cancels < 3) throw new Error("cancel not confirmed");
        w = worker("canceled");
      },
    },
    reasoner: async () => {
      throw new Error("an undelegated issue gets no turn");
    },
    onPoll: (_poll, live) => live,
  });

  expect(result).toMatchObject({ outcome: "stopped", detail: expect.stringContaining("not delegated") });
  expect(cancels).toBe(3);
});
