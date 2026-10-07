import { NoModelAccount } from "@terros/sergeant-contracts";
import { expect, test } from "vitest";
import { failingReset, hasCodexLabel, pickAccount, setAside, SET_ASIDE_MS, type ModelAccount } from "./accounts.ts";
import type { Adapter } from "./agents.ts";
import type { ReadQuota } from "./quota.ts";

// TECH-5179: a task runs only on its owner's registered accounts, chosen by quota. These are the
// owner's accounts as the registry returns them for the owner; nobody else's is ever passed in.

const ann = { id: "ann", name: "Ann" };
const account = (adapter: Adapter, n = ""): ModelAccount => ({ id: `person:ann:${adapter}${n}`, adapter, holder: "Ann <ann@example.com>", credential: `credential-${adapter}${n}` });
const claude = account("claude-code-local");
const codex = account("codex-local");

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const readAt = "2026-10-04T12:00:00.000Z";
// Half of each window gone, so an account's pace is its lower percent left over 50.
const WEEKLY_RESET = "2026-10-08T00:00:00.000Z";
const FIVE_HOUR_RESET = "2026-10-04T14:30:00.000Z";

/** Weekly and 5-hour percent left per account id; an id not listed reads as unknown. */
const quota =
  (left: Record<string, [number, number]>): ReadQuota =>
  async ({ id, adapter }) => {
    const l = left[id];
    return l
      ? { adapter, account: id, readAt, weekly: { remainingPercent: l[0], resetsAt: WEEKLY_RESET }, fiveHour: { remainingPercent: l[1], resetsAt: FIVE_HOUR_RESET } }
      : { adapter, account: id, readAt, error: "usage endpoint answered 401" };
  };
const pick = (accounts: ModelAccount[], left: Record<string, [number, number]>, more: Partial<Parameters<typeof pickAccount>[0]> = {}) =>
  pickAccount({ owner: ann, accounts, read: quota(left), isSetAside: () => false, role: "worker", workerAdapter: undefined, codexLabel: false, now: () => NOW, ...more });

test("the best-paced account, never one with a known zero in either window", async () => {
  const chosen = await pick([claude, codex], { [claude.id]: [83, 90], [codex.id]: [53, 90] });
  expect(chosen).toMatchObject({ account: { id: claude.id }, accountReason: `${claude.id}, 83% weekly, 90% 5-hour left: pace 1.66, the highest of 2 usable` });
  // No 5-hour floor: a thin 5-hour window (pace 0.4) still beats a week further behind (0.3).
  expect((await pick([claude, codex], { [claude.id]: [83, 19.9], [codex.id]: [15, 90] })).account.id).toBe(claude.id);
  expect((await pick([claude, codex], { [claude.id]: [0, 100], [codex.id]: [10, 90] })).account.id).toBe(codex.id);
  expect((await pick([claude, codex], { [claude.id]: [90, 0], [codex.id]: [10, 5] })).account.id).toBe(codex.id);
});

test("a reviewer on its worker's provider says so", async () => {
  const left: Record<string, [number, number]> = { [claude.id]: [83, 90], [codex.id]: [70, 90] };
  const reviewer = await pick([claude, codex], left, { role: "reviewer", workerAdapter: "claude-code-local" });
  expect(reviewer.account.id).toBe(codex.id);
  expect(reviewer.providerChoice?.sameProviderAsWorker).toBeUndefined();
  // Far behind still reviews (TECH-5390); only with no usable Codex account does Claude review its own worker.
  expect((await pick([claude, codex], { ...left, [codex.id]: [5, 90] }, { role: "reviewer", workerAdapter: "claude-code-local" })).account.id).toBe(codex.id);
  const shared = await pick([claude, codex], { ...left, [codex.id]: [0, 90] }, { role: "reviewer", workerAdapter: "claude-code-local" });
  expect(shared).toMatchObject({ account: { id: claude.id }, providerChoice: { sameProviderAsWorker: true } });
});

