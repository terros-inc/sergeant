import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { citation, searchEvidence } from "./evidence-search.ts";

// The citation decides whether a live-check ticket closes: a failure of the same path must never be
// hidden behind a success, and nothing before the deploy may count.

const head = "a".repeat(40);
const merge = { kind: "merge_pr", repo: "terros-inc/sergeant", number: 190, expectedHeadSha: head };
const closeAction = { kind: "close_issue", state: "done", evidence: "covered by #12" };

async function stateDir() {
  const dir = await mkdtemp(join(tmpdir(), "evidence-"));
  const turn = (at: string, outcomes: unknown[]) => JSON.stringify({ at, situation: { big: "ignored" }, turn: {}, outcomes });
  await mkdir(join(dir, "tasks", "TECH-1"), { recursive: true });
  await writeFile(
    join(dir, "tasks", "TECH-1", "turns.jsonl"),
    [
      turn("2026-10-01T00:00:00.000Z", [{ action: closeAction, status: "done", result: { moved: true } }]),
      turn("2026-10-07T00:00:00.000Z", [{ action: merge, status: "done", result: { mergedSha: "b".repeat(40) }, merged: { pr: { mergeableState: "clean" }, mergedSha: "b".repeat(40) } }]),
      "not json",
    ].join("\n"),
  );
  await mkdir(join(dir, "tasks", "TECH-2"), { recursive: true });
  await writeFile(
    join(dir, "tasks", "TECH-2", "turns.jsonl"),
    [
      turn("2026-10-07T01:00:00.000Z", [{ action: closeAction, status: "failed", error: "Linear issueUpdate did not succeed" }]),
      turn("2026-10-07T02:00:00.000Z", [{ action: merge, status: "denied", rule: "M5", reason: "required checks pending" }]),
    ].join("\n"),
  );
  for (const [id, status, startedAt] of [["run-a", "succeeded", "2026-10-07T03:00:00.000Z"], ["run-b", "canceled", "2026-10-07T04:00:00.000Z"]] as const) {
    await mkdir(join(dir, "runs", id), { recursive: true });
    await writeFile(join(dir, "runs", id, "record.json"), JSON.stringify({ runId: id, role: "worker", status, provider: "codex", account: { holder: "Trevor" } }));
    await writeFile(join(dir, "runs", id, "run.json"), JSON.stringify({ startedAt }));
  }
  return dir;
}

test("finds done and failed uses of a path since the deploy, and the citation blocks closing on a failure", async () => {
  const dir = await stateDir();
  const query = { match: /close_issue/i, since: "2026-10-06T00:00:00.000Z" };
  const hits = await searchEvidence(dir, query);
  // The close on 10-01 predates the deploy; the denied merge and the merge are not close_issue.
  expect(hits).toEqual([expect.objectContaining({ kind: "contrary", subject: "TECH-2", source: "turn outcome", what: "close_issue: failed (Linear issueUpdate did not succeed)" })]);
  const out = citation(hits, { query, version: "2.0.90+abc1234", host: "sergeant-host", searchedAt: "2026-10-08T00:00:00.000Z" });
  expect(out.exitCode).toBe(1);
  expect(out.text).toContain("0 supporting, 1 contrary, 0 denied");
});

test("cites a merge that used the new field and a run's account, leaving out canceled runs", async () => {
  const dir = await stateDir();
  const merges = await searchEvidence(dir, { match: /mergeableState/, since: "2026-10-06" });
  expect(merges.map((h) => [h.kind, h.subject, h.what])).toEqual([["supporting", "TECH-1", expect.stringMatching(/^merge_pr terros-inc\/sergeant#190@aaaaaaaaaaaa: done/)]]);

  const query = { match: /"holder"/ };
  const runs = await searchEvidence(dir, query);
  expect(runs.map((h) => [h.kind, h.subject, h.source])).toEqual([["supporting", "run-a", "run record"]]);
  const out = citation(runs, { query, version: "2.0.90+abc1234", host: "sergeant-host", searchedAt: "2026-10-08T00:00:00.000Z" });
  expect(out.exitCode).toBe(0);
  expect(out.text).toMatch(/^\*\*Natural-use evidence\*\* for `\/"holder"\/`, from Sergeant's records on sergeant-host \(Sergeant 2\.0\.90\+abc1234/);
  expect(out.text).toContain("- supporting · 2026-10-07T03:00:00.000Z · run-a · run record: `worker succeeded on codex:");
});

test("no match is not evidence", async () => {
  const query = { match: /never-written/ };
  const out = citation(await searchEvidence(await stateDir(), query), { query, version: "v", host: "h", searchedAt: "t" });
  expect(out.exitCode).toBe(1);
  expect(out.text).toContain("0 supporting, 0 contrary, 0 denied");
});

test("a Gate denial is shown for the operator to judge but is not evidence by itself", async () => {
  const query = { match: /merge_pr/, issue: "TECH-2" };
  const hits = await searchEvidence(await stateDir(), query);
  expect(hits.map((h) => [h.kind, h.what])).toEqual([["denied", expect.stringContaining("denied by M5 (required checks pending)")]]);
  const out = citation(hits, { query, version: "v", host: "h", searchedAt: "t" });
  expect(out.exitCode).toBe(1);
  expect(out.text).toContain("0 supporting, 0 contrary, 1 denied");
});

// f3 on #193: a run whose run.json cannot be read must fail the search, never vanish from it.
test.skipIf(process.getuid?.() === 0)("an unreadable run.json fails the search", async () => {
  const dir = await stateDir();
  await chmod(join(dir, "runs", "run-a", "run.json"), 0o000);
  await expect(searchEvidence(dir, { match: /"holder"/, since: "2026-10-06" })).rejects.toThrow(/EACCES/);
});
