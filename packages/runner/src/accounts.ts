import { NoModelAccount, type LinearPerson, type ProviderChoice, type QuotaReading, type RunAccount } from "@terros/sergeant-contracts";
import type { Adapter } from "./agents.ts";
import { chooseAccount, percent, spent, type Candidate } from "./choose.ts";
import type { Role } from "./options.ts";
import type { QuotaAccount, ReadQuota } from "./quota.ts";

// Which model account a launch runs on (TECH-5179): only the task owner's own registered accounts,
// never the installation's or anyone else's. Each launch picks among them from live quota (choose.ts).
// A run that fails on quota or authentication sets its account aside for an hour, or until the window it
// ran out of resets if that is sooner (TECH-5213), so the next launch takes another of the owner's; the
// set-aside lives in memory only, and losing it on a restart costs at most one more failed run.

/** A model account a run may use: its credential, and whose it is. */
export type ModelAccount = QuotaAccount & { holder: string };

export const SET_ASIDE_MS = 60 * 60_000;

/** Accounts whose last run failed on quota or authentication, until when: `SET_ASIDE_MS`, or `resetsAt` (epoch ms) if sooner. */
export function setAside(now: () => number = Date.now) {
  const until = new Map<string, number>();
  return {
    add(accountId: string, resetsAt?: number) {
      until.set(accountId, Math.min(now() + SET_ASIDE_MS, resetsAt ?? Infinity));
    },
    has: (accountId: string) => (until.get(accountId) ?? 0) > now(),
  };
}

const windowsOf = (r: QuotaReading | undefined) => [r?.weekly, r?.fiveHour].flatMap((w) => (w ? [w] : []));
const resetOf = (w: { resetsAt?: string | undefined }) => (w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN);

/**
 * When a failed account may be usable again (epoch ms), for its set-aside after a quota or
 * authentication failure. From `fresh`, read at the failure: the windows now at 0% are the ones it ran
 * out of, and it is usable once the last of them resets. With none at 0% (a reading still cached from
 * launch, an unreadable one, or a failure the windows do not show), the soonest reset still ahead in
 * `fresh` or `atLaunch`, when its quota next changes. Undefined when that reset is unknown: the hour applies.
 */
export function failingReset(fresh: QuotaReading | undefined, atLaunch: QuotaReading | undefined, now: number): number | undefined {
  const out = windowsOf(fresh).filter((w) => w.remainingPercent <= 0).map(resetOf);
  if (out.length > 0) return out.some(Number.isNaN) ? undefined : Math.max(...out);
  const ahead = [...windowsOf(fresh), ...windowsOf(atLaunch)].map(resetOf).filter((t) => t > now);
  return ahead.length > 0 ? Math.min(...ahead) : undefined;
}

export type AccountPick = {
  account: ModelAccount;
  accountReason: string;
  providerChoice?: ProviderChoice;
};

/**
 * The account for one launch among `accounts`, the owner's registered ones (choose.ts), passing over
 * those set aside. Throws `NoModelAccount` when the owner has none, or none usable.
 */
export async function pickAccount(opts: {
  owner: LinearPerson;
  accounts: ModelAccount[];
  read: ReadQuota | undefined;
  isSetAside: (accountId: string) => boolean;
  role: Role;
  configured: Adapter;
  workerAdapter: Adapter | undefined;
  now?: () => number;
}): Promise<AccountPick> {
  const { owner, accounts, read } = opts;
  const ids = accounts.map((a) => a.id);
  if (accounts.length === 0) throw new NoModelAccount(owner, "none_registered", ids, `${owner.name} has no model account registered for a provider this Sergeant runs`);
  const live = accounts.filter((a) => !opts.isSetAside(a.id));
  const candidates: Candidate<ModelAccount>[] = await Promise.all(
    live.map(async (account) => ({ account, adapter: account.adapter, name: account.id, quota: read ? await read(account) : undefined })),
  );
  const avoid = opts.role === "reviewer" ? opts.workerAdapter : undefined;
  const chosen = chooseAccount(candidates, { prefer: opts.configured, avoid, now: (opts.now ?? Date.now)() });
  if (!chosen) {
    const why = [
      ...accounts.filter((a) => opts.isSetAside(a.id)).map((a) => `${a.id} set aside after a quota or authentication failure`),
      ...candidates.filter(spent).map((c) => `${c.name} spent (${percent(c)})`),
    ];
    throw new NoModelAccount(owner, "none_usable", ids, `none of ${owner.name}'s model accounts is usable: ${why.join("; ")}`);
  }
  const readings = candidates.flatMap((c) => (c.quota ? [c.quota] : []));
  const sameProviderAsWorker = avoid !== undefined && chosen.adapter === avoid;
  return {
    account: chosen.account,
    accountReason: chosen.reason,
    ...(readings.length > 0 && { providerChoice: { adapter: chosen.adapter, reason: chosen.reason, readings, ...(sameProviderAsWorker && { sameProviderAsWorker }) } }),
  };
}

/** What a run record says about its account: never the credential. Every account is a person's registered one. */
export const runAccount = ({ id, holder }: ModelAccount): RunAccount => ({ id, group: "registered", holder });
