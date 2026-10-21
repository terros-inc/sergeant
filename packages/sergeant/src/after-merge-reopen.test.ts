import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { conversationRevision, issueRevision, type RunRecord } from "@terros/sergeant-contracts";
import { call } from "./api-fixtures.ts";
import { startService, type Service } from "./service.ts";
import { fakes, issue, pr, repo } from "./stop-fixtures.ts";
import type { TaskState } from "./task-state.ts";

// TECH-6477: a task with several PRs counted itself landed once the PR its worker called closing
// merged, though its issue still had work. From then on its loop only watched for Done: a human's
// comment, an edit, or `sgt task wake` ("its loop started and takes a turn") gave it no turn, and the
// work stalled. While the issue is open and delegated, any of them now reopens the work: a turn, in a
// fresh window, that can start a worker. Once the issue is Done, a wake says no turn comes.

let stateDir = "";
let service: Service | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await rm(stateDir, { recursive: true, force: true });
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const mergedSha = "b".repeat(40);
// The worker that reported #7 closing, long finished; its merge an hour ago, past the completion wait,
// with its outcome posted and its audit drawn: nothing after it is left but watching for Done.
const closer: RunRecord = {
  runId: "run_w0", role: "worker", status: "succeeded", provider: "p", model: "m",
  report: { reportVersion: "s2-worker-report/1", outcome: "completed", summary: "", knownGaps: [], followups: [], pullRequests: [{ repo, number: 7, headSha: "a".repeat(40), url: pr(7).url, closesIssue: true, review: { required: false, reason: "docs" } }] },
};
const merged = { repo, number: 7, headSha: "a".repeat(40), mergedSha, at: ago(60), outcome: "Merged.", outcomePostedAt: ago(60), auditDrawnAt: ago(60) };

async function mergedTask(o: { stateType: string; state: string; completedAt?: string; description?: string }) {
  stateDir = await mkdtemp(join(tmpdir(), "sergeant-after-merge-reopen-test-"));
  const dir = join(stateDir, "tasks", "UNF-1");
  await mkdir(dir, { recursive: true });
  const live = { conversation: issue(o.stateType, o.state) };
  const seen = { revision: conversationRevision(live.conversation), issue: issueRevision({ title: "T", description: o.description ?? "D" }) };
  await writeFile(join(dir, "state.json"), JSON.stringify({
    issueId: "UNF-1", startedAt: ago(120), turns: 5, runIds: [closer.runId], recentTurns: [], seen,
    owner: { id: "user-ann", name: "Ann", admittedAt: ago(120) },
    budget: { window: { wallMinutes: 120, costUsd: 25 }, activeMs: 0 },
    merged: { ...merged, ...(o.completedAt && { completedAt: o.completedAt }) },
  }));
  const f = fakes(live);
  const status = f.deps.runner.status;
  f.deps.runner.status = async (id) => (id === closer.runId ? closer : status(id));
  f.deps.github.readPullRequest = async (_repo, number) => ({ ...pr(number), state: "merged", mergedSha, mergedAt: merged.at });
  const lines: string[] = [];
  service = await startService({ enrolledRepositories: [repo], stateDir, intakeSeconds: 0.01, pollSeconds: 0.01, slowPollMinutes: 0.0001, idleMinutes: 60, port: 0, trustLoopback: true, log: (l) => void lines.push(l) }, f.deps);
  const state = async () => JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as TaskState;
  return { ...f, live, lines, state, port: service.port ?? 0 };
}

test.each(["comment", "edit", "wake"] as const)("a merged task whose issue is still In Progress takes a turn and starts a worker on a %s", async (direction) => {
  const t = await mergedTask({ stateType: "started", state: "In Progress", ...(direction === "edit" && { description: "D, before the edit" }) });
  if (direction === "comment") {
    t.live.conversation.humanComments = [{ id: "c1", author: { id: "user-ann", name: "Ann" }, createdAt: ago(0), updatedAt: ago(0), body: "Repin the callers to the main commit." }];
  }
  if (direction === "wake") {
    // Before the wake, the task only watches for Done, as it did: no turn.
    await vi.waitFor(() => expect(t.lines.some((l) => l.startsWith("UNF-1: loop ended merged_not_done"))).toBe(true), { timeout: 10_000 });
    expect(t.seen.turns).toBe(0);
    const woke = await call(t.port, "POST", "/v1/tasks/UNF-1/wake", { reason: "repin the callers" });
    expect(woke.status).toBe(200);
    expect(["active", "admitted"]).toContain((woke.json as { woke: string }).woke);
  }

  await vi.waitFor(() => expect(t.seen.starts).toBeGreaterThanOrEqual(1), { timeout: 10_000 });
  expect(t.seen.turns).toBeGreaterThanOrEqual(1);
  const now = await t.state();
  // The landing is set aside, not lost: it is the task's again once the issue is Done.
  expect(now.merged).toBeUndefined();
  expect(now.reopened).toEqual([expect.objectContaining({ repo, number: 7, mergedSha, outcomePostedAt: merged.outcomePostedAt })]);
  expect(now.budget.windowSeq).toBe(1);
  expect(t.lines).toContainEqual(expect.stringMatching(/^UNF-1: reopened after o\/r#7 merged: /));

  // Done, the landing is the task's again and it is seen through as before; the reopen's worker stops.
  Object.assign(t.live.conversation.issue, { state: "Done", stateType: "completed" });
  await vi.waitFor(async () => expect((await t.state()).merged?.completedAt).toBeTypeOf("string"), { timeout: 10_000 });
  expect((await t.state())).toMatchObject({ reopened: [], merged: { number: 7, mergedSha, outcomePostedAt: merged.outcomePostedAt } });
  expect(t.seen.canceled).toHaveLength(1);
}, 30_000);

test.each([
  ["seen through", "2026-10-03T01:00:00.000Z"],
  ["not yet seen through", undefined],
])("a wake on a merged task whose issue is Done (%s) says it takes no turn", async (_, completedAt) => {
  const t = await mergedTask({ stateType: "completed", state: "Done", ...(completedAt && { completedAt }) });
  t.live.conversation.humanComments = [{ id: "c1", author: { id: "user-ann", name: "Ann" }, createdAt: ago(0), updatedAt: ago(0), body: "One more thing." }];

  expect(await call(t.port, "POST", "/v1/tasks/UNF-1/wake", {})).toEqual({ status: 200, json: { ref: "UNF-1", woke: "after_merge" } });
  await vi.waitFor(async () => expect((await t.state()).merged?.completedAt).toBeTypeOf("string"), { timeout: 10_000 });
  expect([t.seen.turns, t.seen.starts]).toEqual([0, 0]);
  expect((await t.state()).reopened ?? []).toEqual([]);
}, 30_000);
