import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import {
  AccountList,
  AccountName,
  AdminRequestResponse,
  AdminStatus,
  type ApiError,
  type ApiResult,
  apiClient,
  CancelRunResponse,
  CancelTaskResponse,
  LoginConfig,
  type Method,
  RegisterAccountResponse,
  RemoveAccountResponse,
  RemovePersonAccountsResponse,
  RepositoryChange,
  RepositoryList,
  RetroRequestResponse,
  RunDetail,
  RunList,
  MIN_CLI_VERSION,
  safeJson,
  Provider,
  sergeantVersion,
  TaskDetail,
  TaskList,
  WakeResponse,
  WhoAmI,
} from "@terros/sergeant-contracts";
import type { z } from "zod";
import { showOutcome, showStatus, staleConfig, waitForOutcome } from "./admin.ts";
import { accountRow, quotaLeft, runRow, showRun, showTask, table, taskRow } from "./format.ts";
import { currentToken, linearLogin, loadCredential, saveCredential } from "./login.ts";
import { providerEmail, registeredLine, registeringFor, registrationRefusal, strandedNotice } from "./register.ts";
import { CHECKOUT, update } from "./update.ts";

// `sgt`, a thin client of the Sergeant 2 API (11 §7, UNF-714): it sends one request per command and
// prints the answer, concise by default and as JSON with `--json` (USAGE says which shape). Every
// decision is the server's. `sgt login` signs the human in with their own Linear login (login.ts), kept
// per API URL and sent as a bearer on every call; the server checks it against Linear and refuses anything else.
// There is no compatibility between versions of sgt and the API (contracts' min-cli.ts): every call
// names this sgt's version, the server refuses one older than it supports before acting and says to run
// `sgt update`, and an sgt newer than its server warns once.

export const DEFAULT_API = "http://127.0.0.1:8080";

export const USAGE = `usage: sgt [--api <url>] [--json] <command>

  login                              sign in with your Linear account (opens a browser)
  logout                             forget this machine's login for the API
  whoami                             who the API takes you for
  update                             update this sgt: fast-forward its checkout to main and install it
  task list                          tasks Sergeant knows, with status, turns, and runs
  task show <UNF-123>                one task: issue, budget, runs, recent turns
  task wake <UNF-123> [--reason …]   take a turn now
  task cancel <UNF-123> --reason …   stop: removes Sergeant's delegation and cancels its runs
  run list [--task <UNF-123>]
  run show <run>
  run report <run>                   the run's raw Markdown report
  run cancel <run> [--reason …]
  repo list                          the enrolled repositories and how Sergeant merges in each
  retro                              ask Sergeant for a retro across tasks now (after a big change, say);
                                     it is posted as a document in the Sergeant project
  account list                       model accounts runs may use: name, provider, whose, what each paid for
  account register <claude|codex> [--name <name>]
                                     register your own subscription: signs in with \`claude setup-token\`
                                     or \`codex login\`, or reads the credential piped to stdin. The name
                                     defaults to the provider; registering a name you have replaces it
  account remove <name>              remove your own registered account of that name
  admin account remove-person <linear-user-id>
                                     an approver's offboarding: remove every model account that
                                     person registered (\`sgt account list\` shows whose each is)
  admin restart                      an approver's: reread the installation config and restart serve on
                                     the release it runs, then wait for the outcome
  admin update [<ref>]               an approver's: move the host to <ref>, a commit on main whose check
                                     passed, else to what its release channel would choose; then wait.
                                     With nothing to install, it says if the config needs a restart
  admin status                       the host's release, when serve started, the last restart or update,
                                     and whether the installation config changed since serve started
  admin repo add <owner/name> [--merge-method squash|merge|rebase]
                                     an approver's enrollment (default squash), once both GitHub
                                     Apps reach it; serve takes it at once, no host update
  admin repo remove <owner/name>     an approver's removal: Sergeant stops working in it at once

The API is --api, else SGT_API_URL, else ${DEFAULT_API} (serve on this host, or the hosted
one through an SSM port-forward). Each API URL has its own login. --json prints JSON for scripts:
the API's answer for most commands, but {"report"} (the Markdown) for run report, {"api","signedOut"}
for logout, {"version"} for update and --version, {"request","outcome"} for admin restart and admin
update, and errors as {"error":{"code","message"}}. -v/--version prints Sergeant's version (from git)
and exits without an API call.`;

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

