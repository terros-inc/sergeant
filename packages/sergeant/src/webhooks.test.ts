import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { Conversation, PullRequestFacts } from "@terros/sergeant-contracts";
import { startService, type Service, type ServiceDeps } from "./service.ts";
import { linearNudge } from "./webhooks.ts";

// Webhooks are a latency optimization only: a signed event ends the wait of the loop watching what
// it names (polls here are an hour apart, so only a webhook can explain a prompt reread), an unsigned
// or stale one does nothing, an event no task watches is ignored, a stream of events rereads at most
// once per gap, and no event forces a turn on its own.

const agent = { id: "agent-v2", name: "Sergeant" };
/** An open Todo issue with no priority, as intake lists it. */
const todo = (identifier: string) => ({ identifier, priority: 0, createdAt: "2026-10-01T00:00:00.000Z", state: { name: "Todo", type: "unstarted" }, blockedBy: [] });
const secrets = { linear: "linear-secret", github: "github-secret" };
const head = "a".repeat(40);
const webhookGapMs = 50;
const pr: PullRequestFacts = {
  repo: "o/r",
  number: 7,
  url: "https://github.com/o/r/pull/7",
  author: "sergeant-worker[bot]",
  state: "open",
  draft: false,
  headSha: head,
  mergedSha: null,
  baseRef: "main",
  body: "Fixes UNF-1",
  mergeable: true,
  checks: { sha: head, required: [{ name: "validate", state: "pending" }] },
  humanFeedback: [],
};
const conversation = (identifier: string): Conversation => ({
  issue: {
    id: `i-${identifier}`,
    identifier,
    url: `https://linear.app/x/issue/${identifier}`,
    title: "T",
    description: "D",
    state: "Todo",
    stateType: "unstarted",
    delegate: agent,
    linkedPullRequests: identifier === "UNF-1" ? [{ repo: "o/r", number: 7 }] : [],
  },
  humanComments: [],
  agentComments: [],
});

let dir = "";
let service: Service | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function start() {
  dir = await mkdtemp(join(tmpdir(), "sergeant-webhooks-test-"));
  const live = new Map([["UNF-1", conversation("UNF-1")]]);
  const delegated = ["UNF-1"];
  const counts = { reads: new Map<string, number>(), intakes: 0, turns: [] as string[] };
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => (counts.intakes++, [...delegated].map(todo)),
    linear: {
      readConversation: async (id) => {
        counts.reads.set(id, (counts.reads.get(id) ?? 0) + 1);
        return live.get(id) ?? Promise.reject(new Error(`no ${id}`));
      },
      postComment: async () => {},
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
      moveIssueToStarted: async () => ({ moved: false as const }),
    },
    github: { readPullRequest: async () => pr, closePullRequest: async () => {}, mergePullRequest: async () => Promise.reject(new Error("unused")) },
    runner: { start: async () => {}, status: async () => Promise.reject(new Error("no runs")), cancel: async () => {} },
    reasoner: {
      async turn(situation) {
        counts.turns.push(situation.conversation.issue.identifier);
        return { output: { summary: "nothing to do yet", actions: [] }, model: "m", promptVersion: "p" };
      },
    },
  };
  service = await startService(
    { enrolledRepositories: ["o/r"], stateDir: dir, intakeSeconds: 3600, pollSeconds: 3600, idleMinutes: 60, port: 0, webhookSecrets: secrets, webhookGapSeconds: webhookGapMs / 1000, log: () => {} },
    deps,
  );
  const port = service.port;
  // A Linear delivery is stamped now unless the payload says otherwise.
  const post = (source: "linear" | "github", payload: object, opts: { secret?: string; event?: string } = {}) => {
    const body = JSON.stringify(source === "linear" ? { webhookTimestamp: Date.now(), ...payload } : payload);
    const signature = createHmac("sha256", opts.secret ?? secrets[source]).update(body).digest("hex");
    const headers: Record<string, string> =
      source === "linear"
        ? { "Linear-Signature": signature, "Linear-Event": "x" }
        : { "X-Hub-Signature-256": `sha256=${signature}`, "X-GitHub-Event": opts.event ?? "check_suite" };
    return fetch(`http://127.0.0.1:${port}/webhooks/${source}`, { method: "POST", headers, body }).then((r) => r.status);
  };
  const reads = (id: string) => counts.reads.get(id) ?? 0;
  await vi.waitFor(() => expect(counts.turns).toEqual(["UNF-1"]), { timeout: 5_000 });
  // The poll after the turn rereads once more, then waits an hour.
  await vi.waitFor(() => expect(reads("UNF-1")).toBe(2), { timeout: 5_000 });
  return { live, delegated, counts, post, reads };
}

