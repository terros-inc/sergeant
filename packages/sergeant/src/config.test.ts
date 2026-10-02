import { expect, test } from "vitest";
import { InstallationConfig } from "./config.ts";

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
