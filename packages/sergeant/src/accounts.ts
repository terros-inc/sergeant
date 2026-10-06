import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountAdapter, type Provider, providerOf, QuotaWindowName, safeJson, type QuotaReading } from "@terros/sergeant-contracts";
import { accountQuota, type ModelAccount, type QuotaAccount } from "@terros/sergeant-runner";
import { z } from "zod";
import { run, secretResolver, type InstallationConfig } from "./config.ts";

// The model accounts people register (TECH-5113): each person's own Claude or Codex subscription
// login, as many as they like under names of their own (TECH-5196), kept with everyone else's in one
// Secrets Manager secret that only this host reads and writes. A person registers and removes only their own: an entry is found by
// their Linear user id, which the API takes from their login, never from the request. They are the
// only accounts runs use, and a task's runs use only its owner's (TECH-5179, owner.ts): the human
// assignee who delegated it. No credential is ever returned, logged, or put in an error.

// `name` and `email` are the person's; `accountName` is the account's, unique among theirs.
const Entry = z.object({
  adapter: AccountAdapter,
  accountName: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  credential: z.string(),
  registeredAt: z.string(),
  /** The quota windows its provider did not report at registration (TECH-5211). */
  quotaUnknown: z.array(QuotaWindowName).optional(),
});
type Entry = z.infer<typeof Entry>;
const Registered = z.object({ accounts: z.array(Entry) });

export type Person = { id: string; name: string; email: string };
/** An account as the API shows it: never its credential. */
export type ListedAccount = Omit<ModelAccount, "credential"> & { group: "registered"; name: string; userId: string; registeredAt: string; quotaUnknown?: QuotaWindowName[] };

/** Registration refused for a reason the caller can act on; its message never quotes the credential. */
export class AccountRefused extends Error {}

// Refusals in plain English (TECH-5202): a person reads them, not an operator, so they name no config.
const NOT_SET_UP = "This Sergeant isn't set up for account registration yet. Ask an approver to enable it.";
const PROVIDER_NAME: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

export type AccountRegistry = ReturnType<typeof accountRegistry>;

