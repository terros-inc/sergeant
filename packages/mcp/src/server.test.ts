import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { saveCredential } from "@terros/sergeant-contracts";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

// The real `sgt-mcp` process over stdio, as an MCP client starts it, against a fake Sergeant API:
// that its tools return the API's own answers (what `sgt task show` prints from), that failures are
// tool errors an agent can read, and that it only ever reads.

type Route = { status?: number; json?: unknown; text?: string; drop?: boolean; headers?: Record<string, string> };
let routes: Record<string, Route> = {};
const seen: string[] = [];
/** Each request's `Sergeant-Cli-Version`: the version sgt-mcp names so a Sergeant can refuse it (TECH-5188). */
const versions: (string | string[] | undefined)[] = [];
/** Each request's `Authorization`: the `sgt login` sgt-mcp sends (TECH-5123). */
const authorizations: (string | undefined)[] = [];
/** sgt-mcp's own config directory, where a test saves the login `sgt login` would. */
let config: string;
let server: Server;
let api: string;
let client: Client;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    versions.push(req.headers["sergeant-cli-version"]);
    authorizations.push(req.headers.authorization);
    const route = routes[`${req.method} ${req.url}`] ?? { status: 404, json: { error: { code: "not_found", message: `no ${req.url}` } } };
    if (route.drop) return req.socket.destroy();
    res.writeHead(route.status ?? 200, { "Content-Type": route.text === undefined ? "application/json" : "text/markdown", ...route.headers });
    res.end(route.text ?? JSON.stringify(route.json));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  api = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  config = await mkdtemp(join(tmpdir(), "sgt-mcp-test-"));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./sgt-mcp.ts", import.meta.url)), "--api", api],
    env: { XDG_CONFIG_HOME: config },
  });
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
});

beforeEach(async () => {
  routes = {};
  seen.length = 0;
  versions.length = 0;
  authorizations.length = 0;
  await saveCredential({ XDG_CONFIG_HOME: config }, api, undefined);
});

afterAll(async () => {
  await client?.close().catch(() => {});
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (config) await rm(config, { recursive: true, force: true });
});

const detail = {
  task: { ref: "UNF-12", status: "active", startedAt: "2026-10-02T10:00:00.000Z", turns: 2, lastTurnAt: "2026-10-02T10:30:00.000Z", runs: 1 },
  issue: { title: "Fix the login", state: "In Progress", url: "https://linear.app/x/issue/UNF-12", delegatedToSergeant: true, delegate: "Sergeant" },
  budget: { window: { wallMinutes: 120, costUsd: 25 }, wallDeadline: "2026-10-02T12:00:00.000Z", spentUsd: 3.5, costLimitUsd: 25, unknownCostRuns: 1, taskStart: "2026-10-02T10:00:00.000Z", windowStart: "2026-10-02T10:00:00.000Z" },
  runs: [{ runId: "run_w1", task: "UNF-12", role: "worker", status: "running", model: "opus" }],
  recentTurns: [{ at: "2026-10-02T10:30:00.000Z", summary: "Started a worker on the login fix", outcomes: ["start_worker: done"] }],
  followups: [],
};

