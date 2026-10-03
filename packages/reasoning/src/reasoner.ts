import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SituationReport, TurnOutput } from "@terros/sergeant-contracts";
import { z } from "zod";
import { fileBlocks, type ReasoningFiles } from "./files.ts";
import { PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt.ts";

export type TurnResult = { output: TurnOutput; costUsd?: number; model: string; promptVersion: string };

/** One reasoning turn: a Situation Report in, validated proposed actions out. Never an effect. */
export interface Reasoner {
  turn(situation: SituationReport): Promise<TurnResult>;
}

/** Runs the CLI with `args`, writes `stdin`, and resolves with stdout. Injected in tests. */
export type RunCli = (args: string[], stdin: string, opts: { cwd: string; timeoutMs: number }) => Promise<string>;

const CliResult = z.object({
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
});

/**
 * Reasoning through the local `claude` CLI. Every turn is a fresh, unpersisted session in an empty
 * directory with no tools, MCP servers, or customizations, so the model can only answer. With
 * `files`, the issue's files go after the Situation Report as image and text blocks through the CLI's
 * stream-json input (TECH-4994); a failure to fetch them never fails the turn.
 */
export function claudeCliReasoner(
  opts: {
    model?: string;
    maxTurnCostUsd?: number;
    timeoutMs?: number;
    runCli?: RunCli;
    files?: (situation: SituationReport) => Promise<ReasoningFiles>;
  } = {},
): Reasoner {
  const model = opts.model ?? "opus";
  const runCli = opts.runCli ?? spawnClaude;
  const schema = JSON.stringify(z.toJSONSchema(TurnOutput, { target: "draft-7", io: "input" }));
  return {
    async turn(situation) {
      const args = [
        "-p", "--output-format", "json", "--json-schema", schema,
        "--model", model, "--max-budget-usd", String(opts.maxTurnCostUsd ?? 1.5),
        "--system-prompt", SYSTEM_PROMPT,
        "--tools", "", "--strict-mcp-config", "--safe-mode", "--no-session-persistence",
      ];
      const report = `Situation Report:\n\n${JSON.stringify(SituationReport.parse(situation), null, 2)}`;
      const files = opts.files
        ? await opts.files(situation).catch((e: Error) => ({ files: [], skipped: [{ url: "(all)", title: "", reason: `fetch failed: ${e.message}` }] }))
        : { files: [], skipped: [] };
      const blocks = fileBlocks(files);
      // Plain text unless there are files: stream-json is the CLI's only way to take an image.
      const input = blocks.length
        ? `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: report }, ...blocks] } })}\n`
        : report;
      if (blocks.length) args.splice(1, 2, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose");
      const cwd = await mkdtemp(join(tmpdir(), "sergeant-reasoning-"));
      try {
        const stdout = await runCli(args, input, { cwd, timeoutMs: opts.timeoutMs ?? 300_000 });
        const cli = CliResult.parse(blocks.length ? streamResult(stdout) : JSON.parse(stdout));
        if (cli.is_error) throw new Error(`reasoning turn failed: ${cli.result ?? "unknown error"}`);
        const output = TurnOutput.parse(cli.structured_output ?? JSON.parse(cli.result ?? ""));
        return { output, model, promptVersion: PROMPT_VERSION, ...(cli.total_cost_usd !== undefined && { costUsd: cli.total_cost_usd }) };
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

/** The final `result` event of a stream-json run. */
function streamResult(stdout: string): unknown {
  const events = stdout.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { type?: string });
  const result = events.findLast((e) => e.type === "result");
  if (!result) throw new Error("reasoning turn ended without a result");
  return result;
}

const spawnClaude: RunCli = (args, stdin, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (err += d));
    child.on("error", reject);
    child.on("close", (code, signal) =>
      code === 0 ? resolve(out) : reject(new Error(`claude exited ${code ?? signal}: ${err.slice(-2000) || out.slice(-2000)}`)),
    );
    child.stdin.end(stdin);
  });
