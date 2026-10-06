import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { CLI_VERSION_HEADER, MIN_CLI_VERSION } from "@terros/sergeant-contracts";
import type { HostAdmin } from "./api-admin.ts";
import { apiHandler, type ApiControl } from "./api.ts";
import type { Caller } from "./auth.ts";

// TECH-5195: only an approver hands the host a restart or update, every one names who asked, and serve
// never runs anything itself: it leaves exactly one request for the host, which a second cannot replace.

const callers: Record<string, Caller> = {
  ada: { kind: "linear", user: { id: "u-ada", name: "Ada Example", email: "ada@example.com" }, approver: false },
  grace: { kind: "linear", user: { id: "u-grace", name: "Grace Example", email: "grace@example.com" }, approver: true },
};

const runs = { count: 447, bytes: 46e9, volumeFreeBytes: 48e9, volumeBytes: 98e9 };
const github = { limit: 5000, remaining: 0, resetAt: "2026-10-04T10:30:00.000Z", observedAt: "2026-10-04T10:05:00.000Z", pausedUntil: "2026-10-04T10:30:00.000Z" };
let dir = "";
let server: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
  server = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function serve(onHost = true) {
  dir = await mkdtemp(join(tmpdir(), "sergeant-admin-test-"));
  const admin: HostAdmin = {
    requestFile: join(dir, "admin-request.json"),
    resultFile: join(dir, "admin-result.json"),
    releaseFile: join(dir, "release"),
    serve: { version: "2.1.70+abc1234", startedAt: "2026-10-04T10:00:00.000Z" },
    config: async () => ({ loaded: 3, current: 4 }),
    runs: async () => runs,
    github: () => github,
  };
  const logs: string[] = [];
  const ctl = {
    stateDir: dir,
    enrolledRepositories: [],
    deps: {},
    log: (line: string) => logs.push(line),
    loop: () => undefined,
    known: () => [],
    callerOf: async (token: string) => callers[token] ?? Promise.reject(new Error("unknown")),
    ...(onHost && { admin }),
  } as unknown as ApiControl;
  server = createServer(apiHandler(ctl));
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (method: string, path: string, as: string, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const headers = { [CLI_VERSION_HEADER]: MIN_CLI_VERSION, Authorization: `Bearer ${as}`, ...(body !== undefined && { "Content-Type": "application/json" }) };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  return { call, admin, logs };
}

test("only an approver hands the host a request, and a second waits for the first to be taken", async () => {
  const { call, admin, logs } = await serve();
  const member = await call("POST", "/v1/admin/restart", "ada", {});
  expect(member.status).toBe(403);
  expect((await call("GET", "/v1/admin/status", "ada")).status).toBe(403);
  expect(await readdir(dir)).toEqual([]);

  const asked = await call("POST", "/v1/admin/update", "grace", { ref: "v2.1.0" });
  expect(asked.status).toBe(200);
  const handed = JSON.parse(await readFile(admin.requestFile, "utf8"));
  expect(handed).toEqual(asked.json.request);
  expect(handed).toMatchObject({ action: "update", ref: "v2.1.0", by: "Grace Example <grace@example.com>" });
  expect(logs).toEqual([`admin update to v2.1.0 requested by Grace Example <grace@example.com> (${handed.id})`]);

  const second = await call("POST", "/v1/admin/restart", "grace", {});
  expect(second.status).toBe(409);
  expect(second.json.error.message).toContain("update by Grace Example <grace@example.com>");
  expect(JSON.parse(await readFile(admin.requestFile, "utf8"))).toEqual(handed);
  expect(await readdir(dir)).toEqual(["admin-request.json"]);
});

test("a ref that could be an option or escape the ref namespace is refused before anything is written", async () => {
  const { call } = await serve();
  for (const ref of ["--upload-pack=x", "main..evil", "a b", ""]) {
    expect((await call("POST", "/v1/admin/update", "grace", { ref })).status).toBe(400);
  }
  expect((await call("POST", "/v1/admin/restart", "grace", { ref: "main" })).status).toBe(400);
  expect(await readdir(dir)).toEqual([]);
});

test("status reads the release, the request not yet taken, the host's last outcome, and the runs directory's size", async () => {
  const { call, admin } = await serve();
  expect((await call("GET", "/v1/admin/status", "grace")).json).toEqual({ serve: admin.serve, release: null, pending: null, last: null, config: { loaded: 3, current: 4 }, runs, github });

  await writeFile(admin.releaseFile, "ref=main\nsha=0123abc\nat=2026-10-04T09:58:00Z\n");
  const last = { action: "automatic", by: "the release channel (main)", outcome: "succeeded", message: "updated a to b", startedAt: "2026-10-04T09:50:00Z", finishedAt: "2026-10-04T09:58:00Z", sha: "0123abc" };
  await writeFile(admin.resultFile, JSON.stringify(last));
  const { json: request } = await call("POST", "/v1/admin/update", "grace", {});
  expect(request.last).toEqual(last);
  expect((await call("GET", "/v1/admin/status", "grace")).json).toEqual({
    serve: admin.serve,
    release: { ref: "main", sha: "0123abc", at: "2026-10-04T09:58:00Z" },
    pending: request.request,
    last,
    config: { loaded: 3, current: 4 },
    runs,
    github,
  });
});

test("off the Sergeant host there is nothing to restart or update", async () => {
  const { call } = await serve(false);
  expect((await call("POST", "/v1/admin/restart", "grace", {})).status).toBe(404);
  expect(await readdir(dir)).toEqual([]);
});

// The host keeps one outcome: while A runs, B is refused, so A's waiting `sgt` reads A's outcome, not B's.
test("while the host still runs one action, another is refused and nothing is left for the host", async () => {
  const { call, admin } = await serve();
  const a = (await call("POST", "/v1/admin/restart", "grace", {})).json.request;
  // The host takes A: it removes the request and records A running.
  await rm(admin.requestFile);
  await writeFile(admin.resultFile, JSON.stringify({ id: a.id, action: "restart", by: a.by, outcome: "running", message: "taken by the host", startedAt: "2026-10-04T10:00:01Z" }));
  const b = await call("POST", "/v1/admin/update", "grace", {});
  expect(b.status).toBe(409);
  expect(b.json.error.message).toBe("the host is still running restart by Grace Example <grace@example.com>, since 2026-10-04T10:00:01Z: see `sgt admin status`");
  expect(await readdir(dir)).toEqual(["admin-result.json"]);
});
