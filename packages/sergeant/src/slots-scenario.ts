import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { commentIdFor, type Conversation, type HumanPullRequestFeedback, type ProposedAction } from "@terros/sergeant-contracts";
import type { DelegatedIssue } from "@terros/sergeant-linear";
import { startService, type Service, type ServiceDeps } from "./service.ts";

// The fakes the task-slot tests (slots.test.ts, slots-waiting.test.ts) run `serve` over, many issues at once.

export const agent = { id: "agent-v2", name: "Sergeant" };
const ask: ProposedAction = { kind: "ask_human", question: "Which one?", options: ["A", "B"] };

export const issue = (identifier: string, status: "In Review" | "In Progress" | "Todo", priority: number, createdAt: string): DelegatedIssue => ({
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
export function fakes(issues: DelegatedIssue[], withPr?: string) {
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
  let listings = 0;
  const holding = new Map<string, () => void>();
  const asking = new Set<string>();
  const posted: string[] = [];
  const ci = { state: "pending" as "pending" | "passed" };
  const feedback: HumanPullRequestFeedback[] = [];
  const sha = "a".repeat(40);
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => (listings++, [...delegated]),
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
        return { repo, number, url: "https://github.com/o/r/pull/1", author: "sergeant-worker[bot]", state: "open", draft: false, headSha: sha, mergedSha: null, baseRef: "main", body: "Fixes WAITS", mergeable: true, mergeableState: "clean", checks, humanFeedback: [...feedback] };
      },
      closePullRequest: async () => {}, mergePolicy: () => "sergeant", mergePullRequest: async () => Promise.reject(new Error("no merge configured")) },
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
  /** Resolves once an intake begun after the call has listed the issues and scheduled the slots. */
  const nextIntake = async () => {
    const before = listings;
    await vi.waitFor(() => expect(listings).toBeGreaterThan(before + 1), { timeout: 5_000 });
  };
  return { delegated, deps, turns, asking, posted, ci, feedback, finish, answer, complete, nextIntake };
}

export let dir = "";
let service: Service | undefined;
// Every turn still held when a test ends: the service stops only once its loops end.
const held = new Set<() => void>();
export async function cleanup() {
  const stopping = service?.stop();
  for (const resolve of held) resolve();
  held.clear();
  await stopping;
  service = undefined;
  await rm(dir, { recursive: true, force: true });
}

/** A started issue runs only as a task already under way (TECH-4989). */
export const underway = async (identifier: string) => {
  await mkdir(join(dir, "tasks", identifier), { recursive: true });
  const task = { issueId: identifier, startedAt: new Date().toISOString(), turns: 0, runIds: [], recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 }, grants: [] } };
  await writeFile(join(dir, "tasks", identifier, "state.json"), JSON.stringify(task));
};

export const start = async (
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
