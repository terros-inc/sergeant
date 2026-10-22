import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { GitHubPort, ReadinessPullRequestFacts } from "@terros/sergeant-contracts";
import { call, fakes } from "./api-fixtures.ts";
import { startService, type Service } from "./service.ts";
import { setAsideStateFile } from "./task-state.ts";

// TECH-6613: the agreement rate is the evidence a later stage uses to consider earned auto-merge, so a
// declaration must be found only through its `readinessCommentId`, counted once, classified from what
// GitHub says now, and UNKNOWN kept out of the denominator.

let dir = "";
let service: Service | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await rm(dir, { recursive: true, force: true });
});

const app = "example-org/example-app";
const other = "example-org/other-app";
const [h1, h2] = ["a".repeat(40), "b".repeat(40)];
const revision = "c".repeat(64);
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const later = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString();
const user = (login: string) => ({ login, type: "User" as const });

const refused = (number: number, at: string, readinessCommentId?: number, repo = app) => ({
  repo, number, url: `https://github.com/${repo}/pull/${number}`, headSha: h1, conversationRevision: revision, reason: "the repository's merge policy is human", at, ...(readinessCommentId && { readinessCommentId }),
});
const merged = (number: number, at: string, readinessCommentId: number, repo = app) => ({ repo, number, headSha: h1, mergedSha: h2, readinessCommentId, at });
const state = (extra: object) => JSON.stringify({ issueId: "i", startedAt: ago(300), turns: 1, runIds: [], recentTurns: [], ...extra });

/** GitHub as it is now for each declaration comment, every one declared at `h1`. */
function github(outcomes: Record<number, { at: string; facts: Partial<ReadinessPullRequestFacts> }>) {
  const asked: number[] = [];
  const port: Pick<GitHubPort, "readReadiness"> = {
    readReadiness: async ({ commentId }) => {
      asked.push(commentId);
      const o = outcomes[commentId];
      if (!o) throw new Error(`unexpected read of comment ${commentId}`);
      const declaration = { id: String(commentId), body: `READY TO MERGE | SHA: ${h1}\n\nReason: Reviewed and green on this head\n\nEvidence on this head:\n- recorded`, author: { login: "sergeant[bot]", type: "Bot" as const }, performedViaGitHubAppId: 42, sergeantAppId: 42, createdAt: o.at };
      const facts: ReadinessPullRequestFacts = { state: "merged", headSha: h1, mergedAt: later(o.at, 60), mergedBy: user("example-owner"), closedAt: later(o.at, 60), reviews: [], mergedViaMergeQueue: false, addedToMergeQueueActor: null, ...o.facts };
      return { declaration, facts };
    },
  };
  return { port, asked };
}