test("an account whose quota cannot be read is usable after every known one", async () => {
  expect((await pick([claude, codex], { [codex.id]: [10, 90] })).account.id).toBe(codex.id);
  const unknown = await pick([claude, codex], {});
  expect(unknown).toMatchObject({ account: { id: claude.id }, accountReason: expect.stringContaining("quota unknown (usage endpoint answered 401)") });
  // Only one window read, the other not reported missing by its provider: ranked after a known reading, however much week it shows; a known zero stays spent.
  const partial: ReadQuota = async ({ id, adapter }) =>
    id === claude.id
      ? { adapter, account: id, readAt, weekly: { remainingPercent: 95, resetsAt: WEEKLY_RESET } }
      : { adapter, account: id, readAt, weekly: { remainingPercent: 10, resetsAt: WEEKLY_RESET }, fiveHour: { remainingPercent: 90, resetsAt: FIVE_HOUR_RESET } };
  expect((await pick([claude, codex], {}, { read: partial })).account.id).toBe(codex.id);
  const spentPartial: ReadQuota = async ({ id, adapter }) => ({ adapter, account: id, readAt, ...(id === claude.id ? { weekly: { remainingPercent: 0 } } : {}) });
  expect((await pick([claude, codex], {}, { read: spentPartial })).account.id).toBe(codex.id);
});

// TECH-5084: the `sergeant:codex` label runs a task's workers on Codex even when Claude is better
// paced, and never refuses a launch Claude could take: the fallback is the normal choice, said in the reason.
test("a labelled worker takes the best usable Codex account, and the normal choice when there is none", async () => {
  expect(hasCodexLabel(["Bug", "Sergeant:Codex"])).toBe(true);
  expect(hasCodexLabel(undefined)).toBe(false);
  const codex2 = account("codex-local", "2");
  const left: Record<string, [number, number]> = { [claude.id]: [83, 90], [codex.id]: [30, 90], [codex2.id]: [53, 90] };
  const labelled = await pick([claude, codex, codex2], left, { codexLabel: true });
  expect(labelled).toMatchObject({
    account: { id: codex2.id },
    accountReason: `sergeant:codex: ${codex2.id}, 53% weekly, 90% 5-hour left: pace 1.06, the highest of 2 usable`,
    providerChoice: { adapter: "codex-local", reason: expect.stringMatching(/^sergeant:codex: /) },
  });
  // Without the label, unchanged: the best-paced account, whatever its provider.
  expect(await pick([claude, codex, codex2], left)).toMatchObject({ account: { id: claude.id }, accountReason: expect.stringMatching(/^person:ann:claude-code-local, 83% weekly/) });

  // No usable Codex account (spent, set aside, or none registered): the normal choice, recorded as a fallback.
  const fallback = `sergeant:codex, but no usable Codex account, so the normal choice: ${claude.id}, 83% weekly`;
  for (const more of [
    { accounts: [claude, codex], left: { ...left, [codex.id]: [0, 90] as [number, number] } },
    { accounts: [claude, codex], left, isSetAside: (id: string) => id === codex.id },
    { accounts: [claude], left },
  ]) {
    const chosen = await pick(more.accounts, more.left, { codexLabel: true, ...(more.isSetAside && { isSetAside: more.isSetAside }) });
    expect(chosen).toMatchObject({ account: { id: claude.id }, accountReason: expect.stringContaining(fallback), providerChoice: { reason: expect.stringContaining(fallback) } });
  }
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

test("a set-aside ends at the reset of the window the account ran out of, when that comes before the hour", async () => {
  let now = NOW;
  const asides = setAside(() => now);
  const inMinutes = (m: number) => new Date(NOW + m * 60_000).toISOString();
  const reading = (weekly: number, fiveHour: number, fiveHourReset = inMinutes(20)) => ({ adapter: "claude-code-local", readAt, weekly: { remainingPercent: weekly, resetsAt: WEEKLY_RESET }, fiveHour: { remainingPercent: fiveHour, resetsAt: fiveHourReset } });
  // The 5-hour window is the one at 0%, though the week showed less left at launch.
  asides.add(claude.id, failingReset(reading(40, 0)));
  // The week ran out: the 5-hour window's sooner reset does not bring it back.
  asides.add(codex.id, failingReset(reading(0, 50)));
  now += 20 * 60_000 - 1;
  expect([asides.has(claude.id), asides.has(codex.id)]).toEqual([true, true]);
  now += 1;
  expect([asides.has(claude.id), asides.has(codex.id)]).toEqual([false, true]);
  now = NOW + SET_ASIDE_MS;
  expect(asides.has(codex.id)).toBe(false);

  // The failing window unknown (unreadable, or none at 0%): the hour, never another window's sooner reset.
  expect(failingReset({ adapter: "claude-code-local", readAt, error: "usage endpoint answered 401" })).toBeUndefined();
  expect(failingReset(reading(5, 30))).toBeUndefined();
  expect(failingReset(undefined)).toBeUndefined();
});
