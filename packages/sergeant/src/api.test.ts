import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CLI_VERSION_HEADER, MIN_CLI_VERSION, type RunRecord } from "@terros/sergeant-contracts";
import type { LinearUser } from "@terros/sergeant-linear";
import { agent, call, fakes } from "./api-fixtures.ts";
import { linearCallers } from "./auth.ts";
import { startService, type Service, type ServiceDeps, type ServiceOptions } from "./service.ts";

// The client API's actions must reach the task through the loop's own paths: a wake ends the loop's
// wait and owes it a turn, a cancel undelegates and cancels the runs until the runner confirms them,
// and a run cancel is the runner's. Only a Linear user the installation admits may use any of it, or,
// under `trustLoopback`, an operator on the service's own host.

// Tests that wait get 30 s, so a slow CI runner never hits vitest's 5 s default before a 5 s wait ends.

let dir = "";
let service: Service | undefined;
afterEach(async () => {
  await service?.stop();
  service = undefined;
  await rm(dir, { recursive: true, force: true });
});

// Polls only when woken: an unwoken loop would sit out the hour.
const start = async (deps: ServiceDeps, opts: Partial<ServiceOptions> = { trustLoopback: true }) => {
  service = await startService({ enrolledRepositories: ["o/r"], stateDir: dir, intakeSeconds: 0.01, pollSeconds: 3600, port: 0, log: () => {}, ...opts }, deps);
  return service.port ?? 0;
};

test("a wake makes an unchanged task take a turn now, and a task without a delegation cannot be woken", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const f = fakes();
  const port = await start(f.deps);
  await vi.waitFor(() => expect(f.turns()).toBe(1), { timeout: 5_000 });

  expect(await call(port, "POST", "/v1/tasks/UNF-1/wake", { reason: "look again" })).toEqual({ status: 200, json: { ref: "UNF-1", woke: "active" } });
  // The turn is saved just after the reasoner answers.
  await vi.waitFor(async () => {
    const { json } = await call(port, "GET", "/v1/tasks");
    expect(json.tasks).toEqual([expect.objectContaining({ ref: "UNF-1", status: "active", turns: 2, lastSummary: "turn 2: nothing to do yet" })]);
  }, { timeout: 5_000 });

  expect(await call(port, "POST", "/v1/tasks/UNF-7/wake", {})).toMatchObject({ status: 409, json: { error: { code: "conflict" } } });
}, 30_000);

test("every /v1 answer, a refusal too, says the oldest sgt it supports (TECH-5185)", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const port = await start(fakes().deps, {});
  for (const path of ["/v1/whoami", "/v1/nothing"]) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { [CLI_VERSION_HEADER]: MIN_CLI_VERSION } });
    expect([res.status, res.headers.get("Sergeant-Min-Cli-Version")]).toEqual([401, MIN_CLI_VERSION]);
  }
  expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).headers.get("Sergeant-Min-Cli-Version")).toBeNull();
}, 30_000);

test("a run view includes its provider choice and credential-free account", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const providerChoice = {
    adapter: "codex-local",
    reason: "more weekly quota",
    readings: [{ adapter: "codex-local", account: "installation-codex", readAt: "2026-10-03T12:00:00.000Z", weekly: { remainingPercent: 80 }, fiveHour: { remainingPercent: 90 } }],
  };
  const account = { id: "installation-codex", group: "owner", holder: "the installation" } as const;
  const run: RunRecord = {
    runId: "run_w1", role: "worker", status: "succeeded", provider: "openai/codex", model: "gpt-5", report: null,
    providerChoice, account, accountReason: "owner's account installation-codex",
  };
  const f = fakes([run]);
  await mkdir(join(dir, "tasks", "UNF-1"), { recursive: true });
  await writeFile(join(dir, "tasks", "UNF-1", "state.json"), JSON.stringify({
    issueId: "UNF-1", startedAt: new Date().toISOString(), turns: 1, runIds: [run.runId], recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 } },
  }));
  const port = await start(f.deps);

  expect(await call(port, "GET", `/v1/runs/${run.runId}`)).toEqual({
    status: 200,
    json: { task: "UNF-1", run },
  });
}, 30_000);

