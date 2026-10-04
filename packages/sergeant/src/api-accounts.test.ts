import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CLI_VERSION_HEADER, MIN_CLI_VERSION, type QuotaReading, type RunRecord } from "@terros/sergeant-contracts";
import type { QuotaAccount } from "@terros/sergeant-runner";
import { accountRegistry } from "./accounts.ts";
import { apiHandler, type ApiControl } from "./api.ts";
import type { Caller } from "./auth.ts";

// TECH-5113: people register and remove their own model account through the authenticated API. The
// registry's secret is the only place a credential goes: never a response, a log line, or an error,
// and nobody can remove, or overwrite, someone else's.

const ADA = { id: "u-ada", name: "Ada Example", email: "ada@example.com" };
const BOB = { id: "u-bob", name: "Bob Example", email: "bob@example.com" };
const CLAUDE = "sk-ant-oat01-ada-personal";
const callers: Record<string, Caller> = {
  ada: { kind: "linear", user: ADA, approver: false },
  bob: { kind: "linear", user: BOB, approver: false },
  grace: { kind: "linear", user: { id: "u-grace", name: "Grace Example", email: "grace@example.com" }, approver: true },
};

let dir = "";
let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

const readable = async ({ id, adapter, credential }: QuotaAccount): Promise<QuotaReading> =>
  credential.includes("expired")
    ? { adapter, account: id, readAt: "2026-10-03T12:00:00.000Z", error: "usage endpoint answered 401" }
    : { adapter, account: id, readAt: "2026-10-03T12:00:00.000Z", weekly: { remainingPercent: 70 }, fiveHour: { remainingPercent: 90 } };

async function serve(runs: RunRecord[] = []) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-accounts-test-"));
  const secrets: Record<string, string> = { "sergeant/x/registered-accounts": '{"accounts":[]}' };
  const logs: string[] = [];
  const accounts = accountRegistry({
    secret: "sergeant/x/registered-accounts",
    readSecret: async (ref) => secrets[ref] ?? Promise.reject(new Error(`no ${ref}`)),
    writeSecret: async (ref, value) => void (secrets[ref] = value),
    adapters: ["claude-code-local"],
    readQuota: readable,
    log: (line) => logs.push(line),
  });
  // One task whose runs the accounts paid for.
  await mkdir(join(dir, "tasks", "UNF-1"), { recursive: true });
  const state = { issueId: "UNF-1", startedAt: "2026-10-03T00:00:00.000Z", turns: 1, runIds: runs.map((r) => r.runId), recentTurns: [], budget: { window: { wallMinutes: 120, costUsd: 25 } } };
  await writeFile(join(dir, "tasks", "UNF-1", "state.json"), JSON.stringify(state));
  const ctl = {
    stateDir: dir,
    enrolledRepositories: [],
    deps: { runner: { status: async (runId: string) => runs.find((r) => r.runId === runId) ?? Promise.reject(new Error("no run")) } },
    log: (line: string) => logs.push(line),
    loop: () => undefined,
    known: () => [],
    callerOf: async (token: string) => callers[token] ?? Promise.reject(new Error("unknown")),
    trustLoopback: true,
    accounts,
  } as unknown as ApiControl;
  server = createServer(apiHandler(ctl));
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, as?: string, body?: unknown) =>
    new Promise<{ status: number; json: any; text: string }>((resolve, reject) => {
      const headers = { [CLI_VERSION_HEADER]: MIN_CLI_VERSION, ...(body !== undefined && { "Content-Type": "application/json" }), ...(as && { Authorization: `Bearer ${as}` }) };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined, text }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { call, secrets, logs, accounts };
}

