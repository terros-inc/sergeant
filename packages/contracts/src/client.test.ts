import { expect, test } from "vitest";
import { RegisterAccountResponse, TaskDetail, TaskList, WakeResponse } from "./api.ts";
import { apiClient } from "./client.ts";
import { type ServerVersion, versionHeaders } from "./skew.ts";

// The client `sgt` and `sgt-mcp` share: what it sends, that a login never leaves the host in the clear,
// and that every way a call can fail becomes an `ApiError`'s error rather than a guess.

type Seen = { url: string; method: string | undefined; headers: unknown; body: unknown };

function fakeFetch(answer: () => Response) {
  const seen: Seen[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method, headers: init?.headers, body: init?.body });
    return answer();
  };
  return { fetch, seen };
}

test("a call sends its JSON body and the caller's bearer, and returns the answer parsed by the contract", async () => {
  const { fetch, seen } = fakeFetch(() => Response.json({ ref: "UNF-1", woke: "queued" }));
  const res = await apiClient({ api: "http://127.0.0.1:8080", fetch, token: "t-1" }).call("POST", "/v1/tasks/UNF-1/wake", WakeResponse, { reason: "go" });

  expect(res).toEqual({ ok: true, value: { ref: "UNF-1", woke: "queued" } });
  expect(seen).toEqual([
    {
      url: "http://127.0.0.1:8080/v1/tasks/UNF-1/wake",
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t-1" },
      body: JSON.stringify({ reason: "go" }),
    },
  ]);
});

test("a login is never sent over plain HTTP off this host", async () => {
  const { fetch, seen } = fakeFetch(() => Response.json({ tasks: [] }));
  const res = await apiClient({ api: "http://sergeant.example.com", fetch, token: "t-1" }).call("GET", "/v1/tasks", TaskList);
  expect(res).toEqual({ ok: false, error: { code: "bad_request", message: "refusing to send your Linear login to sergeant.example.com without HTTPS" } });
  expect(seen).toEqual([]);

  expect(await apiClient({ api: "https://sergeant.example.com", fetch, token: "t-1" }).call("GET", "/v1/tasks", TaskList)).toEqual({ ok: true, value: { tasks: [] } });
  expect(await apiClient({ api: "http://sergeant.example.com", fetch }).call("GET", "/v1/tasks", TaskList)).toEqual({ ok: true, value: { tasks: [] } });
});

test.each(["http://localhost:8080", "http://[::1]:8080"])("a login may be sent over plain HTTP to the loopback API at %s", async (api) => {
  const { fetch, seen } = fakeFetch(() => Response.json({ tasks: [] }));

  expect(await apiClient({ api, fetch, token: "t-1" }).call("GET", "/v1/tasks", TaskList)).toEqual({ ok: true, value: { tasks: [] } });
  expect(seen).toEqual([
    {
      url: `${api}/v1/tasks`,
      method: "GET",
      headers: { Authorization: "Bearer t-1" },
      body: undefined,
    },
  ]);
});

test("an invalid API URL is rejected before sending a login", async () => {
  const { fetch, seen } = fakeFetch(() => Response.json({ tasks: [] }));

  expect(await apiClient({ api: "https://[invalid", fetch, token: "t-1" }).call("GET", "/v1/tasks", TaskList)).toEqual({
    ok: false,
    error: { code: "bad_request", message: "invalid Sergeant API URL: https://[invalid" },
  });
  expect(seen).toEqual([]);
});

