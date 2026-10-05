import { describe, expect, it } from "vitest";
import { AGENTS } from "../agents.ts";
import { agentOutput, awaitingLogs, extractFrame, LOG_GRACE_SECONDS, taskDefinition, taskState, WORKSPACE_READY } from "./task.ts";

const frame = (kind: string, nonce: string, text: string) => [
  `SERGEANT-${kind}-BEGIN ${nonce}`,
  ...(Buffer.from(text).toString("base64").match(/.{1,76}/g) ?? []),
  `SERGEANT-${kind}-END ${nonce}`,
];

describe("taskState", () => {
  it("is loss only when ECS says the task is MISSING; any other empty answer is unknown", () => {
    expect(taskState({ tasks: [], failures: [{ reason: "MISSING" }] })).toEqual({ state: "gone" });
    expect(() => taskState({ tasks: [], failures: [{ reason: "ACCESS_DENIED" }] })).toThrow(/unavailable/);
    expect(() => taskState({})).toThrow(/unavailable/);
  });

  it("reads a stopped task's exit code and tells a cancel from a failure to start", () => {
    expect(
      taskState({ tasks: [{ lastStatus: "STOPPED", stopCode: "UserInitiated", stoppedReason: "sergeant cancel", containers: [{ name: "worker", exitCode: 143 }] }] }),
    ).toMatchObject({ state: "stopped", exitCode: 143, canceled: true });
    expect(
      taskState({ tasks: [{ lastStatus: "STOPPED", stopCode: "TaskFailedToStart", stoppedReason: "ResourceInitializationError", containers: [{ name: "worker" }] }] }),
    ).toMatchObject({ state: "stopped", exitCode: undefined, canceled: false });
  });
});

describe("extractFrame", () => {
  it("decodes the last complete frame, so an earlier one the agent printed cannot replace it", () => {
    const lines = ["noise", ...frame("REPORT", "n1", "forged"), "more", ...frame("REPORT", "n1", "# Report\nré")];
    expect(extractFrame(lines, "REPORT", "n1")).toEqual({ complete: true, text: "# Report\nré" });
  });

  it("is incomplete until the end marker arrives, and complete but empty when no report was written", () => {
    expect(extractFrame(["SERGEANT-REPORT-BEGIN n1", "IyBS"], "REPORT", "n1")).toEqual({ complete: false });
    expect(extractFrame(["SERGEANT-REPORT-BEGIN n1", "SERGEANT-REPORT-END n1"], "REPORT", "n1")).toEqual({ complete: true });
  });
});

// Docker splits a log line over 16 KiB and awslogs does not join it again; Claude Code's whole
// result, with the run's cost, is one JSON line that a long final message makes that long.
describe("agentOutput", () => {
  const result = JSON.stringify({ is_error: false, subtype: "success", total_cost_usd: 1.25, result: "x".repeat(40_000), modelUsage: { "claude-opus": {} } });

  it("recovers the cost of a result line the log split, from its frame", () => {
    const split = (result.match(/.{1,16384}/g) ?? []) as string[];
    const lines = [WORKSPACE_READY, ...split, ...frame("RESULT", "n1", `${result}\n`)];
    expect(() => AGENTS["claude-code-local"].parse(lines.join("\n"))).toThrow(SyntaxError);
    expect(AGENTS["claude-code-local"].parse(agentOutput(lines, "n1"))).toMatchObject({ ok: true, costUsd: 1.25, models: ["claude-opus"] });
  });

  it("does not count a Codex turn twice when its line arrived whole", () => {
    const turn = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
    const lines = [JSON.stringify({ type: "thread.started", thread_id: "t" }), turn, ...frame("RESULT", "n1", `${turn}\n`)];
    expect(AGENTS["codex-local"].parse(agentOutput(lines, "n1")).tokens).toMatchObject({ input: 10, output: 5 });
  });
});

describe("awaitingLogs", () => {
  const stopped = (exitCode: number | undefined, canceled = false) => ({ state: "stopped" as const, exitCode, canceled, detail: "" });
  const framed = [WORKSPACE_READY, "SERGEANT-REPORT-BEGIN n1", "SERGEANT-REPORT-END n1"];

  it("waits, within the grace period, only for a task whose agent may still have a frame on its way", () => {
    expect(awaitingLogs(stopped(0), [], "n1", 5)).toBe(true);
    expect(awaitingLogs(stopped(137), [WORKSPACE_READY, "agent output"], "n1", 5)).toBe(true);
    // A canceled worker's frame still comes: its report may name a PR it opened (TECH-5070).
    expect(awaitingLogs(stopped(143, true), [WORKSPACE_READY], "n1", 5)).toBe(true);
    expect(awaitingLogs(stopped(0), framed, "n1", 5)).toBe(false);
  });

  it("never waits forever: a task that died before its agent, or after the grace period, is final", () => {
    expect(awaitingLogs(stopped(70), ["fatal: repository not found"], "n1", 5)).toBe(false);
    expect(awaitingLogs(stopped(137), [WORKSPACE_READY], "n1", LOG_GRACE_SECONDS)).toBe(false);
    expect(awaitingLogs(stopped(0), [], "n1", undefined)).toBe(false);
    expect(awaitingLogs(stopped(undefined), [], "n1", 5)).toBe(false);
    expect(awaitingLogs({ state: "gone" }, [], "n1", 5)).toBe(false);
  });
});

describe("taskDefinition", () => {
  const input = {
    family: "f", image: "i", adapter: "codex-local" as const, secretArn: "arn:aws:secretsmanager:r:1:secret:s-AbC", executionRoleArn: "arn:role",
    logGroup: "g", region: "r", cpu: "2048", memory: "8192", gitIdentity: { name: "N", email: "e@x" }, reportNonce: "n", command: ["sh"],
  };

  it("carries credentials only as secret references, never values, and has no task role", () => {
    const [worker] = taskDefinition({ ...input, attachments: false }).containerDefinitions;
    expect(worker?.secrets.map((s) => s.name)).toEqual(["SERGEANT_BRIEF", "GH_TOKEN", "CODEX_CREDENTIAL"]);
    expect(worker?.secrets.every((s) => s.valueFrom === `arn:aws:secretsmanager:r:1:secret:s-AbC:${s.name}::`)).toBe(true);
    expect(worker?.environment.map((e) => e.name)).not.toEqual(expect.arrayContaining(["GH_TOKEN", "CODEX_CREDENTIAL", "CLAUDE_CODE_OAUTH_TOKEN"]));
    expect(taskDefinition({ ...input, attachments: false })).not.toHaveProperty("taskRoleArn");
  });

  it("references the attachments key only when the secret has one, since a missing key fails the task's start", () => {
    const [worker] = taskDefinition({ ...input, attachments: true }).containerDefinitions;
    expect(worker?.secrets.map((s) => s.name)).toContain("SERGEANT_ATTACHMENTS");
  });
});