// TECH-5164: a task stuck replaying its accepted ending (a resolve that keeps failing, say) used to list
// only by its loop status or as inactive. Once the ending finishes, its state is set aside and the
// marker alone remains, so the summary no longer says the ending is pending.
test("a task summary shows a pending accepted ending and when it was accepted, and only while it is pending", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const f = fakes();
  f.conversation.issue.delegate = null;
  const acceptedAt = "2026-10-03T12:00:00.000Z";
  const state = (extra: object) => ({ issueId: "i1", startedAt: "2026-10-03T10:00:00.000Z", turns: 3, runIds: [], recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 } }, ...extra });
  const write = async (ref: string, files: Record<string, unknown>) => {
    await mkdir(join(dir, "tasks", ref), { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(join(dir, "tasks", ref, name), JSON.stringify(content));
  };
  await write("UNF-1", { "state.json": state({ accepted: { at: acceptedAt, replyId: "c1", comment: "Sergeant has stopped." } }) });
  await write("UNF-2", { "state.json": state({}) });
  await write("UNF-3", { [`state.accepted-${acceptedAt.replace(/[:.]/g, "-")}.json`]: state({ accepted: { at: acceptedAt, comment: "x" } }), "accepted.json": { at: acceptedAt } });
  const port = await start(f.deps);

  const { json } = await call(port, "GET", "/v1/tasks");
  expect(json.tasks).toEqual([
    expect.objectContaining({ ref: "UNF-1", status: "inactive", acceptedEnding: { since: acceptedAt } }),
    expect.not.objectContaining({ acceptedEnding: expect.anything() }),
    expect.not.objectContaining({ acceptedEnding: expect.anything() }),
  ]);
  expect(json.tasks.map((t: { ref: string }) => t.ref)).toEqual(["UNF-1", "UNF-2", "UNF-3"]);
  expect((await call(port, "GET", "/v1/tasks/UNF-1")).json.task.acceptedEnding).toEqual({ since: acceptedAt });
}, 30_000);
// The hosted proxy forwards to loopback, and a browser page can rebind a name to 127.0.0.1 or post a
// form at it: none of them is an operator on the host, even where loopback is trusted.
test("a trusted loopback still refuses a proxied request, a foreign Host, and a non-JSON post, while /health still answers", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const f = fakes();
  const port = await start(f.deps);
  await vi.waitFor(() => expect(f.turns()).toBe(1), { timeout: 5_000 });

  expect((await call(port, "GET", "/v1/tasks", undefined, { "X-Forwarded-For": "203.0.113.9" })).status).toBe(401);
  expect((await call(port, "GET", "/v1/tasks", undefined, { Forwarded: "for=203.0.113.9" })).status).toBe(401);
  expect((await call(port, "GET", "/v1/tasks", undefined, { Host: "sergeant.example.com" })).status).toBe(401);
  expect(await call(port, "POST", "/v1/tasks/UNF-1/cancel", "reason=x", { "Content-Type": "text/plain" })).toMatchObject({ status: 400 });
  expect(f.conversation.issue.delegate).not.toBeNull();
  expect((await call(port, "GET", "/health")).status).toBe(200);
  expect((await call(port, "GET", "/v1/whoami")).json).toEqual({ auth: "loopback", user: null, approver: true, enrolledRepositories: ["o/r"], registration: { providers: [] }, approvers: [] });
  await service?.stop();
  service = undefined;
  await expect(start(f.deps, { trustLoopback: true, host: "0.0.0.0" })).rejects.toThrow(/--trust-loopback/);
  // `localhost` is resolved when bound, and a resolver may send it anywhere.
  await expect(start(f.deps, { trustLoopback: true, host: "localhost" })).rejects.toThrow(/--trust-loopback/);
}, 30_000);

