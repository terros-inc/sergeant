import { NoModelAccount } from "@terros/sergeant-contracts";
import { expect, test } from "vitest";
import { pickAccount, setAside, SET_ASIDE_MS, type ModelAccount } from "./accounts.ts";
import type { Adapter } from "./agents.ts";
import type { ReadQuota } from "./quota.ts";

// TECH-5179: a task runs only on its owner's registered accounts, chosen by quota. These are the
// owner's accounts as the registry returns them for the owner; nobody else's is ever passed in.

const ann = { id: "ann", name: "Ann" };
const account = (adapter: Adapter, n = ""): ModelAccount => ({ id: `person:ann:${adapter}${n}`, adapter, holder: "Ann <ann@example.com>", credential: `credential-${adapter}${n}` });
const claude = account("claude-code-local");
const codex = account("codex-local");

/** Weekly and 5-hour percent left per account id; an id not listed reads as unknown. */
const quota =
  (left: Record<string, [number, number]>): ReadQuota =>
  async ({ id, adapter }) => {
    const l = left[id];
    return l
      ? { adapter, account: id, readAt: "2026-10-04T12:00:00.000Z", weekly: { remainingPercent: l[0] }, fiveHour: { remainingPercent: l[1], resetsAt: "2026-10-04T15:00:00.000Z" } }
      : { adapter, account: id, readAt: "2026-10-04T12:00:00.000Z", error: "usage endpoint answered 401" };
  };
const pick = (accounts: ModelAccount[], left: Record<string, [number, number]>, more: Partial<Parameters<typeof pickAccount>[0]> = {}) =>
  pickAccount({ owner: ann, accounts, read: quota(left), isSetAside: () => false, role: "worker", configured: "codex-local", workerAdapter: undefined, ...more });

// The one rule: the most weekly capacity left among the usable accounts, skipping a 5-hour window
// under 20% while another usable account exists.
test("the most weekly capacity left, skipping a 5-hour window under the floor while another is usable", async () => {
  const chosen = await pick([claude, codex], { [claude.id]: [83, 90], [codex.id]: [53, 90] });
  expect(chosen).toMatchObject({ account: { id: claude.id }, accountReason: expect.stringContaining("the most weekly left of 2 usable") });
  // More week left but its 5-hour window below 20% (exactly, unrounded): the other one.
  expect((await pick([claude, codex], { [claude.id]: [83, 19.9], [codex.id]: [53, 20] })).account.id).toBe(codex.id);
  // Every usable account under the floor: still the most weekly left, rather than refusing the task.
  const thin = await pick([claude, codex], { [claude.id]: [70, 12], [codex.id]: [80, 5] });
  expect(thin).toMatchObject({ account: { id: codex.id }, accountReason: expect.stringContaining("every usable account under the 20% 5-hour floor") });
  // A spent window is never chosen, even with the other one full.
  expect((await pick([claude, codex], { [claude.id]: [0, 100], [codex.id]: [10, 90] })).account.id).toBe(codex.id);
  expect((await pick([claude, codex], { [claude.id]: [90, 0], [codex.id]: [10, 5] })).account.id).toBe(codex.id);
});

test("a reviewer prefers an account of another provider than its worker's, and says when it shares it", async () => {
  const left: Record<string, [number, number]> = { [claude.id]: [83, 90], [codex.id]: [43, 90] };
  const reviewer = await pick([claude, codex], left, { role: "reviewer", workerAdapter: "claude-code-local" });
  expect(reviewer.account.id).toBe(codex.id);
  expect(reviewer.providerChoice?.sameProviderAsWorker).toBeUndefined();
  // The other provider skipped for its 5-hour window: the worker's own, marked.
  const shared = await pick([claude, codex], { ...left, [codex.id]: [43, 5] }, { role: "reviewer", workerAdapter: "claude-code-local" });
  expect(shared).toMatchObject({ account: { id: claude.id }, providerChoice: { sameProviderAsWorker: true } });
});

test("an account whose quota cannot be read is usable after every known one, the configured provider's first", async () => {
  expect((await pick([claude, codex], { [codex.id]: [10, 90] })).account.id).toBe(codex.id);
  const unknown = await pick([claude, codex], {}, { configured: "claude-code-local" });
  expect(unknown).toMatchObject({ account: { id: claude.id }, accountReason: expect.stringContaining("quota unknown (usage endpoint answered 401)") });
  // Only one window read: ranked after a known reading, however much week it shows; a known zero stays spent.
  const partial: ReadQuota = async ({ id, adapter }) =>
    id === claude.id
      ? { adapter, account: id, readAt: "2026-10-04T12:00:00.000Z", weekly: { remainingPercent: 95 } }
      : { adapter, account: id, readAt: "2026-10-04T12:00:00.000Z", weekly: { remainingPercent: 10 }, fiveHour: { remainingPercent: 90 } };
  expect((await pick([claude, codex], {}, { read: partial })).account.id).toBe(codex.id);
  const spentPartial: ReadQuota = async ({ id, adapter }) => ({ adapter, account: id, readAt: "2026-10-04T12:00:00.000Z", ...(id === claude.id ? { weekly: { remainingPercent: 0 } } : {}) });
  expect((await pick([claude, codex], {}, { read: spentPartial, configured: "claude-code-local" })).account.id).toBe(codex.id);
});

// A run that failed on an account's quota or login moves the next launch to another of the owner's
// accounts; with all of them set aside or spent, nothing starts, and the owner is told why.
test("an owner with no account, or none usable, gets NoModelAccount", async () => {
  let now = 0;
  const asides = setAside(() => now);
  const left: Record<string, [number, number]> = { [claude.id]: [80, 90], [codex.id]: [0, 90] };
  expect((await pick([claude, codex], left, { isSetAside: asides.has })).account.id).toBe(claude.id);
  asides.add(claude.id);
  const refused = await pick([claude, codex], left, { isSetAside: asides.has }).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(NoModelAccount);
  expect(refused).toMatchObject({ kind: "none_usable", owner: ann, accountIds: [claude.id, codex.id] });
  expect((refused as Error).message).toBe(`none of Ann's model accounts is usable: ${claude.id} set aside after a quota or authentication failure; ${codex.id} spent (0% weekly, 90% 5-hour left)`);
  now += SET_ASIDE_MS;
  expect((await pick([claude, codex], left, { isSetAside: asides.has })).account.id).toBe(claude.id);

  await expect(pick([], {})).rejects.toMatchObject({ kind: "none_registered", accountIds: [] });
});
