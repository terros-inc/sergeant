import { createHash } from "node:crypto";
import { chmod, open, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MIN_CLI_HEADER, MIN_CLI_VERSION } from "@terros/sergeant-contracts";
import { TOKEN_URL } from "@terros/sergeant-contracts/credentials";
import { expect, test } from "vitest";
import { USAGE } from "./cli.ts";
import { config, fakeApi, sgt, sgtWith } from "./fake-api.ts";

// What every `sgt` command shares: its errors, its login, its version, and how it meets a Sergeant
// older or newer than it.

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

// TECH-5126: these answers are not the API's JSON, so --help names each shape; scripts rely on it.
test("--json wraps run report's Markdown as {report} and says what logout did as {api, signedOut}", async () => {
  const markdown = "# Report\n\nDone.";
  const { api } = await fakeApi({ "GET /v1/runs/run_w1/report": { text: markdown } });
  expect(JSON.parse((await sgt(api, "--json", "run", "report", "run_w1")).out)).toEqual({ report: markdown });
  expect(JSON.parse((await sgt(api, "--json", "logout")).out)).toEqual({ api, signedOut: false });
  for (const shape of ['{"report"}', '{"api","signedOut"}', '{"version"}', '{"request","outcome"}']) expect(USAGE).toContain(shape);
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
