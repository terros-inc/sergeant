import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { commentIdFor, type Conversation, type HumanPullRequestFeedback, type ProposedAction } from "@terros/sergeant-contracts";
import type { DelegatedIssue } from "@terros/sergeant-linear";
import { startService, type Service, type ServiceDeps } from "./service.ts";

// TECH-5008, TECH-5015: with more delegated issues than slots, finishing work must beat starting it and
// an older high-priority task must never be starved by newer work; a waiting task, on a human or on CI,
// must not keep its slot past the grace, nor lose it when the human answers within it.

const agent = { id: "agent-v2", name: "Sergeant" };
const ask: ProposedAction = { kind: "ask_human", question: "Which one?", options: ["A", "B"] };

const issue = (identifier: string, status: "In Review" | "In Progress" | "Todo", priority: number, createdAt: string): DelegatedIssue => ({
  identifier,
  priority,
  createdAt,
  state: { name: status, type: status === "Todo" ? "unstarted" : "started" },
  blockedBy: [],
});

/**
 * Fakes for the delegated `issues`. Each reasoning turn records its issue and holds its slot until
 * `finish(id)`; an issue in `asking` asks a question on its next turn. `answer(id)` is a human reply.
 * The issue `withPr` has an open PR, o/r#1, whose required check is `ci.state`. `posted` is every
 * Linear comment.
 */
function fakes(issues: DelegatedIssue[], withPr?: string) {
  const delegated = [...issues];
  const conversations = new Map<string, Conversation>();
  const conversation = (identifier: string) => {
    const c = conversations.get(identifier) ?? {
      issue: { id: `i-${identifier}`, identifier, url: `https://linear.app/x/issue/${identifier}`, title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: identifier === withPr ? [{ repo: "o/r", number: 1 }] : [] },
      humanComments: [],
      agentComments: [],
    };
    conversations.set(identifier, c);
    return c;
  };
  const turns: string[] = [];
  const holding = new Map<string, () => void>();
  const asking = new Set<string>();
  const posted: string[] = [];
  const ci = { state: "pending" as "pending" | "passed" };
  const feedback: HumanPullRequestFeedback[] = [];
  const sha = "a".repeat(40);
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [...delegated],
    linear: {
      readConversation: async (id) => conversation(id.replace(/^i-/, "")),
      postComment: async ({ issueId, body, key }) => {
        posted.push(`${issueId}: ${body}`);
        const c = conversation(issueId.replace(/^i-/, ""));
        if (!c.agentComments.some((a) => a.id === commentIdFor(key))) c.agentComments.push({ id: commentIdFor(key), createdAt: new Date().toISOString(), body });
      },
      readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
      moveIssueToStarted: async () => ({ moved: false as const }),
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
    },
    github: {
      readPullRequest: async (repo, number) => {
        const checks = { sha, required: [{ name: "ci", state: ci.state }] };
        return { repo, number, url: "https://github.com/o/r/pull/1", author: "sergeant-worker[bot]", state: "open", draft: false, headSha: sha, mergedSha: null, baseRef: "main", body: "Fixes WAITS", mergeable: true, checks, humanFeedback: [...feedback] };
      },
      closePullRequest: async () => {}, mergePullRequest: async () => Promise.reject(new Error("no merge configured")) },
    runner: { start: async () => {}, status: async () => Promise.reject(new Error("no run")), cancel: async () => {} },
    reasoner: {
      async turn(situation) {
        const id = situation.conversation.issue.identifier;
        turns.push(id);
        await new Promise<void>((resolve) => {
          holding.set(id, resolve);
          held.add(resolve);
        });
        const actions = asking.delete(id) ? [ask] : [];
        return { output: { summary: "turn", actions }, model: "m", promptVersion: "p" };
      },
    },
  };
  const finish = async (id: string) => {
    await vi.waitFor(() => expect(holding.has(id)).toBe(true), { timeout: 5_000 });
    holding.get(id)?.();
    holding.delete(id);
  };
  const answer = (id: string) => {
    const c = conversation(id);
    const now = new Date().toISOString();
    conversations.set(id, { ...c, humanComments: [...c.humanComments, { id: `reply-${id}`, author: { id: "u1", name: "Human" }, createdAt: now, updatedAt: now, body: "A" }] });
  };
  const complete = (id: string) => {
    const c = conversation(id);
    conversations.set(id, { ...c, issue: { ...c.issue, state: "Done", stateType: "completed", delegate: null } });
    const listed = delegated.findIndex((i) => i.identifier === id);
    if (listed >= 0) delegated.splice(listed, 1);
  };
  return { delegated, deps, turns, asking, posted, ci, feedback, finish, answer, complete };
}

