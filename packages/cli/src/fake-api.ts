import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_CLI_HEADER, MIN_CLI_VERSION, type WhoAmI } from "@terros/sergeant-contracts";
import { afterEach, beforeEach } from "vitest";
import { main, type Io } from "./cli.ts";

// `sgt` against a fake Sergeant API: what it sends, what it prints for a human, and that `--json` is
// the API's own answer, or the shape USAGE names where sgt builds it, errors included, so Firstmate
// tooling can parse every outcome. The fakes the
// cli*.test.ts files share; importing this registers their per-test setup and teardown.

type Seen = { method: string; url: string; body: string; contentType: string | undefined; authorization: string | undefined; version?: string | string[] | undefined };
let server: Server | undefined;
// Each test's own config directory, so no test reads or writes this machine's real login.
export let config = "";
beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), "sgt-test-"));
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await rm(config, { recursive: true, force: true });
});

// A route's `headers` replace those of a Sergeant that supports this sgt and no newer minimum.
export async function fakeApi(routes: Record<string, { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }>) {
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

export async function sgt(api: string, ...argv: string[]) {
  return sgtWith({}, api, ...argv);
}

export async function sgtWith(io: Partial<Io>, api: string, ...argv: string[]) {
  let out = "";
  let err = "";
  const env = { SGT_API_URL: api, XDG_CONFIG_HOME: config, SGT_LOGIN_PORT: "0" };
  const code = await main(argv, { env, version: `${MIN_CLI_VERSION}+test`, out: (t) => (out += t), err: (t) => (err += t), ...io });
  return { code, out, err };
}

/** Stops the fake API now, for a test that starts another. */
export const closeApi = () => new Promise<void>((resolve) => server?.close(() => resolve()));

export const whoami = (over: Partial<WhoAmI> = {}): WhoAmI => ({
  auth: "linear",
  user: { id: "u1", name: "Ada Example", email: "ada@example.com" },
  approver: false,
  enrolledRepositories: [],
  registration: { providers: ["claude", "codex"] },
  approvers: ["Grace Hopper", "Linus Torvalds"],
  ...over,
});
