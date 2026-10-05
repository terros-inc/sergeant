import type { RegisterTaskDefinitionCommandInput } from "@aws-sdk/client-ecs";
import { AGENTS, type Adapter } from "../agents.ts";
import { ATTACHMENTS_PATH } from "../attachments.ts";

// The deterministic pieces of a worker run as an ECS Fargate task (TECH-5231 spike, TECH-5237):
// the in-task script, the task definition, the task's state from DescribeTasks, and the frames the
// task prints into its CloudWatch log stream. docs/spikes/tech-5231-fargate.md.

/** The line the task prints once its workspace is ready and its agent starts. */
export const WORKSPACE_READY = "sergeant: workspace ready";

/** The ECS container name of a run's one container. */
export const CONTAINER = "worker";

/**
 * What the task runs in place of the host's clone + bind mount: it writes the brief and the
 * attachments, clones the run's repositories with the worker token (the image's credential helper
 * reads `GH_TOKEN`), and runs the adapter's unchanged agent script with its stdout also copied to a
 * file. Then it prints, each base64 encoded between two marker lines, the agent's last JSON line (the
 * Claude Code result, with the run's cost: a log line over 16 KiB is split, and this frame's lines are
 * short) and the report, so both reach the control plane through the task's log stream, after a cancel
 * too. Exits with the agent's code; 71 if the brief or a file cannot be written, 70 if a clone fails,
 * both before `WORKSPACE_READY` and with no frame.
 *
 * `SERGEANT_ATTACHMENTS` is one `<name> <base64>` line per file; names are `fetchAttachments`'s, safe.
 * Args: `<wall> <model> <budget> <repo>...`.
 */
export const TASK_SCRIPT = `
set -u
wall="$1"; model="$2"; budget="$3"; shift 3
printf '%s' "$SERGEANT_BRIEF" > /workspace/sergeant-brief.md || exit 71
unset SERGEANT_BRIEF
if [ -n "\${SERGEANT_ATTACHMENTS:-}" ]; then
  mkdir -p "${ATTACHMENTS_PATH}" || exit 71
  printf '%s\\n' "$SERGEANT_ATTACHMENTS" | while read -r name data; do
    [ -n "$name" ] || continue
    printf '%s' "$data" | base64 -d > "${ATTACHMENTS_PATH}/$name" && chmod 0444 "${ATTACHMENTS_PATH}/$name" || exit 71
  done || exit 71
  chmod 0555 "${ATTACHMENTS_PATH}"
fi
unset SERGEANT_ATTACHMENTS
for repo in "$@"; do
  git clone --quiet "https://github.com/$repo.git" "/workspace/$repo" || exit 70
done
echo "${WORKSPACE_READY}"
out=/tmp/sergeant-agent.out
mkfifo /tmp/sergeant-agent.pipe || exit 71
tee "$out" < /tmp/sergeant-agent.pipe &
copy=$!
# In the background so a cancel's SIGTERM reaches the agent and this script still prints its frames.
sh -c "$SERGEANT_AGENT_SCRIPT" sh "$wall" "$model" "$budget" > /tmp/sergeant-agent.pipe &
agent=$!
trap 'kill -TERM "$agent" 2>/dev/null' TERM
wait "$agent"; code=$?
while kill -0 "$agent" 2>/dev/null; do wait "$agent"; code=$?; done
# A process the agent left behind may hold the pipe open: tee gets a few seconds to drain, no more.
for _ in 1 2 3 4 5; do kill -0 "$copy" 2>/dev/null || break; sleep 1; done
kill "$copy" 2>/dev/null
# The leading newlines end an agent's unterminated last line, so each marker stays a line of its own.
printf '\\nSERGEANT-RESULT-BEGIN %s\\n' "$SERGEANT_REPORT_NONCE"
grep '^{' "$out" | tail -n 1 | base64
echo "SERGEANT-RESULT-END $SERGEANT_REPORT_NONCE"
printf '\\nSERGEANT-REPORT-BEGIN %s\\n' "$SERGEANT_REPORT_NONCE"
if [ -f /workspace/sergeant-report.md ] && [ ! -L /workspace/sergeant-report.md ]; then
  base64 /workspace/sergeant-report.md
fi
echo "SERGEANT-REPORT-END $SERGEANT_REPORT_NONCE"
exit $code
`;

