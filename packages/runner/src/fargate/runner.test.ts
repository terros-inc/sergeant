import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunSpec } from "@terros/sergeant-contracts";
import type { Exec } from "../exec.ts";
import { annClaude, GH, REPORT, spec, TOKEN } from "../runner-fixtures.ts";
import { fakeAws, frame, serviceError } from "./fake-aws.ts";
import { fargateRunner } from "./runner.ts";
import { WORKSPACE_READY } from "./task.ts";

const settings = {
  region: "us-west-2",
  cluster: "sergeant-v2-runs",
  subnets: ["subnet-1"],
  securityGroup: "sg-1",
  executionRoleArn: "arn:aws:iam::1:role/sergeant-v2-run-execution",
  logGroup: "/sergeant/v2/runs",
  taskFamily: "sergeant-v2-run",
  image: "1.dkr.ecr.us-west-2.amazonaws.com/sergeant-v2-runner:abc123",
  cpu: "2048",
  memory: "8192",
};

async function setUp(over: { spec?: RunSpec; now?: () => Date } = {}) {
  const aws = fakeAws();
  const calls: Parameters<Exec>[] = [];
  const exec: Exec = async (...args) => (calls.push(args), { code: 0, stdout: "abc\trefs/heads/sergeant/unf-1-old\n", stderr: "" });
  const rootDir = await mkdtemp(join(tmpdir(), "sergeant-fargate-test-"));
  const runner = fargateRunner({
    rootDir,
    settings,
    clients: aws.clients,
    exec,
    models: { worker: { "claude-code-local": "sonnet", "codex-local": "gpt-5" }, reviewer: { "claude-code-local": "opus", "codex-local": "gpt-5" } },
    accounts: async () => [annClaude],
    gitIdentity: { name: "Ada Example", email: "ada@example.com" },
    githubTokens: async () => GH,
    ...(over.now && { now: over.now }),
  });
  return { aws, calls, rootDir, runner, run: () => runner.start(over.spec ?? spec) };
}

const launchOf = async (rootDir: string) => JSON.parse(await readFile(join(rootDir, "run_t1", "launch.json"), "utf8")) as { nonce: string; taskArn?: string };
const result = JSON.stringify({ is_error: false, subtype: "success", session_id: "s1", total_cost_usd: 0.42, result: "x".repeat(20_000), modelUsage: { "claude-sonnet-5-5": {} } });

