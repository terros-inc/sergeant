import { afterEach, expect, test } from "vitest";
import type { BudgetStatus, RunRecord } from "@terros/sergeant-contracts";
import { windowFor } from "./budget.ts";
import { cleanup, repo, saved, scenario, start, stopAfter, turnOf, worker } from "./budget-scenario.ts";

// TECH-5219: a repository's `budget` in the installation config replaces the installation's window for a
// task with a run in that repository, field by field. Getting it wrong either cancels slow repositories'
// work (iOS builds and CI) at the installation's window, or lets a task run past the window it was given.

afterEach(cleanup);

const ios = "o/ios";
const overrides: Record<string, { wallMinutes?: number; costUsd?: number }> = { [repo]: { wallMinutes: 240 }, [ios]: { wallMinutes: 90, costUsd: 60 } };
const override = (r: string) => overrides[r];
const installation = { wallMinutes: 120, costUsd: 25 };

test("a repository's budget replaces each field it sets, and the largest of each field holds across repositories", () => {
  expect(windowFor(installation, [], override)).toEqual(installation);
  expect(windowFor(installation, ["o/plain"], override)).toEqual(installation);
  expect(windowFor(installation, [repo], override)).toEqual({ wallMinutes: 240, costUsd: 25 });
  expect(windowFor(installation, [ios], override)).toEqual({ wallMinutes: 90, costUsd: 60 });
  expect(windowFor(installation, [repo, ios], override)).toEqual({ wallMinutes: 240, costUsd: 60 });
});

// A task three hours into its window, its worker running until the second poll: past the installation's
// 120 minutes, within the repository's 240.
async function threeHoursIn(repositoryBudget?: (r: string) => { wallMinutes?: number; costUsd?: number } | undefined) {
  const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
  let w: RunRecord = worker("running");
  let cancels = 0;
  let polls = 0;
  const windows: BudgetStatus[] = [];
  const outcome = await scenario({
    state: { startedAt: threeHoursAgo, runIds: ["run_w"], repositories: [repo] },
    runner: { start: async () => {}, status: async () => w, cancel: async () => void (cancels++, (w = worker("canceled"))) },
    reasoner: async (situation) => (windows.push(situation.budget), turnOf([])),
    onPoll: async (poll, live) => {
      if (++polls === 2 && w.status === "running") w = worker("succeeded", 1);
      return stopAfter(4)(poll, live);
    },
    loop: { ...(repositoryBudget && { repositoryBudget }) },
  });
  return { ...outcome, cancels, windows };
}

test("the wall-time deadline is the repository's: its worker is kept, and the task goes on, past the installation's window", async () => {
  const { cancels, posted, windows } = await threeHoursIn(override);
  expect(cancels).toBe(0);
  expect(posted).toEqual([]);
  expect(windows[0]?.window).toEqual({ wallMinutes: 240, costUsd: 25 });
  expect(Date.parse(windows[0]?.wallDeadline ?? "") - Date.parse(windows[0]?.windowStart ?? "")).toBe(240 * 60_000);
});

test("without the repository's budget the same task is stopped at the installation's window", async () => {
  const { cancels, posted, windows } = await threeHoursIn();
  expect(cancels).toBe(1);
  expect(posted[0]).toMatch(/budget is exhausted \(wall time exhausted at /);
  expect(windows).toEqual([]);
});

test("a task's first worker in a repository records it, and from then on the task works in that repository's window", async () => {
  const windows: BudgetStatus["window"][] = [];
  let started = false;
  await scenario({
    runner: { start: async () => void (started = true), status: async () => worker("succeeded", 1), cancel: async () => {} },
    reasoner: async (situation) => (windows.push(situation.budget.window), turnOf(started ? [] : [start])),
    onPoll: stopAfter(4),
    loop: { repositoryBudget: override },
  });
  expect((await saved()).repositories).toEqual([repo]);
  expect(windows[0]).toEqual(installation);
  expect(windows.at(-1)).toEqual({ wallMinutes: 240, costUsd: 25 });
});
