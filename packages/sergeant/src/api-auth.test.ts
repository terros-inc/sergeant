import { createServer, request } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { CLI_VERSION_HEADER, MIN_CLI_VERSION } from "@terros/sergeant-contracts";
import { apiHandler, type ApiControl } from "./api.ts";
import type { Caller } from "./auth.ts";
import type { ServiceDeps } from "./service.ts";

// Every operational route Caddy publishes. `/v1/auth/config` is the one public bootstrap route:
// without it `sgt login` cannot discover the OAuth client id, and it returns 404 until `humans`
// exists. Keep this list in lockstep with api.ts so a new read or mutation cannot escape auth.
const authenticatedPaths = [
  ["GET", "/v1/whoami"],
  ["GET", "/v1/tasks"],
  ["GET", "/v1/tasks/UNF-1"],
  ["POST", "/v1/tasks/UNF-1/wake"],
  ["POST", "/v1/tasks/UNF-1/cancel"],
  ["GET", "/v1/runs"],
  ["GET", "/v1/runs/run_w1"],
  ["GET", "/v1/runs/run_w1/report"],
  ["POST", "/v1/runs/run_w1/cancel"],
] as const;

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

const control = (over: Partial<ApiControl> = {}): ApiControl => ({
  stateDir: "/unused",
  enrolledRepositories: [],
  deps: {} as ServiceDeps,
  log: () => {},
  loop: () => undefined,
  known: () => [],
  wake: async () => "not_delegated",
  cancelTask: async () => ({ undelegated: false, stopping: [], closedPullRequests: [] }),
  ...over,
});

async function start(ctl: ApiControl): Promise<number> {
  const server = createServer(apiHandler(ctl));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test API did not listen on TCP");
  return address.port;
}

/** One call naming the client's version (`null`: none), with a JSON body when it posts. */
function call(port: number, method: string, path: string, token?: string, version: string | null = MIN_CLI_VERSION) {
  return new Promise<{ status: number; json?: unknown }>((resolve, reject) => {
    const headers = { ...(version !== null && { [CLI_VERSION_HEADER]: version }), ...(token && { Authorization: `Bearer ${token}` }), ...(method === "POST" && { "Content-Type": "application/json" }) };
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => (text += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? JSON.stringify({ reason: "go" }) : undefined);
  });
}

test("without humans configured every published operational /v1 route fails closed", async () => {
  const port = await start(control());
  expect(await call(port, "GET", "/v1/auth/config")).toMatchObject({ status: 404, json: { error: { code: "not_found" } } });

  for (const [method, path] of authenticatedPaths) {
    expect(await call(port, method, path, "any-token"), `${method} ${path}`).toMatchObject({
      status: 401,
      json: { error: { code: "unauthorized" } },
    });
  }
});

test("with humans configured every published operational /v1 route still refuses an unauthenticated caller", async () => {
  const callerOf = vi.fn();
  const port = await start(control({ linearClientId: "client-1", callerOf }));
  expect(await call(port, "GET", "/v1/auth/config")).toEqual({ status: 200, json: { linear: { clientId: "client-1" } } });

  for (const [method, path] of authenticatedPaths) {
    expect(await call(port, method, path), `${method} ${path}`).toMatchObject({
      status: 401,
      json: { error: { code: "unauthorized" } },
    });
  }
  expect(callerOf).not.toHaveBeenCalled();
});

// TECH-5188: a too-old `sgt` must change nothing, so its version is checked before the caller, the
// body, or the route: even a caller every other check would admit cannot reach a mutating handler.
test("a request naming no client version, a malformed one, or one older than the minimum, is refused before any handler runs", async () => {
  const wake = vi.fn(async () => "active" as const);
  const cancelTask = vi.fn(async () => ({ undelegated: true, stopping: [], closedPullRequests: [] }));
  const callerOf = vi.fn(async (): Promise<Caller> => ({ kind: "loopback", approver: true }));
  const port = await start(control({ linearClientId: "client-1", callerOf, trustLoopback: true, wake, cancelTask }));
  const tooOld = { status: 400, json: { error: { code: "bad_request", message: expect.stringContaining("Run `sgt update`") } } };

  // Malformed values with a current numeric prefix must not pass as current.
  const malformed = [`${MIN_CLI_VERSION}garbage`, `${MIN_CLI_VERSION}.9`, `${MIN_CLI_VERSION}+`, `${MIN_CLI_VERSION}+abc def`, `v${MIN_CLI_VERSION}`, "99.0"];
  for (const version of [null, "", "2.1.0+abcdef0", "garbage", ...malformed]) {
    for (const [method, path] of [["GET", "/v1/auth/config"], ...authenticatedPaths, ["POST", "/v1/accounts/register"]] as const) {
      expect(await call(port, method, path, undefined, version), `${method} ${path} from ${version}`).toMatchObject(tooOld);
      expect(await call(port, method, path, "t-1", version), `${method} ${path} from ${version} with a login`).toMatchObject(tooOld);
    }
  }
  expect([wake, cancelTask, callerOf].map((f) => f.mock.calls.length)).toEqual([0, 0, 0]);

  // The same wake from a current client reaches its handler.
  expect(await call(port, "POST", "/v1/tasks/UNF-1/wake", undefined, `${MIN_CLI_VERSION}+abcdef0`)).toEqual({ status: 200, json: { ref: "UNF-1", woke: "active" } });
  expect(wake).toHaveBeenCalledOnce();
});

test("only /v1 and paths under it are gated: /v10 and the like keep their plain 404", async () => {
  const port = await start(control());
  for (const path of ["/v10", "/v1x/tasks", "/v1-old"]) {
    const req = await fetch(`http://127.0.0.1:${port}${path}`);
    expect([req.status, req.headers.has("sergeant-min-cli-version")], path).toEqual([404, false]);
  }
  expect((await call(port, "GET", "/v1", undefined, null)).status).toBe(400);
  expect((await call(port, "GET", "/v1?x=1", undefined, null)).status).toBe(400);
});
