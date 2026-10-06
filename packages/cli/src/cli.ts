import { parseArgs } from "node:util";
import { LoginConfig, RetroRequestResponse, WhoAmI } from "@terros/sergeant-contracts";
import { currentToken, loadCredential, saveCredential } from "@terros/sergeant-contracts/credentials";
import { sergeantVersion } from "@terros/sergeant-contracts/version";
import { accountCommands } from "./cli-accounts.ts";
import { adminCommands } from "./cli-admin.ts";
import { type Command, type Context, call, callAnswer, caller, Failure, fail, type Flags, type Io, print, Usage } from "./cli-call.ts";
import { repoCommands } from "./cli-repos.ts";
import { runCommands } from "./cli-runs.ts";
import { taskCommands } from "./cli-tasks.ts";
import { linearLogin } from "./login.ts";
import { CHECKOUT, update } from "./update.ts";

export type { Io };

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
  admin repo add <owner/name> [--merge-method squash|merge|rebase] [--merge-policy sergeant|human]
                                     an approver's enrollment (default squash, human), once both GitHub
                                     Apps reach it; serve takes it at once, no host update. In a human
                                     repository Sergeant never approves or merges; a human merges.
                                     --merge-policy on an enrolled repository sets its policy
  admin repo remove <owner/name>     an approver's removal: Sergeant stops working in it at once

The API is --api, else SGT_API_URL, else ${DEFAULT_API} (serve on this host); the hosted API
is the installation's HTTPS endpoint, https://<hostname> (docs/sgt.md). Each API URL has its own
login. --json prints JSON for scripts: the API's answer for most commands, but {"report"} (the
Markdown) for run report, {"api","signedOut"} for logout, {"version"} for update and --version,
{"request","outcome"} for admin restart and admin update, and errors as {"error":{"code","message"}}.
-v/--version prints Sergeant's version (from git) and exits without an API call.`;

// Each command group has its own module (cli-tasks.ts, cli-runs.ts, cli-accounts.ts, cli-admin.ts,
// cli-repos.ts) over the shared API-call plumbing in cli-call.ts; signing in, out, updating, and retro are here.
const commands: Record<string, Command> = {
  ...taskCommands,
  ...runCommands,
  ...accountCommands,
  ...adminCommands,
  ...repoCommands,
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
      const { value: me, answer } = await callAnswer({ ...ctx, token: credential.accessToken }, "GET", "/v1/whoami", WhoAmI);
      await saveCredential(ctx.io.env, ctx.api, credential);
      print(ctx, answer, () => `signed in to ${ctx.api} as ${caller(me)}`);
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
      const { value: me, answer } = await callAnswer(ctx, "GET", "/v1/whoami", WhoAmI);
      print(ctx, answer, () => [`api ${ctx.api}: ${caller(me)}`, `enrolled ${me.enrolledRepositories.join(", ") || "none"}`].join("\n"));
    },
  },
  retro: {
    args: 0,
    run: async (ctx) => {
      const { answer } = await callAnswer(ctx, "POST", "/v1/retro", RetroRequestResponse, {});
      print(ctx, answer, () => "retro requested: Sergeant runs it now and posts it as a document in the Sergeant project");
    },
  },
};

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
        "merge-policy": { type: "string" },
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
    const flags: Flags = { name: values.name, reason: values.reason, task: values.task, "merge-method": values["merge-method"], "merge-policy": values["merge-policy"] };
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