// The API fails closed: with no login, a login Linear rejects or cannot check, or a Linear user the
// installation does not admit, nothing is read or changed; an admitted user is named where they act.
test("only an admitted Linear user may call the API, and approvers are told apart", async () => {
  dir = await mkdtemp(join(tmpdir(), "sergeant-api-test-"));
  const f = fakes();
  const user = (id: string, over: Partial<LinearUser> = {}): LinearUser => ({ id, name: id, email: `${id}@example.com`, active: true, organizationId: "org", teamKeys: ["UNF"], ...over });
  const users: Record<string, LinearUser> = {
    member: user("Ada"),
    approver: user("Grace", { teamKeys: ["OPS", "UNF"] }),
    // A configured approver outside every allowed team is nobody here: approval adds to membership.
    strayApprover: user("Linus", { teamKeys: ["OPS"] }),
    outsider: user("Eve", { teamKeys: ["OPS"] }),
    elsewhere: user("Mallory", { organizationId: "other-org" }),
    former: user("Bob", { active: false }),
    agent: user("agent-v2"),
  };
  const callerOf = linearCallers({
    humans: { linearClientId: "client-1", teams: ["UNF"], approvers: ["Grace", "Linus"] },
    organizationId: "org",
    agentUserIds: [agent.id],
    lookup: async (token) => (token === "linear-down" ? Promise.reject(new Error("Linear API request failed (502)")) : users[token]),
  });
  const port = await start(f.deps, { humans: { callerOf, linearClientId: "client-1" } });
  await vi.waitFor(() => expect(f.turns()).toBe(1), { timeout: 5_000 });
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  expect(await call(port, "GET", "/v1/auth/config")).toEqual({ status: 200, json: { linear: { clientId: "client-1" } } });
  // Without trustLoopback, a caller on this host is nobody.
  expect(await call(port, "GET", "/v1/tasks")).toMatchObject({ status: 401, json: { error: { code: "unauthorized" } } });
  expect((await call(port, "POST", "/v1/tasks/UNF-1/cancel", { reason: "x" })).status).toBe(401);
  expect((await call(port, "POST", "/v1/tasks/UNF-1/cancel", { reason: "x" }, { Authorization: "Basic eDp5" })).status).toBe(401);
  expect((await call(port, "POST", "/v1/tasks/UNF-1/cancel", { reason: "x" }, as("revoked"))).status).toBe(401);
  expect((await call(port, "POST", "/v1/tasks/UNF-1/cancel", { reason: "x" }, as("linear-down"))).status).toBe(503);
  for (const refused of ["outsider", "strayApprover", "elsewhere", "former", "agent"]) {
    expect(await call(port, "POST", "/v1/tasks/UNF-1/cancel", { reason: "x" }, as(refused))).toMatchObject({ status: 403, json: { error: { code: "forbidden" } } });
  }
  expect(f.conversation.issue.delegate).not.toBeNull();

  expect((await call(port, "GET", "/v1/whoami", undefined, as("member"))).json).toEqual({
    auth: "linear",
    user: { id: "Ada", name: "Ada", email: "Ada@example.com" },
    approver: false,
    enrolledRepositories: ["o/r"],
    registration: { providers: [] },
    approvers: [],
  });
  expect((await call(port, "GET", "/v1/whoami", undefined, as("approver"))).json).toMatchObject({ user: { id: "Grace" }, approver: true });
  expect((await call(port, "POST", "/v1/tasks/UNF-1/cancel", { reason: "wrong approach" }, as("member"))).json).toMatchObject({ undelegated: true });
  expect(f.comments).toEqual([expect.objectContaining({ body: expect.stringContaining("the task was canceled by Ada: wrong approach") })]);
}, 30_000);
