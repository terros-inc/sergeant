import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_CLI_HEADER, MIN_CLI_VERSION, type WhoAmI } from "@terros/sergeant-contracts";
import { afterEach, beforeEach, expect, test } from "vitest";
import { main, type Io } from "./cli.ts";
import { quotaLeft } from "./format.ts";
import { TOKEN_URL } from "./login.ts";

// `sgt` against a fake Sergeant API: what it sends, what it prints for a human, and that `--json` is
// the API's own answer, errors included, so Firstmate tooling can parse every outcome.

type Seen = { method: string; url: string; body: string; contentType: string | undefined; authorization: string | undefined; version?: string | string[] | undefined };
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

// A route's `headers` replace those of a Sergeant that supports this sgt and no newer minimum.
async function fakeApi(routes: Record<string, { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }>) {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", body, contentType: req.headers["content-type"], authorization: req.headers.authorization, version: req.headers["sergeant-cli-version"] });
      const route = routes[`${req.method} ${req.url}`] ?? { status: 404, json: { error: { code: "not_found", message: `no ${req.url}` } } };
      res.writeHead(route.status ?? 200, { "Content-Type": route.text === undefined ? "application/json" : "text/markdown", ...(route.headers ?? { [MIN_CLI_HEADER]: MIN_CLI_VERSION }) });
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
  const env = { SGT_API_URL: api, XDG_CONFIG_HOME: config, SGT_LOGIN_PORT: "0" };
  const code = await main(argv, { env, version: `${MIN_CLI_VERSION}+test`, out: (t) => (out += t), err: (t) => (err += t), ...io });
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
  const { api, seen } = await fakeApi({ "POST /v1/tasks/UNF-12/cancel": { json: { ref: "UNF-12", undelegated: true, stopping: [], closedPullRequests: [] } } });

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

// An operator must see which worker PRs a cancel closed without opening Linear.
test("task cancel lists the PRs the cancel closed", async () => {
  const pr = { repo: "terros-inc/sergeant", number: 7, url: "https://github.com/terros-inc/sergeant/pull/7" };
  const { api } = await fakeApi({
    "POST /v1/tasks/UNF-12/cancel": { json: { ref: "UNF-12", undelegated: true, stopping: [], closedPullRequests: [pr] } },
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

  const stopping = await sgt(api, "task", "cancel", "UNF-14", "--reason", "wrong approach");
  expect(stopping).toMatchObject({ code: 0, out: expect.stringContaining("Sergeant keeps canceling: run_w1") });
  expect(stopping.out).toContain("Its open PRs are closed once they stop.");
});

test("a refusal, an off-contract answer, and an unreachable API each exit 1 with a usable error", async () => {
  const refusal = { error: { code: "conflict", message: "UNF-7 is not delegated to Sergeant's agent" } };
  const { api } = await fakeApi({
    "POST /v1/tasks/UNF-7/wake": { status: 409, json: refusal },
    "GET /v1/tasks": { json: { tasks: [{ ref: "UNF-1", status: "dozing" }] } },
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
  const me = { auth: "linear", user: { id: "u1", name: "Ada", email: "ada@example.com" }, approver: false, enrolledRepositories: ["o/r"], registration: { providers: [] }, approvers: [] };
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
// and only the API's answer, which never holds it, is printed. TECH-5196: with nothing piped it comes
// from the provider's own sign-in, and a name defaults to the provider.
test("account register sends the piped or signed-in credential under its name and prints the account without it", async () => {
  const notice = "Your credential is used inside Sergeant's worker and reviewer containers … run `sgt account remove codex` … `codex login` again.";
  const account = { id: "person:u1:codex", group: "registered", holder: "Ada Example <ada@example.com>", adapter: "codex-local", name: "codex", mine: true };
  const { api, seen } = await fakeApi({
    "GET /v1/whoami": { json: whoami() },
    "POST /v1/accounts/register": { json: { account, replaced: false, quota: { adapter: "codex-local", readAt: "t", weekly: { remainingPercent: 82 }, fiveHour: { remainingPercent: 99 } }, notice } },
    "GET /v1/accounts": { json: { accounts: [{ ...account, usage: { runs: 3, costUsd: 0, unknownCostRuns: 3 } }, { ...account, name: "codexPersonal", quotaUnknown: ["5-hour"], usage: { runs: 0, costUsd: 0, unknownCostRuns: 0 } }] } },
  });
  const credential = '{"tokens":{"access_token":"secret-access"}}';
  const signIns: string[] = [];
  const signIn = async (provider: string) => (signIns.push(provider), `${credential}\n`);

  for (const bad of [["codex", "--name", "my work"], ["codex-local"]]) expect((await sgtWith({ signIn }, api, "account", "register", ...bad)).code).toBe(2);
  // TECH-5205: bare, it names the providers and shows --name, before any login or API call.
  const bare = await sgtWith({ signIn }, api, "account", "register");
  expect([bare.code, bare.out, seen, signIns]).toEqual([2, "", [], []]);
  expect(bare.err).toMatch(/claude \(your Claude subscription\) or codex/);
  expect(bare.err).toContain("\n  sgt account register codex --name codexWork\n(sgt --help for usage)\n");
  expect((await sgtWith({ stdin: async () => "\n", signIn }, api, "account", "register", "codex")).code).toBe(2);
  expect([seen, signIns]).toEqual([[], []]);

  const piped = await sgtWith({ stdin: async () => `${credential}\n`, signIn }, api, "account", "register", "codex");
  expect(piped).toMatchObject({ code: 0, out: expect.stringContaining("registered codex account codex for Ada Example <ada@example.com>: 82% weekly left, 99% 5-hour left") });
  expect(piped.out).toContain(notice);
  const signedIn = await sgtWith({ signIn }, api, "account", "register", "codex", "--name", "codexWork");
  expect(signedIn.code).toBe(0);
  expect(signIns).toEqual(["codex"]);
  const posted = seen.filter((s) => s.method === "POST").map((s) => JSON.parse(s.body));
  expect(posted).toEqual([{ provider: "codex", name: "codex", credential }, { provider: "codex", name: "codexWork", credential }]);
  for (const r of [piped, signedIn]) expect(r.out + r.err).not.toContain("secret-access");

  const list = await sgt(api, "account", "list");
  expect(list.out).toMatch(/codex\s+codex\s+Ada Example <ada@example.com> \(yours\)\s+3 runs\s+\$0.00 \+3 of unknown cost/);
  // TECH-5211: a plan that reports one window registers, and both lines say which one is unknown.
  expect(list.out).toMatch(/codexPersonal\s+codex\s+.*\$0.00\s+quota: 5-hour unknown/);
  expect(quotaLeft({ adapter: "codex-local", readAt: "t", weekly: { remainingPercent: 60.4 } })).toBe("60% weekly left, 5-hour unknown");
});

const whoami = (over: Partial<WhoAmI> = {}): WhoAmI => ({
  auth: "linear",
  user: { id: "u1", name: "Ada Example", email: "ada@example.com" },
  approver: false,
  enrolledRepositories: [],
  registration: { providers: ["claude", "codex"] },
  approvers: ["Grace Hopper", "Linus Torvalds"],
  ...over,
});

// TECH-5202: a refusal comes before the provider's sign-in makes a credential, in words a person acts
// on; one that comes after says what to do with the credential that now exists.
test("account register asks first, refuses before any sign-in, and says what to do with a credential it could not register", async () => {
  const signIns: string[] = [];
  const signIn = async (provider: string) => (signIns.push(provider), "sk-ant-oat01-made");
  const refusedBy = async (me: WhoAmI, provider: string) => {
    const { api, seen } = await fakeApi({ "GET /v1/whoami": { json: me } });
    const res = await sgtWith({ signIn }, api, "account", "register", provider, "--name", "claudeWork");
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    expect(seen.map((s) => s.url)).toEqual(["/v1/whoami"]);
    return res;
  };
  expect(await refusedBy(whoami({ registration: { providers: [] } }), "claude")).toEqual({
    code: 1,
    out: "",
    err: "sgt: bad_request: This Sergeant isn't set up for account registration yet. Ask an approver (Grace Hopper or Linus Torvalds) to enable it.\n",
  });
  expect((await refusedBy(whoami({ registration: { providers: ["claude"] }, approvers: [] }), "codex")).err).toContain(
    "This Sergeant doesn't run Codex accounts, only Claude. Ask an approver if you need Codex.",
  );
  expect((await refusedBy(whoami({ auth: "loopback", user: null }), "claude")).err).toContain("sign in with `sgt login`");
  expect(signIns).toEqual([]);

  const refusal = { status: 400, json: { error: { code: "bad_request", message: "its subscription quota cannot be read with this credential" } } };
  const { api } = await fakeApi({ "GET /v1/whoami": { json: whoami() }, "POST /v1/accounts/register": refusal });
  const failed = await sgtWith({ signIn }, api, "account", "register", "claude", "--name", "claudeWork");
  expect(failed.code).toBe(1);
  expect(failed.err).toContain("claudeWork was not registered.");
  expect(failed.err).toContain("`pbpaste | sgt account register claude --name claudeWork`");
  expect(failed.err).toContain("open https://claude.ai/new#settings/claude-code and, under Authorization tokens, delete the user:inference-scoped token `claude setup-token` made");
  expect(failed.out + failed.err).not.toContain("sk-ant-oat01-made");
  const codex = await sgtWith({ signIn }, api, "account", "register", "codex");
  expect(codex.err).toContain("codex was not registered. sgt deleted its copy of the Codex login and Sergeant stored none, so no copy of it is left: `sgt account register codex --name codex` signs in again.");
  expect(failed.err).toContain("https://claude.ai/new#settings/claude-code and, under Authorization tokens");
  // A piped credential is the person's own copy: nothing is stranded.
  expect((await sgtWith({ stdin: async () => "sk-ant-oat01-mine", signIn }, api, "account", "register", "claude")).err).not.toContain("pbpaste");
  await new Promise<void>((resolve) => server?.close(() => resolve()));

  // The person already has a claudeWork; the server stored the new token over it, but its answer did not
  // arrive whole. A listed claudeWork proves nothing, so sgt says to send the same token again, which
  // replaces whichever claudeWork is there, never to look at the list or to revoke first.
  const lost = await fakeApi({
    "GET /v1/whoami": { json: whoami() },
    "GET /v1/accounts": { json: { accounts: [{ id: "person:u1:claudeWork", group: "registered", holder: "Ada Example <ada@example.com>", adapter: "claude-code-local", name: "claudeWork", mine: true, usage: { runs: 0, costUsd: 0, unknownCostRuns: 0 } }] } },
    "POST /v1/accounts/register": { json: { account: {} } },
  });
  const unknown = await sgtWith({ signIn }, lost.api, "account", "register", "claude", "--name", "claudeWork");
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("sgt: unavailable: POST /v1/accounts/register answered outside the API contract");
  expect(unknown.err).toContain("sgt cannot tell whether claudeWork was registered. Once Sergeant answers, register the same token again");
  expect(unknown.err).toContain("`pbpaste | sgt account register claude --name claudeWork`");
  expect(unknown.err).not.toMatch(/sgt account list|was not registered/);
  const codexUnknown = await sgtWith({ signIn }, lost.api, "account", "register", "codex", "--name", "codexWork");
  expect(codexUnknown.err).toContain("Once Sergeant answers, `sgt account register codex --name codexWork` signs in again and replaces whatever codexWork holds. To not use it at all, `sgt account remove codexWork` and revoke it. To revoke a Codex login, open https://chatgpt.com/settings/security?view=sessions and log out the session its sign-in created");
});

// TECH-5198: removing an account passes on where to revoke it, since removal does not revoke a copy.
test("account remove prints the server's revoke reminder", async () => {
  const notice = "A run could have copied it, and removing it here does not revoke that copy. To revoke a Codex login, open https://chatgpt.com/settings/security?view=sessions and log out the session its sign-in created.";
  const { api, seen } = await fakeApi({ "POST /v1/accounts/remove": { json: { name: "codex", removed: true, notice } } });
  expect(await sgt(api, "account", "remove", "codex")).toMatchObject({ code: 0, out: expect.stringContaining(`removed your account codex. ${notice}`) });
  expect(seen.map((s) => [s.method, s.url, JSON.parse(s.body)])).toEqual([["POST", "/v1/accounts/remove", { name: "codex" }]]);
});

// TECH-5130: a three-word command, sending the person's Linear user id in the body.
test("admin account remove-person posts the user id and says what it removed", async () => {
  const { api, seen } = await fakeApi({
    "POST /v1/accounts/remove-person": { json: { userId: "u1", removed: [{ id: "person:u1:codex-local", adapter: "codex-local", holder: "Ada Example <ada@example.com>" }] } },
  });
  const done = await sgt(api, "admin", "account", "remove-person", "u1");
  expect(done).toMatchObject({ code: 0, out: expect.stringContaining("removed person:u1:codex-local (Ada Example <ada@example.com>)") });
  expect(seen.map((s) => [s.method, s.url, JSON.parse(s.body)])).toEqual([["POST", "/v1/accounts/remove-person", { userId: "u1" }]]);
  expect((await sgt(api, "admin", "account", "remove-person")).code).toBe(2);
  expect((await sgt(api, "admin", "account")).code).toBe(2);
});

test("repo list is any signed-in user's, and only adding and removing are under admin", async () => {
  const { api, seen } = await fakeApi({
    "GET /v1/repositories": { json: { repositories: [{ repo: "terros-inc/one", mergeMethod: "squash" }] } },
    "POST /v1/repositories/add": { json: { repo: "terros-inc/two", changed: true, repositories: ["terros-inc/one", "terros-inc/two"] } },
  });
  expect(await sgt(api, "repo", "list")).toMatchObject({ code: 0, out: "terros-inc/one  squash\n" });
  expect((await sgt(api, "admin", "repo", "list")).code).toBe(2);
  expect(await sgt(api, "admin", "repo", "add", "terros-inc/two", "--merge-method", "rebase")).toMatchObject({ code: 0, out: expect.stringContaining("enrolled terros-inc/two") });
  expect(seen.map((s) => [s.method, s.url, s.body && JSON.parse(s.body)])).toEqual([
    ["GET", "/v1/repositories", ""],
    ["POST", "/v1/repositories/add", { repo: "terros-inc/two", mergeMethod: "rebase" }],
  ]);
});

// TECH-5185: no compatibility between sgt and the API, only the oldest sgt the server supports. Each
// request names this sgt's version, so a Sergeant that no longer supports it refuses before acting (TECH-5188).
test("an sgt older than its Sergeant supports stops and says to update; one newer than it warns", async () => {
  const tooOld = "Your sgt is older than this Sergeant server supports. Run `sgt update`.";
  const { api, seen } = await fakeApi({
    "POST /v1/tasks/UNF-12/wake": { json: { error: { code: "bad_request", message: tooOld } }, status: 400 },
    "GET /v1/tasks": { json: { tasks: [] }, headers: { [MIN_CLI_HEADER]: "2.0.5" } },
    "GET /v1/runs": { json: { runs: [] }, headers: {} },
  });

  expect(await sgtWith({ version: "2.0.4+aaaaaaa" }, api, "task", "wake", "UNF-12")).toEqual({ code: 1, out: "", err: `sgt: bad_request: ${tooOld}\n` });
  const json = await sgtWith({ version: "0.0.0+unknown" }, api, "--json", "task", "wake", "UNF-12");
  expect(JSON.parse(json.out)).toEqual({ error: { code: "bad_request", message: tooOld } });
  expect(seen.map((s) => s.version)).toEqual(["2.0.4+aaaaaaa", "0.0.0+unknown"]);

  // A Sergeant whose minimum is below this sgt's, or that predates saying one, lacks a change this sgt needs.
  const newer = await sgtWith({ version: "2.0.5+aaaaaaa" }, api, "task", "list");
  expect(newer).toEqual({
    code: 0,
    out: "no tasks\n",
    err: `sgt: warning: Sergeant at ${api} is older than this sgt (it supports sgt 2.0.5 and later; this sgt needs one that supports ${MIN_CLI_VERSION}), so commands may fail until it is redeployed\n`,
  });
  expect((await sgt(api, "run", "list")).err).toContain("does not say which sgt it supports");
});

// TECH-5195: `sgt admin update` hands the host its request and waits out serve's restart for the outcome,
// so nobody polls the host; a failed outcome says why and exits 1.
test("admin update waits through serve's restart for the host's outcome, and a failed one exits 1", async () => {
  const request = { id: "req-1", action: "update", ref: "v2.1.0", by: "Grace Example <grace@example.com>", at: "2026-10-04T10:00:00.700Z" };
  // The host's outcome when the request was made: an automatic update that finished earlier.
  const before = { action: "automatic", by: "the release channel (main)", outcome: "succeeded", message: "updated zzz to aaa", startedAt: "2026-10-04T09:50:00Z" };
  const running = { id: "req-1", action: "update", ref: "v2.1.0", by: request.by, outcome: "running", message: "updating aaa to bbb", startedAt: "2026-10-04T10:00:05Z" };
  const status = (last: object | null, pending: object | null = null, config: object | null = null) => ({
    json: { serve: { version: "2.1.70+abc1234", startedAt: "2026-10-04T09:00:00.000Z" }, release: null, pending, last, config },
  });
  let statuses: { status?: number; json?: unknown; text?: string }[] = [];
  const { api, seen } = await fakeApi({
    "POST /v1/admin/update": { json: { request, last: before } },
    get "GET /v1/admin/status"() {
      return statuses.shift() ?? { status: 500, text: "read too often" };
    },
  });
  const noWait = { sleep: async () => {} };

  statuses = [status(before, request), status(running), { status: 502, text: "bad gateway" }, status({ ...running, outcome: "succeeded", message: "updated aaa to bbb" })];
  const done = await sgtWith(noWait, api, "admin", "update", "v2.1.0");
  expect(done).toEqual({
    code: 0,
    out: "succeeded: updated aaa to bbb\n",
    err: "update to v2.1.0 requested (req-1); waiting for the host\nwaiting for the host to take it\nrunning: updating aaa to bbb\nserve is restarting\n",
  });
  expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ ref: "v2.1.0" });

  statuses = [status({ ...running, outcome: "failed", message: "update to bbb failed; reinstalled aaa", output: "serve is not healthy at /health" })];
  const failed = await sgtWith(noWait, api, "admin", "update", "v2.1.0");
  expect(failed.code).toBe(1);
  expect(failed.out).toBe("failed: update to bbb failed; reinstalled aaa\n\nlast lines of the update's output:\nserve is not healthy at /health\n");
  expect((await sgt(api, "admin", "update", "a", "b")).code).toBe(2);

  // An automatic update replaced the outcome before sgt read it, even one the host stamped in the same
  // second as the request (its whole-second startedAt is before the request's): say so, never wait it out.
  statuses = [status(before, request), status({ ...before, outcome: "running", message: "updating bbb to ccc", startedAt: "2026-10-04T10:00:00Z" })];
  const replaced = await sgtWith(noWait, api, "admin", "update", "v2.1.0");
  expect(replaced.code).toBe(1);
  expect(replaced.err).toContain("sgt: conflict: the host took your update (req-1), but automatic by the release channel (main) replaced its outcome before sgt read it");
  expect(statuses).toEqual([]);

  // TECH-5205: nothing newer to install, but the installation config changed since serve started.
  const unchanged = { ...running, outcome: "unchanged", message: "up to date at aaa (requested by Grace Example <grace@example.com>)" };
  statuses = [status(unchanged, null, { loaded: 3, current: 4 }), status(unchanged, null, { loaded: 3, current: 4 })];
  const stale = await sgtWith(noWait, api, "admin", "update", "v2.1.0");
  expect(stale).toMatchObject({ code: 0, out: `unchanged: ${unchanged.message}\nversion 4 in AWS, but serve has version 3: the installation config changed since serve started, so run \`sgt admin restart\` to reread it\n` });
  statuses = [status(unchanged, null, { loaded: 4, current: 4 }), status(unchanged, null, { loaded: 4, current: 4 })];
  expect((await sgtWith(noWait, api, "admin", "update", "v2.1.0")).out).toBe(`unchanged: ${unchanged.message}\n`);
});

test("admin status says when the installation config changed since serve started", async () => {
  const status = (config: object | null) => ({ json: { serve: { version: "2.1.70+abc1234", startedAt: "2026-10-04T09:00:00.000Z" }, release: null, pending: null, last: null, config } });
  let next = status({ loaded: 3, current: 4 });
  const { api } = await fakeApi({
    get "GET /v1/admin/status"() {
      return next;
    },
  });
  expect((await sgt(api, "admin", "status")).out).toContain("config   version 4 in AWS, but serve has version 3: the installation config changed since serve started, so run `sgt admin restart` to reread it");
  next = status({ loaded: 4, current: 4 });
  expect((await sgt(api, "admin", "status")).out).toContain("config   version 4, as serve has it\n");
  next = status({ loaded: 4, current: null });
  expect((await sgt(api, "admin", "status")).out).toContain("config   version 4; serve cannot read the parameter now");
  next = status(null);
  expect((await sgt(api, "admin", "status")).out).not.toContain("config");
});
