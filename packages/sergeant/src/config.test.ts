import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { InstallationConfig, taskBudget } from "./config.ts";
import { runLoop } from "./loop.ts";

const config = (controlPlaneAppId: number | string, workerAppId: number | string) => ({
  secrets: { awsRegion: "us-west-2" },
  linear: { tokenSecret: "sergeant/linear", agentUserId: "agent" },
  github: {
    controlPlaneApp: { appId: controlPlaneAppId, installationId: 1, privateKeySecret: "sergeant/control-plane" },
    workerApp: { appId: workerAppId, installationId: 2, privateKeySecret: "sergeant/worker" },
  },
  repositories: { "acme/app": { mergeMethod: "squash" } },
  modelTokenSecret: "sergeant/model",
  gitIdentity: { name: "Ada", email: "ada@example.com" },
});

// One App in both roles would let a worker merge as the control plane.
test("the control-plane and worker GitHub Apps must differ, however the App ID is written", () => {
  expect(InstallationConfig.safeParse(config(42, 42)).success).toBe(false);
  expect(InstallationConfig.safeParse(config(42, "42")).success).toBe(false);
  expect(InstallationConfig.parse(config(42, "43")).github.workerApp.appId).toBe(43);
});

// TECH-4964: the config's budget is a task's stored window when it starts, the defaults without it,
// and a config change never moves a task that already started.
test("a task starts with the installation config's budget window, or the default without one, and keeps it", async () => {
  const root = await mkdtemp(join(tmpdir(), "sergeant-config-test-"));
  try {
    // The loop saves the task's window before anything else, then finds STOP and ends: no port is used.
    const start = async (task: string, raw: object) => {
      const dir = join(root, task);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "STOP"), "");
      const budget = taskBudget(InstallationConfig.parse(raw));
      await runLoop({ issueId: task, enrolledRepositories: [], dir, budget, log: () => {} }, {} as Parameters<typeof runLoop>[1]);
      return (JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as { budget: { window: unknown } }).budget.window;
    };
    const lowered = { ...config(1, 2), budget: { minutes: 45, usd: 10 } };
    expect(await start("UNF-1", lowered)).toEqual({ wallMinutes: 45, costUsd: 10 });
    expect(await start("UNF-2", config(1, 2))).toEqual({ wallMinutes: 120, costUsd: 25 });
    expect(await start("UNF-1", { ...config(1, 2), budget: { minutes: 600, usd: 100 } })).toEqual({ wallMinutes: 45, costUsd: 10 });
    expect(InstallationConfig.safeParse({ ...config(1, 2), budget: { minutes: 0 } }).success).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
