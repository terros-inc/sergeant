import { expect, test } from "vitest";
import type { ProposedAction } from "@terros/sergeant-contracts";
import { execute, type Ports } from "./execute.ts";
import { conversation, followup, head, ports, pr, situation } from "./execute-fixtures.ts";
import { takeTurn } from "./index.ts";

test("two start_worker proposals in one turn start exactly one worker", async () => {
  const start: ProposedAction = { kind: "start_worker", objective: "Do UNF-1.", repositories: [pr.repo] };
  const reasoner = { turn: async () => ({ output: { summary: "s", actions: [start, start] }, model: "m", promptVersion: "p" }) };
  const { p, started } = ports();
  const { outcomes } = await takeTurn({ ...situation, runs: [] }, { ...p, reasoner });
  expect(started).toHaveLength(1);
  expect(outcomes[1]).toMatchObject({ status: "denied", rule: "R4" });
});

// TECH-4947: a started worker makes the issue visibly In Progress, best effort. The move runs after
// the start is a done fact, only for a worker, and a failed status write never fails or blocks the start.
test("start_worker moves the issue to In Progress, and a failed move still leaves the start done", async () => {
  const start: ProposedAction = { kind: "start_worker", objective: "Do UNF-1.", repositories: [pr.repo] };
  const ok = ports();
  expect(await execute(start, { ...situation, runs: [] }, ok.p)).toMatchObject({ status: "done" });
  expect([ok.started.length, ok.moved]).toEqual([1, ["i1"]]);

  const failing = ports({ moveFails: true });
  expect(await execute(start, { ...situation, runs: [] }, failing.p)).toMatchObject({ status: "done" });
  expect([failing.started.length, failing.moved]).toEqual([1, ["i1"]]);

  // A reviewer start never moves the issue: In Progress belongs to the worker starting.
  const review: ProposedAction = { kind: "start_reviewer", subject: [{ repo: pr.repo, number: 7, headSha: head }] };
  const rv = ports();
  expect(await execute(review, { ...situation, runs: [] }, rv.p)).toMatchObject({ status: "done" });
  expect([rv.started.length, rv.moved]).toEqual([1, []]);
});

test("send_run to a run outside this task is refused before the runner", async () => {
  const { p, sent } = ports();
  const send = { kind: "send_run", runId: "run_foreign", message: "change course" } as const;
  expect(await execute(send, situation, p)).toMatchObject({ status: "denied", rule: "S1" });
  expect(sent).toEqual([]);
});

// UNF-729: a key reasoning repeats, in the same turn or a later one, files nothing new. There is no
// per-task count (TECH-5186). The filed issue opens with the follow-up's category and why.
test("a repeated follow-up key files one issue", async () => {
  const actions = [followup("a"), followup("a"), followup("b")];
  const reasoner = { turn: async () => ({ output: { summary: "s", actions }, model: "m", promptVersion: "p" }) };
  const { p, filed } = ports();
  const { outcomes } = await takeTurn(situation, { ...p, reasoner });
  expect(filed.map((f) => f.key)).toEqual(["followup:tsk_1:a", "followup:tsk_1:b"]);
  expect(filed[0]).toMatchObject({ originIssueId: "i1", relation: "related", description: expect.stringContaining(conversation.issue.url) });
  expect(filed[0]?.description).toMatch(/^\*\*Why a follow-up \(a concrete bug\):\*\* a fails\.\n\nWhy a\./);
  expect(outcomes.map((o) => o.status)).toEqual(["done", "done", "done"]);
  expect(outcomes[1]).toMatchObject({ followup: { key: "a", identifier: "UNF-101" } });

  // A later turn shown the filed follow-up gets it back without a second issue.
  const later = await execute(followup("a"), { ...situation, followups: [{ key: "a", title: "Do a", identifier: "UNF-101", url: "https://linear.app/x/issue/UNF-101" }] }, p);
  expect(later).toMatchObject({ status: "done", followup: { identifier: "UNF-101" } });
  expect(filed).toHaveLength(2);
});

// TECH-4990: the reviewer's brief shows the humans' feedback on its PRs, read live as it starts, so a
// change a human requested after the deciding turn's snapshot still reaches the reviewer.
test("a reviewer starts with the live human feedback on its subject PRs, not the snapshot's", async () => {
  const requested = {
    id: "review:9", kind: "review" as const, author: "ada", state: "CHANGES_REQUESTED" as const, body: "Rename it.",
    path: null, line: null, commitId: head, createdAt: "2026-10-02T06:01:00.000Z", updatedAt: "2026-10-02T06:01:00.000Z", url: `${pr.url}#pullrequestreview-9`,
  };
  const { p } = ports({ pr: { humanFeedback: [requested] } });
  const specs: Parameters<Ports["runner"]["start"]>[0][] = [];
  p.runner.start = async (spec) => void specs.push(spec);
  const review: ProposedAction = { kind: "start_reviewer", subject: [{ repo: pr.repo, number: 7, headSha: head }] };
  expect(await execute(review, { ...situation, runs: [] }, p)).toMatchObject({ status: "done" });
  expect(specs).toMatchObject([{ role: "reviewer", pullRequests: [{ repo: pr.repo, number: 7, humanFeedback: [requested] }] }]);
});

// TECH-5179: the owner's episode is reread from Linear's history at the effect, not only each poll.
test("a newer or someone else's delegation since the poll starts no run and records the handoff; unreadable history starts nothing", async () => {
  const start: ProposedAction = { kind: "start_worker", repositories: [pr.repo], objective: "o" };
  const again = ports({ taskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" }, delegatedAt: "2026-10-04T01:00:00.000Z" }) });
  expect(await execute(start, situation, again.p)).toMatchObject({ status: "denied", rule: "O1" });
  expect(again.started).toEqual([]);
  expect(again.handoffs).toEqual([expect.stringMatching(/delegated to Sergeant again/)]);

  const bob = ports({ taskOwner: async () => ({ refused: "delegator_differs", assignee: { id: "user-ann", name: "Ann" }, delegator: { id: "user-bob", name: "Bob" } }) });
  expect(await execute(start, situation, bob.p)).toMatchObject({ status: "denied", rule: "O1" });
  expect(bob.started).toEqual([]);
  expect(bob.handoffs).toHaveLength(1);

  const unreadable = ports({ taskOwner: async () => Promise.reject(new Error("Linear down")) });
  expect(await execute(start, situation, unreadable.p)).toMatchObject({ status: "failed" });
  expect(unreadable.started).toEqual([]);
  expect(unreadable.handoffs).toEqual([]);
});