test("a person registers, replaces, and removes only their own account, and its credential stays in the secret", async () => {
  const { call, secrets, logs } = await serve();

  const registered = await call("POST", "/v1/accounts/register", "ada", { provider: "claude", name: "claude", credential: CLAUDE });
  expect(registered).toMatchObject({
    status: 200,
    json: { account: { id: "person:u-ada:claude", group: "registered", holder: "Ada Example <ada@example.com>", mine: true }, replaced: false, quota: { weekly: { remainingPercent: 70 } } },
  });
  expect(JSON.parse(secrets["sergeant/x/registered-accounts"] ?? "").accounts).toEqual([expect.objectContaining({ userId: "u-ada", credential: CLAUDE })]);
  // The accepted exposure (09 §3a) is said at registration: where the credential goes, that it can leak, and the way out.
  const { notice } = registered.json;
  expect(notice).toContain("inside Sergeant's worker and reviewer containers");
  expect(notice).toContain("Register your Terros company seat (for example Claude Team or ChatGPT Team), not a personal subscription");
  expect(notice).toContain("could be exposed if a run is compromised");
  expect(notice).toContain("`sgt account remove claude`");
  expect(notice).toContain("`claude setup-token`");

  // Bob sees it is not his, and his remove leaves Ada's alone; a loopback operator is nobody's.
  const listed = await call("GET", "/v1/accounts", "bob");
  expect(listed.json.accounts.map((a: { id: string; mine: boolean }) => [a.id, a.mine])).toEqual([["person:u-ada:claude", false]]);
  expect(await call("POST", "/v1/accounts/remove", "bob", { name: "claude" })).toMatchObject({ status: 200, json: { removed: false } });
  expect(await call("POST", "/v1/accounts/remove", undefined, { name: "claude" })).toMatchObject({ status: 403 });
  expect(JSON.parse(secrets["sergeant/x/registered-accounts"] ?? "").accounts).toHaveLength(1);

  // A re-registration replaces Ada's own; an unreadable credential is refused and changes nothing.
  expect(await call("POST", "/v1/accounts/register", "ada", { provider: "claude", name: "claude", credential: "sk-ant-oat01-ada-new" })).toMatchObject({ json: { replaced: true } });
  const refused = await call("POST", "/v1/accounts/register", "ada", { provider: "claude", name: "claude", credential: "sk-ant-oat01-expired" });
  expect(refused).toMatchObject({ status: 400, json: { error: { message: expect.stringContaining("usage endpoint answered 401") } } });
  expect(await call("POST", "/v1/accounts/register", "ada", { provider: "codex", name: "codex", credential: "{}" })).toMatchObject({ status: 400 });
  expect(JSON.parse(secrets["sergeant/x/registered-accounts"] ?? "").accounts).toEqual([expect.objectContaining({ credential: "sk-ant-oat01-ada-new" })]);

  expect(await call("POST", "/v1/accounts/remove", "ada", { name: "claude" })).toMatchObject({ status: 200, json: { removed: true } });
  expect(JSON.parse(secrets["sergeant/x/registered-accounts"] ?? "").accounts).toEqual([]);

  for (const said of [registered.text, listed.text, refused.text, ...logs]) expect(said).not.toMatch(/sk-ant-oat01-(ada|expired)/);
  expect(logs).toContain("Ada Example registered their claude-code-local model account claude");
});

// TECH-5179: a task's runs get only its owner's registered accounts: never someone else's, and never
// an empty list standing in for an unreadable secret.
test("the runner reads only the task owner's own accounts", async () => {
  const { call, accounts, secrets } = await serve();
  await call("POST", "/v1/accounts/register", "ada", { provider: "claude", name: "claude", credential: CLAUDE });
  await call("POST", "/v1/accounts/register", "bob", { provider: "claude", name: "claude", credential: "sk-ant-oat01-bob" });
  expect((await accounts.of(BOB.id)).map((a) => [a.id, a.credential])).toEqual([["person:u-bob:claude", "sk-ant-oat01-bob"]]);
  expect(await accounts.of("u-carol")).toEqual([]);
  secrets["sergeant/x/registered-accounts"] = "not json";
  await expect(accounts.of(ADA.id)).rejects.toThrow(/is not/);
});

