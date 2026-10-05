import { AGENTS, type Adapter } from "../agents.ts";

// TECH-5231 spike: the deterministic pieces of running one worker as an ECS Fargate task. Not
// wired into `serve` or `containerRunner`; `cli.ts` drives it by hand. docs/spikes/tech-5231-fargate.md.

/**
 * What the task runs in place of the host's clone + bind mount: it writes the brief, clones the run's
 * repositories with the worker token (the image's credential helper reads `GH_TOKEN`), runs the
 * adapter's unchanged agent script, then prints the report between two marker lines, base64 encoded,
 * so it reaches the control plane through the task's CloudWatch log stream, after a cancel too.
 * Exits with the agent's code.
 * Args: `<wall> <model> <budget> <repo>...`.
 */
export const TASK_SCRIPT = `
set -u
wall="$1"; model="$2"; budget="$3"; shift 3
printf '%s' "$SERGEANT_BRIEF" > /workspace/sergeant-brief.md
unset SERGEANT_BRIEF
for repo in "$@"; do
  git clone --quiet "https://github.com/$repo.git" "/workspace/$repo" || exit 70
done
echo "sergeant: workspace ready"
# In the background so a cancel's SIGTERM reaches the agent and this script still prints its report.
sh -c "$SERGEANT_AGENT_SCRIPT" sh "$wall" "$model" "$budget" &
agent=$!
trap 'kill -TERM "$agent" 2>/dev/null' TERM
wait "$agent"; code=$?
while kill -0 "$agent" 2>/dev/null; do wait "$agent"; code=$?; done
echo "SERGEANT-REPORT-BEGIN $SERGEANT_REPORT_NONCE"
if [ -f /workspace/sergeant-report.md ] && [ ! -L /workspace/sergeant-report.md ]; then
  base64 /workspace/sergeant-report.md
fi
echo "SERGEANT-REPORT-END $SERGEANT_REPORT_NONCE"
exit $code
`;

export type TaskDefinitionInput = {
  family: string;
  image: string;
  adapter: Adapter;
  /** Full ARN of the run's secret, as `create-secret` returns it (JSON-key references need it). */
  secretArn: string;
  executionRoleArn: string;
  logGroup: string;
  region: string;
  cpu: string;
  memory: string;
  gitIdentity: { name: string; email: string };
  reportNonce: string;
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
        name: "worker",
        image: i.image,
        essential: true,
        user: "node",
        workingDirectory: "/workspace",
        stopTimeout: 30,
        linuxParameters: { capabilities: { drop: ["ALL"] }, initProcessEnabled: true },
        secrets: [fromSecret("SERGEANT_BRIEF"), fromSecret("GH_TOKEN"), fromSecret(AGENTS[i.adapter].credentialEnv)],
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
  };
}

/** ECS's `describe-tasks` output, only the fields read here. */
export type DescribeTasks = {
  tasks?: {
    lastStatus?: string;
    stopCode?: string;
    stoppedReason?: string;
    createdAt?: string | number;
    startedAt?: string | number;
    stoppedAt?: string | number;
    containers?: { name?: string; exitCode?: number; reason?: string }[];
  }[];
  failures?: { reason?: string }[];
};

export type TaskState =
  | { state: "running"; lastStatus: string }
  | { state: "stopped"; exitCode: number | undefined; canceled: boolean; detail: string }
  | { state: "gone" };

/**
 * One task's state from `describe-tasks`. `MISSING` is ECS's definite answer that the task does not
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
  const worker = task.containers?.find((c) => c.name === "worker");
  const detail = [task.stopCode, task.stoppedReason, worker?.reason].filter(Boolean).join(": ");
  return { state: "stopped", exitCode: worker?.exitCode, canceled: task.stopCode === "UserInitiated", detail };
}

/** The run's terminal status from a stopped task and what its agent said, as containerRunner decides it. */
export function terminalStatus(s: Extract<TaskState, { state: "stopped" }>, agentOk: boolean) {
  if (s.canceled) return "canceled" as const;
  return s.exitCode === 0 && agentOk ? ("succeeded" as const) : ("failed" as const);
}

/**
 * The report the task printed between its markers, decoded; undefined when the end marker has not
 * arrived (CloudWatch delivers a stopped task's last lines a few seconds late) or the agent wrote none.
 * The last complete frame wins, so a marker the agent itself printed earlier cannot replace it.
 */
export function extractReport(lines: string[], nonce: string): { complete: boolean; markdown?: string } {
  const begin = `SERGEANT-REPORT-BEGIN ${nonce}`;
  const end = `SERGEANT-REPORT-END ${nonce}`;
  const e = lines.lastIndexOf(end);
  if (e < 0) return { complete: false };
  const b = lines.lastIndexOf(begin, e);
  if (b < 0) return { complete: false };
  const body = lines.slice(b + 1, e).join("");
  return body ? { complete: true, markdown: Buffer.from(body, "base64").toString("utf8") } : { complete: true };
}

/** Seconds between two ECS timestamps (ISO strings or epoch seconds, as the CLI prints them). */
export function secondsBetween(from: string | number | undefined, to: string | number | undefined) {
  const ms = (t: string | number) => (typeof t === "number" ? t * 1000 : Date.parse(t));
  return from === undefined || to === undefined ? undefined : Math.round((ms(to) - ms(from)) / 1000);
}
