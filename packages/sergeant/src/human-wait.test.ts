import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { commentIdFor, type Conversation, type PullRequestFacts } from "@terros/sergeant-contracts";
import { cleanup, dir, human, issue, pr, scenario, turnOf } from "./budget-scenario.ts";
import { handoffKey } from "./handoff.ts";
import { Wake } from "./wake.ts";

// TECH-6669: a task whose PR was handed to a human to merge, in a repository whose merges are a
// human's, took a paid "nothing changed" turn each time its PRs were reread, often two a few seconds
// apart: the base branch had moved (in the fingerprint), and GitHub reported mergeability unknown while
// it recomputed, then settled. Its window ran out on those turns alone, which would ask the budget
// question. Only a fact the wait is for may wake a turn, and one change wakes exactly one.

afterEach(cleanup);

const sha = (n: number) => n.toString(16).padStart(40, "0");
const hold = human("hold", new Date(Date.now() - 120_000).toISOString(), "Please hold until UNF-2 and UNF-3 move.");
const handoff = { id: commentIdFor(handoffKey(issue.id, pr)), createdAt: new Date(Date.now() - 60_000).toISOString(), body: "Ready for a human to merge" };

/**
 * The PR as GitHub shows it at `poll`, the base branch moving under it every poll: GitHub reports
 * mergeability unknown on the poll the base moved, and settles it by the next.
 */
const busyBase = (poll: number, patch: Partial<PullRequestFacts>, offset = 0): PullRequestFacts => {
  const moved = poll % 2 === 0;
  return { ...pr, baseSha: sha(offset + Math.ceil(poll / 2)), ...(moved && { mergeable: null, mergeableState: "unknown" as const }), ...patch };
};

/**
 * A task waiting on a human merge, polled `polls` times under a busy base; `change` applies at
 * `changeAt`. Returns the turns taken and what was posted. With `keepDir`, it continues the last one.
 */
async function waiting(opts: { polls: number; costUsd?: number; change?: { at: number; pr?: Partial<PullRequestFacts>; issue?: (live: Conversation) => Conversation }; wake?: Wake; keepDir?: boolean; baseOffset?: number; hold?: boolean }) {
  let turns = 0;
  let poll = 0;
  let patch: Partial<PullRequestFacts> = {};
  if (opts.keepDir) await rm(join(dir, "STOP"), { force: true });
  const result = await scenario({
    ...(!opts.keepDir && { state: { startedAt: new Date().toISOString(), turns: 0, runIds: [] } }),
    // A hold a human asked for is a comment on the issue, with no handoff to a human merge.
    conversation: opts.hold ? { humanComments: [hold] } : { agentComments: [handoff] },
    runner: { start: async () => {}, status: async () => { throw new Error("no runs"); }, cancel: async () => {} },
    reasoner: async () => (turns++, turnOf([], opts.costUsd ?? 0.25)),
    pullRequest: () => busyBase(poll, patch, opts.baseOffset),
    mergePolicy: "human",
    onPoll: async (n, live) => {
      poll = n;
      if (n === opts.change?.at) {
        patch = { ...patch, ...opts.change.pr };
        if (opts.change.issue) live = opts.change.issue(live);
      }
      if (n === opts.change?.at && opts.wake) opts.wake.request();
      if (n >= opts.polls) await writeFile(join(dir, "STOP"), "");
      return live;
    },
    loop: { idleMinutes: 24 * 60, ...(opts.wake && { wake: opts.wake }) },
  });
  return { turns, posted: result.posted };
}

const spent = async () => (JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { turnCostUsd: number }).turnCostUsd;

test("a task waiting on a human merge takes no turn and spends nothing while only its base moves", async () => {
  // The turn that decides to wait, then many rereads of a PR whose base moves and mergeability flaps.
  const { turns, posted } = await waiting({ polls: 20 });

  expect(turns).toBe(1);
  expect(posted).toEqual([]);
  expect(await spent()).toBe(0.25);
});

