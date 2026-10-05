import { expect, test, vi } from "vitest";
import { conversationRevision, type ProposedAction } from "@terros/sergeant-contracts";
import { execute } from "./execute.ts";
import { conversation, followup, head, merge, ports, pr, situation } from "./execute-fixtures.ts";
import { takeTurn } from "./index.ts";

// The Gate is only protective if the executor feeds it live facts. If the executor checked the
// turn's own snapshot instead, M4 and M10 would always pass and a merge could overtake a pushed
// head or a new human comment. This proves an allowed merge reaches the effect seam and a live
// change stops it there.

test("an exact-head reviewed merge reaches GitHub with the expected head", async () => {
  const { p, merged } = ports();
  expect(await execute(merge, situation, p)).toMatchObject({ status: "done" });
  expect(merged).toMatchObject([{ repo: pr.repo, number: 7, expectedHeadSha: head }]);
});

test("a head pushed or a human comment added after the turn's snapshot stops the merge", async () => {
  const pushed = ports({ pr: { headSha: "b".repeat(40) } });
  expect(await execute(merge, situation, pushed.p)).toMatchObject({ status: "denied", rule: "M4" });

  const stop = { id: "c1", author: { id: "u1", name: "Human" }, createdAt: "2026-10-02T06:01:00.000Z", updatedAt: "2026-10-02T06:01:00.000Z", body: "Stop, don't merge yet." };
  const commented = ports({ conversation: { ...conversation, humanComments: [stop] } });
  expect(await execute(merge, situation, commented.p)).toMatchObject({ status: "denied", rule: "M10" });

  expect([...pushed.merged, ...commented.merged]).toEqual([]);
});

