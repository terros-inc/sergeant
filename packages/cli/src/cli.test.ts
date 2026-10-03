import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main, type Io } from "./cli.ts";
import { TOKEN_URL } from "./login.ts";

// `sgt` against a fake Sergeant API: what it sends, what it prints for a human, and that `--json` is
// the API's own answer, errors included, so Firstmate tooling can parse every outcome.

type Seen = { method: string; url: string; body: string; contentType: string | undefined; authorization: string | undefined };
let server: Server | undefined;
// Each test's own config directory, so no test reads or writes this machine's real login.
let config = "";
beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), "sgt-test-"));
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await rm(config, { recursive: true, force: true });
});

async function fakeApi(routes: Record<string, { status?: number; json?: unknown; text?: string }>) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body, contentType: req.headers["content-type"], authorization: req.headers.authorization });
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
  return sgtWith({}, api, ...argv);
}

async function sgtWith(io: Partial<Io>, api: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const code = await main(argv, { env: { SGT_API_URL: api, XDG_CONFIG_HOME: config, SGT_LOGIN_PORT: "0" }, out: (t) => (out += t), err: (t) => (err += t), ...io });
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
    taskStart: "2026-10-02T10:00:00.000Z",
    windowStart: "2026-10-02T10:00:00.000Z",
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
  expect(human.out).toContain("budget: $3.50 of $25.00 (+1 run of unknown cost)");
  expect(human.out).toMatch(/run_w1\s+worker\s+running/);
  expect(human.out).toContain("Started a worker on the login fix");

  const json = await sgt(api, "--json", "task", "show", "UNF-12");
  expect(JSON.parse(json.out)).toEqual(detail);
});

