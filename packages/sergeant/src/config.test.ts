import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { InstallationConfig, reviewerProfileLookup, runnerRoles, taskBudget } from "./config.ts";
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

// TECH-5113: the owner's further accounts name whose subscription paid, so names must not pass for the
// installation's own; a Codex account needs the codex config's model; a literal credential is refused.
test("the owner's further model accounts are named secret references", () => {
  const account = (name: string, adapter = "claude-code-local", credentialSecret = "sergeant/claude-2") => ({ ...config(1, 2), modelAccounts: [{ name, adapter, credentialSecret }] });
  expect(InstallationConfig.parse(account("terros-claude-2")).modelAccounts).toHaveLength(1);
  expect(InstallationConfig.parse(config(1, 2)).modelAccounts).toEqual([]);
  expect(InstallationConfig.safeParse(account("installation-claude")).success).toBe(false);
  expect(InstallationConfig.safeParse(account("terros-codex-2", "codex-local")).success).toBe(false);
  expect(InstallationConfig.safeParse(account("terros-claude-2", "claude-code-local", "sk-ant-oat01-literal")).success).toBe(false);
});

test("reviewer profiles are validated and GitHub logins are matched case-insensitively", () => {
  const profile = "https://linear.app/acme/profiles/ada";
  const parsed = InstallationConfig.parse({
    ...config(1, 2),
    linear: { ...config(1, 2).linear, reviewerProfiles: { "Ada-Lovelace": profile } },
  });
  const lookup = reviewerProfileLookup(parsed);

  expect(lookup("ada-lovelace")).toBe(profile);
  expect(lookup("grace")).toBeUndefined();
  expect(InstallationConfig.safeParse({ ...config(1, 2), linear: { ...config(1, 2).linear, reviewerProfiles: { ada: "https://example.com/ada" } } }).success).toBe(false);
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

// TECH-5009: an installation that names no runner keeps today's Claude Code workers and reviewers, and
// a Codex role can't start without the installation's own Codex credential behind it.
test("each role runs Claude Code unless the config selects Codex for it, with the installation's credential", () => {
  const none = { worker: undefined, reviewer: undefined };
  expect(runnerRoles(InstallationConfig.parse(config(1, 2)), none)).toEqual({
    adapters: { worker: "claude-code-local", reviewer: "claude-code-local" },
    models: { worker: { "claude-code-local": "opus", "codex-local": "opus" }, reviewer: { "claude-code-local": "opus", "codex-local": "opus" } },
  });

  const codexReviewer = { ...config(1, 2), runners: { reviewer: "codex-local" } };
  expect(InstallationConfig.safeParse(codexReviewer).success).toBe(false);
  expect(InstallationConfig.safeParse({ ...codexReviewer, codex: { credentialSecret: "sk-proj-abc", model: "m" } }).success).toBe(false);
  const parsed = InstallationConfig.parse({ ...codexReviewer, codex: { credentialSecret: "sergeant/codex", model: "gpt-5.5-codex" } });
  expect(runnerRoles(parsed, none)).toEqual({
    adapters: { worker: "claude-code-local", reviewer: "codex-local" },
    models: {
      worker: { "claude-code-local": "opus", "codex-local": "gpt-5.5-codex" },
      reviewer: { "claude-code-local": "opus", "codex-local": "gpt-5.5-codex" },
    },
  });
  // A model flag is for the role's configured adapter; quota may still move the role to the other one (TECH-5117).
  expect(runnerRoles(parsed, { worker: "sonnet", reviewer: "gpt-6" }).models).toEqual({
    worker: { "claude-code-local": "sonnet", "codex-local": "gpt-5.5-codex" },
    reviewer: { "claude-code-local": "opus", "codex-local": "gpt-6" },
  });
});