type Flags = { name?: string | undefined; reason?: string | undefined; task?: string | undefined; "merge-method"?: string | undefined };
/**
 * `token`: the Linear access token sent as the caller's bearer, when signed in. `warned`: whether this
 * invocation has said its server is older than it, shared by every copy of the context.
 */
type Context = { api: string; json: boolean; io: Io; flags: Flags; token?: string | undefined; warned: { olderServer: boolean } };
/** `args` arguments, and up to `optional` more; `usage`, what a wrong number of them says instead of the count. */
type Command = { args: number; optional?: number; usage?: string; flags?: (keyof Flags)[]; run: (ctx: Context, args: string[]) => Promise<void> };

class Usage extends Error {}

// TECH-5205: a bare `sgt account register` names the providers and how to name an account.
const REGISTER_USAGE = [
  "account register takes the provider: claude (your Claude subscription) or codex (your ChatGPT login for Codex).",
  "The account is named after the provider unless --name gives it a name of your own:",
  "  sgt account register claude",
  "  sgt account register codex --name codexWork",
].join("\n");
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
        const prs = res.closedPullRequests;
        const closed = prs.length === 0 ? ["no open worker PR to close"] : prs.map((p) => `closed ${p.repo}#${p.number}  ${p.url}`);
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
      const { value: detail, answer } = await callAnswer(ctx, "GET", `/v1/runs/${path(runId)}`, RunDetail);
      print(ctx, answer, () => showRun(detail));
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
  "account list": {
    args: 0,
    run: async (ctx) => {
      const { accounts } = await call(ctx, "GET", "/v1/accounts", AccountList);
      print(ctx, { accounts }, () => (accounts.length ? table(accounts.map(accountRow)) : "no accounts"));
    },
  },
  "account register": {
    args: 1,
    usage: REGISTER_USAGE,
    flags: ["name"],
    run: async (ctx, [named]) => {
      const provider = Provider.safeParse(named).data;
      if (!provider) throw new Usage(REGISTER_USAGE);
      const name = ctx.flags.name ?? provider;
      const valid = AccountName.safeParse(name);
      if (!valid.success) throw new Usage(`--name: ${valid.error.issues[0]?.message}`);
      const piped = ctx.io.stdin && (await ctx.io.stdin()).trim();
      if (piped === "") throw new Usage("account register read an empty stdin: pipe the credential, or run it with nothing piped to sign in");
      if (!piped && !ctx.io.signIn) throw new Usage("account register needs the credential on stdin here");
      // TECH-5202: the login and whether this Sergeant takes the account, before anything makes a credential.
      const me = await call(ctx, "GET", "/v1/whoami", WhoAmI);
      const refused = registrationRefusal(me, provider);
      if (refused) fail(ctx, refused.code, refused.message);
      ctx.io.err(`${registeringFor(me, provider, name)}\n`);
      let credential = piped;
      if (!credential && ctx.io.signIn) {
        ctx.io.err(`Signing in with ${provider === "claude" ? "`claude setup-token`" : "`codex login` (in a temporary CODEX_HOME; your ~/.codex is not touched)"}.\n`);
        credential = (await ctx.io.signIn(provider).catch((e: Error) => fail(ctx, "bad_request", e.message))).trim();
        if (!credential) fail(ctx, "bad_request", "the sign-in gave no credential; nothing was registered");
      }
      const signedIn = !piped;
      const posted = await client(ctx).call("POST", "/v1/accounts/register", RegisterAccountResponse, { provider, name, credential });
      if (!posted.ok && signedIn) {
        // `unavailable` is the one failure that may come after the store: unreachable, an unreadable answer, a failed write.
        try {
          settle(ctx, posted);
        } finally {
          ctx.io.err(`${strandedNotice(provider, name, posted.error.code !== "unavailable")}\n`);
        }
      }
      const res = settle(ctx, posted);
      print(ctx, res, () => `${registeredLine(res.replaced ? "replaced" : "registered", res.account.name, provider, providerEmail(provider, credential ?? ""), quotaLeft(res.quota))} Sergeant uses it only for tasks assigned to you that you delegate to it yourself.\n\n${res.notice}`);
    },
  },
  "account remove": {
    args: 1,
    run: async (ctx, [name]) => {
      const res = await call(ctx, "POST", "/v1/accounts/remove", RemoveAccountResponse, { name });
      print(ctx, res, () => (res.removed ? `removed your account ${res.name}. ${res.notice ?? "It does not revoke a copy a run may have taken."}` : `you have no registered account named ${res.name}`));
    },
  },
  "admin account remove-person": {
    args: 1,
    run: async (ctx, [userId]) => {
      const res = await call(ctx, "POST", "/v1/accounts/remove-person", RemovePersonAccountsResponse, { userId });
      print(ctx, res, () =>
        res.removed.length
          ? `removed ${res.removed.map((a) => `${a.id} (${a.holder})`).join(", ")}; runs already on them finish on them, and a copy is not revoked`
          : `${res.userId} has no registered model account`,
      );
    },
  },
  "admin status": {
    args: 0,
    run: async (ctx) => {
      const status = await call(ctx, "GET", "/v1/admin/status", AdminStatus);
      print(ctx, status, () => showStatus(status));
    },
  },
  "admin restart": {
    args: 0,
    run: (ctx) => adminRequest(ctx, "restart", {}),
  },
  "admin update": {
    args: 0,
    optional: 1,
    run: (ctx, [ref]) => adminRequest(ctx, "update", ref === undefined ? {} : { ref }),
  },
  retro: {
    args: 0,
    run: async (ctx) => {
      const res = await call(ctx, "POST", "/v1/retro", RetroRequestResponse, {});
      print(ctx, res, () => "retro requested: Sergeant runs it now and posts it as a document in the Sergeant project");
    },
  },
  "repo list": {
    args: 0,
    run: async (ctx) => {
      const { repositories } = await call(ctx, "GET", "/v1/repositories", RepositoryList);
      print(ctx, { repositories }, () => (repositories.length ? table(repositories.map((r) => [r.repo, r.mergeMethod])) : "no enrolled repositories"));
    },
  },
  "admin repo add": {
    args: 1,
    flags: ["merge-method"],
    run: async (ctx, [repo]) => {
      const res = await call(ctx, "POST", "/v1/repositories/add", RepositoryChange, { repo, mergeMethod: ctx.flags["merge-method"] });
      print(ctx, res, () => `${res.changed ? "enrolled" : "already enrolled:"} ${res.repo}; enrolled now: ${res.repositories.join(", ")}`);
    },
  },
  "admin repo remove": {
    args: 1,
    run: async (ctx, [repo]) => {
      const res = await call(ctx, "POST", "/v1/repositories/remove", RepositoryChange, { repo });
      print(ctx, res, () => `${res.changed ? "removed" : "not enrolled:"} ${res.repo}; enrolled now: ${res.repositories.join(", ") || "none"}`);
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
  update: {
    args: 0,
    run: async (ctx) => {
      ctx.io.err(`updating ${CHECKOUT} to origin's main\n`);
      const version = await update(CHECKOUT).catch((e: Error) => fail(ctx, "unavailable", e.message));
      print(ctx, { version }, () => `sgt ${version}`);
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

/** Hands the host the request, then waits for and prints its outcome: exit 1 when it failed. */
async function adminRequest(ctx: Context, action: "restart" | "update", body: { ref?: string }): Promise<void> {
  const { request, last } = await call(ctx, "POST", `/v1/admin/${action}`, AdminRequestResponse, body);
  ctx.io.err(`${action}${request.ref ? ` to ${request.ref}` : ""} requested (${request.id}); waiting for the host\n`);
  const sleep = ctx.io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const read = () => client(ctx).call("GET", "/v1/admin/status", AdminStatus);
  const outcome = settle(ctx, await waitForOutcome(request, last, read, { sleep, say: (line) => ctx.io.err(`${line}\n`), now: Date.now }));
  // TECH-5205: nothing newer to install, but the installation config changed since serve started: only a restart rereads it.
  const stale = outcome.outcome === "unchanged" ? await read().then((s) => (s.ok ? staleConfig(s.value) : undefined)) : undefined;
  print(ctx, { request, outcome }, () => (stale ? `${showOutcome(outcome)}\n${stale}` : showOutcome(outcome)));
  if (outcome.outcome === "failed") throw new Failure(outcome.message);
}

const caller = (me: WhoAmI) =>
  me.user ? `${me.user.name} <${me.user.email}>${me.approver ? ", an approver" : ""}` : "an operator on the Sergeant host (serve --trust-loopback)";


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
        name: { type: "string" },
        reason: { type: "string" },
        task: { type: "string" },
        "merge-method": { type: "string" },
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
    // The longest command the leading words name: `whoami`, `task show`, `admin account remove-person`.
    const name = [3, 2, 1].map((n) => positionals.slice(0, n).join(" ")).find((n) => Object.hasOwn(commands, n));
    const command = name === undefined ? undefined : commands[name];
    if (name === undefined || !command) throw new Usage(`unknown command: ${positionals.join(" ")}`);
    const args = positionals.slice(name.split(" ").length);
    const most = command.args + (command.optional ?? 0);
    if (args.length < command.args || args.length > most) {
      const takes = most === command.args ? `${command.args || "no"}` : `${command.args} to ${most}`;
      throw new Usage(command.usage ?? `${name} takes ${takes} argument${most === 1 ? "" : "s"}`);
    }
    const flags: Flags = { name: values.name, reason: values.reason, task: values.task, "merge-method": values["merge-method"] };
    const stray = (Object.keys(flags) as (keyof Flags)[]).find((f) => flags[f] !== undefined && !command.flags?.includes(f));
    if (stray) throw new Usage(`${name} takes no --${stray}`);
    const api = (values.api ?? io.env.SGT_API_URL ?? DEFAULT_API).replace(/\/+$/, "");
    const ctx: Context = { api, json, io, flags, warned: { olderServer: false } };
    if (name !== "login" && name !== "logout" && name !== "update") {
      ctx.token = await currentToken(io.env, api, io.fetch ?? globalThis.fetch).catch((e: Error) => fail(ctx, "unauthorized", e.message));
    }
    await command.run(ctx, args);
    return 0;
  } catch (e) {
    if (e instanceof Failure) return 1;
    const usage = e instanceof Usage || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    if (!usage) throw e;
    const message = (e as Error).message;
    io.err(`sgt: ${message}${message.includes("\n") ? "\n" : " "}(sgt --help for usage)\n`);
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

/**
 * `call`, also returning the API's answer as sent: `--json` prints that, so a field this sgt's contract
 * does not know yet, which the parse strips, still reaches it (TECH-5148).
 */
async function callAnswer<T>(ctx: Context, method: Method, path: string, schema: z.ZodType<T>): Promise<{ value: T; answer: unknown }> {
  const text = await request(ctx, method, path);
  const answer = safeJson(text);
  const parsed = schema.safeParse(answer);
  if (!parsed.success) fail(ctx, "unavailable", `${method} ${path} answered outside the API contract: ${parsed.error.issues[0]?.message ?? text.slice(0, 200)}`);
  return { value: parsed.data, answer };
}

const client = (ctx: Context) =>
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