let dir = "";
let service: Service | undefined;
// Every turn still held when a test ends: the service stops only once its loops end.
const held = new Set<() => void>();
afterEach(async () => {
  const stopping = service?.stop();
  for (const resolve of held) resolve();
  held.clear();
  await stopping;
  service = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** A started issue runs only as a task already under way (TECH-4989). */
const underway = async (identifier: string) => {
  await mkdir(join(dir, "tasks", identifier), { recursive: true });
  const task = { issueId: identifier, startedAt: new Date().toISOString(), turns: 0, runIds: [], recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] } };
  await writeFile(join(dir, "tasks", identifier, "state.json"), JSON.stringify(task));
};

const start = async (
  deps: ServiceDeps,
  opts: { maxTasks: number; waitingGraceMinutes?: number; idleMinutes?: number; intakeSeconds?: number },
  logs: string[] = [],
  setup?: () => Promise<void>,
) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-slots-test-"));
  for (const { identifier, state } of await deps.delegatedIssues()) if (state.type === "started") await underway(identifier);
  await setup?.();
  service = await startService(
    { enrolledRepositories: ["o/r"], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 0, idleMinutes: 0, log: (l) => logs.push(l), ...opts },
    deps,
  );
};

test("free slots go to In Review, then In Progress, then Todo; then by priority; then newest first", async () => {
  const f = fakes([
    issue("TODO-URGENT-NEW", "Todo", 1, "2026-10-03T00:00:00.000Z"),
    issue("TODO-NONE", "Todo", 0, "2026-10-02T00:00:00.000Z"),
    issue("PROGRESS-HIGH-OLD", "In Progress", 2, "2026-09-01T00:00:00.000Z"),
    issue("PROGRESS-LOW-NEW", "In Progress", 4, "2026-10-02T00:00:00.000Z"),
    issue("PROGRESS-HIGH-NEW", "In Progress", 2, "2026-09-20T00:00:00.000Z"),
    issue("REVIEW-NONE-OLD", "In Review", 0, "2026-08-01T00:00:00.000Z"),
  ]);
  await start(f.deps, { maxTasks: 3 });
  await vi.waitFor(() => expect(f.turns).toHaveLength(3), { timeout: 5_000 });
  await sleep(100);
  expect(new Set(f.turns)).toEqual(new Set(["REVIEW-NONE-OLD", "PROGRESS-HIGH-NEW", "PROGRESS-HIGH-OLD"]));

  // Each slot that frees goes to the next in order: the low-priority In Progress task before the urgent
  // Todo, and the urgent Todo before the one with no priority, at the next periodic intake.
  for (const [n, id] of ["REVIEW-NONE-OLD", "PROGRESS-HIGH-NEW", "PROGRESS-HIGH-OLD"].entries()) {
    f.complete(id);
    await f.finish(id);
    await vi.waitFor(() => expect(f.turns).toHaveLength(4 + n), { timeout: 5_000 });
  }
  expect(f.turns.slice(3)).toEqual(["PROGRESS-LOW-NEW", "TODO-URGENT-NEW", "TODO-NONE"]);
});

// TECH-5066: a delegated Todo issue blocked by an unfinished Linear issue must not start, nor take a
// slot from work that can start; once its last blocker finishes it starts in its usual place in order.
test("a Todo issue waits while a blocker is unfinished, then is admitted in its usual order", async () => {
  const f = fakes([
    { ...issue("BLOCKED-URGENT", "Todo", 1, "2026-10-03T00:00:00.000Z"), blockedBy: ["TECH-1"] },
    issue("FREE-HIGH", "Todo", 2, "2026-10-01T00:00:00.000Z"),
    issue("LATER-NONE", "Todo", 0, "2026-10-02T00:00:00.000Z"),
  ]);
  const logs: string[] = [];
  await start(f.deps, { maxTasks: 1 }, logs);
  await vi.waitFor(() => expect(f.turns).toEqual(["FREE-HIGH"]), { timeout: 5_000 });
  // Many intakes later it still waits, and says so once.
  await sleep(100);
  expect(logs.filter((l) => l.includes("waiting on blocker"))).toEqual(["BLOCKED-URGENT waiting on blocker TECH-1"]);

  // The blocker is Done: Linear lists it no more among the unfinished ones. The urgent issue now goes
  // ahead of the one with no priority, as if it had never been blocked.
  f.delegated[0] = { ...f.delegated[0]!, blockedBy: [] };
  await sleep(100);
  f.complete("FREE-HIGH");
  await f.finish("FREE-HIGH");
  await vi.waitFor(() => expect(f.turns).toEqual(["FREE-HIGH", "BLOCKED-URGENT"]), { timeout: 5_000 });
  f.complete("BLOCKED-URGENT");
  await f.finish("BLOCKED-URGENT");
  await vi.waitFor(() => expect(f.turns).toEqual(["FREE-HIGH", "BLOCKED-URGENT", "LATER-NONE"]), { timeout: 5_000 });
});

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

