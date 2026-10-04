import type { IncomingMessage } from "node:http";
import {
  AccountAdapter,
  RegisterAccountRequest,
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

// `/v1/accounts` (TECH-5113): the model accounts runs may use and the runs each paid for, and a
// person's own account, registered or removed with their own Linear login. A loopback operator is no
// person, so registers nothing; the owner's accounts are the installation config's.
//
//   GET  /v1/accounts
//   POST /v1/accounts/<claude-code-local|codex-local>/register   { "credential": "…" }
//   POST /v1/accounts/<claude-code-local|codex-local>/remove
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
  if (at.id === undefined || req.method !== "POST") throw notFound(at.pathname);
  if (at.id === "remove-person" && at.verb === undefined) {
    if (!caller.approver) throw new Refusal(403, "forbidden", "only an approver, or an operator on the Sergeant host, removes another person's model accounts");
    const { userId } = parse(RemovePersonAccountsRequest, await body(req));
    return ok({ userId, removed: await refusing(registry.removePerson(userId, callerName(caller))) } satisfies RemovePersonAccountsResponse);
  }
  const adapter = parse(AccountAdapter, at.id);
  if (!me) throw new Refusal(403, "forbidden", "an account is registered or removed by its own person: sign in with `sgt login`");
  if (at.verb === "register") {
    const { credential } = parse(RegisterAccountRequest, await body(req));
    const res = await refusing(registry.register(me, adapter, credential));
    return ok({ account: { ...res.account, mine: true }, replaced: res.replaced, quota: res.quota, notice: exposureNotice(adapter) } satisfies RegisterAccountResponse);
  }
  if (at.verb === "remove") return ok({ adapter, removed: await refusing(registry.remove(me, adapter)) } satisfies RemoveAccountResponse);
  throw notFound(at.pathname);
}

// The accepted risk (09 §3a), told to everyone who registers: a run's model credential is in its
// container, so a compromised run can copy it, and removing it from Sergeant does not revoke a copy.
const ROTATE: Record<AccountAdapter, string> = {
  "claude-code-local": "revoke the token in your Claude account settings and make a new one with `claude setup-token`",
  "codex-local": "sign out of all ChatGPT sessions in your ChatGPT security settings and `codex login` again",
};

export const exposureNotice = (adapter: AccountAdapter): string =>
  `Your credential is used inside Sergeant's worker and reviewer containers while runs work on it, so it could be exposed if a run is compromised, for example by prompt injection. ` +
  `To stop Sergeant using it, run \`sgt account remove ${adapter}\`. That does not revoke a copy: to rotate it, ${ROTATE[adapter]}.`;

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