/** The keys of a run's secret, each one environment variable of its container. */
export const secretKeys = (adapter: Adapter, attachments: boolean) => [
  "SERGEANT_BRIEF",
  ...(attachments ? ["SERGEANT_ATTACHMENTS"] : []),
  "GH_TOKEN",
  AGENTS[adapter].credentialEnv,
];

export type TaskDefinitionInput = {
  family: string;
  image: string;
  adapter: Adapter;
  /** Full ARN of the run's secret, as CreateSecret returns it (JSON-key references need it). */
  secretArn: string;
  /** Whether the secret holds `SERGEANT_ATTACHMENTS`: a reference to a missing key fails the task's start. */
  attachments: boolean;
  executionRoleArn: string;
  logGroup: string;
  region: string;
  cpu: string;
  memory: string;
  gitIdentity: { name: string; email: string };
  reportNonce: string;
  /** The task's whole command; a definition per run, so nothing is overridden at RunTask. */
  command: string[];
};

/**
 * The run's task definition. Credentials and the brief are only `secrets` references, resolved by
 * the execution role as the task starts; no value is in the definition. There is no task role, so
 * nothing in the run can call AWS, as IMDS hop limit 1 does for the host's containers.
 */
export function taskDefinition(i: TaskDefinitionInput) {
  const fromSecret = (name: string) => ({ name, valueFrom: `${i.secretArn}:${name}::` });
  const plain = (name: string, value: string) => ({ name, value });
  return {
    family: i.family,
    requiresCompatibilities: ["FARGATE"],
    networkMode: "awsvpc",
    cpu: i.cpu,
    memory: i.memory,
    // The Sergeant host is Graviton; the image it builds is arm64.
    runtimePlatform: { cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" },
    executionRoleArn: i.executionRoleArn,
    containerDefinitions: [
      {
        name: CONTAINER,
        image: i.image,
        essential: true,
        user: "node",
        workingDirectory: "/workspace",
        command: i.command,
        stopTimeout: 30,
        linuxParameters: { capabilities: { drop: ["ALL"] }, initProcessEnabled: true },
        secrets: secretKeys(i.adapter, i.attachments).map(fromSecret),
        environment: [
          plain("SERGEANT_AGENT_SCRIPT", AGENTS[i.adapter].script),
          plain("SERGEANT_REPORT_NONCE", i.reportNonce),
          plain("GIT_AUTHOR_NAME", i.gitIdentity.name),
          plain("GIT_AUTHOR_EMAIL", i.gitIdentity.email),
          plain("GIT_COMMITTER_NAME", i.gitIdentity.name),
          plain("GIT_COMMITTER_EMAIL", i.gitIdentity.email),
        ],
        logConfiguration: {
          logDriver: "awslogs",
          options: { "awslogs-group": i.logGroup, "awslogs-region": i.region, "awslogs-stream-prefix": "run" },
        },
      },
    ],
  } satisfies RegisterTaskDefinitionCommandInput;
}

/** The task's log stream: `awslogs` names it `<prefix>/<container>/<task id>`. */
export const logStream = (taskArn: string) => `run/${CONTAINER}/${taskArn.split("/").pop()}`;

type Timestamp = Date | string | number;

/** ECS's DescribeTasks output, only the fields read here. */
export type DescribeTasks = {
  tasks?:
    | {
        lastStatus?: string | undefined;
        stopCode?: string | undefined;
        stoppedReason?: string | undefined;
        createdAt?: Timestamp | undefined;
        startedAt?: Timestamp | undefined;
        stoppedAt?: Timestamp | undefined;
        containers?: { name?: string | undefined; exitCode?: number | undefined; reason?: string | undefined }[] | undefined;
      }[]
    | undefined;
  failures?: { reason?: string | undefined }[] | undefined;
};

export type TaskState =
  | { state: "running"; lastStatus: string }
  | { state: "stopped"; exitCode: number | undefined; canceled: boolean; detail: string }
  | { state: "gone" };

/**
 * One task's state from DescribeTasks. `MISSING` is ECS's definite answer that the task does not
 * exist (it forgets stopped tasks after about an hour), the only loss; anything else unreadable throws,
 * so the caller treats it as unknown (04 §6).
 */
export function taskState(out: DescribeTasks): TaskState {
  const task = out.tasks?.[0];
  if (!task) {
    if (out.failures?.some((f) => f.reason === "MISSING")) return { state: "gone" };
    throw new Error(`task status unavailable: ${out.failures?.map((f) => f.reason).join(", ") || "no task in the answer"}`);
  }
  const lastStatus = task.lastStatus ?? "UNKNOWN";
  if (lastStatus !== "STOPPED") return { state: "running", lastStatus };
  const worker = task.containers?.find((c) => c.name === CONTAINER);
  const detail = [task.stopCode, task.stoppedReason, worker?.reason].filter(Boolean).join(": ");
  return { state: "stopped", exitCode: worker?.exitCode, canceled: task.stopCode === "UserInitiated", detail };
}

/**
 * What the task printed between its `kind` markers, decoded; incomplete until the end marker arrives
 * (CloudWatch delivers a stopped task's last lines a few seconds late), and complete without `text`
 * when the frame is empty. The last complete frame wins, so a marker the agent printed earlier cannot
 * replace it.
 */
export function extractFrame(lines: string[], kind: "REPORT" | "RESULT", nonce: string): { complete: boolean; text?: string } {
  const e = lines.lastIndexOf(`SERGEANT-${kind}-END ${nonce}`);
  if (e < 0) return { complete: false };
  const b = lines.lastIndexOf(`SERGEANT-${kind}-BEGIN ${nonce}`, e);
  if (b < 0) return { complete: false };
  const text = Buffer.from(lines.slice(b + 1, e).join(""), "base64").toString("utf8");
  return text ? { complete: true, text } : { complete: true };
}

/**
 * The agent's stdout for its adapter's `parse`: the log lines, with the framed last JSON line added
 * at the end when the log split it, so Claude Code's cost survives a line over 16 KiB. A line the
 * log kept whole is not added again, so Codex's usage is not counted twice.
 */
export function agentOutput(lines: string[], nonce: string): string {
  const result = extractFrame(lines, "RESULT", nonce).text?.replace(/\n$/, "");
  return [...lines, ...(result && !lines.includes(result) ? [result] : [])].join("\n");
}

/** How long after a task stops its last log lines may still be on their way to CloudWatch. */
export const LOG_GRACE_SECONDS = 120;

/**
 * Whether to wait for more logs rather than record the run now. Only a task stopped with an exit
 * code and no complete report frame is in doubt; it waits only within `LOG_GRACE_SECONDS` of
 * stopping, and only if its agent may have printed a frame: it exited 0, or reached
 * `WORKSPACE_READY` (a canceled agent still has its frames printed). A clone failure (70) is final
 * at once; an OOM kill (137) after the agent started is final after the grace period.
 */
export function awaitingLogs(s: TaskState, lines: string[], nonce: string, stoppedSecondsAgo: number | undefined) {
  if (s.state !== "stopped" || s.exitCode === undefined || extractFrame(lines, "REPORT", nonce).complete) return false;
  if (stoppedSecondsAgo === undefined || stoppedSecondsAgo >= LOG_GRACE_SECONDS) return false;
  return s.exitCode === 0 || lines.includes(WORKSPACE_READY);
}

/** Seconds between two ECS timestamps. */
export function secondsBetween(from: Timestamp | undefined, to: Timestamp | undefined) {
  const ms = (t: Timestamp) => (t instanceof Date ? t.getTime() : typeof t === "number" ? t * 1000 : Date.parse(t));
  return from === undefined || to === undefined ? undefined : Math.round((ms(to) - ms(from)) / 1000);
}