describe("fargateRunner", () => {
  it("starts one task whose credentials are only in the run's secret, never in an ECS call", async () => {
    const { aws, calls, rootDir, run } = await setUp();
    await run();

    const secret = JSON.parse(aws.secrets.get("sergeant/runs/run_t1") ?? "{}");
    expect(Object.keys(secret)).toEqual(["SERGEANT_BRIEF", "GH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(secret).toMatchObject({ GH_TOKEN: GH, CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    // The brief lists the branches the host read with ls-remote, the token only in git's environment.
    expect(secret.SERGEANT_BRIEF).toContain("o/canary: sergeant/unf-1-old");
    expect(calls[0]?.[2]?.env?.SERGEANT_RUN_GITHUB_TOKEN).toBe(GH);
    expect(calls.flatMap((c) => c[1]).join(" ")).not.toContain(GH);

    const ecs = aws.sent.filter((c) => !c.name.includes("Secret"));
    expect(ecs.map((c) => c.name)).toEqual(["RegisterTaskDefinitionCommand", "RunTaskCommand"]);
    expect(JSON.stringify(ecs)).not.toMatch(new RegExp(`${TOKEN}|${GH}`));
    const [def] = aws.defs.values();
    expect(def).toMatchObject({ family: "sergeant-v2-run", executionRoleArn: settings.executionRoleArn, containerDefinitions: [{ image: settings.image }] });
    expect(def).not.toHaveProperty("taskRoleArn");
    expect(aws.tasks).toHaveLength(1);
    expect(JSON.parse(await readFile(join(rootDir, "run_t1", "run.json"), "utf8"))).toMatchObject({ backend: "fargate", adapter: "claude-code-local" });
  });

  it("collects a finished run from its logs, its cost from the framed result line, then deletes its secret", async () => {
    const { aws, rootDir, run, runner } = await setUp();
    await run();
    expect((await runner.status("run_t1")).status).toBe("running");

    const { nonce, taskArn } = await launchOf(rootDir);
    // The log split Claude Code's result line at 16 KiB; only its frame has it whole.
    const lines = [WORKSPACE_READY, result.slice(0, 16_384), result.slice(16_384), ...frame("RESULT", nonce, `${result}\n`), ...frame("REPORT", nonce, REPORT)];
    aws.stopTask(taskArn as string, 0, lines);

    const record = await runner.status("run_t1");
    expect(record).toMatchObject({ status: "succeeded", costUsd: 0.42, model: "claude-sonnet-5-5", report: { outcome: "completed" } });
    expect(await runner.report?.("run_t1")).toBe(REPORT);
    expect(aws.secrets.size + aws.defs.size).toBe(0);
    // Terminal: read from the record, with no further AWS call.
    const before = aws.sent.length;
    expect(await runner.status("run_t1")).toEqual(record);
    expect(aws.sent.length).toBe(before);
  });

  it("keeps a stopped run running while its report may still be on its way, and fails it after the grace period", async () => {
    let now = new Date("2026-10-05T00:00:10Z");
    const { aws, rootDir, run, runner } = await setUp({ now: () => now });
    await run();
    const { taskArn } = await launchOf(rootDir);
    aws.stopTask(taskArn as string, 137, [WORKSPACE_READY], new Date("2026-10-05T00:00:00Z"));

    expect((await runner.status("run_t1")).status).toBe("running");
    expect(aws.secrets.size).toBe(1);
    now = new Date("2026-10-05T00:03:00Z");
    expect(await runner.status("run_t1")).toMatchObject({ status: "failed", report: null, reportError: expect.stringMatching(/no report written; exit 137/) });
    expect(aws.secrets.size).toBe(0);
  });

  it("cancels: stays retryable until ECS shows the task stopped, then keeps the report the worker wrote", async () => {
    const { aws, rootDir, run, runner } = await setUp();
    await run();
    const { nonce, taskArn } = await launchOf(rootDir);

    await expect(runner.cancel("run_t1")).rejects.toThrow(/not confirmed: the task is DEACTIVATING/);
    expect(aws.sent.filter((c) => c.name === "StopTaskCommand")).toHaveLength(1);
    expect(aws.secrets.size).toBe(1);

    aws.stopTask(taskArn as string, 143, [WORKSPACE_READY, ...frame("RESULT", nonce, ""), ...frame("REPORT", nonce, REPORT)]);
    await runner.cancel("run_t1");
    expect(await runner.status("run_t1")).toMatchObject({ status: "canceled", report: { outcome: "completed" } });
    expect(aws.secrets.size + aws.defs.size).toBe(0);
  });

  it("is unknown, never failed, while ECS cannot answer; failed only once ECS says the task is MISSING", async () => {
    const { aws, run, runner } = await setUp();
    await run();
    aws.faults.set("DescribeTasksCommand", serviceError("ServerException"));
    await expect(runner.status("run_t1")).rejects.toThrow();

    aws.tasks.length = 0;
    expect(await runner.status("run_t1")).toMatchObject({ status: "failed", reportError: expect.stringMatching(/the task is gone/) });
    expect(aws.secrets.size).toBe(0);
  });

  it("settles a start whose RunTask answer was lost from the run's status, without a second task", async () => {
    const { aws, run, runner } = await setUp();
    aws.faults.set("RunTaskCommand", "lost");
    await expect(run()).rejects.toThrow(/outcome is unknown/);
    expect(aws.secrets.size).toBe(1);

    expect((await runner.status("run_t1")).status).toBe("running");
    expect(aws.tasks).toHaveLength(1);
    expect(aws.sent.filter((c) => c.name === "RunTaskCommand")).toHaveLength(1);
  });

  it("strands no credentials when ECS rejects the start, and records the run as never started", async () => {
    const { aws, run, runner } = await setUp();
    aws.faults.set("RunTaskCommand", serviceError("ClientException"));
    await expect(run()).rejects.toThrow(/ClientException/);
    expect(aws.secrets.size + aws.defs.size + aws.tasks.length).toBe(0);
    expect(await runner.status("run_t1")).toMatchObject({ status: "failed", reportError: "its Fargate task never started" });
  });

  it("records a rejected start as never started once a retry finds its lost deregistration already done", async () => {
    const { aws, rootDir, run, runner } = await setUp();
    aws.faults.set("RunTaskCommand", serviceError("ClientException"));
    aws.faults.set("DeregisterTaskDefinitionCommand", "lost");
    await expect(run()).rejects.toThrow(/socket hang up/);
    expect(aws.secrets.size + aws.defs.size).toBe(0);
    expect(await launchOf(rootDir)).toHaveProperty("taskDefinitionArn");

    // Only ECS's already-inactive answer counts as done; any other rejection keeps the record for a retry.
    aws.faults.set("DeregisterTaskDefinitionCommand", serviceError("ClientException"));
    await expect(runner.status("run_t1")).rejects.toThrow(/ClientException/);
    expect(await runner.status("run_t1")).toMatchObject({ status: "failed", reportError: "its Fargate task never started" });
    await expect(launchOf(rootDir)).rejects.toThrow(/ENOENT/);
  });

  it("fails clearly, creating nothing, when the brief does not fit in a 64 KiB secret", async () => {
    const huge = { ...spec, objective: "x".repeat(70_000) } as RunSpec;
    const { aws, run } = await setUp({ spec: huge });
    await expect(run()).rejects.toThrow(/over Secrets Manager's 65536-byte limit/);
    expect(aws.sent).toEqual([]);
  });

  it("runs workers only", async () => {
    const { run } = await setUp({ spec: { ...spec, role: "reviewer", subject: [], pullRequests: [] } as unknown as RunSpec });
    await expect(run()).rejects.toThrow(/workers only/);
  });
});