test("a refusal, a non-contract error, an off-contract answer, and an unreachable API are each an ApiError", async () => {
  const api = "http://127.0.0.1:8080";
  const refusal = { error: { code: "conflict", message: "UNF-7 is not delegated" } };
  const answering = (res: () => Response) => apiClient({ api, fetch: fakeFetch(res).fetch });

  expect(await answering(() => Response.json(refusal, { status: 409 })).request("POST", "/v1/tasks/UNF-7/wake")).toEqual({ ok: false, ...refusal });
  expect(await answering(() => new Response("Bad Gateway", { status: 502 })).request("GET", "/v1/tasks")).toEqual({
    ok: false,
    error: { code: "unavailable", message: "GET /v1/tasks answered 502: Bad Gateway" },
  });
  const drift = await answering(() => Response.json({ tasks: [{ ref: "UNF-1" }] })).call("GET", "/v1/tasks", TaskList);
  expect(drift).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringContaining("GET /v1/tasks answered outside the API contract") } });

  const down = apiClient({
    api,
    unreachableHint: "; is serve running?",
    fetch: async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    },
  });
  expect(await down.request("GET", "/v1/tasks")).toEqual({
    ok: false,
    error: { code: "unavailable", message: `cannot reach the Sergeant API at ${api} (connect ECONNREFUSED); is serve running?` },
  });
});

// Version skew (skew.ts): a Sergeant whose contract differs is reported, and an older Sergeant's answer
// that lacks only fields it never knew is still its answer, so a command it performed is not a failure.

test("a server whose contract differs, or that reports none, is reported; a proxy's error is not", async () => {
  const api = "http://127.0.0.1:8080";
  const reported = async (res: () => Response) => {
    const seen: ServerVersion[] = [];
    await apiClient({ api, fetch: fakeFetch(res).fetch, onSkew: (s) => seen.push(s) }).request("GET", "/v1/tasks");
    return seen;
  };
  const same = versionHeaders("2.0.40+aaaaaaa");

  expect(await reported(() => Response.json({ tasks: [] }, { headers: same }))).toEqual([]);
  expect(await reported(() => Response.json({ error: { code: "not_found", message: "no" } }, { status: 404, headers: same }))).toEqual([]);
  const newer = { ...same, "Sergeant-Api-Contract": "0123456789ab" };
  expect(await reported(() => Response.json({ tasks: [] }, { headers: newer }))).toEqual([{ version: "2.0.40+aaaaaaa", contract: "0123456789ab" }]);
  expect(await reported(() => Response.json({ tasks: [] }))).toEqual([{ version: undefined, contract: undefined }]);
  expect(await reported(() => new Response("Bad Gateway", { status: 502 }))).toEqual([]);
});

test("an older server's answer lacking only newer required fields is accepted and names them; any other mismatch is not", async () => {
  const api = "http://127.0.0.1:8080";
  const answering = (json: unknown) => apiClient({ api, fetch: fakeFetch(() => Response.json(json)).fetch });

  // TECH-5159: the server stored the credential before it answered without `notice`.
  const account = { id: "person:u1:codex-local", group: "registered", holder: "Ada", adapter: "codex-local", mine: true };
  const registered = { account, replaced: false, quota: { adapter: "codex-local", readAt: "t" } };
  expect(await answering(registered).call("POST", "/v1/accounts/codex-local/register", RegisterAccountResponse, { credential: "c" })).toEqual({
    ok: true,
    value: registered,
    absent: ["notice"],
  });

  // TECH-5161: a budget from before `taskStart`, nested in a task's detail.
  const budget = { window: { wallMinutes: 120, costUsd: 25 }, windowStart: "2026-10-02T10:00:00.000Z", wallDeadline: "2026-10-02T12:00:00.000Z", spentUsd: 1, costLimitUsd: 25, unknownCostRuns: 0 };
  const detail = { task: { ref: "UNF-1", status: "active", turns: 1, runs: 0 }, issue: { error: "x" }, budget, runs: [], recentTurns: [], followups: [] };
  expect(await answering(detail).call("GET", "/v1/tasks/UNF-1", TaskDetail)).toEqual({ ok: true, value: detail, absent: ["budget.taskStart"] });

  // A present field of the wrong type, or a value the contract does not have, is still outside it.
  const wrong = await answering({ ...registered, notice: 7 }).call("POST", "/v1/accounts/codex-local/register", RegisterAccountResponse, { credential: "c" });
  expect(wrong).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(await answering({ ref: "UNF-1", woke: "later" }).call("POST", "/v1/tasks/UNF-1/wake", WakeResponse, {})).toMatchObject({ ok: false });
});
