import { expect, test } from "vitest";
import { pickAccount, setAside, SET_ASIDE_MS, type ModelAccount } from "./accounts.ts";
import type { Adapter } from "./agents.ts";
import type { ReadQuota } from "./quota.ts";

const account = (id: string, adapter: Adapter, group: ModelAccount["group"] = "owner"): ModelAccount => ({
  id,
  adapter,
  group,
  holder: group === "owner" ? "the installation" : "Ada Example",
  credential: `credential-of-${id}`,
});
const terrosClaude = account("installation-claude", "claude-code-local");
const terrosCodex = account("installation-codex", "codex-local");

/** Weekly and 5-hour percent left per account id; an id not listed reads as unknown. */
const quota =
  (left: Record<string, [number, number]>): ReadQuota =>
  async ({ id, adapter }) => {
    const l = left[id];
    return l
      ? { adapter, account: id, readAt: "2026-10-03T12:00:00.000Z", weekly: { remainingPercent: l[0] }, fiveHour: { remainingPercent: l[1] } }
      : { adapter, account: id, readAt: "2026-10-03T12:00:00.000Z", error: "usage endpoint answered 401" };
  };
const pick = (accounts: ModelAccount[], left: Record<string, [number, number]>, more: Partial<Parameters<typeof pickAccount>[0]> = {}) =>
  pickAccount({ accounts, read: quota(left), isSetAside: () => false, role: "worker", configured: "codex-local", workerAdapter: undefined, ...more });

// The owner's decision (2026-10-03): the owner's own accounts serve first, and someone's registered
// subscription only when none of the owner's is usable, even when it has more of its week left.
test("the owner's usable account wins over a registered one with more week left", async () => {
  const ada = account("person:ada:codex-local", "codex-local", "registered");
  const second = account("terros-codex-2", "codex-local");
  const left = { "installation-codex": [30, 90], "terros-codex-2": [50, 90], [ada.id]: [95, 95] } as Record<string, [number, number]>;
  const chosen = await pick([terrosCodex, second, ada], left);
  expect(chosen.account.id).toBe("terros-codex-2");
  expect(chosen.accountReason).toMatch(/^owner's account terros-codex-2, 50% weekly/);

  // Every owner's account below the 5-hour floor, spent for the week, or unreadable: the registered one.
  const spent = await pick([terrosCodex, second, ada], { "installation-codex": [30, 19.9], "terros-codex-2": [0, 90], [ada.id]: [40, 60] });
  expect(spent).toMatchObject({ account: { id: ada.id, group: "registered" }, accountReason: expect.stringContaining("no owner's account usable") });

  // Nothing usable anywhere: the installation's own account, as an unknown reading keeps the configured provider.
  expect((await pick([terrosCodex, ada], { "installation-codex": [30, 5], [ada.id]: [80, 10] })).account.id).toBe("installation-codex");
});

// Owner-first across providers (the owner, 2026-10-03): a usable owner's account of either provider
// serves before any registered one. Terros Claude's 5-hour window is spent, so the worker runs on
// Terros Codex at 53% rather than a registered Claude account with more of its week left.
test("a usable owner's account of the other provider wins over a registered one", async () => {
  const ada = account("person:ada:claude-code-local", "claude-code-local", "registered");
  const accounts = [terrosClaude, terrosCodex, ada];
  const left: Record<string, [number, number]> = { "installation-claude": [83, 10], "installation-codex": [53, 90], [ada.id]: [70, 90] };
  const chosen = await pick(accounts, left);
  expect(chosen.account.id).toBe("installation-codex");
  expect(chosen.providerChoice).toMatchObject({ adapter: "codex-local", reason: "the only provider with a usable owner's account" });

  // Its reviewer stays on the owner's accounts too: the same provider as its worker, and says so.
  const reviewer = await pick(accounts, left, { role: "reviewer", workerAdapter: "codex-local" });
  expect(reviewer).toMatchObject({ account: { id: "installation-codex" }, providerChoice: { sameProviderAsWorker: true } });

  // With both of the owner's usable, TECH-5117's rule decides between them: the 2026-10-03 morning
  // (Terros Codex at 53%, Claude with room) sends the worker to Claude and its reviewer to Codex.
  const both = { ...left, "installation-claude": [83, 90] } as Record<string, [number, number]>;
  expect((await pick(accounts, both)).account.id).toBe("installation-claude");
  expect((await pick(accounts, both, { role: "reviewer", workerAdapter: "claude-code-local" })).account.id).toBe("installation-codex");
});

test("registered accounts serve only once every owner's account of either provider is unusable", async () => {
  const adaClaude = account("person:ada:claude-code-local", "claude-code-local", "registered");
  const adaCodex = account("person:ada:codex-local", "codex-local", "registered");
  const accounts = [terrosClaude, terrosCodex, adaClaude, adaCodex];
  const left: Record<string, [number, number]> = { "installation-claude": [83, 10], "installation-codex": [0, 90], [adaClaude.id]: [40, 90], [adaCodex.id]: [70, 90] };
  const worker = await pick(accounts, left);
  expect(worker).toMatchObject({ account: { id: adaCodex.id }, accountReason: expect.stringContaining("no owner's account usable") });
  // The reviewer, among the registered ones, goes to the other provider as TECH-5117 wants.
  expect((await pick(accounts, left, { role: "reviewer", workerAdapter: "codex-local" })).account.id).toBe(adaClaude.id);
});

// A run that failed on the account's quota or login must not be retried on the same account while
// another can take it; with no other, the provider's accounts are all tried again rather than none.
test("an account set aside after a quota or auth failure is passed over until it is the only one", async () => {
  let now = 0;
  const asides = setAside(() => now);
  const second = account("terros-claude-2", "claude-code-local");
  const left: Record<string, [number, number]> = { "installation-claude": [80, 90], "terros-claude-2": [20, 90] };
  const next = { isSetAside: asides.has, configured: "claude-code-local" as const };
  expect((await pick([terrosClaude, second], left, next)).account.id).toBe("installation-claude");
  asides.add("installation-claude");
  expect((await pick([terrosClaude, second], left, next)).account.id).toBe("terros-claude-2");
  // Without a quota reader too: the next account, and the record says why.
  expect(await pick([terrosClaude, second], left, { ...next, read: undefined })).toMatchObject({
    account: { id: "terros-claude-2" },
    accountReason: "installation-claude set aside after a quota or authentication failure",
  });
  expect((await pick([terrosClaude], left, next)).account.id).toBe("installation-claude");
  now += SET_ASIDE_MS;
  expect((await pick([terrosClaude, second], left, next)).account.id).toBe("installation-claude");
});

// An installation with one account per provider and no quota reader behaves as before TECH-5113.
test("a single account reads nothing and runs the configured provider", async () => {
  let reads = 0;
  const chosen = await pickAccount({
    accounts: [terrosClaude],
    read: async (a) => (reads++, { adapter: a.adapter, readAt: "" }),
    isSetAside: () => false,
    role: "worker",
    configured: "claude-code-local",
    workerAdapter: undefined,
  });
  expect(chosen).toEqual({ account: terrosClaude });
  expect(reads).toBe(0);
});
