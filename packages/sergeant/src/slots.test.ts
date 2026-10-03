import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import { commentIdFor, type Conversation, type PullRequestFacts } from "@terros/sergeant-contracts";
import type { DelegatedIssue } from "@terros/sergeant-linear";
import { startService, type Service, type ServiceDeps } from "./service.ts";

// TECH-5008: with more delegated issues than slots, finishing work must beat starting it and an older
// high-priority task must never be starved by newer work. TECH-5015: a waiting task keeps its slot for
// the grace, then asks a human and keeps it for the grace again; only an unanswered question frees it.

const agent = { id: "agent-v2", name: "Sergeant" };
const head = "a".repeat(40);

const issue = (identifier: string, status: "In Review" | "In Progress" | "Todo", priority: number, createdAt: string): DelegatedIssue => ({
  identifier,
  priority,
  createdAt,
  state: { name: status, type: status === "Todo" ? "unstarted" : "started" },
});

/**
 * Fakes for the delegated `issues`. Each reasoning turn records its issue and holds its slot until
 * `finish(id)`, then proposes nothing. An issue in `blocked` has a PR whose required check is pending
 * until `checks.state` changes; `answer(id)` is a human reply.
 */
function fakes(issues: DelegatedIssue[]) {
  const delegated = [...issues];
  const conversations = new Map<string, Conversation>();
  const conversation = (identifier: string) => {
    const c = conversations.get(identifier) ?? {
      issue: { id: `i-${identifier}`, identifier, url: `https://linear.app/x/issue/${identifier}`, title: "T", description: "D", state: "In Progress", delegate: agent, linkedPullRequests: [] },
      humanComments: [],
      agentComments: [],
    };
    conversations.set(identifier, c);
    return c;
  };
  const turns: string[] = [];
  const holding = new Map<string, () => void>();
  const blocked = new Set<string>();
  const checks = { state: "pending" as "pending" | "passed" };
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [...delegated],
    linear: {
      readConversation: async (id) => {
        const c = conversation(id.replace(/^i-/, ""));
        return { ...c, issue: { ...c.issue, linkedPullRequests: blocked.has(c.issue.identifier) ? [{ repo: "o/r", number: 1 }] : [] } };
      },
      postComment: async ({ issueId, body, key }) => {
        const c = conversation(issueId.replace(/^i-/, ""));
        if (!c.agentComments.some((a) => a.id === commentIdFor(key))) c.agentComments.push({ id: commentIdFor(key), createdAt: new Date().toISOString(), body });
      },
      moveIssueToStarted: async () => ({ moved: false as const }),
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
    },
    github: {
      readPullRequest: async (): Promise<PullRequestFacts> => ({
        repo: "o/r",
        number: 1,
        url: "https://github.com/o/r/pull/1",
        state: "open",
        draft: false,
        author: "sergeant-worker[bot]",
        headSha: head,
        mergedSha: null,
        baseRef: "main",
        body: "",
        mergeable: true,
        checks: { sha: head, required: [{ name: "validate", state: checks.state }] },
        humanFeedback: [],
      }),
      mergePullRequest: async () => Promise.reject(new Error("unused")),
    },
    runner: { start: async () => {}, status: async () => Promise.reject(new Error("no runs")), cancel: async () => {} },
    reasoner: {
      async turn(situation) {
        const id = situation.conversation.issue.identifier;
        turns.push(id);
        await new Promise<void>((resolve) => {
          holding.set(id, resolve);
          held.add(resolve);
        });
        return { output: { summary: "turn", actions: [] }, model: "m", promptVersion: "p" };
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
  return { delegated, deps, turns, blocked, checks, finish, answer };
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

const start = async (deps: ServiceDeps, opts: { maxTasks: number; waitingGraceMinutes?: number; idleMinutes?: number }, logs: string[] = []) => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-slots-test-"));
  service = await startService(
    { enrolledRepositories: ["o/r"], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 0, idleMinutes: 60, log: (l) => logs.push(l), ...opts },
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
  // Each task ends on the idle guard once its turn finishes, freeing its slot.
  await start(f.deps, { maxTasks: 3, idleMinutes: 0 });
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

const asked = (logs: string[], id: string) => logs.some((l) => l.startsWith(`${id}: blocked past the grace: asking a human`));
const lostSlot = (logs: string[], id: string) => logs.filter((l) => l.startsWith(`${id}:`) && /released|queued|admitted to a task slot again/.test(l));

test("an external wait that clears within the grace continues at once in the same slot", async () => {
  const f = fakes([issue("CI", "In Progress", 2, "2026-10-01T00:00:00.000Z"), issue("NEWER", "Todo", 1, "2026-10-03T00:00:00.000Z")]);
  f.blocked.add("CI");
  const logs: string[] = [];
  // A grace of 3 seconds; the check passes well within it.
  await start(f.deps, { maxTasks: 1, waitingGraceMinutes: 0.05 }, logs);
  await f.finish("CI");
  await vi.waitFor(() => expect(logs).toContainEqual("CI: waiting: nothing changed since the last turn"), { timeout: 5_000 });
  f.checks.state = "passed";
  await vi.waitFor(() => expect(f.turns).toEqual(["CI", "CI"]), { timeout: 5_000 });
  expect(asked(logs, "CI")).toBe(false);
  expect(lostSlot(logs, "CI")).toEqual([]);
});

test("blocked past the grace, the task asks a human; answered within the next grace, it continues in the same slot", async () => {
  const f = fakes([issue("CI", "In Progress", 2, "2026-10-01T00:00:00.000Z"), issue("NEWER", "Todo", 1, "2026-10-03T00:00:00.000Z")]);
  f.blocked.add("CI");
  const logs: string[] = [];
  // A grace of 1.2 seconds: the check stays pending past it, and the human answers within the next.
  await start(f.deps, { maxTasks: 1, waitingGraceMinutes: 0.02 }, logs);
  await f.finish("CI");
  await vi.waitFor(() => expect(asked(logs, "CI")).toBe(true), { timeout: 5_000 });
  await vi.waitFor(() => expect(logs).toContainEqual(expect.stringContaining("CI: waiting: blocked; asked a human at")), { timeout: 5_000 });
  expect(f.turns).toEqual(["CI"]);

  f.answer("CI");
  await vi.waitFor(() => expect(f.turns).toEqual(["CI", "CI"]), { timeout: 5_000 });
  // Its wait ended with the answer: the grace running out during its next turn frees nothing.
  await sleep(1_500);
  expect(f.turns).toEqual(["CI", "CI"]);
  expect(lostSlot(logs, "CI")).toEqual([]);
});

test("after the blocked question, a change on GitHub continues the task in the same slot without a reply", async () => {
  const f = fakes([issue("CI", "In Progress", 2, "2026-10-01T00:00:00.000Z"), issue("NEWER", "Todo", 1, "2026-10-03T00:00:00.000Z")]);
  f.blocked.add("CI");
  const logs: string[] = [];
  await start(f.deps, { maxTasks: 1, waitingGraceMinutes: 0.02 }, logs);
  await f.finish("CI");
  await vi.waitFor(() => expect(asked(logs, "CI")).toBe(true), { timeout: 5_000 });
  f.checks.state = "passed";
  await vi.waitFor(() => expect(f.turns).toEqual(["CI", "CI"]), { timeout: 5_000 });
  expect(lostSlot(logs, "CI")).toEqual([]);
});

test("unanswered past the next grace, the slot is released; a later reply queues in admission order", async () => {
  const f = fakes([issue("CI", "In Progress", 2, "2026-10-01T00:00:00.000Z"), issue("NEWER", "Todo", 1, "2026-10-03T00:00:00.000Z")]);
  f.blocked.add("CI");
  const logs: string[] = [];
  await start(f.deps, { maxTasks: 1, waitingGraceMinutes: 0 }, logs);
  await f.finish("CI");
  // Blocked, it asks; unanswered, its slot goes to the next task while the question stays open.
  await vi.waitFor(() => expect(f.turns).toEqual(["CI", "NEWER"]), { timeout: 5_000 });
  expect(asked(logs, "CI")).toBe(true);
  expect(logs).toContainEqual("CI: no human answer within the grace: task slot released until something changes");

  // Answered while the slot is taken, the task queues; an In Review issue delegated meanwhile is ahead of it.
  f.answer("CI");
  await vi.waitFor(() => expect(logs).toContainEqual("CI: queued: waiting for a free task slot"), { timeout: 5_000 });
  f.delegated.push(issue("REVIEW", "In Review", 0, "2026-09-01T00:00:00.000Z"));
  await sleep(100);
  await f.finish("NEWER");
  await vi.waitFor(() => expect(f.turns).toEqual(["CI", "NEWER", "REVIEW"]), { timeout: 5_000 });
  await sleep(100);
  expect(f.turns).toHaveLength(3);
  await f.finish("REVIEW");
  await vi.waitFor(() => expect(f.turns).toEqual(["CI", "NEWER", "REVIEW", "CI"]), { timeout: 5_000 });
  expect(logs).toContainEqual("CI: admitted to a task slot again");
  await f.finish("CI");
});