const run = {
  task: "UNF-12",
  run: {
    runId: "run_w1",
    role: "worker",
    status: "succeeded",
    provider: "local",
    model: "opus",
    costUsd: 1.25,
    report: {
      reportVersion: "s2-worker-report/1",
      outcome: "completed",
      summary: "Fixed the login",
      pullRequests: [{ repo: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", headSha: "a".repeat(40), closesIssue: true, review: { required: true, reason: "auth" } }],
      knownGaps: [],
      followups: [],
    },
  },
};

test("an MCP client reads a task and its runs as the API answers them, through read-only tools that only GET", async () => {
  routes = {
    "GET /v1/tasks": { json: { tasks: [detail.task] } },
    "GET /v1/tasks/UNF-12": { json: detail },
    "GET /v1/runs?task=UNF-12": { json: { runs: detail.runs } },
    "GET /v1/runs/run_w1": { json: run },
    "GET /v1/runs/run_w1/report": { text: "# Report\n\nFixed the login\n" },
    "GET /health": { status: 503, json: { ok: false } },
  };

  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(["health", "run_list", "run_report", "run_show", "task_list", "task_show"]);
  expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);

  const shown = await client.callTool({ name: "task_show", arguments: { ref: "UNF-12" } });
  expect(shown.isError).toBeFalsy();
  expect(shown.structuredContent).toEqual(detail);
  expect(JSON.parse((shown.content as { text: string }[])[0]?.text ?? "")).toEqual(detail);

  expect((await client.callTool({ name: "task_list", arguments: {} })).structuredContent).toEqual({ tasks: [detail.task] });
  expect((await client.callTool({ name: "run_list", arguments: { task: "UNF-12" } })).structuredContent).toEqual({ runs: detail.runs });
  expect((await client.callTool({ name: "run_show", arguments: { run: "run_w1" } })).structuredContent).toEqual(run);
  expect((await client.callTool({ name: "run_report", arguments: { run: "run_w1" } })).content).toEqual([{ type: "text", text: "# Report\n\nFixed the login\n" }]);
  // An unhealthy service is an answer, not a tool failure.
  expect((await client.callTool({ name: "health", arguments: {} })).structuredContent).toEqual({ ok: false, api });

  expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
  expect(versions.filter((v) => typeof v !== "string" || !/^\d+\.\d+\.\d+/.test(v))).toEqual([]);
});

test("refusals, an unreachable API, answers outside the contract, and bad refs are tool errors, not guesses", async () => {
  routes = {
    "GET /v1/runs/run_x": { json: { task: "UNF-12", run: { runId: 7, role: "worker" } } },
    // TECH-5188: a Sergeant that supports only a newer sgt-mcp than this one refuses it.
    "GET /v1/tasks": { status: 400, json: { error: { code: "bad_request", message: "Your sgt is older than this Sergeant server supports. Run `sgt update`." } } },
  };
  const errorOf = async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError).toBe(true);
    return (res.content as { text: string }[])[0]?.text ?? "";
  };

  expect(JSON.parse(await errorOf("task_show", { ref: "UNF-99" }))).toEqual({ error: { code: "not_found", message: "no /v1/tasks/UNF-99" } });
  expect(await errorOf("run_show", { run: "run_x" })).toContain("outside the API contract");
  expect(await errorOf("task_show", { ref: "not a ref" })).toMatch(/Linear issue identifier/);
  expect(JSON.parse(await errorOf("task_list", {})).error.message).toBe("Your sgt is older than this Sergeant server supports. Run `sgt update`.");
  expect(seen).toEqual(["GET /v1/tasks/UNF-99", "GET /v1/runs/run_x", "GET /v1/tasks"]);

  // Dropping the API connection exercises the same fetch rejection as an unreachable port without
  // paying for another cold `sgt-mcp` process in this integration suite.
  routes["GET /v1/tasks"] = { drop: true };
  const res = await client.callTool({ name: "task_list", arguments: {} });
  expect(res.isError).toBe(true);
  const error = JSON.parse((res.content as { text: string }[])[0]?.text ?? "").error;
  expect(error.code).toBe("unavailable");
  expect(error.message).toMatch(/cannot reach the Sergeant API/);
});

// TECH-5123: from a laptop, against the hosted API, sgt-mcp is the person whose `sgt login` is saved
// for its API URL, read on every call so a login made or renewed after it started is used.
test("sgt-mcp sends the saved sgt login, and a missing, refused, or expired one says to run sgt login", async () => {
  const env = { XDG_CONFIG_HOME: config };
  routes = { "GET /v1/tasks": { status: 401, json: { error: { code: "unauthorized", message: "the Sergeant API needs your Linear login: run `sgt login`" } } } };
  const errorOf = async (name: string) => {
    const res = await client.callTool({ name, arguments: {} });
    expect(res.isError).toBe(true);
    return JSON.parse((res.content as { text: string }[])[0]?.text ?? "").error;
  };

  expect(await errorOf("task_list")).toEqual({
    code: "unauthorized",
    message: `the Sergeant API needs your Linear login: run \`sgt login\` (sgt-mcp sends the login \`sgt login --api ${api}\` saved on this machine; there is none)`,
  });
  expect(authorizations).toEqual([undefined]);

  // Saved after sgt-mcp started, as `sgt login` would, and sent as the bearer from then on.
  await saveCredential(env, api, { clientId: "client-1", accessToken: "token-1", refreshToken: "refresh-1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  routes = { "GET /v1/tasks": { json: { tasks: [detail.task] } }, "GET /v1/runs/run_w1/report": { text: "# Report\n" } };
  expect((await client.callTool({ name: "task_list", arguments: {} })).structuredContent).toEqual({ tasks: [detail.task] });
  expect((await client.callTool({ name: "run_report", arguments: { run: "run_w1" } })).isError).toBeFalsy();
  expect(authorizations).toEqual([undefined, "Bearer token-1", "Bearer token-1"]);

  // An expired login that cannot be renewed is refused before anything is sent.
  await saveCredential(env, api, { clientId: "client-1", accessToken: "token-1", expiresAt: new Date(Date.now() - 60_000).toISOString() });
  expect(await errorOf("task_list")).toEqual({
    code: "unauthorized",
    message: `your Linear login expired: run \`sgt login\` again (sgt-mcp sends the login \`sgt login --api ${api}\` saved on this machine)`,
  });
  expect(authorizations).toHaveLength(3);
});
