import type { IncomingMessage } from "node:http";
import {
  type AccountAdapter,
  PROVIDER_ADAPTER,
  providerOf,
  REVOKE,
  RegisterAccountRequest,
  RemoveAccountRequest,
  type AccountList,
  type AccountSummary,
  type RegisterAccountResponse,
  type RemoveAccountResponse,
  RemovePersonAccountsRequest,
  type RemovePersonAccountsResponse,
  type RunRecord,
} from "@terros/sergeant-contracts";
import { AccountRefused, type AccountRegistry, type Person } from "./accounts.ts";
import { body, notFound, ok, parse, Refusal, type Reply } from "./api-http.ts";
import { callerName, type Caller } from "./auth.ts";

// `/v1/accounts` (TECH-5113): the registered model accounts and the runs each paid for, and a person's
// own accounts, each under a name of theirs (TECH-5196), registered or removed with their own Linear
// login. A loopback operator is no person, so registers nothing. A task's runs use only its owner's
// accounts (TECH-5179).
//
//   GET  /v1/accounts
//   POST /v1/accounts/register   { "provider": "claude|codex", "name": "…", "credential": "…" }
//   POST /v1/accounts/remove     { "name": "…" }
//   POST /v1/accounts/remove-person   { "userId": "<Linear user id>" }
//
// `remove-person` is offboarding hygiene (TECH-5130), an approver's or a loopback operator's: it removes
// every account that person registered, so Sergeant starts no new run on them. It is no launch guard:
// once a task runs only on its own owner's accounts (TECH-5179), a leaver's registration cannot pay for
// anyone else's work in any case.

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
  if (at.id === undefined || at.verb !== undefined || req.method !== "POST") throw notFound(at.pathname);
  if (at.id === "remove-person") {
    if (!caller.approver) throw new Refusal(403, "forbidden", "only an approver, or an operator on the Sergeant host, removes another person's model accounts");
    const { userId } = parse(RemovePersonAccountsRequest, await body(req));
    return ok({ userId, removed: await refusing(registry.removePerson(userId, callerName(caller))) } satisfies RemovePersonAccountsResponse);
  }
  if (at.id !== "register" && at.id !== "remove") throw notFound(at.pathname);
  if (!me) throw new Refusal(403, "forbidden", "an account is registered or removed by its own person: sign in with `sgt login`");
  if (at.id === "register") {
    const { provider, name, credential } = parse(RegisterAccountRequest, await body(req));
    const adapter = PROVIDER_ADAPTER[provider];
    const res = await refusing(registry.register(me, adapter, name, credential));
    return ok({ account: { ...res.account, mine: true }, replaced: res.replaced, quota: res.quota, notice: exposureNotice(adapter, name) } satisfies RegisterAccountResponse);
  }
  const { name } = parse(RemoveAccountRequest, await body(req));
  const removed = await refusing(registry.remove(me, name));
  return ok({ name, removed: removed !== undefined, ...(removed && { notice: removalNotice(removed, name) }) } satisfies RemoveAccountResponse);
}

// The accepted risk (09 §3a), told at registration and again at removal: a run's model credential is in
// its container, so a compromised run can copy it, and removing it from Sergeant does not revoke a copy.
// Neither provider documents a revoke Sergeant could call with the stored credential (TECH-5198), so
// the notices say how the person revokes it themselves, or, for Codex, that OpenAI documents no way to
// (contracts' REVOKE, TECH-5200).
export const exposureNotice = (adapter: AccountAdapter, name: string): string =>
  `Your credential is used inside Sergeant's worker and reviewer containers while runs work on it, so it could be exposed if a run is compromised, for example by prompt injection. ` +
  `To stop Sergeant using it, run \`sgt account remove ${name}\`. That does not revoke a copy a run took. ${REVOKE[providerOf(adapter)]} ` +
  `\`sgt account register ${providerOf(adapter)} --name ${name}\` registers a new one in its place.`;

const removalNotice = (adapter: AccountAdapter, name: string): string =>
  `Sergeant starts no new run on ${name}; runs already on it finish on it. A run could have copied it, and removing it here does not revoke that copy. ` +
  REVOKE[providerOf(adapter)];

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
