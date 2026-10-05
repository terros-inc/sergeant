// TECH-5231 spike, never run by CI and not used by `serve`: one worker run as an ECS Fargate task,
// driven by hand from the control-plane side with the AWS CLI. Setup and findings are in
// docs/spikes/tech-5231-fargate.md. From packages/runner:
//
//   node src/fargate-spike/cli.ts start  --run-id <id> --brief <file> --repo <owner/name> --model <m> [--adapter codex-local]
//   node src/fargate-spike/cli.ts status --run-id <id>
//   node src/fargate-spike/cli.ts cancel --run-id <id>
//   node src/fargate-spike/cli.ts result --run-id <id>    # once stopped: record.json, report.md, cleanup
//
// `start` reads GH_TOKEN and the adapter's model credential (CLAUDE_CODE_OAUTH_TOKEN or
// CODEX_CREDENTIAL) from its own environment and the SPIKE_* settings below; no value is ever an argument.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseReport, RunRecord, WorkerReport } from "@terros/sergeant-contracts";
import { ADAPTERS, AGENTS, type Adapter } from "../agents.ts";
import { execOk } from "../exec.ts";
import { extractReport, secondsBetween, taskDefinition, taskState, TASK_SCRIPT, terminalStatus, type DescribeTasks } from "./task.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "run-id": { type: "string" },
    brief: { type: "string" },
    repo: { type: "string", multiple: true, default: [] },
    adapter: { type: "string", default: "claude-code-local" },
    model: { type: "string" },
    cpu: { type: "string", default: "2048" },
    memory: { type: "string", default: "8192" },
    wall: { type: "string", default: "3600" },
    budget: { type: "string", default: "10" },
    "state-dir": { type: "string", default: "fargate-spike-runs" },
  },
});

