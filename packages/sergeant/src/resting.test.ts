import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { Conversation } from "@terros/sergeant-contracts";
import { startService, type Service, type ServiceDeps } from "./service.ts";

// TECH-5942: every intake resumed every task whose loop had ended (idle, waiting on a human's review,
// say) for a full reread of its issue and PRs: every 2 minutes, for each such task. A change to the task
// arrives as a webhook, so intake leaves it resting until one names it, or for the safety interval,
// whether or not deliveries arrive. Missing that wake would leave a human's comment unread that long.

const agent = { id: "agent-v2", name: "Sergeant" };
const secrets = { linear: "linear-secret", github: "github-secret" };
const conversation: Conversation = {
  issue: {
    id: "i-UNF-1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "Todo", stateType: "unstarted",
    delegate: agent, assignee: { id: "user-ann", name: "Ann" }, linkedPullRequests: [],
  },
  humanComments: [],
  agentComments: [],
};

let dir = "";
let service: Service | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await rm(dir, { recursive: true, force: true });
});

test("intake leaves an ended task resting until a webhook names it, whether or not webhooks deliver", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-resting-test-"));
  let reads = 0;
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [{ identifier: "UNF-1", priority: 0, createdAt: "2026-10-01T00:00:00.000Z", state: { name: "Todo", type: "unstarted" }, blockedBy: [] }],
    linear: {
      readConversation: async () => (reads++, conversation),
      postComment: async () => {},
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
      readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }),
      moveIssueToStarted: async () => ({ moved: false as const }),
    },
    github: { readPullRequest: async () => Promise.reject(new Error("unused")), closePullRequest: async () => {}, mergePolicy: () => "sergeant", mergePullRequest: async () => Promise.reject(new Error("unused")) },
    runner: { start: async () => {}, status: async () => Promise.reject(new Error("no runs")), cancel: async () => {} },
    reasoner: { turn: async () => ({ output: { summary: "nothing to do yet", actions: [], waitingOn: "the next change" }, model: "m", promptVersion: "p" }) },
  };
  // The loop ends idle right after its turn, and intake runs every 50 ms.
  service = await startService(
    { enrolledRepositories: ["o/r"], stateDir: dir, intakeSeconds: 0.05, pollSeconds: 3600, idleMinutes: 0, port: 0, webhookSecrets: secrets, webhookGapSeconds: 0.01, log: () => {} },
    deps,
  );
  const post = (source: "linear" | "github", payload: object, event = "pull_request") => {
    const body = JSON.stringify(source === "linear" ? { webhookTimestamp: Date.now(), ...payload } : payload);
    const signature = createHmac("sha256", secrets[source]).update(body).digest("hex");
    const headers = source === "linear" ? { "Linear-Signature": signature } : { "X-Hub-Signature-256": `sha256=${signature}`, "X-GitHub-Event": event };
    return fetch(`http://127.0.0.1:${service?.port}/webhooks/${source}`, { method: "POST", headers, body }).then((r) => r.status);
  };

  // No deliveries yet: admitted, its loop reads the issue and ends, and the following intakes leave it resting.
  await vi.waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 5_000 });
  await sleep(150);
  const resting = reads;
  await sleep(400);
  expect(reads - resting).toBeLessThanOrEqual(1);

  // Both sources deliver, about other things: it still rests.
  expect(await post("linear", { type: "Reaction", action: "create", data: { issueId: "i-OTHER" } })).toBe(200);
  expect(await post("github", { repository: { full_name: "other/repo" }, pull_request: { number: 1 } })).toBe(200);
  await sleep(150);
  const stillResting = reads;
  await sleep(400);
  expect(reads - stillResting).toBeLessThanOrEqual(1);

  // A comment on its issue resumes it at once.
  const before = reads;
  expect(await post("linear", { type: "Comment", action: "create", data: { id: "c1", issueId: "i-UNF-1" } })).toBe(200);
  await vi.waitFor(() => expect(reads).toBeGreaterThan(before), { timeout: 2_000 });
  await sleep(150);
  const after = reads;
  await sleep(400);
  expect(reads - after).toBeLessThanOrEqual(1);
});
