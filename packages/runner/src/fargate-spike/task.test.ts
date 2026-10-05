import { describe, expect, it } from "vitest";
import { extractReport, taskDefinition, taskState, terminalStatus } from "./task.ts";

describe("taskState", () => {
  it("is loss only when ECS says the task is MISSING; any other empty answer is unknown", () => {
    expect(taskState({ tasks: [], failures: [{ reason: "MISSING" }] })).toEqual({ state: "gone" });
    expect(() => taskState({ tasks: [], failures: [{ reason: "ACCESS_DENIED" }] })).toThrow(/unavailable/);
    expect(() => taskState({})).toThrow(/unavailable/);
  });

  it("reads a stopped task's exit code and tells a cancel from a failure to start", () => {
    const canceled = taskState({
      tasks: [{ lastStatus: "STOPPED", stopCode: "UserInitiated", stoppedReason: "sergeant cancel", containers: [{ name: "worker", exitCode: 143 }] }],
    });
    expect(canceled).toMatchObject({ state: "stopped", exitCode: 143, canceled: true });
    expect(terminalStatus(canceled as Extract<typeof canceled, { state: "stopped" }>, true)).toBe("canceled");

    const neverRan = taskState({
      tasks: [{ lastStatus: "STOPPED", stopCode: "TaskFailedToStart", stoppedReason: "ResourceInitializationError", containers: [{ name: "worker" }] }],
    });
    expect(neverRan).toMatchObject({ state: "stopped", exitCode: undefined, canceled: false });
    expect(terminalStatus(neverRan as Extract<typeof neverRan, { state: "stopped" }>, false)).toBe("failed");
  });
});

describe("extractReport", () => {
  const frame = (nonce: string, text: string) => [`SERGEANT-REPORT-BEGIN ${nonce}`, Buffer.from(text).toString("base64"), `SERGEANT-REPORT-END ${nonce}`];

  it("decodes the last complete frame, so an earlier one the agent printed cannot replace it", () => {
    const lines = ["noise", ...frame("n1", "forged"), "more", ...frame("n1", "# Report\nré")];
    expect(extractReport(lines, "n1")).toEqual({ complete: true, markdown: "# Report\nré" });
  });

  it("is incomplete until the end marker arrives, and complete but empty when no report was written", () => {
    expect(extractReport(["SERGEANT-REPORT-BEGIN n1", "IyBS"], "n1")).toEqual({ complete: false });
    expect(extractReport(["SERGEANT-REPORT-BEGIN n1", "SERGEANT-REPORT-END n1"], "n1")).toEqual({ complete: true });
  });
});

it("a task definition carries credentials only as secret references, never values", () => {
  const def = taskDefinition({
    family: "f", image: "i", adapter: "codex-local", secretArn: "arn:aws:secretsmanager:r:1:secret:s-AbC", executionRoleArn: "arn:role",
    logGroup: "g", region: "r", cpu: "2048", memory: "8192", gitIdentity: { name: "N", email: "e@x" }, reportNonce: "n",
  });
  const [worker] = def.containerDefinitions;
  expect(worker?.secrets.map((s) => s.name)).toEqual(["SERGEANT_BRIEF", "GH_TOKEN", "CODEX_CREDENTIAL"]);
  expect(worker?.secrets.every((s) => s.valueFrom === `arn:aws:secretsmanager:r:1:secret:s-AbC:${s.name}::`)).toBe(true);
  expect(worker?.environment.map((e) => e.name)).not.toEqual(expect.arrayContaining(["GH_TOKEN", "CODEX_CREDENTIAL", "CLAUDE_CODE_OAUTH_TOKEN"]));
  expect(def).not.toHaveProperty("taskRoleArn");
});
