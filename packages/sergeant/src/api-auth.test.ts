import { createServer, request } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { apiHandler, type ApiControl } from "./api.ts";
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

function call(port: number, method: string, path: string, token?: string) {
  return new Promise<{ status: number; json?: unknown }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => (text += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
    });
    req.on("error", reject);
    req.end();
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
