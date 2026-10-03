import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiError } from "@terros/sergeant-contracts";
import type { z } from "zod";
import type { ApiControl } from "./api.ts";
import { CallerRefused, type Caller } from "./auth.ts";

// The client API's HTTP plumbing (api.ts): replies, refusals, request bodies, and who the caller is.

export type Reply = { status: number; json?: unknown; markdown?: string };

export class Refusal extends Error {
  readonly status: number;
  readonly code: ApiError["error"]["code"];
  constructor(status: number, code: ApiError["error"]["code"], message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const LOOPBACK_PEER = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function send(res: ServerResponse, reply: Reply): void {
  if (reply.markdown !== undefined) {
    res.writeHead(reply.status, { "Content-Type": "text/markdown; charset=utf-8" }).end(reply.markdown);
  } else if (reply.json !== undefined) {
    res.writeHead(reply.status, { "Content-Type": "application/json" }).end(JSON.stringify(reply.json));
  } else {
    res.writeHead(reply.status).end();
  }
}

export async function callerOf(req: IncomingMessage, ctl: ApiControl): Promise<Caller> {
  const authorization = req.headers.authorization;
  if (authorization !== undefined) {
    const token = /^Bearer (\S+)$/.exec(authorization)?.[1];
    if (!token) throw new Refusal(401, "unauthorized", "send the Linear login as `Authorization: Bearer <access token>`");
    if (!ctl.callerOf) throw new Refusal(401, "unauthorized", "this Sergeant has no Linear login configured (installation config `humans`)");
    return ctl.callerOf(token).catch((e: Error) => {
      if (e instanceof CallerRefused) throw new Refusal(e.status, e.status === 401 ? "unauthorized" : "forbidden", e.message);
      throw new Refusal(503, "unavailable", `cannot check the caller's Linear login: ${e.message}`);
    });
  }
  const forwarded = req.headers.forwarded !== undefined || req.headers["x-forwarded-for"] !== undefined;
  if (ctl.trustLoopback && LOOPBACK_PEER.has(req.socket.remoteAddress ?? "") && LOOPBACK_HOST.test(req.headers.host ?? "") && !forwarded) {
    return { kind: "loopback", approver: true };
  }
  throw new Refusal(401, "unauthorized", "the Sergeant API needs your Linear login: run `sgt login`");
}

export const ok = (json: unknown): Reply => ({ status: 200, json });
export const notFound = (what: string) => new Refusal(404, "not_found", `no ${what}`);

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Refusal(400, "bad_request", parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

export async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
    throw new Refusal(400, "bad_request", "send the request body as application/json");
  }
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > 64_000) throw new Refusal(400, "bad_request", "request body too large");
  }
  try {
    return raw === "" ? {} : JSON.parse(raw);
  } catch {
    throw new Refusal(400, "bad_request", "request body is not JSON");
  }
}
