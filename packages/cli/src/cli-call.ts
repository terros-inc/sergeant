import {
  type ApiError,
  type ApiResult,
  apiClient,
  type Method,
  MIN_CLI_VERSION,
  type Provider,
  safeJson,
  type WhoAmI,
} from "@terros/sergeant-contracts";
import { sergeantVersion } from "@terros/sergeant-contracts/version";
import type { z } from "zod";

// The plumbing every `sgt` command shares (cli.ts): one API call per request, sent with the caller's
// login and this sgt's version, and the answer printed concise or as the API's own JSON with `--json`.

export type Io = {
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch?: typeof globalThis.fetch;
  /** Shows the human a URL in their browser (`sgt login`); it is printed either way. */
  openUrl?: (url: string) => void;
  /** All of standard input when it is piped: a credential to register, never an argument a shell history would keep. */
  stdin?: () => Promise<string>;
  /** With nothing piped, the credential from the provider's own sign-in on this terminal (signin.ts). */
  signIn?: (provider: Provider) => Promise<string>;
  /** This sgt's version (tests); sergeantVersion's otherwise. */
  version?: string;
  /** Waits between reads while `sgt admin` waits for the host (tests); a timer otherwise. */
  sleep?: (ms: number) => Promise<void>;
};

export type Flags = { name?: string | undefined; reason?: string | undefined; task?: string | undefined; "merge-method"?: string | undefined };
/**
 * `token`: the Linear access token sent as the caller's bearer, when signed in. `warned`: whether this
 * invocation has said its server is older than it, shared by every copy of the context.
 */
export type Context = { api: string; json: boolean; io: Io; flags: Flags; token?: string | undefined; warned: { olderServer: boolean } };
/** `args` arguments, and up to `optional` more; `usage`, what a wrong number of them says instead of the count. */
export type Command = { args: number; optional?: number; usage?: string; flags?: (keyof Flags)[]; run: (ctx: Context, args: string[]) => Promise<void> };

export class Usage extends Error {}
export class Failure extends Error {}

/** One API call; a refusal, an unreachable API, or a response outside the contract ends the command. */
export async function request(ctx: Context, method: Method, path: string, body?: object): Promise<string> {
  return settle(ctx, await client(ctx).request(method, path, body));
}

export async function call<T>(ctx: Context, method: Method, path: string, schema: z.ZodType<T>, body?: object): Promise<T> {
  return settle(ctx, await client(ctx).call(method, path, schema, body));
}

/**
 * `call`, also returning the API's answer as sent: `--json` prints that, so a field this sgt's contract
 * does not know yet, which the parse strips, still reaches it (TECH-5148).
 */
export async function callAnswer<T>(ctx: Context, method: Method, path: string, schema: z.ZodType<T>): Promise<{ value: T; answer: unknown }> {
  const text = await request(ctx, method, path);
  const answer = safeJson(text);
  const parsed = schema.safeParse(answer);
  if (!parsed.success) fail(ctx, "unavailable", `${method} ${path} answered outside the API contract: ${parsed.error.issues[0]?.message ?? text.slice(0, 200)}`);
  return { value: parsed.data, answer };
}

export const client = (ctx: Context) =>
  apiClient({
    api: ctx.api,
    fetch: ctx.io.fetch,
    token: ctx.token,
    unreachableHint: ". Is serve running there, and is SGT_API_URL the hosted HTTPS endpoint (README.md)?",
    version: ctx.io.version ?? sergeantVersion().version,
    onOlderServer: (serverMin) => warnOlderServer(ctx, serverMin),
  });

/** Once per invocation: the Sergeant answering predates a change this sgt needs, so commands may fail. */
function warnOlderServer(ctx: Context, serverMin: string | undefined): void {
  if (ctx.warned.olderServer) return;
  ctx.warned.olderServer = true;
  const supports = serverMin === undefined ? "does not say which sgt it supports" : `supports sgt ${serverMin} and later`;
  ctx.io.err(`sgt: warning: Sergeant at ${ctx.api} is older than this sgt (it ${supports}; this sgt needs one that supports ${MIN_CLI_VERSION}), so commands may fail until it is redeployed\n`);
}

export const settle = <T>(ctx: Context, res: ApiResult<T>): T => (res.ok ? res.value : fail(ctx, res.error.code, res.error.message));

export function fail(ctx: Context, code: ApiError["error"]["code"], message: string): never {
  if (ctx.json) ctx.io.out(`${JSON.stringify({ error: { code, message } } satisfies ApiError)}\n`);
  else ctx.io.err(`sgt: ${code}: ${message}\n`);
  throw new Failure(message);
}

export const path = (segment: string | undefined) => encodeURIComponent(segment ?? "");

export function print(ctx: Context, value: unknown, human: () => string): void {
  ctx.io.out(`${ctx.json ? JSON.stringify(value) : human()}\n`);
}

export const caller = (me: WhoAmI) =>
  me.user ? `${me.user.name} <${me.user.email}>${me.approver ? ", an approver" : ""}` : "an operator on the Sergeant host (serve --trust-loopback)";
