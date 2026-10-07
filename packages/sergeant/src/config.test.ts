import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { CODEX_PRICES } from "@terros/sergeant-runner";
import { CODEX_DEFAULT_MODEL, fargateSettings, InstallationConfig, loadConfig, repoBudget, reviewerProfileLookup, runnerRoles, taskBudget } from "./config.ts";
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
    // The loop admits the task's owner and saves its window before anything else, then finds STOP and
    // ends: no other port is used.
    const start = async (task: string, raw: object) => {
      const dir = join(root, task);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "STOP"), "");
      const budget = taskBudget(InstallationConfig.parse(raw));
      await runLoop({ issueId: task, enrolledRepositories: [], dir, budget, log: () => {} }, { agentUserId: "agent-v2", linear: { readTaskOwner: async () => ({ owner: { id: "user-ann", name: "Ann" } }) } } as unknown as Parameters<typeof runLoop>[1]);
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

// TECH-5219: a repository's own budget window, each field optional; a mistyped or nonpositive one fails
// the config rather than silently leaving the repository on the installation's window.
test("a repository's budget parses field by field, and an invalid one fails the config", () => {
  const withBudget = (budget: unknown) => ({ ...config(1, 2), repositories: { "acme/app": { mergeMethod: "squash", budget } } });
  const parsed = (budget: unknown) => repoBudget(InstallationConfig.parse(withBudget(budget)).repositories["acme/app"]);
  expect(parsed({ wallMinutes: 90, costUsd: 60 })).toEqual({ wallMinutes: 90, costUsd: 60 });
  expect(parsed({ wallMinutes: 90 })).toEqual({ wallMinutes: 90 });
  expect(parsed({})).toEqual({});
  expect(repoBudget(InstallationConfig.parse(config(1, 2)).repositories["acme/app"])).toBeUndefined();
  for (const invalid of [{ wallMinutes: 0 }, { costUsd: -1 }, { wallMinutes: "90" }, { minutes: 90 }, 90]) {
    expect(InstallationConfig.safeParse(withBudget(invalid)).success, JSON.stringify(invalid)).toBe(false);
  }
});

// TECH-5390: which provider a run uses comes from its owner's registered accounts, so a config needs no
// runner or codex setting for Codex. An existing codex.model still names Codex's model; an existing
// runners.worker/reviewer still parses but is ignored, with a warning.
test("Codex runs a built-in default model, codex.model overrides it, and runners.worker/reviewer are ignored with a warning", async () => {
  const none = { worker: undefined, reviewer: undefined };
  const both = (claude: string, codex: string) => ({ "claude-code-local": claude, "codex-local": codex });
  // A default run records an estimated cost (TECH-5021).
  expect(CODEX_PRICES[CODEX_DEFAULT_MODEL]).toBeDefined();
  expect(runnerRoles(InstallationConfig.parse(config(1, 2)), none)).toEqual({
    models: { worker: both("opus", CODEX_DEFAULT_MODEL), reviewer: both("opus", CODEX_DEFAULT_MODEL) },
  });

  const legacy = { ...config(1, 2), runners: { worker: "claude-code-local", reviewer: "codex-local" }, codex: { model: "gpt-5.5-codex" } };
  // TECH-5184: runs use only their owner's registered accounts, so a config still naming the installation's
  // Codex credential is refused, and install.sh keeps serve on its previous config until it is removed.
  expect(InstallationConfig.safeParse({ ...legacy, codex: { credentialSecret: "sergeant/codex", model: "m" } }).success).toBe(false);
  const parsed = InstallationConfig.parse(legacy);
  expect(runnerRoles(parsed, none).models).toEqual({ worker: both("opus", "gpt-5.5-codex"), reviewer: both("opus", "gpt-5.5-codex") });
  // A model flag is the role's Claude Code model, whatever runners.<role> says.
  expect(runnerRoles(parsed, { worker: "sonnet", reviewer: "haiku" }).models).toEqual({
    worker: both("sonnet", "gpt-5.5-codex"),
    reviewer: both("haiku", "gpt-5.5-codex"),
  });

  const dir = await mkdtemp(join(tmpdir(), "sergeant-legacy-config-"));
  const file = join(dir, "installation.json");
  await writeFile(file, JSON.stringify(legacy));
  const warnings: string[] = [];
  expect((await loadConfig(file, (line) => warnings.push(line))).codex?.model).toBe("gpt-5.5-codex");
  expect(warnings).toEqual([
    expect.stringMatching(/runners\.worker is deprecated and ignored/),
    expect.stringMatching(/runners\.reviewer is deprecated and ignored/),
  ]);
  await writeFile(file, JSON.stringify({ ...config(1, 2), runners: { workerBackend: "fargate" } }));
  await loadConfig(file, (line) => warnings.push(line));
  expect(warnings).toHaveLength(2);
  await rm(dir, { recursive: true });

  // TECH-5021: the config's Codex prices reach the runner, with or without a model.
  const prices = { "gpt-5.5-codex": { input: 1.25, cachedInput: 0.125, output: 10 } };
  expect(runnerRoles(InstallationConfig.parse({ ...legacy, codex: { model: "gpt-5.5-codex", prices } }), none).codexPrices).toEqual(prices);
  expect(runnerRoles(InstallationConfig.parse({ ...config(1, 2), codex: { prices } }), none)).toMatchObject({ codexPrices: prices, models: { worker: both("opus", CODEX_DEFAULT_MODEL) } });
});

// TECH-5237: workers stay on the host unless the config says fargate, and a host without Terraform's
// Fargate resources must refuse to start rather than fail every worker it launches.
test("Fargate settings are required only when workers run on Fargate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sergeant-fargate-settings-"));
  const missing = join(dir, "missing.json");
  const local = InstallationConfig.parse(config(1, 2));
  const onFargate = InstallationConfig.parse({ ...config(1, 2), runners: { workerBackend: "fargate" } });
  expect(local.runners?.workerBackend).toBeUndefined();
  expect(await fargateSettings(local, missing)).toBeUndefined();
  await expect(fargateSettings(onFargate, missing)).rejects.toThrow(/workerBackend is fargate/);

  const file = join(dir, "fargate-runner.json");
  const settings = {
    region: "us-west-2", cluster: "c", subnets: ["subnet-1"], securityGroup: "sg-1", executionRoleArn: "arn:role",
    logGroup: "/g", taskFamily: "f", image: "repo:abc",
  };
  await writeFile(file, JSON.stringify(settings));
  expect(await fargateSettings(onFargate, file)).toMatchObject({ ...settings, cpu: "2048", memory: "8192" });
  await rm(dir, { recursive: true });
});
