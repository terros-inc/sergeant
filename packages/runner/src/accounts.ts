import type { ProviderChoice, RunAccount } from "@terros/sergeant-contracts";
import { ADAPTERS, type Adapter } from "./agents.ts";
import { chooseAccount, chooseReviewer, chooseWorker, type AccountCandidate } from "./choose.ts";
import type { Role } from "./options.ts";
import type { QuotaAccount, ReadQuota } from "./quota.ts";

// Which model account a launch runs on (TECH-5113). An installation holds several per provider: its
// own (the config's), then those people registered with `sgt`. Each launch picks its provider and
// that provider's account from live quota (choose.ts). A run that fails on quota or authentication
// sets its account aside for a while, so the next launch takes the next one; the set-aside lives in
// memory only, and losing it on a restart costs at most one more failed run.

/** A model account a run may use: its credential, and whose it is. */
export type ModelAccount = QuotaAccount & { group: RunAccount["group"]; holder: string };

/** The installation's own two credentials, its first accounts: `installation-claude` and `installation-codex`. */
export function installationAccounts(claudeOAuthToken: string, codexCredential: string | undefined): ModelAccount[] {
  const own = (id: string, adapter: Adapter, credential: string): ModelAccount => ({ id, adapter, credential, group: "owner", holder: "the installation" });
  return [own("installation-claude", "claude-code-local", claudeOAuthToken), ...(codexCredential ? [own("installation-codex", "codex-local", codexCredential)] : [])];
}

export const SET_ASIDE_MS = 60 * 60_000;

/** Accounts whose last run failed on quota or authentication, until when. */
export function setAside(now: () => number = Date.now) {
  const until = new Map<string, number>();
  return {
    add(accountId: string) {
      until.set(accountId, now() + SET_ASIDE_MS);
    },
    has: (accountId: string) => (until.get(accountId) ?? 0) > now(),
  };
}

export type AccountPick = { account: ModelAccount; accountReason?: string; providerChoice?: ProviderChoice };

/**
 * The account for one launch, in the order the owner set: the role's provider is TECH-5117's choice
 * between the providers' best accounts, and each provider's account is `chooseAccount`'s. Accounts set
 * aside are passed over unless every account of their provider is. Without `read`, or with a single
 * account and provider, nothing is read and the role's configured provider runs its first account.
 */
export async function pickAccount(opts: {
  accounts: ModelAccount[];
  read: ReadQuota | undefined;
  isSetAside: (accountId: string) => boolean;
  role: Role;
  configured: Adapter;
  workerAdapter: Adapter | undefined;
}): Promise<AccountPick> {
  const pools = new Map<Adapter, ModelAccount[]>();
  for (const adapter of ADAPTERS) {
    const all = opts.accounts.filter((a) => a.adapter === adapter);
    const live = all.filter((a) => !opts.isSetAside(a.id));
    if (all.length) pools.set(adapter, live.length ? live : all);
  }
  const read = opts.read;
  const several = pools.size > 1 || [...pools.values()].some((p) => p.length > 1);
  if (!read || !several) {
    const account = (pools.get(opts.configured) ?? [])[0];
    if (!account) throw new Error(`no ${opts.configured} model account`);
    const skipped = opts.accounts.find((a) => a.adapter === opts.configured && opts.isSetAside(a.id));
    return { account, ...(skipped && { accountReason: `${skipped.id} set aside after a quota or authentication failure` }) };
  }
  const best = new Map<string, AccountCandidate<ModelAccount> & { reason: string }>();
  for (const [adapter, pool] of pools) {
    const candidates = await Promise.all(
      pool.map(async (account) => ({ adapter, account, group: account.group, quota: await read(account) })),
    );
    best.set(adapter, chooseAccount(candidates));
  }
  const providers = [...best.values()].map(({ adapter, quota }) => ({ adapter, quota }));
  const providerChoice =
    providers.length > 1
      ? opts.role === "worker"
        ? chooseWorker(providers, opts.configured)
        : chooseReviewer(providers, opts.workerAdapter, opts.configured)
      : undefined;
  const chosen = best.get(providerChoice?.adapter ?? opts.configured) ?? [...best.values()][0];
  if (!chosen) throw new Error("no model account");
  return { account: chosen.account, accountReason: chosen.reason, ...(providerChoice && { providerChoice }) };
}

/** What a run record says about its account: never the credential. */
export const runAccount = ({ id, group, holder }: ModelAccount): RunAccount => ({ id, group, holder });