// TECH-5148: the client's RunDetail parse strips unknown keys, so the provider choice and account
// must be in its schema to reach `sgt run show` and `--json`.
test("run show prints the run's account, provider and quota, and --json keeps them", async () => {
  const run = {
    runId: "run_w1", role: "worker", status: "succeeded", provider: "openai/codex", model: "gpt-5", report: null, costUsd: 0,
    providerChoice: {
      adapter: "codex-local",
      reason: "more weekly quota",
      readings: [{ adapter: "codex-local", account: "installation-codex", readAt: "2026-10-03T12:00:00.000Z", weekly: { remainingPercent: 80 }, fiveHour: { remainingPercent: 90 } }],
    },
    account: { id: "installation-codex", group: "owner", holder: "the installation" },
    accountReason: "owner's account installation-codex",
  };
  const { api } = await fakeApi({ "GET /v1/runs/run_w1": { json: { task: "UNF-12", run } } });

  const human = await sgt(api, "run", "show", "run_w1");
  expect(human.code).toBe(0);
  expect(human.out).toContain("account: installation-codex (the installation), owner's account installation-codex");
  expect(human.out).toContain("provider: codex-local, more weekly quota");
  expect(human.out).toContain("quota: codex-local 80% weekly, 90% 5-hour left");

  const json = await sgt(api, "--json", "run", "show", "run_w1");
  expect(JSON.parse(json.out)).toEqual({ task: "UNF-12", run });
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

// An operator must see which worker PRs a cancel closed without opening Linear, and a Sergeant that
// predates the field must still answer in contract.
test("task cancel lists the PRs the cancel closed, and reads an answer without them", async () => {
  const pr = { repo: "terros-inc/sergeant", number: 7, url: "https://github.com/terros-inc/sergeant/pull/7" };
  const { api } = await fakeApi({
    "POST /v1/tasks/UNF-12/cancel": { json: { ref: "UNF-12", undelegated: true, stopping: [], closedPullRequests: [pr] } },
    "POST /v1/tasks/UNF-13/cancel": { json: { ref: "UNF-13", undelegated: false, stopping: [] } },
    "POST /v1/tasks/UNF-15/cancel": { json: { ref: "UNF-15", undelegated: true, stopping: [], closedPullRequests: [] } },
    "POST /v1/tasks/UNF-14/cancel": { json: { ref: "UNF-14", undelegated: true, stopping: ["run_w1"], closedPullRequests: [] } },
  });

  const closed = await sgt(api, "task", "cancel", "UNF-12", "--reason", "wrong approach");
  expect(closed).toEqual({
    code: 0,
    out: "UNF-12 canceled: Sergeant's delegation is removed and no run of it is running\nclosed terros-inc/sergeant#7  https://github.com/terros-inc/sergeant/pull/7\n",
    err: "",
  });
  const json = await sgt(api, "--json", "task", "cancel", "UNF-12", "--reason", "wrong approach");
  expect(JSON.parse(json.out)).toEqual({ ref: "UNF-12", undelegated: true, stopping: [], closedPullRequests: [pr] });

  const none = await sgt(api, "task", "cancel", "UNF-15", "--reason", "wrong approach");
  expect(none.out).toBe("UNF-15 canceled: Sergeant's delegation is removed and no run of it is running\nno open worker PR to close\n");

  // An older answer says nothing of PRs: the CLI cannot know none was closed, and --json adds nothing.
  const old = await sgt(api, "task", "cancel", "UNF-13", "--reason", "wrong approach");
  expect(old).toMatchObject({ code: 0, out: "UNF-13 canceled: Sergeant was already not delegated and no run of it is running\n" });
  const oldJson = await sgt(api, "--json", "task", "cancel", "UNF-13", "--reason", "wrong approach");
  expect(JSON.parse(oldJson.out)).toStrictEqual({ ref: "UNF-13", undelegated: false, stopping: [] });

  const stopping = await sgt(api, "task", "cancel", "UNF-14", "--reason", "wrong approach");
  expect(stopping).toMatchObject({ code: 0, out: expect.stringContaining("Sergeant keeps canceling: run_w1") });
  expect(stopping.out).toContain("Its open PRs are closed once they stop.");
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
  expect(JSON.parse(down.out).error).toMatchObject({ code: "unavailable", message: expect.stringContaining("hosted HTTPS endpoint") });
});

// `sgt login` against a fake Linear: the PKCE proof travels with the code and no client secret exists,
// a redirect this login did not start is refused, the login is kept where only its owner can read
// it, even when it replaces a file others could read, and every later call sends it, renewed before it expires.
test("login signs in through the browser with PKCE, keeps the token privately, and sends it renewed", async () => {
  const me = { auth: "linear", user: { id: "u1", name: "Ada", email: "ada@example.com" }, approver: false, enrolledRepositories: ["o/r"] };
  const { api, seen } = await fakeApi({ "GET /v1/auth/config": { json: { linear: { clientId: "client-1" } } }, "GET /v1/whoami": { json: me }, "GET /v1/tasks": { json: { tasks: [] } } });
  const tokenRequests: URLSearchParams[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    if (String(url) !== TOKEN_URL) return globalThis.fetch(url, init);
    tokenRequests.push(new URLSearchParams(String(init?.body)));
    return Response.json({ access_token: `token-${tokenRequests.length}`, refresh_token: "refresh-1", expires_in: 86_400 });
  };
  let authorize: URL | undefined;
  // The human's browser: Linear sends it back to the redirect with a code and the login's state.
  const browser = (state?: string) => (url: string) => {
    authorize = new URL(url);
    const redirect = new URL(authorize.searchParams.get("redirect_uri") ?? "");
    redirect.search = new URLSearchParams({ code: "code-1", state: state ?? authorize.searchParams.get("state") ?? "" }).toString();
    void globalThis.fetch(redirect).catch(() => {});
  };
  const credentials = join(config, "sergeant", "credentials.json");

  const forged = await sgtWith({ fetch, openUrl: browser("forged") }, api, "login");
  expect(forged).toMatchObject({ code: 1, err: expect.stringContaining("different login's state") });
  expect(tokenRequests).toEqual([]);

  const login = await sgtWith({ fetch, openUrl: browser() }, api, "login");
  expect(login).toMatchObject({ code: 0, out: `signed in to ${api} as Ada <ada@example.com>\n` });
  expect(Object.fromEntries(authorize?.searchParams ?? [])).toMatchObject({ client_id: "client-1", actor: "user", scope: "read", code_challenge_method: "S256" });
  const exchange = tokenRequests[0];
  expect(exchange?.get("client_secret")).toBeNull();
  expect(createHash("sha256").update(exchange?.get("code_verifier") ?? "").digest("base64url")).toBe(authorize?.searchParams.get("code_challenge"));
  expect(seen.find((r) => r.url === "/v1/whoami")?.authorization).toBe("Bearer token-1");
  expect((await stat(credentials)).mode & 0o777).toBe(0o600);

  await sgt(api, "task", "list");
  expect(seen.at(-1)?.authorization).toBe("Bearer token-1");

  const saved = JSON.parse(await readFile(credentials, "utf8"));
  saved[api].expiresAt = new Date(Date.now() + 60_000).toISOString();
  await writeFile(credentials, JSON.stringify(saved));
  // A login file others can read (left by an older sgt, or a careless copy) never receives the renewed token.
  await chmod(credentials, 0o644);
  const broad = await open(credentials, "r");
  await sgtWith({ fetch }, api, "task", "list");
  expect(tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
  expect(seen.at(-1)?.authorization).toBe("Bearer token-2");
  expect(await broad.readFile("utf8")).not.toContain("token-2");
  await broad.close();
  expect((await stat(credentials)).mode & 0o777).toBe(0o600);

  expect(await sgt(api, "logout")).toMatchObject({ code: 0, out: expect.stringContaining("signed out") });
  await sgt(api, "task", "list");
  expect(seen.at(-1)?.authorization).toBeUndefined();
});

test("-v and --version print Sergeant's git version and exit 0 without touching the API", async () => {
  // A fetch that fails the test if the version flag reaches the API; no server is running either.
  const fetch = (() => {
    throw new Error("version must not call the API");
  }) as unknown as typeof globalThis.fetch;
  const line = /^sgt \d+\.\d+\.\d+\+([0-9a-f]{7,}|unknown)\n$/;

  for (const flag of ["-v", "--version"]) {
    const human = await sgtWith({ fetch }, "http://127.0.0.1:0", flag);
    expect(human.code).toBe(0);
    expect(human.out).toMatch(line);
    expect(human.err).toBe("");

    const json = await sgtWith({ fetch }, "http://127.0.0.1:0", "--json", flag);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out);
    expect(parsed).toEqual({ version: expect.stringMatching(/^\d+\.\d+\.\d+\+([0-9a-f]{7,}|unknown)$/) });
  }
});

// TECH-5113: a credential is read from stdin, never an argument a shell history or process list keeps,
// and only the API's answer, which never holds it, is printed.
test("account register posts the credential read from stdin and prints the account without it", async () => {
  const account = { id: "person:u1:codex-local", group: "registered", holder: "Ada Example <ada@example.com>", adapter: "codex-local", mine: true };
  const { api, seen } = await fakeApi({
    "POST /v1/accounts/codex-local/register": { json: { account, replaced: false, quota: { adapter: "codex-local", readAt: "t", weekly: { remainingPercent: 82 }, fiveHour: { remainingPercent: 99 } } } },
    "GET /v1/accounts": { json: { accounts: [{ ...account, usage: { runs: 3, costUsd: 0, unknownCostRuns: 3 } }] } },
  });
  const credential = '{"tokens":{"access_token":"secret-access"}}';

  const empty = await sgtWith({ stdin: async () => "\n" }, api, "account", "register", "codex-local");
  expect(empty.code).toBe(2);
  expect(seen).toEqual([]);

  const done = await sgtWith({ stdin: async () => `${credential}\n` }, api, "account", "register", "codex-local");
  expect(done).toMatchObject({ code: 0, out: expect.stringContaining("registered person:u1:codex-local for Ada Example <ada@example.com>: 82% weekly, 99% 5-hour left") });
  expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ credential });
  expect(done.out + done.err).not.toContain("secret-access");

  const list = await sgt(api, "account", "list");
  expect(list.out).toMatch(/person:u1:codex-local\s+registered\s+Ada Example <ada@example.com> \(yours\)\s+3 runs\s+\$0.00 \+3 of unknown cost/);
});
