import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { QuotaReading, RunRecord } from "@terros/sergeant-contracts";
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
  const installation = { id: "installation-claude", adapter: "claude-code-local", group: "owner", holder: "the installation", credential: "sk-ant-oat01-terros" } as const;
  const accounts = accountRegistry({
    installation: [installation],
    owners: [{ ...installation, id: "terros-claude-2", holder: "terros-claude-2", credential: "sk-ant-oat01-terros-2" }],
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
      const headers = { ...(body !== undefined && { "Content-Type": "application/json" }), ...(as && { Authorization: `Bearer ${as}` }) };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined, text }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { call, secrets, logs };
}

test("a person registers, replaces, and removes only their own account, and its credential stays in the secret", async () => {
  const { call, secrets, logs } = await serve();

  const registered = await call("POST", "/v1/accounts/claude-code-local/register", "ada", { credential: CLAUDE });
  expect(registered).toMatchObject({
    status: 200,
    json: { account: { id: "person:u-ada:claude-code-local", group: "registered", holder: "Ada Example <ada@example.com>", mine: true }, replaced: false, quota: { weekly: { remainingPercent: 70 } } },
  });
  expect(JSON.parse(secrets["sergeant/x/registered-accounts"] ?? "").accounts).toEqual([expect.objectContaining({ userId: "u-ada", credential: CLAUDE })]);

  // Bob sees it is not his, and his remove leaves Ada's alone; a loopback operator is nobody's.
  const listed = await call("GET", "/v1/accounts", "bob");
  expect(listed.json.accounts.map((a: { id: string; mine: boolean }) => [a.id, a.mine])).toEqual([
    ["installation-claude", false],
    ["terros-claude-2", false],
    ["person:u-ada:claude-code-local", false],
  ]);
  expect(await call("POST", "/v1/accounts/claude-code-local/remove", "bob")).toMatchObject({ status: 200, json: { removed: false } });
  expect(await call("POST", "/v1/accounts/claude-code-local/remove")).toMatchObject({ status: 403 });
  expect(JSON.parse(secrets["sergeant/x/registered-accounts"] ?? "").accounts).toHaveLength(1);

  // A re-registration replaces Ada's own; an unreadable credential is refused and changes nothing.
  expect(await call("POST", "/v1/accounts/claude-code-local/register", "ada", { credential: "sk-ant-oat01-ada-new" })).toMatchObject({ json: { replaced: true } });
  const refused = await call("POST", "/v1/accounts/claude-code-local/register", "ada", { credential: "sk-ant-oat01-expired" });
  expect(refused).toMatchObject({ status: 400, json: { error: { message: expect.stringContaining("usage endpoint answered 401") } } });
  expect(await call("POST", "/v1/accounts/codex-local/register", "ada", { credential: "{}" })).toMatchObject({ status: 400 });
  expect(JSON.parse(secrets["sergeant/x/registered-accounts"] ?? "").accounts).toEqual([expect.objectContaining({ credential: "sk-ant-oat01-ada-new" })]);

  expect(await call("POST", "/v1/accounts/claude-code-local/remove", "ada")).toMatchObject({ status: 200, json: { removed: true } });
  expect(JSON.parse(secrets["sergeant/x/registered-accounts"] ?? "").accounts).toEqual([]);

  for (const said of [registered.text, listed.text, refused.text, ...logs]) expect(said).not.toMatch(/sk-ant-oat01-(ada|expired|terros)/);
  expect(logs).toContain("Ada Example registered their claude-code-local model account");
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
    account: { id: account, group: "owner", holder: account },
  });
  const { call } = await serve([run("run_a", "installation-claude", 1.5), run("run_b", "installation-claude"), run("run_c", "terros-claude-2", 2)]);
  const { json } = await call("GET", "/v1/accounts", "ada");
  expect(json.accounts.map((a: { id: string; usage: unknown }) => [a.id, a.usage])).toEqual([
    ["installation-claude", { runs: 2, costUsd: 1.5, unknownCostRuns: 1 }],
    ["terros-claude-2", { runs: 1, costUsd: 2, unknownCostRuns: 0 }],
  ]);
  expect((await call("GET", "/v1/runs", "ada")).json.runs[0]).toMatchObject({ runId: "run_a", account: "installation-claude" });
});