test("declarations are found only by readinessCommentId, counted once, and UNKNOWN stays out of the rate; --repo and --since narrow before GitHub is read", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-readiness-"));
  const [a, b] = [join(dir, "tasks", "UNF-10"), join(dir, "tasks", "UNF-11")];
  await Promise.all([mkdir(a, { recursive: true }), mkdir(b, { recursive: true })]);
  const [recent, old] = [ago(1), ago(200)];
  // A human handoff with a declaration, and a refusal from before TECH-6610 without one (never read).
  await writeFile(join(a, "state.json"), state({ refusedMerges: [refused(1, recent, 101), refused(9, recent)] }));
  // A set-aside episode whose merge carries the same declaration as its earlier refusal.
  await writeFile(join(a, "state.completed-2026-01-01T00-00-00-000Z.json"), state({ refusedMerges: [refused(2, recent, 102)], merged: merged(2, recent, 102) }));
  await writeFile(join(b, "state.json"), state({ refusedMerges: [refused(3, recent, 103), refused(4, recent, 104), refused(6, old, 106)], merged: merged(5, recent, 105, other) }));

  const reviewAt = later(recent, 30);
  const gh = github({
    101: { at: recent, facts: {} },
    102: { at: recent, facts: { headSha: h2, mergedBy: user("example-dev") } },
    103: { at: recent, facts: { state: "closed", mergedAt: null, mergedBy: null, reviews: [{ author: user("example-owner"), state: "CHANGES_REQUESTED", commitId: h1, submittedAt: reviewAt }] } },
    104: { at: recent, facts: { state: "open", mergedAt: null, mergedBy: null, closedAt: null } },
    105: { at: recent, facts: { mergedBy: { login: "sergeant[bot]", type: "Bot" } } },
    // A merge queue's bot merged it; the human who queued it is the merger.
    106: { at: old, facts: { mergedBy: { login: "github-merge-queue[bot]", type: "Bot" }, mergedViaMergeQueue: true, addedToMergeQueueActor: user("example-queuer") } },
  });
  const f = fakes();
  service = await startService({ enrolledRepositories: [app], stateDir: dir, intakeSeconds: 3600, pollSeconds: 3600, port: 0, log: () => {}, trustLoopback: true }, { ...f.deps, github: { ...f.deps.github, ...gh.port } });
  const port = service.port ?? 0;

  const all = await call(port, "GET", "/v1/review-readiness");
  expect(all.status).toBe(200);
  expect(all.json).toMatchObject({ agreed: 2, differentHead: 1, rejected: 1, evaluated: 4, unknown: { pending: 1, closed_unmerged: 0, not_human_merge: 1, uninterpretable: 0 } });
  expect(all.json.mergers).toEqual([{ login: "example-dev", count: 1 }, { login: "example-owner", count: 1 }, { login: "example-queuer", count: 1 }]);
  expect(gh.asked.toSorted()).toEqual([101, 102, 103, 104, 105, 106]);
  expect(all.json.declarations.find((d: { number: number }) => d.number === 4)).toEqual({
    task: "UNF-11", repo: app, number: 4, url: `https://github.com/${app}/pull/4`, commentUrl: `https://github.com/${app}/pull/4#issuecomment-104`, headSha: h1, at: recent, class: "UNKNOWN", reason: "pending", declarationReason: "Reviewed and green on this head",
  });

  gh.asked.length = 0;
  const narrowed = await call(port, "GET", `/v1/review-readiness?since=90d&repo=${app}`);
  expect(narrowed.json).toMatchObject({ repo: app, agreed: 1, differentHead: 1, rejected: 1, evaluated: 3, unknown: { pending: 1, not_human_merge: 0 } });
  expect(gh.asked.toSorted()).toEqual([101, 102, 103, 104]);

  expect(await call(port, "GET", "/v1/review-readiness?since=ninety")).toMatchObject({ status: 400, json: { error: { code: "bad_request" } } });
}, 30_000);

test("declarations in accepted and stopped episodes count too, each comment once", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-readiness-"));
  const a = join(dir, "tasks", "UNF-12");
  await mkdir(a, { recursive: true });
  const at = ago(1);
  // Named by the same helper accept and stop use, so a new or renamed set-aside kind cannot hide from the scan.
  await writeFile(join(a, "state.json"), state({ refusedMerges: [refused(7, at, 107)] }));
  await writeFile(join(a, setAsideStateFile("accepted", ago(3))), state({ refusedMerges: [refused(8, at, 108)], merged: merged(8, at, 108) }));
  await writeFile(join(a, setAsideStateFile("stopped", ago(2))), state({ refusedMerges: [refused(9, at, 109), refused(7, at, 107)] }));

  const gh = github({ 107: { at, facts: {} }, 108: { at, facts: {} }, 109: { at, facts: { state: "closed", mergedAt: null, mergedBy: null } } });
  const f = fakes();
  service = await startService({ enrolledRepositories: [app], stateDir: dir, intakeSeconds: 3600, pollSeconds: 3600, port: 0, log: () => {}, trustLoopback: true }, { ...f.deps, github: { ...f.deps.github, ...gh.port } });

  const all = await call(service.port ?? 0, "GET", "/v1/review-readiness");
  expect(all.json).toMatchObject({ agreed: 2, evaluated: 2, unknown: { closed_unmerged: 1 } });
  expect(gh.asked.toSorted()).toEqual([107, 108, 109]);
}, 30_000);
