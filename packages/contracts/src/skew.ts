import { createHash } from "node:crypto";
import { z } from "zod";
import * as api from "./api.ts";

// Client/server version skew (TECH-5155). People run `sgt` and `sgt-mcp` from their own clone, so
// they are often older or newer than the hosted `serve`. The policy, so a contract change needs no
// compatibility ticket of its own:
//
// 1. Visible: `serve` stamps every `/v1` answer with its git version and a fingerprint of the `/v1`
//    contract (api.ts and what it embeds). A client whose own fingerprint differs, or whose server
//    sends none (it predates this), warns once that fields one side added are missing or ignored on
//    the other. Unequal versions with an equal contract are not worth a warning.
// 2. Additive: a response may gain fields. An older client drops them (zod strips unknown keys),
//    and rule 1 warns it. A request field the server would require, a removed or retyped field, or a
//    new enum value an older client must parse is not additive: it is a breaking change to make
//    deliberately, not under this rule.
// 3. Tolerant: a client accepts a 2xx answer whose only fault is required fields it lacks (an older
//    server never sent them), names them, and shows the API's JSON instead of reading them, so a
//    command the server performed is never reported as failed for a field it did not know. So a new
//    response field is added as required, not optional; any other mismatch is still an error.

export const VERSION_HEADER = "Sergeant-Version";
export const CONTRACT_HEADER = "Sergeant-Api-Contract";

let fingerprint: string | undefined;

/** The `/v1` contract's fingerprint: a hash of every api.ts schema as JSON Schema, so it changes exactly when a schema does. */
export function apiContract(): string {
  if (fingerprint === undefined) {
    const schemas = Object.entries<unknown>(api)
      .filter((e): e is [string, z.ZodType] => e[1] instanceof z.ZodType)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, schema]) => [name, z.toJSONSchema(schema, { io: "output", unrepresentable: "any" })]);
    fingerprint = createHash("sha256").update(JSON.stringify(schemas)).digest("hex").slice(0, 12);
  }
  return fingerprint;
}

/** The headers `serve` sends on every `/v1` answer: its `version` (sergeantVersion) and its contract. */
export const versionHeaders = (version: string) => ({ [VERSION_HEADER]: version, [CONTRACT_HEADER]: apiContract() });

/** What a server says of itself in its answer's headers; both absent from a server that predates this. */
export type ServerVersion = { version?: string | undefined; contract?: string | undefined };

/** The one warning a client gives when its server's contract differs from its own. */
export function skewWarning(apiUrl: string, server: ServerVersion, clientVersion: string): string {
  const fix = "Update this client (git pull) or redeploy Sergeant so they match.";
  if (server.contract === undefined) {
    return `Sergeant at ${apiUrl} predates API contract reporting, so it is older than this client (${clientVersion}): fields this client expects may be missing. ${fix}`;
  }
  return `Sergeant at ${apiUrl} (${server.version ?? "unknown version"}) serves a different API contract than this client (${clientVersion}): fields one side added are missing or ignored on the other. ${fix}`;
}

/**
 * The fields `issues` say are required but absent from `input`, when that is all that is wrong with it
 * (rule 3): an older server's answer. Undefined when any issue is something else.
 */
export function absentFields(issues: readonly z.core.$ZodIssue[], input: unknown): string[] | undefined {
  const absent: string[] = [];
  for (const issue of issues) {
    if (issue.code !== "invalid_type" || issue.path.length === 0) return undefined;
    const parent = issue.path.slice(0, -1).reduce<unknown>((v, key) => (v as Record<PropertyKey, unknown> | undefined)?.[key], input);
    const key = issue.path.at(-1) as PropertyKey;
    if (typeof parent !== "object" || parent === null || Array.isArray(parent) || key in parent) return undefined;
    absent.push(issue.path.join("."));
  }
  return absent.length > 0 ? absent : undefined;
}