test("a signed event wakes the loop watching its issue or PR; an unsigned or unwatched one does nothing", async () => {
  const { live, counts, post, reads } = await start();
  const before = reads("UNF-1");
  const comment = { type: "Comment", action: "create", data: { id: "c1", issueId: "i-UNF-1", body: "Also update the README." } };

  // A forged or unsigned delivery is refused before its body is looked at, and a signed Linear one
  // with no timestamp, or one over a minute from now, as a replay.
  expect(await post("linear", comment, { secret: "wrong" })).toBe(401);
  expect(await post("github", { repository: { full_name: "o/r" }, check_suite: { head_sha: head, pull_requests: [] } }, { secret: "wrong" })).toBe(401);
  expect(await post("linear", { ...comment, webhookTimestamp: undefined })).toBe(401);
  expect(await post("linear", { ...comment, webhookTimestamp: Date.now() - 120_000 })).toBe(401);
  expect(await post("linear", { ...comment, webhookTimestamp: Date.now() + 120_000 })).toBe(401);
  // Signed, but about a head and a repository no task watches.
  expect(await post("github", { repository: { full_name: "o/r" }, check_suite: { head_sha: "b".repeat(40), pull_requests: [{ number: 8 }] } })).toBe(200);
  expect(await post("github", { repository: { full_name: "other/repo" }, pull_request: { number: 7 } }, { event: "pull_request" })).toBe(200);
  await sleep(200);
  expect(reads("UNF-1")).toBe(before);

  // A check on the PR's watched head rereads at once, but nothing changed, so no turn.
  expect(await post("github", { repository: { full_name: "O/R" }, check_suite: { head_sha: head, pull_requests: [] } })).toBe(200);
  await vi.waitFor(() => expect(reads("UNF-1")).toBe(before + 1), { timeout: 2_000 });
  // A burst, then a steady stream across three gaps, rereads at most once per 50 ms gap (each event would
  // reread without the cap), and still owes no turn.
  const pullRequest = () => post("github", { repository: { full_name: "o/r" }, pull_request: { number: 7 } }, { event: "pull_request" });
  const streamStarted = Date.now();
  await Promise.all(Array.from({ length: 10 }, pullRequest));
  for (let i = 0; i < 30; i++) await Promise.all([pullRequest(), sleep(5)]);
  await sleep(70);
  const streamElapsed = Date.now() - streamStarted;
  expect(reads("UNF-1") - (before + 1)).toBeGreaterThanOrEqual(2);
  expect(reads("UNF-1") - (before + 1)).toBeLessThanOrEqual(Math.ceil(streamElapsed / webhookGapMs) + 1);
  expect(counts.turns).toEqual(["UNF-1"]);

  // A human comments: the comment's webhook, naming the issue only by id, gets it a turn now.
  live.set("UNF-1", {
    ...conversation("UNF-1"),
    humanComments: [{ id: "c1", author: { id: "u1", name: "Human" }, createdAt: "2026-10-02T06:01:00.000Z", updatedAt: "2026-10-02T06:01:00.000Z", body: "Also update the README." }],
  });
  expect(await post("linear", comment)).toBe(200);
  await vi.waitFor(() => expect(counts.turns).toEqual(["UNF-1", "UNF-1"]), { timeout: 2_000 });
});

test("a delegation to the V2 agent runs an intake now, which admits the issue", async () => {
  const { live, delegated, counts, post, reads } = await start();
  const intakes = counts.intakes;
  live.set("UNF-2", conversation("UNF-2"));
  delegated.push("UNF-2");
  // Someone else's delegation is not Sergeant's to look at.
  expect(await post("linear", { type: "Issue", action: "update", data: { id: "i-UNF-2", identifier: "UNF-2", delegateId: "someone-else" }, updatedFrom: { delegateId: null } })).toBe(200);
  await sleep(200);
  expect(counts.intakes).toBe(intakes);

  expect(await post("linear", { type: "Issue", action: "update", data: { id: "i-UNF-2", identifier: "UNF-2", delegateId: agent.id }, updatedFrom: { delegateId: null } })).toBe(200);
  await vi.waitFor(() => expect(counts.turns).toContain("UNF-2"), { timeout: 2_000 });
  expect(reads("UNF-2")).toBeGreaterThan(0);
});

test("an issue update that touches nothing Sergeant reads is dropped", () => {
  const issue = { id: "i-UNF-1", identifier: "UNF-1" };
  expect(linearNudge({ type: "Issue", action: "update", data: issue, updatedFrom: { priority: 2, sortOrder: 1 } }, agent.id)).toBeUndefined();
  expect(linearNudge({ type: "Issue", action: "update", data: issue, updatedFrom: { stateId: "s" } }, agent.id)).toEqual({ keys: ["i-UNF-1", "UNF-1"], intake: false });
  expect(linearNudge({ type: "Reaction", action: "create", data: { issueId: "i-UNF-1" } }, agent.id)).toBeUndefined();
});
