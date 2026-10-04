import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { apiClient, type Conversation, MIN_CLI_VERSION, RunDetail, type RunSpec } from "@terros/sergeant-contracts";
import { containerRunner } from "@terros/sergeant-runner";
import { startService, type Service, type ServiceDeps } from "./service.ts";

// TECH-5148: the hosted path end to end, with no fake run record: `serve`'s own containerRunner on
// `<stateDir>/runs` (serve.ts), startService's GET /v1/runs/:id, and the typed client `sgt` and
// `sgt-mcp` parse with. The run.json is the one the runner writes at launch; only Docker is faked.
// A running run and a terminal one, before and after its record.json is written, all keep the
// provider choice and account, and no credential reaches the answer.

const agent = { id: "agent-v2", name: "Sergeant" };
const ann = { id: "user-ann", name: "Ann" };
const CREDENTIAL = "sk-ant-oat01-never-in-a-view";
const conversation: Conversation = {
  issue: { id: "i-UNF-1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "Todo", stateType: "unstarted", delegate: agent, assignee: ann, linkedPullRequests: [] },
  humanComments: [],
  agentComments: [],
};
const worker = (runId: string): RunSpec => ({ runId, owner: ann, role: "worker", objective: "Do it.", context: { pullRequests: [], runs: [] }, repositories: ["o/r"], conversation });

let dir = "";
let service: Service | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await rm(dir, { recursive: true, force: true });
});

test("GET /v1/runs/:id through serve's containerRunner and the typed client keeps a run's provider choice and account", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-run-view-test-"));
  const state: Record<string, string> = { "sergeant-run_live": "running 0", "sergeant-run_done": "exited 0" };
  const runner = containerRunner({
    rootDir: join(dir, "runs"),
    models: { worker: { "claude-code-local": "opus", "codex-local": "gpt-5" }, reviewer: { "claude-code-local": "opus", "codex-local": "gpt-5" } },
    accounts: async (ownerId) => (ownerId === ann.id ? [
      { id: "person:ann:claude", adapter: "claude-code-local", holder: "Ann", credential: CREDENTIAL },
      { id: "person:ann:codex", adapter: "codex-local", holder: "Ann", credential: '{"tokens":{"access_token":"t"}}' },
    ] : []),
    quota: async ({ id, adapter }) => ({ adapter, account: id, readAt: "2026-10-03T12:00:00.000Z", weekly: { remainingPercent: adapter === "claude-code-local" ? 80 : 40 }, fiveHour: { remainingPercent: 90 } }),
    gitIdentity: { name: "Ada Example", email: "ada@example.com" },
    githubTokens: async () => "ghs_test",
    exec: async (cmd, args) => {
      if (cmd === "docker" && args[0] === "inspect") return { code: 0, stdout: `${state[args.at(-1) ?? ""]}\n`, stderr: "" };
      if (cmd === "docker" && args[0] === "logs") return { code: 0, stdout: '{"is_error":false,"total_cost_usd":0.5}', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  for (const runId of ["run_live", "run_done"]) await runner.start(worker(runId));

  await mkdir(join(dir, "tasks", "UNF-1"), { recursive: true });
  await writeFile(join(dir, "tasks", "UNF-1", "state.json"), JSON.stringify({
    issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds: ["run_live", "run_done"], recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 } },
  }));
  const deps: ServiceDeps = {
    agentUserId: agent.id,
    workerLogin: "sergeant-worker[bot]",
    delegatedIssues: async () => [{ identifier: "UNF-1", priority: 0, createdAt: "2026-10-01T00:00:00.000Z", state: { name: "Todo", type: "unstarted" }, blockedBy: [] }],
    undelegate: async () => {},
    linear: {
      readConversation: async () => conversation,
      readTaskOwner: async () => ({ owner: ann }),
      moveIssueToStarted: async () => ({ moved: false as const }),
      postComment: async () => {},
      createFollowupIssue: async () => Promise.reject(new Error("unused")),
    },
    github: { readPullRequest: async () => Promise.reject(new Error("no PRs")), closePullRequest: async () => {}, mergePullRequest: async () => Promise.reject(new Error("no PRs")) },
    runner,
    reasoner: { turn: async () => ({ output: { summary: "nothing to do yet", actions: [] }, model: "m", promptVersion: "p" }) },
  };
  service = await startService({ enrolledRepositories: ["o/r"], stateDir: dir, intakeSeconds: 3600, pollSeconds: 3600, port: 0, trustLoopback: true, log: () => {} }, deps);
  const client = apiClient({ api: `http://127.0.0.1:${service.port}`, version: MIN_CLI_VERSION });

  const chosen = {
    providerChoice: { adapter: "claude-code-local", reason: expect.any(String), readings: expect.arrayContaining([expect.objectContaining({ account: "person:ann:claude" })]) },
    account: { id: "person:ann:claude", group: "registered", holder: "Ann" },
    accountReason: expect.stringContaining("person:ann:claude"),
  };
  // run_done twice: first finalized from Docker, then read back from the record.json that wrote.
  for (const [runId, status] of [["run_live", "running"], ["run_done", "succeeded"], ["run_done", "succeeded"]] as const) {
    const raw = await client.request("GET", `/v1/runs/${runId}`);
    expect(raw.ok && raw.value).not.toContain(CREDENTIAL);
    expect(raw.ok && JSON.parse(raw.value)).toMatchObject({ task: "UNF-1", run: { runId, status, ...chosen } });
    expect(await client.call("GET", `/v1/runs/${runId}`, RunDetail)).toMatchObject({ ok: true, value: { task: "UNF-1", run: { runId, status, ...chosen } } });
  }
}, 30_000);
