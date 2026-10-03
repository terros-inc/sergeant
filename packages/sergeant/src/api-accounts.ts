import type { IncomingMessage } from "node:http";
import {
  AccountAdapter,
  RegisterAccountRequest,
  type AccountList,
  type AccountSummary,
  type RegisterAccountResponse,
  type RemoveAccountResponse,
  type RunRecord,
} from "@terros/sergeant-contracts";
import { AccountRefused, type AccountRegistry, type Person } from "./accounts.ts";
import { body, notFound, ok, parse, Refusal, type Reply } from "./api-http.ts";
import type { Caller } from "./auth.ts";

// `/v1/accounts` (TECH-5113): the model accounts runs may use and the runs each paid for, and a
// person's own account, registered or removed with their own Linear login. A loopback operator is no
// person, so registers nothing; the owner's accounts are the installation config's.
//
//   GET  /v1/accounts
//   POST /v1/accounts/<claude-code-local|codex-local>/register   { "credential": "…" }
//   POST /v1/accounts/<claude-code-local|codex-local>/remove

export async function accountsRoute(
  registry: AccountRegistry | undefined,
  caller: Caller,
  req: IncomingMessage,
  at: { id: string | undefined; verb: string | undefined; pathname: string },
  runs: () => Promise<RunRecord[]>,
): Promise<Reply> {
  if (!registry) throw new Refusal(404, "not_found", "this Sergeant lists no model accounts");
  const me = caller.kind === "linear" ? caller.user : undefined;
  if (at.id === undefined && req.method === "GET") return ok(await listAccounts(registry, me?.id, await runs()));
  if (at.id === undefined || req.method !== "POST") throw notFound(at.pathname);
  const adapter = parse(AccountAdapter, at.id);
  if (!me) throw new Refusal(403, "forbidden", "an account is registered or removed by its own person: sign in with `sgt login`");
  if (at.verb === "register") {
    const { credential } = parse(RegisterAccountRequest, await body(req));
    const res = await refusing(registry.register(me, adapter, credential));
    return ok({ account: { ...res.account, mine: true }, replaced: res.replaced, quota: res.quota } satisfies RegisterAccountResponse);
  }
  if (at.verb === "remove") return ok({ adapter, removed: await refusing(registry.remove(me, adapter)) } satisfies RemoveAccountResponse);
  throw notFound(at.pathname);
}

const refusing = <T>(p: Promise<T>): Promise<T> =>
  p.catch((e: Error) => {
    throw e instanceof AccountRefused ? new Refusal(400, "bad_request", e.message) : new Refusal(503, "unavailable", `model accounts unavailable: ${e.message}`);
  });

async function listAccounts(registry: AccountRegistry, userId: string | undefined, runs: RunRecord[]): Promise<AccountList> {
  const accounts = await refusing(registry.list());
  return {
    accounts: accounts.map(({ userId: owner, registeredAt, ...a }): AccountSummary => {
      const paid = runs.filter((r) => r.account?.id === a.id);
      const reported = paid.flatMap((r) => (r.costUsd === undefined ? [] : [r.costUsd]));
      return {
        ...a,
        mine: owner !== undefined && owner === userId,
        ...(registeredAt && { registeredAt }),
        usage: { runs: paid.length, costUsd: reported.reduce((sum, c) => sum + c, 0), unknownCostRuns: paid.length - reported.length },
      };
    }),
  };
}
