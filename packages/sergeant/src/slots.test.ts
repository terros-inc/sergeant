import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { commentIdFor, type Conversation, type ProposedAction } from "@terros/sergeant-contracts";
import type { DelegatedIssue } from "@terros/sergeant-linear";
import { startService, type Service, type ServiceDeps } from "./service.ts";

// TECH-5008: with more delegated issues than slots, finishing work must beat starting it and an older
// high-priority task must never be starved by newer work; a task waiting on a human must not keep its
// slot past the grace, nor lose it when the human answers within it.

const agent = { id: "agent-v2", name: "Sergeant" };
const ask: ProposedAction = { kind: "ask_human", question: "Which one?", options: ["A", "B"] };

const issue = (identifier: string, status: "In Review" | "In Progress" | "Todo", priority: number, createdAt: string): DelegatedIssue => ({
  identifier,
  priority,
  createdAt,
  state: { name: status, type: status === "Todo" ? "unstarted" : "started" },
});

/**
 * Fakes for the delegated `issues`. Each reasoning turn records its issue and holds its slot until
 * `finish(id)`; an issue in `asking` asks a question on its next turn. `answer(id)` is a human reply.
 */
function fakes(issues: DelegatedIssue[]) {
  const delegated = [...issues];
  const conversations = new Map<string, Conversation>();
  const conversation = (identifier: string) => {
    const c = conversations.get(identifier) ?? {
      issue: { id: `i-${identifier}`, identifier, url: `https://linear.app/x/issue/${identifier}`, title: "T", description: "D", state: "In Progress", stateType: "started", delegate: agent, linkedPullRequests: [] },
      humanComments: [],
      agentComments: [],
    };
    conversations.set(identifier, c);
    return c;
  };
  const turns: string[] = [];
  const holding = new Map<string, () => void>();
  const asking = new Set<string>();
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [...delegated],
    linear: {
      readConversation: async (id) => conversation(id.replace(/^i-/, "")),
      postComment: async ({ issueId, body, key }) => {
        const c = conversation(issueId.replace(/^i-/, ""));
        if (!c.agentComments.some((a) => a.id === commentIdFor(key))) c.agentComments.push({ id: commentIdFor(key), createdAt: new Date().toISOString(), body });
      },
      moveIssueToStarted: async () => ({ moved: false as const }),
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
    },
    github: { readPullRequest: async () => Promise.reject(new Error("no PRs")), closePullRequest: async () => {}, mergePullRequest: async () => Promise.reject(new Error("no PRs")) },
    runner: { start: async () => {}, status: async () => Promise.reject(new Error("no runs")), cancel: async () => {} },
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
  return { delegated, deps, turns, asking, finish, answer };
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

const start = async (deps: ServiceDeps, opts: { maxTasks: number; waitingGraceMinutes?: number }, logs: string[] = []) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-slots-test-"));
  for (const { identifier, state } of await deps.delegatedIssues()) if (state.type === "started") await underway(identifier);
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
  // Todo, and the urgent Todo before the one with no priority. One slot at a time: two admitted
  // together may start their turns in either order.
  for (const [n, id] of ["REVIEW-NONE-OLD", "PROGRESS-HIGH-NEW", "PROGRESS-HIGH-OLD"].entries()) {
    await f.finish(id);
    await vi.waitFor(() => expect(f.turns).toHaveLength(4 + n), { timeout: 5_000 });
  }
  expect(f.turns.slice(3)).toEqual(["PROGRESS-LOW-NEW", "TODO-URGENT-NEW", "TODO-NONE"]);
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
  expect(logs).toContainEqual("ASKS: waiting on a human past the grace; its task slot is free until the human answers");

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