const at = new Date().toISOString();
const changes: [string, NonNullable<Parameters<typeof waiting>[0]["change"]>][] = [
  ["a new commit", { at: 7, pr: { headSha: "d".repeat(40), checks: { sha: "d".repeat(40), required: [{ name: "validate", state: "pending" }] } } }],
  ["a human review", { at: 7, pr: { humanFeedback: [{ id: "review:1", kind: "review", author: "captain", state: "APPROVED", body: "", path: null, line: null, commitId: pr.headSha, createdAt: at, updatedAt: at, url: `${pr.url}#pullrequestreview-1` }] } }],
  ["a human comment on the issue", { at: 7, issue: (live) => ({ ...live, humanComments: [human("c1", at, "Please hold.")] }) }],
  ["a reply in a thread", { at: 7, issue: (live) => ({ ...live, humanComments: [{ ...human("c2", at, "Merging after lunch."), parentId: handoff.id }] }) }],
  ["a CI change", { at: 7, pr: { checks: { sha: pr.headSha, required: [{ name: "validate", state: "failed" }] } } }],
  ["a mergeability change", { at: 7, pr: { mergeable: false, mergeableState: "dirty" } }],
  ["a merge", { at: 7, pr: { state: "merged", mergedSha: "c".repeat(40), mergedAt: at } }],
  ["a close", { at: 7, pr: { state: "closed" } }],
  ["a change of the issue's state", { at: 7, issue: (live) => ({ ...live, issue: { ...live.issue, state: "In Review" } }) }],
  ["a change of the issue's blockers", { at: 7, issue: (live) => ({ ...live, issue: { ...live.issue, blockedBy: ["UNF-2"] } }) }],
];

test.each(changes)("%s wakes exactly one turn while the base keeps moving", async (_name, change) => {
  // Changed on a poll where GitHub settled mergeability, then as on every poll the base moves after it.
  const { turns } = await waiting({ polls: 20, change });

  expect(turns).toBe(2);
});

test("a change that arrives while GitHub recomputes mergeability wakes one turn, not one more as it settles", async () => {
  // Poll 8 moves the base, so GitHub reports unknown there and settles it, unchanged, on poll 9.
  const { turns } = await waiting({ polls: 20, change: { at: 8, pr: { checks: { sha: pr.headSha, required: [{ name: "validate", state: "failed" }] } } } });

  expect(turns).toBe(2);
});

test("sgt task wake still takes a turn while the task waits on a human merge", async () => {
  const { turns } = await waiting({ polls: 12, change: { at: 7 }, wake: new Wake() });

  expect(turns).toBe(2);
});

test.each([
  ["it kept", false, 0],
  // As code from before the wait facts saved it, read back from its last turn though the base has moved since.
  ["code before them did not keep", true, 100],
])("a task already waiting on a merge with an exhausted window, wait facts %s, asks nothing while only its base moves", async (_name, legacy, baseOffset) => {
  // The work before the handoff spent the whole window.
  const first = await waiting({ polls: 3, costUsd: 25 });
  expect(first.turns).toBe(1);
  const file = join(dir, "state.json");
  if (legacy) {
    const { waitFacts: _, ...saved } = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify(saved));
  }

  const { turns, posted } = await waiting({ polls: 20, keepDir: true, baseOffset });

  expect(turns).toBe(0);
  expect(posted).toEqual([]);
  expect(await spent()).toBe(25);
});

test("a task holding at a human's request with an exhausted window asks nothing, takes no turn and spends nothing while nothing changes", async () => {
  // The turn that reads the hold and waits spends the rest of the window.
  const first = await waiting({ polls: 3, costUsd: 25, hold: true });
  expect(first.turns).toBe(1);
  expect(first.posted).toEqual([]);

  const { turns, posted } = await waiting({ polls: 20, keepDir: true, hold: true });

  expect(turns).toBe(0);
  expect(posted).toEqual([]);
  expect(await spent()).toBe(25);
});

test("a human's comment on a task holding with an exhausted window wakes exactly one turn", async () => {
  await waiting({ polls: 3, costUsd: 25, hold: true });

  const { turns, posted } = await waiting({ polls: 20, keepDir: true, hold: true, change: { at: 7, issue: (live) => ({ ...live, humanComments: [...live.humanComments, human("c3", new Date().toISOString(), "Go ahead.")] }) } });

  expect(turns).toBe(1);
  expect(posted).toEqual([]);
});