export function accountRegistry(opts: {
  /** The secret holding registered accounts; absent, nobody can register. */
  secret?: string | undefined;
  readSecret: (ref: string) => Promise<string>;
  writeSecret: (ref: string, value: string) => Promise<void>;
  /** Adapters this installation can run: Codex only with its `codex` config, which names the model. */
  adapters: AccountAdapter[];
  /** Reads a credential's quota: registration keeps one with at least one window read (TECH-5211). */
  readQuota: (account: QuotaAccount) => Promise<QuotaReading>;
  log: (line: string) => void;
}) {
  const id = (e: Pick<Entry, "userId" | "accountName">) => `person:${e.userId}:${e.accountName}`;
  const holder = (e: Pick<Entry, "name" | "email">) => `${e.name} <${e.email}>`;
  // One write at a time, so two registrations cannot overwrite each other's read-modify-write.
  let writes: Promise<unknown> = Promise.resolve();

  async function entries(): Promise<Entry[]> {
    if (!opts.secret) return [];
    const raw = await opts.readSecret(opts.secret);
    const parsed = Registered.safeParse(safeJson(raw));
    // Never quote the value: it holds credentials.
    if (!parsed.success) throw new Error(`the registered-accounts secret ${opts.secret} is not {"accounts":[…]}`);
    return parsed.data.accounts;
  }

  function change<T>(edit: (current: Entry[]) => Promise<{ next: Entry[]; result: T }>): Promise<T> {
    const secret = opts.secret;
    if (!secret) return Promise.reject(new AccountRefused(NOT_SET_UP));
    const done = writes.then(async () => {
      const { next, result } = await edit(await entries());
      await opts.writeSecret(secret, JSON.stringify({ accounts: next }));
      return result;
    });
    writes = done.catch(() => {});
    return done;
  }

  const account = (e: Entry): ModelAccount => ({ id: id(e), adapter: e.adapter, holder: holder(e), credential: e.credential });
  const listed = (e: Entry): ListedAccount => {
    const { credential: _, ...a } = account(e);
    return { ...a, group: "registered", name: e.accountName, userId: e.userId, registeredAt: e.registeredAt, ...(e.quotaUnknown && { quotaUnknown: e.quotaUnknown }) };
  };

  return {
    /** The providers people may register accounts of: none without the secret (TECH-5202). */
    providers(): Provider[] {
      return opts.secret ? opts.adapters.map(providerOf) : [];
    },

    /** The accounts `userId` registered, for an installation's adapters: the only ones their tasks run on. Throws when unreadable. */
    async of(userId: string): Promise<ModelAccount[]> {
      return (await entries()).filter((e) => e.userId === userId && opts.adapters.includes(e.adapter)).map(account);
    },

    /** Every registered account, without credentials. */
    async list(): Promise<ListedAccount[]> {
      return (await entries()).map(listed);
    },

    /** Registers, or replaces, the person's own account named `accountName`, once some of its quota reads with it. */
    async register(person: Person, adapter: AccountAdapter, accountName: string, credential: string) {
      if (!opts.adapters.includes(adapter)) throw new AccountRefused(`This Sergeant doesn't run ${PROVIDER_NAME[providerOf(adapter)]} accounts. Ask an approver if you need it.`);
      if (adapter === "codex-local" && !credential.startsWith("{")) {
        throw new AccountRefused("a Codex account is the JSON of the auth.json a `codex login` with your ChatGPT account writes, not an API key");
      }
      const at = { userId: person.id, accountName };
      const quota = await opts.readQuota({ id: id(at), adapter, credential });
      // A rejected credential (401/403) reads no window. A plan that reports only one still registers
      // (TECH-5211), and chooseAccount scores it on that window (TECH-5342).
      if (!quota.weekly && !quota.fiveHour) {
        throw new AccountRefused(`its subscription quota cannot be read with this credential (${quota.error ?? "no quota window was reported"}), so Sergeant could not choose it`);
      }
      const unknown: QuotaWindowName[] = [...(quota.weekly ? [] : ["weekly" as const]), ...(quota.fiveHour ? [] : ["5-hour" as const])];
      const entry: Entry = {
        adapter, ...at, name: person.name, email: person.email, credential, registeredAt: new Date().toISOString(),
        ...(unknown.length > 0 && { quotaUnknown: unknown }),
      };
      const replaced = await change(async (current) => {
        const mine = (e: Entry) => e.userId === person.id && e.accountName === accountName;
        return { next: [...current.filter((e) => !mine(e)), entry], result: current.some(mine) };
      });
      opts.log(`${person.name} ${replaced ? "replaced" : "registered"} their ${adapter} model account ${accountName}`);
      return { account: listed(entry), replaced, quota };
    },

    /** Removes the person's own account named `accountName`; its adapter, or undefined when they had none. */
    async remove(person: Pick<Person, "id" | "name">, accountName: string): Promise<AccountAdapter | undefined> {
      const removed = await change(async (current) => {
        const mine = (e: Entry) => e.userId === person.id && e.accountName === accountName;
        return { next: current.filter((e) => !mine(e)), result: current.find(mine)?.adapter };
      });
      if (removed) opts.log(`${person.name} removed their model account ${accountName}`);
      return removed;
    },

    /** Offboarding (TECH-5130): removes every account `userId` registered, by `by`; the ones removed, without credentials. */
    async removePerson(userId: string, by: string): Promise<{ id: string; adapter: AccountAdapter; holder: string }[]> {
      const removed = await change(async (current) => ({
        next: current.filter((e) => e.userId !== userId),
        result: current.filter((e) => e.userId === userId).map((e) => ({ id: id(e), adapter: e.adapter, holder: holder(e) })),
      }));
      for (const a of removed) opts.log(`${by} removed ${a.holder}'s ${a.adapter} model account`);
      return removed;
    },
  };
}

/** The runner's model accounts and the registry behind `/v1/accounts`, from the installation (serve, canary). */
export function modelAccounts(config: InstallationConfig, log: (line: string) => void) {
  const readQuota = accountQuota();
  const registry = accountRegistry({
    secret: config.registeredAccountsSecret,
    readSecret: secretResolver(config),
    writeSecret: secretWriter(config),
    adapters: config.codex ? ["claude-code-local", "codex-local"] : ["claude-code-local"],
    readQuota,
    log,
  });
  const runner = { quota: readQuota, accounts: registry.of };
  return { registry, runner };
}

/** Puts a new value of an existing secret: from a private temporary file, so it is never on a command line. */
export function secretWriter(config: InstallationConfig) {
  const { awsRegion, awsProfile } = config.secrets;
  return async (ref: string, value: string): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), "sergeant-secret-"));
    const file = join(dir, "value");
    try {
      await writeFile(file, value, { mode: 0o600 });
      await run("aws", [
        "secretsmanager", "put-secret-value", "--secret-id", ref, "--secret-string", `file://${file}`,
        "--region", awsRegion, ...(awsProfile ? ["--profile", awsProfile] : []),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
