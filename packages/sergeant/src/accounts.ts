import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeJson, type AccountAdapter, type QuotaReading } from "@terros/sergeant-contracts";
import { accountQuota, installationAccounts, type ModelAccount, type QuotaAccount } from "@terros/sergeant-runner";
import { z } from "zod";
import { run, secretResolver, type Installation, type InstallationConfig } from "./config.ts";

// The model accounts people register (TECH-5113): each person's own Claude or Codex subscription
// login, at most one per agent CLI, kept with everyone else's in one Secrets Manager secret that only
// this host reads and writes. A person registers and removes only their own: an entry is found by
// their Linear user id, which the API takes from their login, never from the request. Runs use the
// owner's accounts first, then these, in registration order (runner `accounts.ts`). No credential is
// ever returned, logged, or put in an error.

const Entry = z.object({
  adapter: z.enum(["claude-code-local", "codex-local"]),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  credential: z.string(),
  registeredAt: z.string(),
});
type Entry = z.infer<typeof Entry>;
const Registered = z.object({ accounts: z.array(Entry) });

export type Person = { id: string; name: string; email: string };
/** An account as the API shows it: never its credential. */
export type ListedAccount = Omit<ModelAccount, "credential"> & { userId?: string; registeredAt?: string };

/** Registration refused for a reason the caller can act on; its message never quotes the credential. */
export class AccountRefused extends Error {}

export type AccountRegistry = ReturnType<typeof accountRegistry>;

export function accountRegistry(opts: {
  /** The installation's own accounts, which the runner already holds (`installation-claude`, `installation-codex`). */
  installation: ModelAccount[];
  /** The config's further accounts: the owner's, after the installation's own. */
  owners: ModelAccount[];
  /** The secret holding registered accounts; absent, nobody can register. */
  secret?: string | undefined;
  readSecret: (ref: string) => Promise<string>;
  writeSecret: (ref: string, value: string) => Promise<void>;
  /** Adapters this installation can run: Codex only with its `codex` config, which names the model. */
  adapters: AccountAdapter[];
  /** Reads a credential's quota: registration keeps only one whose weekly and 5-hour windows read. */
  readQuota: (account: QuotaAccount) => Promise<QuotaReading>;
  log: (line: string) => void;
}) {
  const id = (e: Pick<Entry, "userId" | "adapter">) => `person:${e.userId}:${e.adapter}`;
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
    if (!secret) return Promise.reject(new AccountRefused("this Sergeant takes no registered accounts (installation config `registeredAccountsSecret`)"));
    const done = writes.then(async () => {
      const { next, result } = await edit(await entries());
      await opts.writeSecret(secret, JSON.stringify({ accounts: next }));
      return result;
    });
    writes = done.catch(() => {});
    return done;
  }

  const account = (e: Entry): ModelAccount => ({ id: id(e), adapter: e.adapter, group: "registered", holder: holder(e), credential: e.credential });

  return {
    /** Every account runs may use after the installation's own two: the config's, then people's. Never throws. */
    async more(): Promise<ModelAccount[]> {
      const people = await entries().catch((e: Error) => {
        opts.log(`registered model accounts unreadable, using the owner's only: ${e.message}`);
        return [];
      });
      return [...opts.owners, ...people.filter((e) => opts.adapters.includes(e.adapter)).map(account)];
    },

    /** Every account, owner's first, without credentials. */
    async list(): Promise<ListedAccount[]> {
      const people = await entries();
      return [
        ...[...opts.installation, ...opts.owners].map(({ credential: _, ...a }) => a),
        ...people.map((e) => {
          const { credential: _, ...a } = account(e);
          return { ...a, userId: e.userId, registeredAt: e.registeredAt };
        }),
      ];
    },

    /** Registers, or replaces, the person's own account for `adapter`, once its quota reads with it. */
    async register(person: Person, adapter: AccountAdapter, credential: string) {
      if (!opts.adapters.includes(adapter)) throw new AccountRefused(`this Sergeant runs no ${adapter}`);
      if (adapter === "codex-local" && !credential.startsWith("{")) {
        throw new AccountRefused("a Codex account is the JSON of the auth.json a `codex login` with your ChatGPT account writes, not an API key");
      }
      const entry: Entry = { adapter, userId: person.id, name: person.name, email: person.email, credential, registeredAt: new Date().toISOString() };
      const quota = await opts.readQuota({ id: id(entry), adapter, credential });
      if (!quota.weekly || !quota.fiveHour) {
        throw new AccountRefused(`its subscription quota cannot be read with this credential (${quota.error ?? "a quota window is missing"}), so Sergeant could not choose it`);
      }
      const replaced = await change(async (current) => {
        const mine = (e: Entry) => e.userId === person.id && e.adapter === adapter;
        return { next: [...current.filter((e) => !mine(e)), entry], result: current.some(mine) };
      });
      opts.log(`${person.name} ${replaced ? "replaced" : "registered"} their ${adapter} model account`);
      const { credential: _, ...listed } = account(entry);
      return { account: { ...listed, userId: entry.userId, registeredAt: entry.registeredAt }, replaced, quota };
    },

    /** Removes the person's own account for `adapter`; false when they had none. */
    async remove(person: Pick<Person, "id" | "name">, adapter: AccountAdapter): Promise<boolean> {
      const removed = await change(async (current) => {
        const next = current.filter((e) => !(e.userId === person.id && e.adapter === adapter));
        return { next, result: next.length < current.length };
      });
      if (removed) opts.log(`${person.name} removed their ${adapter} model account`);
      return removed;
    },
  };
}

/** The runner's model accounts and the registry behind `/v1/accounts`, from the installation (serve, canary). */
export function modelAccounts(config: InstallationConfig, installation: Installation, log: (line: string) => void) {
  const readQuota = accountQuota();
  const { modelToken, codexCredential } = installation;
  const registry = accountRegistry({
    installation: installationAccounts(modelToken, codexCredential),
    owners: installation.ownerAccounts,
    secret: config.registeredAccountsSecret,
    readSecret: secretResolver(config),
    writeSecret: secretWriter(config),
    adapters: config.codex ? ["claude-code-local", "codex-local"] : ["claude-code-local"],
    readQuota,
    log,
  });
  const runner = { claudeOAuthToken: modelToken, ...(codexCredential !== undefined && { codexCredential }), quota: readQuota, accounts: registry.more };
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
