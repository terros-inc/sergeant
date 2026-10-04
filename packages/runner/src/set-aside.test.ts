import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { NoModelAccount, type QuotaReading, type RunSpec } from "@terros/sergeant-contracts";
import type { Exec } from "./exec.ts";
import { containerRunner } from "./runner.ts";

// TECH-5213, through the runner's own set-aside: a run that fails on quota or authentication benches
// its account for an hour, or until the window it ran out of resets if that is sooner. The window is
// told from the account's quota read again as the run fails. Docker is faked; so is the clock.

const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString();
const ann = { id: "ann", name: "Ann" };
const account = { id: "person:ann:claude-code-local", adapter: "claude-code-local", holder: "Ann <ann@example.com>", credential: "sk-ant-oat01-ann" } as const;
const issue = { id: "i1", identifier: "UNF-1", url: "https://linear.app/x/issue/UNF-1", title: "T", description: "D", state: "Todo", stateType: "unstarted", delegate: null, linkedPullRequests: [] };
const worker: RunSpec = { runId: "run_1", owner: ann, role: "worker", objective: "Do it.", context: { pullRequests: [], runs: [] }, repositories: ["o/r"], conversation: { issue, humanComments: [], agentComments: [] } };
const QUOTA_LOGS = '{"is_error":true,"result":"Claude AI usage limit reached"}';
const AUTH_LOGS = '{"is_error":true,"result":"OAuth token has expired. Please run /login"}';

type Windows = Pick<QuotaReading, "weekly" | "fiveHour" | "error">;
const healthy: Windows = { weekly: { remainingPercent: 60, resetsAt: at(3 * 24 * 60) }, fiveHour: { remainingPercent: 60, resetsAt: at(4 * 60) } };

afterEach(() => vi.useRealTimers());

/**
 * Launches a worker on Ann's only account with `atLaunch` read, fails it after 5 minutes with `logs`
 * while its quota reads `atFailure`, and answers how many minutes after launch the account is usable again.
 */
async function benchedUntil(logs: string, atLaunch: Windows, atFailure: Windows) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  let windows = atLaunch;
  const exec: Exec = async (cmd, args) => {
    if (cmd === "docker" && args[0] === "inspect") return { code: 0, stdout: "exited 1\n", stderr: "" };
    if (cmd === "docker" && args[0] === "logs") return { code: 0, stdout: logs, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const runner = containerRunner({
    rootDir: await mkdtemp(join(tmpdir(), "sergeant-set-aside-test-")),
    models: { worker: { "claude-code-local": "opus", "codex-local": "gpt-5" }, reviewer: { "claude-code-local": "opus", "codex-local": "gpt-5" } },
    accounts: async (ownerId) => (ownerId === ann.id ? [account] : []),
    // Uncached, so each read is what the test says the account shows at that moment.
    quota: async ({ id, adapter }) => ({ adapter, account: id, readAt: new Date().toISOString(), ...windows }),
    gitIdentity: { name: "Ada Example", email: "ada@example.com" },
    githubTokens: async () => "ghs_test",
    exec,
  });

  await runner.start(worker);
  vi.setSystemTime(NOW + 5 * MINUTE);
  windows = atFailure;
  expect(await runner.status(worker.runId)).toMatchObject({ status: "failed", account: { id: account.id } });
  // Afterwards the account reads healthy, so only the set-aside can refuse it.
  windows = healthy;
  for (let minute = 6; minute <= 120; minute++) {
    vi.setSystemTime(NOW + minute * MINUTE);
    const refused = await runner.start({ ...worker, runId: `run_at_${minute}` }).then(() => undefined, (e: unknown) => e);
    if (!refused) return minute;
    expect(refused).toBeInstanceOf(NoModelAccount);
  }
  return undefined;
}

test("a quota failure's set-aside ends when the window now at 0% resets, before the hour", async () => {
  // At launch the week shows less left than the 5-hour window, but it is the 5-hour window that ran out.
  const atLaunch: Windows = { weekly: { remainingPercent: 8, resetsAt: at(3 * 24 * 60) }, fiveHour: { remainingPercent: 30, resetsAt: at(20) } };
  const atFailure: Windows = { weekly: { remainingPercent: 7, resetsAt: at(3 * 24 * 60) }, fiveHour: { remainingPercent: 0, resetsAt: at(20) } };
  expect(await benchedUntil(QUOTA_LOGS, atLaunch, atFailure)).toBe(20);
});

test("an authentication failure's set-aside ends at the account's next known reset, before the hour", async () => {
  // A failed login cannot read quota either: the reset ahead comes from the launch reading.
  const atLaunch: Windows = { weekly: { remainingPercent: 50, resetsAt: at(3 * 24 * 60) }, fiveHour: { remainingPercent: 40, resetsAt: at(30) } };
  expect(await benchedUntil(AUTH_LOGS, atLaunch, { error: "usage endpoint answered 401" })).toBe(30);
  // One that reads, with a window at 0%, waits for that window instead.
  const atFailure: Windows = { weekly: { remainingPercent: 0, resetsAt: at(45) }, fiveHour: { remainingPercent: 40, resetsAt: at(30) } };
  expect(await benchedUntil(AUTH_LOGS, atLaunch, atFailure)).toBe(45);
});

test("a set-aside keeps the hour when the window resets later, or its reset is unknown", async () => {
  // The run fails 5 minutes after launch, so its hour ends 65 minutes after launch.
  const atLaunch: Windows = { weekly: { remainingPercent: 5, resetsAt: at(2 * 24 * 60) }, fiveHour: { remainingPercent: 50, resetsAt: at(30) } };
  // The week ran out: the 5-hour window resetting in half an hour does not bring the account back.
  const weekOut: Windows = { weekly: { remainingPercent: 0, resetsAt: at(2 * 24 * 60) }, fiveHour: { remainingPercent: 50, resetsAt: at(30) } };
  expect(await benchedUntil(QUOTA_LOGS, atLaunch, weekOut)).toBe(65);
  const unknownReset: Windows = { weekly: { remainingPercent: 0 }, fiveHour: { remainingPercent: 50, resetsAt: at(30) } };
  expect(await benchedUntil(QUOTA_LOGS, atLaunch, unknownReset)).toBe(65);
  const nothingKnown: Windows = { weekly: { remainingPercent: 50 }, fiveHour: { remainingPercent: 50 } };
  expect(await benchedUntil(AUTH_LOGS, nothingKnown, { error: "usage endpoint answered 401" })).toBe(65);
});