// B1 is checked again after the live reads, in the merge preflight: a deadline that passes while they
// run (TECH-5065 moved it into the shared preflight) still stops the merge before GitHub.
test("a wall deadline that passes during the merge's live reads stops the merge", async () => {
  const deadline = new Date(Date.now() + 60_000);
  const { p, merged } = ports();
  const read = p.github.readPullRequest;
  p.github.readPullRequest = async (repo, number) => (vi.setSystemTime(deadline), read(repo, number));
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const late = { ...situation, budget: { ...situation.budget, wallDeadline: deadline.toISOString() } };
    expect(await execute(merge, late, p)).toMatchObject({ status: "denied", rule: "B1", reason: expect.stringContaining("wall time exhausted") });
    expect(merged).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("an issue reassigned or undelegated after the turn's snapshot gets no new start and no merge", async () => {
  const start: ProposedAction = { kind: "start_worker", objective: "Do UNF-1.", repositories: [pr.repo] };
  for (const delegate of [{ id: "agent-v1", name: "Sergeant V1" }, null]) {
    const { p, merged, started, filed } = ports({ conversation: { ...conversation, issue: { ...conversation.issue, delegate } } });
    expect(await execute(merge, situation, p)).toMatchObject({ status: "denied", rule: "A1" });
    expect(await execute(start, { ...situation, runs: [] }, p)).toMatchObject({ status: "denied", rule: "A1" });
    expect(await execute(followup("a"), situation, p)).toMatchObject({ status: "denied", rule: "A1" });
    expect([...merged, ...started, ...filed]).toEqual([]);
  }
});

test("a green, reviewed PR in an enrolled repo that Linear does not link to this issue is neither reviewed nor merged", async () => {
  // The turn's snapshot lists #7, but live Linear links only #8: a stale snapshot or a reasoning turn
  // that names an unrelated PR must not get it reviewed or merged.
  const live = { ...conversation, issue: { ...conversation.issue, linkedPullRequests: [{ repo: pr.repo, number: 8 }] } };
  const { p, merged, started } = ports({ conversation: live });
  const review: ProposedAction = { kind: "start_reviewer", subject: [{ repo: pr.repo, number: 7, headSha: head }] };
  expect(await execute(review, { ...situation, runs: [] }, p)).toMatchObject({ status: "denied", rule: "G3" });
  expect(await execute(merge, situation, p)).toMatchObject({ status: "denied", rule: "M2" });
  expect([...merged, ...started]).toEqual([]);
});

test("a green, reviewed PR linked to this issue but not opened by Sergeant's worker App is neither reviewed nor merged", async () => {
  // Linear's GitHub integration links any PR whose branch, title, or body names the issue, so the
  // link alone is PR-controlled text. A human-opened PR for the task is not Sergeant's to merge either.
  const { p, merged, started } = ports({ pr: { author: "someone" } });
  const review: ProposedAction = { kind: "start_reviewer", subject: [{ repo: pr.repo, number: 7, headSha: head }] };
  expect(await execute(review, { ...situation, runs: [] }, p)).toMatchObject({ status: "denied", rule: "G3" });
  expect(await execute(merge, situation, p)).toMatchObject({ status: "denied", rule: "M2" });
  expect([...merged, ...started]).toEqual([]);
});

const stop ={ id: "c9", author: { id: "u1", name: "Human" }, createdAt: "2026-10-02T06:02:00.000Z", updatedAt: "2026-10-02T06:02:00.000Z", body: "Stop, do not merge." };

test("a snapshot pairing the old conversation with the live revision cannot merge", async () => {
  // Reasoning saw no comment, but the supplied revision already describes the live "stop" comment.
  const live = { ...conversation, humanComments: [stop] };
  const incoherent = { ...situation, conversationRevision: conversationRevision(live) };
  const { p, merged } = ports({ conversation: live });
  expect(await execute(merge, incoherent, p)).toMatchObject({ status: "denied", rule: "M10" });
  expect(merged).toEqual([]);
});

// UNF-733: a merge ends the task. A turn that also starts work, before or after the merge, must not
// leave a live run on a merged task, and nothing is filed after the merge.
test("a merge in a turn with a start leaves no live run, and nothing runs after it", async () => {
  const start: ProposedAction = { kind: "start_worker", objective: "Do more.", repositories: [pr.repo] };
  const turnOf = async (actions: ProposedAction[]) => {
    const reasoner = { turn: async () => ({ output: { summary: "s", actions }, model: "m", promptVersion: "p" }) };
    const run = ports();
    return { ...run, outcomes: (await takeTurn(situation, { ...run.p, reasoner })).outcomes };
  };

  const mergeFirst = await turnOf([merge, start, followup("a")]);
  expect(mergeFirst.merged).toHaveLength(1);
  expect([...mergeFirst.started, ...mergeFirst.filed]).toEqual([]);
  expect(mergeFirst.outcomes.slice(1)).toMatchObject([{ status: "denied", rule: "M11" }, { status: "denied", rule: "M11" }]);

  const startFirst = await turnOf([start, merge]);
  expect(startFirst.started).toHaveLength(1);
  expect(startFirst.merged).toEqual([]);
  expect(startFirst.outcomes[1]).toMatchObject({ status: "denied", rule: "M11" });

  const followupFirst = await turnOf([followup("a"), merge]);
  expect(followupFirst.outcomes.map((o) => o.status)).toEqual(["done", "done"]);
});

test("the live merge preflight refuses a reassigned issue or a newer delegation and records the handoff, keeping the PR", async () => {
  const moved = ports({ conversation: { ...conversation, issue: { ...conversation.issue, assignee: { id: "user-bob", name: "Bob" } } } });
  expect(await execute(merge, situation, moved.p)).toMatchObject({ status: "denied", rule: "O1" });
  expect(moved.merged).toEqual([]);
  expect(moved.handoffs).toEqual([expect.stringMatching(/reassigned from Ann to Bob/)]);

  const again = ports({ taskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" }, delegatedAt: "2026-10-04T01:00:00.000Z" }) });
  expect(await execute(merge, situation, again.p)).toMatchObject({ status: "denied", rule: "O1" });
  expect(again.merged).toEqual([]);
  expect(again.handoffs).toHaveLength(1);
});