test("a just-ended Todo task is not readmitted until the next periodic intake", async () => {
  const f = fakes([issue("TODO", "Todo", 1, "2026-10-03T00:00:00.000Z")]);
  await start(f.deps, { maxTasks: 1, intakeSeconds: 3_600 });
  await vi.waitFor(() => expect(f.turns).toEqual(["TODO"]), { timeout: 5_000 });

  // It remains listed in Linear, but ending its loop does not trigger an immediate intake that
  // readmits it, ends it again, and repeats without the configured intake delay.
  await f.finish("TODO");
  await sleep(100);
  expect(f.turns).toEqual(["TODO"]);
});

test("post-merge effects wait for a task slot", async () => {
  const f = fakes([issue("HOLDS", "In Progress", 1, "2026-10-03T00:00:00.000Z")]);
  const logs: string[] = [];
  const at = new Date().toISOString();
  await start(f.deps, { maxTasks: 1, intakeSeconds: 3_600 }, logs, async () => {
    await mkdir(join(dir, "tasks", "MERGED"), { recursive: true });
    await writeFile(join(dir, "tasks", "MERGED", "state.json"), JSON.stringify({
      issueId: "MERGED",
      startedAt: at,
      turns: 1,
      runIds: [],
      recentTurns: [],
      budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] },
      merged: { repo: "o/r", number: 1, headSha: "a".repeat(40), mergedSha: "b".repeat(40), at, outcome: "Merged." },
    }));
  });
  await vi.waitFor(() => expect(f.turns).toEqual(["HOLDS"]), { timeout: 5_000 });
  await vi.waitFor(() => expect(logs).toContainEqual("MERGED: queued: waiting for a free task slot"), { timeout: 5_000 });
  expect(f.posted).toEqual([]);

  await f.finish("HOLDS");
  await vi.waitFor(() => expect(logs).toContainEqual("MERGED: has work again; admitted to a task slot"), { timeout: 5_000 });
  await vi.waitFor(() => expect(f.posted.join("\n")).toContain("Merged."), { timeout: 5_000 });
});

test("a merged task with its outcome posted and audit drawn ends without asking for a slot", async () => {
  // TECH-5127: intake resumes a merged task whose issue never reaches Done (canceled after the merge,
  // say) every time. With nothing left to post or draw, it must not queue ahead of fresh work.
  const f = fakes([issue("HOLDS", "In Progress", 1, "2026-10-03T00:00:00.000Z")]);
  const logs: string[] = [];
  const at = new Date(Date.now() - 3_600_000).toISOString();
  await start(f.deps, { maxTasks: 1, intakeSeconds: 3_600 }, logs, async () => {
    await mkdir(join(dir, "tasks", "MERGED"), { recursive: true });
    await writeFile(join(dir, "tasks", "MERGED", "state.json"), JSON.stringify({
      issueId: "MERGED",
      startedAt: at,
      turns: 1,
      runIds: [],
      recentTurns: [],
      budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] },
      merged: { repo: "o/r", number: 1, headSha: "a".repeat(40), mergedSha: "b".repeat(40), at, outcome: "Merged.", outcomePostedAt: at, auditDrawnAt: at },
    }));
  });
  await vi.waitFor(() => expect(f.turns).toEqual(["HOLDS"]), { timeout: 5_000 });
  await vi.waitFor(() => expect(logs.some((l) => l.startsWith("MERGED: loop ended merged_not_done"))).toBe(true), { timeout: 5_000 });
  expect(logs.filter((l) => l.startsWith("MERGED: ") && /queued|admitted/.test(l))).toEqual([]);
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
