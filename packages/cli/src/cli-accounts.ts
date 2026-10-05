import { AccountList, AccountName, Provider, RegisterAccountResponse, RemoveAccountResponse, RemovePersonAccountsResponse, WhoAmI } from "@terros/sergeant-contracts";
import { type Command, call, client, fail, print, settle, Usage } from "./cli-call.ts";
import { accountRow, quotaLeft, table } from "./format.ts";
import { providerEmail, registeredLine, registeringFor, registrationRefusal, strandedNotice } from "./register.ts";

// `sgt account …`: the model accounts runs may use, registering and removing your own, and an
// approver's `sgt admin account remove-person`.

// TECH-5205: a bare `sgt account register` names the providers and how to name an account.
const REGISTER_USAGE = [
  "account register takes the provider: claude (your Claude subscription) or codex (your ChatGPT login for Codex).",
  "The account is named after the provider unless --name gives it a name of your own:",
  "  sgt account register claude",
  "  sgt account register codex --name codexWork",
].join("\n");

export const accountCommands: Record<string, Command> = {
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
};