// TECH-5196: a person keeps several accounts, a provider's more than once, each under a name of theirs.
// Registering a name again replaces that one alone.
test("a person's accounts are named, and only the named one is replaced or removed", async () => {
  const { call, accounts, secrets } = await serve();
  const mine = async () => (await accounts.of(ADA.id)).map((a) => [a.id, a.credential]);
  await call("POST", "/v1/accounts/register", "ada", { provider: "claude", name: "claude", credential: "sk-ant-oat01-first" });

  const work = await call("POST", "/v1/accounts/register", "ada", { provider: "claude", name: "claudeWork", credential: "sk-ant-oat01-work" });
  expect(work).toMatchObject({ json: { account: { id: "person:u-ada:claudeWork", name: "claudeWork" }, replaced: false } });
  expect(work.json.notice).toContain("`sgt account remove claudeWork`");
  expect(await call("POST", "/v1/accounts/register", "ada", { provider: "claude", name: "claude", credential: "sk-ant-oat01-new" })).toMatchObject({ json: { replaced: true } });
  expect(await mine()).toEqual([["person:u-ada:claudeWork", "sk-ant-oat01-work"], ["person:u-ada:claude", "sk-ant-oat01-new"]]);
  expect(JSON.parse(secrets["sergeant/x/registered-accounts"] ?? "").accounts.map((e: { accountName: string }) => e.accountName)).toEqual(["claudeWork", "claude"]);
  expect(await call("POST", "/v1/accounts/register", "ada", { provider: "claude", name: "my work", credential: "sk-ant-oat01-x" })).toMatchObject({ status: 400 });

  expect(await call("POST", "/v1/accounts/remove", "ada", { name: "claudeWork" })).toMatchObject({ json: { name: "claudeWork", removed: true } });
  expect(await mine()).toEqual([["person:u-ada:claude", "sk-ant-oat01-new"]]);
});

test("each account's usage is the runs it paid for", async () => {
  const run = (runId: string, account: string, costUsd?: number): RunRecord => ({
    runId,
    role: "worker",
    status: "succeeded",
    provider: "anthropic/claude-code",
    model: "opus",
    report: null,
    ...(costUsd !== undefined && { costUsd }),
    account: { id: account, group: "registered", holder: account },
  });
  const ada = "person:u-ada:claude";
  const bob = "person:u-bob:claude";
  const { call } = await serve([run("run_a", ada, 1.5), run("run_b", ada), run("run_c", bob, 2)]);
  await call("POST", "/v1/accounts/register", "ada", { provider: "claude", name: "claude", credential: CLAUDE });
  await call("POST", "/v1/accounts/register", "bob", { provider: "claude", name: "claude", credential: "sk-ant-oat01-bob" });
  const { json } = await call("GET", "/v1/accounts", "ada");
  expect(json.accounts.map((a: { id: string; usage: unknown }) => [a.id, a.usage])).toEqual([
    [ada, { runs: 2, costUsd: 1.5, unknownCostRuns: 1 }],
    [bob, { runs: 1, costUsd: 2, unknownCostRuns: 0 }],
  ]);
  expect((await call("GET", "/v1/runs", "ada")).json.runs[0]).toMatchObject({ runId: "run_a", account: ada });
});

// TECH-5130: offboarding. An approver, or an operator on the host, removes everything one person
// registered; nobody else can remove another person's accounts, and nobody else's are touched.
test("an approver removes every account a person registered, and only theirs", async () => {
  const { call, secrets, logs } = await serve();
  const stored = () => JSON.parse(secrets["sergeant/x/registered-accounts"] ?? "").accounts.map((e: { userId: string }) => e.userId);
  await call("POST", "/v1/accounts/register", "ada", { provider: "claude", name: "claude", credential: CLAUDE });
  await call("POST", "/v1/accounts/register", "bob", { provider: "claude", name: "claude", credential: "sk-ant-oat01-bob-personal" });

  expect(await call("POST", "/v1/accounts/remove-person", "bob", { userId: "u-ada" })).toMatchObject({ status: 403 });
  expect(await call("POST", "/v1/accounts/remove-person", "grace", {})).toMatchObject({ status: 400 });
  expect(stored()).toEqual(["u-ada", "u-bob"]);

  const removed = await call("POST", "/v1/accounts/remove-person", "grace", { userId: "u-ada" });
  expect(removed).toMatchObject({
    status: 200,
    json: { userId: "u-ada", removed: [{ id: "person:u-ada:claude", adapter: "claude-code-local", holder: "Ada Example <ada@example.com>" }] },
  });
  expect(removed.text).not.toContain(CLAUDE);
  expect(stored()).toEqual(["u-bob"]);
  expect(logs).toContain("Grace Example removed Ada Example <ada@example.com>'s claude-code-local model account");

  // Removing someone with nothing registered is no error; a loopback operator may offboard too.
  expect(await call("POST", "/v1/accounts/remove-person", "grace", { userId: "u-ada" })).toMatchObject({ status: 200, json: { removed: [] } });
  expect(await call("POST", "/v1/accounts/remove-person", undefined, { userId: "u-bob" })).toMatchObject({ status: 200, json: { removed: [{ id: "person:u-bob:claude" }] } });
  expect(stored()).toEqual([]);
});
