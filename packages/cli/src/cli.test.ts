import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";
import { main } from "./cli.ts";

// `sgt` against a fake Sergeant API: what it sends, what it prints for a human, and that `--json` is
// the API's own answer, errors included, so Firstmate tooling can parse every outcome.

type Seen = { method: string; url: string; body: string; contentType: string | undefined };
let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function fakeApi(routes: Record<string, { status?: number; json?: unknown; text?: string }>) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body, contentType: req.headers["content-type"] });
      const route = routes[`${req.method} ${req.url}`] ?? { status: 404, json: { error: { code: "not_found", message: `no ${req.url}` } } };
      res.writeHead(route.status ?? 200, { "Content-Type": route.text === undefined ? "application/json" : "text/markdown" });
      res.end(route.text ?? JSON.stringify(route.json));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const api = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return { api, seen };
}

async function sgt(api: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, { env: { SGT_API_URL: api }, out: (t) => (out += t), err: (t) => (err += t) });
  return { code, out, err };
}

const detail = {
  task: { ref: "UNF-12", status: "active", startedAt: "2026-10-02T10:00:00.000Z", turns: 2, lastTurnAt: "2026-10-02T10:30:00.000Z", runs: 1 },
  issue: { title: "Fix the login", state: "In Progress", url: "https://linear.app/x/issue/UNF-12", delegatedToSergeant: true, delegate: "Sergeant" },
  budget: {
    window: { wallMinutes: 120, costUsd: 25 },
    wallDeadline: "2026-10-02T12:00:00.000Z",
    spentUsd: 3.5,
    costLimitUsd: 25,
    unknownCostRuns: 1,
    grants: [],
  },
  runs: [{ runId: "run_w1", task: "UNF-12", role: "worker", status: "running", model: "opus" }],
  recentTurns: [{ at: "2026-10-02T10:30:00.000Z", summary: "Started a worker on the login fix", outcomes: ["start_worker: done"] }],
  followups: [],
};

test("task show prints the facts an operator acts on, and --json is the API's answer unchanged", async () => {
  const { api } = await fakeApi({ "GET /v1/tasks/UNF-12": { json: detail } });

  const human = await sgt(api, "task", "show", "UNF-12");
  expect(human.code).toBe(0);
  expect(human.out).toContain("UNF-12  active  Fix the login");
  expect(human.out).toContain("budget: $3.50 of $25.00 (+1 run not yet costed)");
  expect(human.out).toMatch(/run_w1\s+worker\s+running/);
  expect(human.out).toContain("Started a worker on the login fix");

  const json = await sgt(api, "--json", "task", "show", "UNF-12");
  expect(JSON.parse(json.out)).toEqual(detail);
});

test("task cancel requires a reason before calling the API, then posts it as JSON with a request id", async () => {
  const { api, seen } = await fakeApi({ "POST /v1/tasks/UNF-12/cancel": { json: { ref: "UNF-12", undelegated: true, stopping: [] } } });

  const missing = await sgt(api, "task", "cancel", "UNF-12");
  expect(missing.code).toBe(2);
  expect(missing.err).toContain("task cancel needs --reason");
  expect(seen).toEqual([]);

  const done = await sgt(api, "task", "cancel", "UNF-12", "--reason", "wrong approach");
  expect(done).toMatchObject({ code: 0, out: expect.stringContaining("UNF-12 canceled") });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.contentType).toBe("application/json");
  expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ reason: "wrong approach", requestId: expect.stringMatching(/^[\w-]+$/) });
});

test("a refusal, an off-contract answer, and an unreachable API each exit 1 with a usable error", async () => {
  const refusal = { error: { code: "conflict", message: "UNF-7 is not delegated to Sergeant's agent" } };
  const { api } = await fakeApi({
    "POST /v1/tasks/UNF-7/wake": { status: 409, json: refusal },
    "GET /v1/tasks": { json: { tasks: [{ ref: "UNF-1" }] } },
  });

  const human = await sgt(api, "task", "wake", "UNF-7");
  expect(human).toEqual({ code: 1, out: "", err: "sgt: conflict: UNF-7 is not delegated to Sergeant's agent\n" });
  const json = await sgt(api, "--json", "task", "wake", "UNF-7");
  expect([json.code, JSON.parse(json.out)]).toEqual([1, refusal]);

  const drift = await sgt(api, "task", "list");
  expect(drift.code).toBe(1);
  expect(drift.err).toContain("outside the API contract");

  const down = await sgt("http://127.0.0.1:9", "--json", "whoami");
  expect(down.code).toBe(1);
  expect(JSON.parse(down.out).error).toMatchObject({ code: "unavailable", message: expect.stringContaining("SSM port-forward") });
});
