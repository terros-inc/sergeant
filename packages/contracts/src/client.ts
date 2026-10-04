import type { z } from "zod";
import { ApiError } from "./api.ts";
import { CLI_VERSION_HEADER, MIN_CLI_HEADER, MIN_CLI_VERSION, olderThan } from "./min-cli.ts";

// The one typed client of the Sergeant API (`/v1`, api.ts) that `sgt` and `sgt-mcp` share (TECH-4950):
// one request, and its answer validated against the contract. A refusal, an unreachable API, or an
// answer outside the contract comes back as an `ApiError`'s error, never as a guess; each client
// decides how to show it. It lives here because client packages may depend only on contracts. Every
// request names this client's version, so a Sergeant that needs a newer client refuses it before acting
// (min-cli.ts); an answer from a Sergeant older than this client is reported.

export type ApiFailure = ApiError["error"];
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiFailure };
export type Method = "GET" | "POST";

export type ApiClientOptions = {
  /** The API's base URL, without a trailing slash. */
  api: string;
  fetch?: typeof globalThis.fetch | undefined;
  /** The caller's Linear access token, sent as a bearer; never over plain HTTP off this host. */
  token?: string | undefined;
  /** Appended to the message when the API cannot be reached: where the human should look. */
  unreachableHint?: string | undefined;
  /** This client's own version (sergeantVersion), sent on every request: a Sergeant that supports only newer clients refuses it. */
  version: string;
  /** Called for each answer from a Sergeant older than this client's minimum (min-cli.ts), or that reports none. */
  onOlderServer?: ((serverMin: string | undefined) => void) | undefined;
};

export type ApiClient = {
  /** One call; its body as text when the API answers 2xx. */
  request(method: Method, path: string, body?: object): Promise<ApiResult<string>>;
  /** One call; its answer parsed with `schema`. */
  call<T>(method: Method, path: string, schema: z.ZodType<T>, body?: object): Promise<ApiResult<T>>;
};

const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];

export function apiClient(opts: ApiClientOptions): ApiClient {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const failure = (code: ApiFailure["code"], message: string): { ok: false; error: ApiFailure } => ({ ok: false, error: { code, message } });

  async function request(method: Method, path: string, body?: object): Promise<ApiResult<string>> {
    const url = `${opts.api}${path}`;
    if (opts.token) {
      const parsed = URL.parse(url);
      if (!parsed) {
        return failure("bad_request", `invalid Sergeant API URL: ${opts.api}`);
      }
      if (parsed.protocol !== "https:" && !LOOPBACK.includes(parsed.hostname)) {
        return failure("bad_request", `refusing to send your Linear login to ${parsed.host} without HTTPS`);
      }
    }
    const headers = {
      [CLI_VERSION_HEADER]: opts.version,
      ...(body && { "Content-Type": "application/json" }),
      ...(opts.token && { Authorization: `Bearer ${opts.token}` }),
    };
    let res: Response;
    try {
      res = await fetchFn(url, { method, headers, ...(body && { body: JSON.stringify(body) }) });
    } catch (e) {
      const cause = ((e as Error).cause as Error | undefined)?.message ?? (e as Error).message;
      return failure("unavailable", `cannot reach the Sergeant API at ${opts.api} (${cause})${opts.unreachableHint ?? ""}`);
    }
    const text = await res.text();
    const refused = res.ok ? undefined : ApiError.safeParse(safeJson(text));
    // Only Sergeant's own answers say which clients it supports: a proxy's 502 does not.
    if (res.ok || refused?.success) {
      const serverMin = res.headers.get(MIN_CLI_HEADER) ?? undefined;
      if (serverMin === undefined || olderThan(serverMin, MIN_CLI_VERSION)) opts.onOlderServer?.(serverMin);
    }
    if (res.ok) return { ok: true, value: text };
    if (refused?.success) return { ok: false, error: refused.data.error };
    return failure("unavailable", `${method} ${path} answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }

  async function call<T>(method: Method, path: string, schema: z.ZodType<T>, body?: object): Promise<ApiResult<T>> {
    const res = await request(method, path, body);
    if (!res.ok) return res;
    const parsed = schema.safeParse(safeJson(res.value));
    if (!parsed.success) return failure("unavailable", `${method} ${path} answered outside the API contract: ${parsed.error.issues[0]?.message ?? res.value.slice(0, 200)}`);
    return { ok: true, value: parsed.data };
  }

  return { request, call };
}

/** `JSON.parse`, or `undefined` for text that is not JSON. */
export const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
