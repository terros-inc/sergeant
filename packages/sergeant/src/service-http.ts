import { createServer, type RequestListener, type Server } from "node:http";
import { sergeantVersion, type ApiError } from "@terros/sergeant-contracts";
import { fromThisHost, send } from "./api-http.ts";
import type { Slot } from "./slots.ts";
import { WEBHOOK_PATHS } from "./webhooks.ts";

type IntakeStatus = { at: string; error?: string } | undefined;

export function createServiceServer(input: {
  abort: AbortController;
  lastIntake: () => IntakeStatus;
  slots: Map<string, Slot>;
  active: Map<string, Promise<void>>;
  webhooks: RequestListener;
  api: RequestListener;
}): Server {
  const webhookPaths = new Set<string>(Object.values(WEBHOOK_PATHS));
  const { version } = sergeantVersion();
  return createServer((req, res) => {
    // `/health` and the webhooks are the only paths the host's proxy publishes, so `/health` says
    // only whether serve is healthy: not stopping, and its latest intake succeeded. Task ids and
    // intake errors are private, served on `/status` to loopback only, with Sergeant's git version.
    // `/status` refuses any other caller as `/v1` does, so its privacy does not rest on the proxy.
    const lastIntake = input.lastIntake();
    const ok = !input.abort.signal.aborted && !lastIntake?.error;
    if (req.method === "GET" && req.url === "/status" && !fromThisHost(req)) {
      const refused: ApiError = { error: { code: "unauthorized", message: "/status answers only a caller on the Sergeant host" } };
      send(res, { status: 401, json: refused });
    } else if (req.method === "GET" && (req.url === "/health" || req.url === "/status")) {
      res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
      const released = [...input.slots].filter(([, slot]) => slot.released).map(([id]) => id);
      const detail = req.url === "/status" && { version, stopping: input.abort.signal.aborted, tasks: [...input.active.keys()], released, lastIntake };
      res.end(JSON.stringify({ ok, ...detail }));
    } else if (webhookPaths.has(new URL(req.url ?? "/", "http://localhost").pathname)) {
      input.webhooks(req, res);
    } else {
      input.api(req, res);
    }
  });
}
