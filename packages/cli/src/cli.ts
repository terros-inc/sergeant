import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  type ApiError,
  type ApiResult,
  apiClient,
  CancelRunResponse,
  CancelTaskResponse,
  LoginConfig,
  type Method,
  RunDetail,
  RunList,
  sergeantVersion,
  TaskDetail,
  TaskList,
  WakeResponse,
  WhoAmI,
} from "@terros/sergeant-contracts";
import type { z } from "zod";
import { runRow, showRun, showTask, table, taskRow } from "./format.ts";
import { currentToken, linearLogin, loadCredential, saveCredential } from "./login.ts";

// `sgt`, a thin client of the Sergeant 2 API (11 §7, UNF-714): it sends one request per command and
// prints the answer, concise by default and the API's own JSON with `--json`. Every decision is the
// server's. `sgt login` signs the human in with their own Linear login (login.ts), kept per API URL and
// sent as a bearer on every call; the server checks it against Linear and refuses anything else.

export const DEFAULT_API = "http://127.0.0.1:8080";

export const USAGE = `usage: sgt [--api <url>] [--json] <command>

  login                              sign in with your Linear account (opens a browser)
  logout                             forget this machine's login for the API
  whoami                             who the API takes you for
  task list                          tasks Sergeant knows, with status, turns, and runs
  task show <UNF-123>                one task: issue, budget, runs, recent turns
  task wake <UNF-123> [--reason …]   take a turn now
  task cancel <UNF-123> --reason …   stop: removes Sergeant's delegation and cancels its runs
  run list [--task <UNF-123>]
  run show <run>
  run report <run>                   the run's raw Markdown report
  run cancel <run> [--reason …]

The API is --api, else SGT_API_URL, else ${DEFAULT_API} (serve on this host, or the hosted
one through an SSM port-forward). Each API URL has its own login. --json prints the API's JSON
unchanged, errors included. -v/--version prints Sergeant's version (from git) and exits without an API call.`;

export type Io = {
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  fetch?: typeof globalThis.fetch;
  /** Shows the human a URL in their browser (`sgt login`); it is printed either way. */
  openUrl?: (url: string) => void;
};

type Flags = { reason?: string | undefined; task?: string | undefined };
/** `token`: the Linear access token sent as the caller's bearer, when signed in. */
type Context = { api: string; json: boolean; io: Io; flags: Flags; token?: string | undefined };
type Command = { args: number; flags?: (keyof Flags)[]; run: (ctx: Context, args: string[]) => Promise<void> };

class Usage extends Error {}
class Failure extends Error {}