const need = (name: string, v = process.env[name]) => {
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const runId = need("--run-id", values["run-id"]);
const region = need("AWS_REGION");
const cluster = need("SPIKE_CLUSTER");
const logGroup = process.env.SPIKE_LOG_GROUP ?? "/sergeant/fargate-spike";
const dir = join(values["state-dir"], runId);
const launchFile = join(dir, "launch.json");

const aws = async (args: string[]) => JSON.parse((await execOk("aws", [...args, "--region", region, "--output", "json"])) || "null");
const at = () => new Date().toISOString();

type Launch = {
  runId: string;
  adapter: Adapter;
  model: string;
  nonce: string;
  secretArn: string;
  taskDefinitionArn: string;
  taskArn?: string;
  launchedAt: string;
};
const readLaunch = async (): Promise<Launch> => JSON.parse(await readFile(launchFile, "utf8"));
const describe = async (l: Launch) => (await aws(["ecs", "describe-tasks", "--cluster", cluster, "--tasks", need("taskArn", l.taskArn)])) as DescribeTasks;

/** Writes `body` to a 0600 file in a fresh 0700 directory for `aws ... file://`, then removes it. */
async function withFile<T>(body: string, use: (uri: string) => Promise<T>): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), "sergeant-spike-"));
  const path = join(tmp, "input.json");
  try {
    await writeFile(path, body, { mode: 0o600 });
    return await use(`file://${path}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function start() {
  if (await readFile(launchFile).then(() => true, () => false)) return console.log(`${runId} already launched`); // idempotent on runId
  if (!ADAPTERS.includes(values.adapter as Adapter)) throw new Error(`--adapter must be one of ${ADAPTERS.join(", ")}`);
  const adapter = values.adapter as Adapter;
  const credentialEnv = AGENTS[adapter].credentialEnv;
  const repos = values.repo;
  if (!repos.length) throw new Error("--repo is required");
  const brief = await readFile(need("--brief", values.brief), "utf8");
  await mkdir(dir, { recursive: true });
  const t0 = Date.now();

  // One secret per run: the brief (too big for RunTask overrides) and the run's two credentials.
  const secretString = JSON.stringify({ SERGEANT_BRIEF: brief, GH_TOKEN: need("GH_TOKEN"), [credentialEnv]: need(credentialEnv) });
  const secret = await withFile(secretString, (uri) =>
    aws(["secretsmanager", "create-secret", "--name", `sergeant/fargate-spike/${runId}`, "--secret-string", uri, "--tags", `Key=sergeant.run,Value=${runId}`]),
  );
  const nonce = randomBytes(12).toString("hex");
  const def = taskDefinition({
    family: "sergeant-fargate-spike",
    image: need("SPIKE_IMAGE"),
    adapter,
    secretArn: secret.ARN,
    executionRoleArn: need("SPIKE_EXECUTION_ROLE_ARN"),
    logGroup,
    region,
    cpu: values.cpu,
    memory: values.memory,
    gitIdentity: { name: need("SPIKE_GIT_NAME"), email: need("SPIKE_GIT_EMAIL") },
    reportNonce: nonce,
  });
  const registered = await withFile(JSON.stringify(def), (uri) => aws(["ecs", "register-task-definition", "--cli-input-json", uri]));
  const launch: Launch = {
    runId,
    adapter,
    model: need("--model", values.model),
    nonce,
    secretArn: secret.ARN,
    taskDefinitionArn: registered.taskDefinition.taskDefinitionArn,
    launchedAt: at(),
  };
  // Written before RunTask (record first): a lost answer leaves the launch findable by `startedBy`.
  await writeFile(launchFile, JSON.stringify(launch, null, 2));
  const network = `awsvpcConfiguration={subnets=[${need("SPIKE_SUBNETS")}],securityGroups=[${need("SPIKE_SECURITY_GROUP")}],assignPublicIp=ENABLED}`;
  const overrides = { containerOverrides: [{ name: "worker", command: ["sh", "-c", TASK_SCRIPT, "sh", values.wall, launch.model, values.budget, ...repos] }] };
  const ran = await withFile(JSON.stringify(overrides), (uri) =>
    aws([
      "ecs", "run-task", "--cluster", cluster, "--launch-type", "FARGATE", "--task-definition", launch.taskDefinitionArn,
      "--network-configuration", network, "--overrides", uri, "--started-by", runId,
      "--client-token", runId.slice(0, 64), "--tags", `key=sergeant.run,value=${runId}`,
    ]),
  );
  const taskArn = ran.tasks?.[0]?.taskArn;
  if (!taskArn) throw new Error(`run-task started nothing: ${JSON.stringify(ran.failures)}`);
  await writeFile(launchFile, JSON.stringify({ ...launch, taskArn }, null, 2));
  console.log(JSON.stringify({ runId, taskArn, setupSeconds: (Date.now() - t0) / 1000 }));
}

async function status() {
  const l = await readLaunch();
  const out = await describe(l);
  const s = taskState(out);
  const t = (out.tasks?.[0] ?? {}) as Record<string, string | number | undefined>;
  console.log(JSON.stringify({
    runId, ...s,
    // Cold start: RunTask to the container running, of which the image pull is usually most.
    secondsToRunning: secondsBetween(t.createdAt, t.startedAt),
    pullSeconds: secondsBetween(t.pullStartedAt, t.pullStoppedAt),
    runSeconds: secondsBetween(t.startedAt, t.stoppedAt),
  }));
}

async function cancel() {
  const l = await readLaunch();
  const s = taskState(await describe(l));
  if (s.state !== "running") return console.log(JSON.stringify({ runId, alreadyEnded: s.state }));
  // SIGTERM, then SIGKILL after the definition's 30 s stopTimeout. `status` shows STOPPED/UserInitiated once done.
  await aws(["ecs", "stop-task", "--cluster", cluster, "--task", need("taskArn", l.taskArn), "--reason", "sergeant cancel"]);
  console.log(JSON.stringify({ runId, stopRequested: true }));
}

/** Every line of the task's log stream, oldest first. */
async function logLines(l: Launch) {
  const stream = `run/worker/${need("taskArn", l.taskArn).split("/").pop()}`;
  const lines: string[] = [];
  let token: string | undefined;
  for (;;) {
    const page = await aws(["logs", "get-log-events", "--log-group-name", logGroup, "--log-stream-name", stream, "--start-from-head", ...(token ? ["--next-token", token] : [])]);
    lines.push(...page.events.map((e: { message: string }) => e.message));
    if (page.nextForwardToken === token) return lines;
    token = page.nextForwardToken;
  }
}

async function result() {
  const l = await readLaunch();
  const s = taskState(await describe(l));
  if (s.state === "running") throw new Error(`${runId} is still ${s.lastStatus}`);
  // ECS forgets a stopped task after about an hour; its log stream, and so its report, outlives it.
  const lines = s.state === "gone" ? await logLines(l).catch(() => []) : await logLines(l);
  const framed = extractReport(lines, l.nonce);
  // A task that ran to its end prints the end marker last; without it the logs have not all arrived yet.
  if (s.state === "stopped" && s.exitCode !== undefined && !s.canceled && !framed.complete) throw new Error("report not in the logs yet; retry");
  const agentOut = lines.join("\n");
  const agent = AGENTS[l.adapter].parse(agentOut, agentOut);
  const parsed = framed.markdown ? parseReport(framed.markdown, WorkerReport) : undefined;
  const record = RunRecord.parse({
    runId, role: "worker",
    status: s.state === "gone" ? "failed" : terminalStatus(s, agent.ok),
    provider: AGENTS[l.adapter].provider,
    model: agent.models.length ? agent.models.join(",") : l.model,
    ...(agent.costUsd !== undefined && { costUsd: agent.costUsd }),
    ...(agent.tokens && { tokens: agent.tokens }),
    ...(agent.failureReason && { failureReason: agent.failureReason }),
    report: parsed?.ok ? parsed.report : null,
    ...(!parsed?.ok && { reportError: parsed ? parsed.error : `no report written; ${s.state === "gone" ? "task is gone" : `exit ${s.exitCode} ${s.detail}`}` }),
  });
  if (framed.markdown) await writeFile(join(dir, "report.md"), framed.markdown);
  await writeFile(join(dir, "record.json"), JSON.stringify(record, null, 2));
  await aws(["secretsmanager", "delete-secret", "--secret-id", l.secretArn, "--force-delete-without-recovery"]);
  await aws(["ecs", "deregister-task-definition", "--task-definition", l.taskDefinitionArn]);
  console.log(JSON.stringify({ runId, status: record.status, exitCode: s.state === "stopped" ? s.exitCode : undefined, report: Boolean(parsed?.ok) }));
}

const commands: Record<string, () => Promise<unknown>> = { start, status, cancel, result };
const command = commands[positionals[0] ?? ""];
if (!command) throw new Error(`usage: cli.ts ${Object.keys(commands).join("|")} --run-id <id> ...`);
await command();
