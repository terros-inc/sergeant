import { randomUUID } from "node:crypto";
import { link, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import {
  AdminRequest,
  AdminResult,
  AdminUpdateRequest,
  type AdminRequestResponse,
  type AdminStatus,
} from "@terros/sergeant-contracts";
import { z } from "zod";
import { body, notFound, ok, parse, Refusal, type Reply } from "./api-http.ts";
import { callerName, type Caller } from "./auth.ts";

// `/v1/admin` (TECH-5195, contracts' admin.ts): an approver restarts or updates the Sergeant host. serve
// runs nothing privileged and changes nothing itself: it records who asked in its log and leaves one
// request file in its state directory, created atomically and never replaced. One action at a time: a
// request is refused while another waits to be taken or the host's latest outcome is still running,
// so the outcome a waiting `sgt` reads is not replaced by a request it never saw coming. The host's automatic-update service (sergeant-autoupdate.path and
// .sh, deploy/README.md) takes it as root, checks it again, runs `sergeant-update`, and writes the
// outcome to a root-owned file this route reads back. The restart is serve's ordinary graceful stop.

export type HostAdmin = {
  /** Where serve leaves a request: `<state dir>/admin-request.json`, which sergeant-autoupdate.path watches. */
  requestFile: string;
  /** The host's latest restart or update, written by sergeant-autoupdate: `/etc/sergeant/admin-result.json`. */
  resultFile: string;
  /** What sergeant-update last checked out: `/etc/sergeant/release`. */
  releaseFile: string;
  /** This process, as it started: the checkout may change under it during an update. */
  serve: AdminStatus["serve"];
};

export async function adminRoute(
  admin: HostAdmin | undefined,
  caller: Caller,
  req: IncomingMessage,
  at: { id: string | undefined; verb: string | undefined; pathname: string },
  log: (line: string) => void,
): Promise<Reply> {
  if (!admin) throw new Refusal(404, "not_found", "this Sergeant is not on a Sergeant host (deploy/README.md), so it cannot restart or update itself");
  if (!caller.approver) throw new Refusal(403, "forbidden", "only an approver restarts or updates the Sergeant host, or reads its status");
  if (at.verb === undefined && at.id === "status" && req.method === "GET") return ok(await status(admin));
  if (at.verb === undefined && at.id === "restart" && req.method === "POST") {
    parse(z.strictObject({}), await body(req));
    return ok(await hand(admin, { action: "restart" }, caller, log));
  }
  if (at.verb === undefined && at.id === "update" && req.method === "POST") {
    const { ref } = parse(AdminUpdateRequest, await body(req));
    return ok(await hand(admin, { action: "update", ...(ref && { ref }) }, caller, log));
  }
  throw notFound(at.pathname);
}

async function hand(admin: HostAdmin, what: Pick<AdminRequest, "action" | "ref">, caller: Caller, log: (line: string) => void): Promise<AdminRequestResponse> {
  const busy = await readJson(admin.resultFile, AdminResult);
  if (busy?.outcome === "running") {
    throw new Refusal(409, "conflict", `the host is still running ${busy.action} by ${busy.by}, since ${busy.startedAt}: see \`sgt admin status\``);
  }
  const by = caller.kind === "linear" ? `${caller.user.name} <${caller.user.email}>` : callerName(caller);
  const request: AdminRequest = { id: randomUUID(), ...what, by, at: new Date().toISOString() };
  // Written whole, then linked into place: the host never reads half a request, and link refuses to replace one.
  const tmp = `${admin.requestFile}.${request.id}.tmp`;
  await writeFile(tmp, JSON.stringify(request));
  try {
    await link(tmp, admin.requestFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pending = await readJson(admin.requestFile, AdminRequest);
    const which = pending ? `${pending.action} by ${pending.by}, asked at ${pending.at}` : "an earlier request";
    throw new Refusal(409, "conflict", `the host has not yet taken ${which}: see \`sgt admin status\``);
  } finally {
    await rm(tmp, { force: true });
  }
  log(`admin ${request.action}${request.ref ? ` to ${request.ref}` : ""} requested by ${by} (${request.id})`);
  return { request, last: busy };
}

async function status(admin: HostAdmin): Promise<AdminStatus> {
  const [release, pending, last] = await Promise.all([
    readFile(admin.releaseFile, "utf8").then(parseRelease, () => null),
    readJson(admin.requestFile, AdminRequest),
    readJson(admin.resultFile, AdminResult),
  ]);
  return { serve: admin.serve, release, pending, last };
}

/** sergeant-update's `ref=…`, `sha=…`, `at=…` lines. */
function parseRelease(text: string): AdminStatus["release"] {
  const field = (name: string) => new RegExp(`^${name}=(.*)$`, "m").exec(text)?.[1];
  const [ref, sha, at] = [field("ref"), field("sha"), field("at")];
  return ref && sha && at ? { ref, sha, at } : null;
}

/** The file's JSON if it holds what `schema` says; null when it is absent or does not. */
async function readJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