const commands: Record<string, Command> = {
  "task list": {
    args: 0,
    run: async (ctx) => {
      const { tasks } = await call(ctx, "GET", "/v1/tasks", TaskList);
      print(ctx, { tasks }, () => (tasks.length ? table(tasks.map(taskRow)) : "no tasks"));
    },
  },
  "task show": {
    args: 1,
    run: async (ctx, [ref]) => {
      const detail = await call(ctx, "GET", `/v1/tasks/${path(ref)}`, TaskDetail);
      print(ctx, detail, () => showTask(detail));
    },
  },
  "task wake": {
    args: 1,
    flags: ["reason"],
    run: async (ctx, [ref]) => {
      const res = await call(ctx, "POST", `/v1/tasks/${path(ref)}/wake`, WakeResponse, { reason: ctx.flags.reason });
      const said = {
        active: "its loop polls now and takes a turn once nothing holds it (a running run, an open question, an exhausted budget)",
        admitted: "its loop started and takes a turn",
        queued: "every task slot is busy; it starts and takes a turn at the next free slot",
      }[res.woke];
      print(ctx, res, () => `${res.ref} woken: ${said}`);
    },
  },
  "task cancel": {
    args: 1,
    flags: ["reason"],
    run: async (ctx, [ref]) => {
      if (!ctx.flags.reason?.trim()) throw new Usage("task cancel needs --reason");
      const res = await call(ctx, "POST", `/v1/tasks/${path(ref)}/cancel`, CancelTaskResponse, { reason: ctx.flags.reason, requestId: randomUUID() });
      print(ctx, res, () => {
        const delegation = res.undelegated ? "Sergeant's delegation is removed" : "Sergeant was already not delegated";
        if (res.stopping.length > 0) {
          return `${res.ref} canceling: ${delegation}; not yet confirmed stopped, Sergeant keeps canceling: ${res.stopping.join(", ")} (sgt run list --task ${res.ref}). Its open PRs are closed once they stop.`;
        }
        // An older Sergeant does not report the PRs it closed: say nothing rather than guess.
        const prs = res.closedPullRequests;
        const closed = prs === undefined ? [] : prs.length === 0 ? ["no open worker PR to close"] : prs.map((p) => `closed ${p.repo}#${p.number}  ${p.url}`);
        return [`${res.ref} canceled: ${delegation} and no run of it is running`, ...closed].join("\n");
      });
    },
  },
  "run list": {
    args: 0,
    flags: ["task"],
    run: async (ctx) => {
      const query = ctx.flags.task ? `?task=${path(ctx.flags.task)}` : "";
      const { runs } = await call(ctx, "GET", `/v1/runs${query}`, RunList);
      print(ctx, { runs }, () => (runs.length ? table(runs.map(runRow)) : "no runs"));
    },
  },
  "run show": {
    args: 1,
    run: async (ctx, [runId]) => {
      const detail = await call(ctx, "GET", `/v1/runs/${path(runId)}`, RunDetail);
      print(ctx, detail, () => showRun(detail));
    },
  },
  "run report": {
    args: 1,
    run: async (ctx, [runId]) => {
      const markdown = await request(ctx, "GET", `/v1/runs/${path(runId)}/report`);
      ctx.io.out(ctx.json ? `${JSON.stringify({ report: markdown })}\n` : markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    },
  },
  "run cancel": {
    args: 1,
    flags: ["reason"],
    run: async (ctx, [runId]) => {
      const res = await call(ctx, "POST", `/v1/runs/${path(runId)}/cancel`, CancelRunResponse, { reason: ctx.flags.reason });
      print(ctx, res, () => `${res.runId} (${res.task}) ${res.status === "canceled" ? "canceled" : `already ${res.status}`}`);
    },
  },
  login: {
    args: 0,
    run: async (ctx) => {
      const { linear } = await call(ctx, "GET", "/v1/auth/config", LoginConfig);
      const credential = await linearLogin({
        clientId: linear.clientId,
        env: ctx.io.env,
        fetch: ctx.io.fetch ?? globalThis.fetch,
        open: (url) => {
          ctx.io.err(`Sign in to Sergeant at ${ctx.api} with Linear. If no browser opens, visit:\n  ${url}\n`);
          ctx.io.openUrl?.(url);
        },
      }).catch((e: Error) => fail(ctx, "unauthorized", e.message));
      // Kept only once the API accepts it: a login it refuses would fail every later command.
      const me = await call({ ...ctx, token: credential.accessToken }, "GET", "/v1/whoami", WhoAmI);
      await saveCredential(ctx.io.env, ctx.api, credential);
      print(ctx, me, () => `signed in to ${ctx.api} as ${caller(me)}`);
    },
  },
  logout: {
    args: 0,
    run: async (ctx) => {
      const signedOut = (await loadCredential(ctx.io.env, ctx.api)) !== undefined;
      if (signedOut) await saveCredential(ctx.io.env, ctx.api, undefined);
      print(ctx, { api: ctx.api, signedOut }, () =>
        signedOut
          ? `signed out of ${ctx.api} on this machine; to end the login at Linear too, revoke the Sergeant app in your Linear account settings`
          : `not signed in to ${ctx.api}`,
      );
    },
  },
  whoami: {
    args: 0,
    run: async (ctx) => {
      const me = await call(ctx, "GET", "/v1/whoami", WhoAmI);
      print(ctx, me, () => [`api ${ctx.api}: ${caller(me)}`, `enrolled ${me.enrolledRepositories.join(", ") || "none"}`].join("\n"));
    },
  },
};

const caller = (me: WhoAmI) =>
  me.user ? `${me.user.name} <${me.user.email}>${me.approver ? ", an approver" : ""}` : "an operator on the Sergeant host (serve --trust-loopback)";

const ONE_WORD = ["login", "logout", "whoami"];

/** Runs one `sgt` invocation; returns the exit code: 0 ok, 1 the API refused or failed, 2 usage. */
export async function main(argv: string[], io: Io): Promise<number> {
  let json = argv.includes("--json");
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        api: { type: "string" },
        json: { type: "boolean" },
        reason: { type: "string" },
        task: { type: "string" },
        version: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    });
    json = values.json ?? false;
    if (values.version) {
      // Sergeant's version from git (contracts' sergeantVersion), never the package.json number.
      const { version } = sergeantVersion();
      io.out(`${json ? JSON.stringify({ version }) : `sgt ${version}`}\n`);
      return 0;
    }
    if (values.help || positionals.length === 0) {
      io.out(`${USAGE}\n`);
      return values.help ? 0 : 2;
    }
    const name = ONE_WORD.includes(positionals[0] ?? "") ? (positionals[0] ?? "") : positionals.slice(0, 2).join(" ");
    const command = commands[name];
    if (!command) throw new Usage(`unknown command: ${positionals.join(" ")}`);
    const args = positionals.slice(name.split(" ").length);
    if (args.length !== command.args) throw new Usage(`${name} takes ${command.args || "no"} argument${command.args === 1 ? "" : "s"}`);
    const flags = { reason: values.reason, task: values.task };
    const stray = (Object.keys(flags) as (keyof Flags)[]).find((f) => flags[f] !== undefined && !command.flags?.includes(f));
    if (stray) throw new Usage(`${name} takes no --${stray}`);
    const api = (values.api ?? io.env.SGT_API_URL ?? DEFAULT_API).replace(/\/+$/, "");
    const ctx: Context = { api, json, io, flags };
    if (name !== "login" && name !== "logout") {
      ctx.token = await currentToken(io.env, api, io.fetch ?? globalThis.fetch).catch((e: Error) => fail(ctx, "unauthorized", e.message));
    }
    await command.run(ctx, args);
    return 0;
  } catch (e) {
    if (e instanceof Failure) return 1;
    const usage = e instanceof Usage || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    if (!usage) throw e;
    io.err(`sgt: ${(e as Error).message} (sgt --help for usage)\n`);
    return 2;
  }
}

/** One API call; a refusal, an unreachable API, or a response outside the contract ends the command. */
async function request(ctx: Context, method: Method, path: string, body?: object): Promise<string> {
  return settle(ctx, await client(ctx).request(method, path, body));
}

async function call<T>(ctx: Context, method: Method, path: string, schema: z.ZodType<T>, body?: object): Promise<T> {
  return settle(ctx, await client(ctx).call(method, path, schema, body));
}

const client = (ctx: Context) =>
  apiClient({
    api: ctx.api,
    fetch: ctx.io.fetch,
    token: ctx.token,
    unreachableHint: ". Is serve running there, and is SGT_API_URL the hosted HTTPS endpoint (README.md)?",
  });

const settle = <T>(ctx: Context, res: ApiResult<T>): T => (res.ok ? res.value : fail(ctx, res.error.code, res.error.message));

function fail(ctx: Context, code: ApiError["error"]["code"], message: string): never {
  if (ctx.json) ctx.io.out(`${JSON.stringify({ error: { code, message } } satisfies ApiError)}\n`);
  else ctx.io.err(`sgt: ${code}: ${message}\n`);
  throw new Failure(message);
}

const path = (segment: string | undefined) => encodeURIComponent(segment ?? "");

function print(ctx: Context, value: unknown, human: () => string): void {
  ctx.io.out(`${ctx.json ? JSON.stringify(value) : human()}\n`);
}
