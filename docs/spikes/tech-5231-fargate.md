# Spike: one Sergeant worker on ECS Fargate (TECH-5231)

Question: can Sergeant run a normal worker in an ECS Fargate task with a small, clean execution
boundary? Target shape if yes:
`serve on the EC2 control plane -> ECS RunTask -> isolated Fargate worker -> PR/report -> task exits`.

**Status: the spike path is built but has not run live.** The worker that wrote it had no AWS access
(by design, a run gets none), so no Fargate task has run yet. Nothing below claims a live result.
Section 5 is the procedure for an operator with AWS access, and section 6 lists what that run must
record before the recommendation is final.

## 1. What was built

Standalone, in `packages/runner/src/fargate-spike/`. It is not wired into `serve`, and it does not
change `containerRunner`:

| File | What it does |
|---|---|
| `task.ts` | Pure pieces: the task definition, the in-task wrapper script (`TASK_SCRIPT`), ECS task state from `describe-tasks`, the terminal status, and report extraction from log lines. |
| `task.test.ts` | Unit tests for those pieces: loss vs unknown, cancel vs failed start, report framing, and no credential values in the task definition. |
| `cli.ts` | Manual control-plane driver over the `aws` CLI: `start`, `status`, `cancel`, `result`. No new dependency. |

How a run works:

1. **Start (control plane).** `cli.ts start` reads `GH_TOKEN` and the adapter's model credential
   (`CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_CREDENTIAL`) from its own environment. It creates **one
   Secrets Manager secret per run** (`sergeant/fargate-spike/<runId>`) holding the brief and those two
   values as JSON keys. It writes the secret string to a 0600 temp file and passes it as `file://`,
   so no value is ever on a command line. It then registers a task definition whose `secrets` point at
   those keys, records `launch.json` (record first), and calls `RunTask` with `--client-token <runId>`
   (idempotent) and `--started-by <runId>` (findable by `list-tasks`).
2. **In the task.** The same runner image runs `TASK_SCRIPT`. It writes `/workspace/sergeant-brief.md`
   from `SERGEANT_BRIEF` and unsets it, then clones the run's repositories with the worker token (the
   image's credential helper already reads `GH_TOKEN`). It runs the adapter's **unchanged** agent script
   (`AGENTS[adapter].script`: `claude -p …` or `codex exec …`, with `timeout` and `--max-budget-usd`).
   Finally it prints `sergeant-report.md` base64-encoded between `SERGEANT-REPORT-BEGIN/END <nonce>`
   lines and exits with the agent's code. The agent runs in the background so that a cancel's SIGTERM
   reaches it and the report is still printed.
3. **Status.** `describe-tasks`. `PROVISIONING…RUNNING…DEPROVISIONING` maps to running and `STOPPED`
   to terminal with the container's exit code. Only `failures[].reason == MISSING` counts as loss (04
   §6); any other unreadable answer throws, which the caller treats as unknown. Status also prints the
   cold-start split: `createdAt→startedAt`, the image pull, and the run time.
4. **Cancel.** `stop-task`: SIGTERM, then SIGKILL after the definition's 30 s `stopTimeout`. ECS then
   shows `STOPPED` / `stopCode: UserInitiated`, which `terminalStatus` records as `canceled`.
5. **Result.** The task's CloudWatch log stream (`awslogs`) is the transport for both agent output and
   the report. `result` reads the stream and runs the adapter's existing `parse` (cost, tokens, session,
   failureReason). It takes the last complete report frame, parses it with `WorkerReport`, and writes
   `record.json` (validated by `RunRecord.parse`) and `report.md`. Then it deletes the secret and
   deregisters the task definition. If the end marker has not arrived yet (CloudWatch delivers a stopped
   task's last lines a few seconds late), it throws so the caller retries.

### The execution boundary

- An explicit `cpu`/`memory` per task (default 2 vCPU / 8 GiB, set by `--cpu`/`--memory`) on Fargate
  capacity. Nothing in the run uses the Sergeant host's CPU; the host makes only the API calls.
- **No task role.** Nothing in the run can call AWS, the counterpart of the host's IMDS hop limit 1.
  Only the *execution* role (used by the ECS agent, not by the run) can read
  `sergeant/fargate-spike/*` secrets, pull from ECR, and write logs.
- `user: node`, `capabilities.drop: ["ALL"]`, `initProcessEnabled`. Fargate does not support Docker's
  `no-new-privileges`. The image has no setuid tools that matter, but this is weaker than the local
  runner.
- Task-local workspace: ephemeral storage (20 GiB by default), discarded with the task. No EFS and no
  bind mount.
- Network: `awsvpc` in the default VPC's public subnets with a public IP (for GitHub and model APIs),
  and a security group with no ingress.

## 2. Credentials

Credentials appear in no argument, no committed file, and no task definition plaintext.
`task.test.ts` checks that the definition carries only `valueFrom` references; the fake-`aws` dry run
below checked every argv. ECS resolves the references as the task starts and injects them as
environment variables. The secret is deleted (`--force-delete-without-recovery`) once the result is
collected.

Remaining exposure, acceptable for a spike:

- The values are in the container's environment, exactly as in the local runner.
- Anyone with `secretsmanager:GetSecretValue` on the prefix can read a live run's secret. Only the
  execution role and the operator have it.
- The agent's own output goes to CloudWatch. It could print `GH_TOKEN` there, which is a risk the
  local runner has with `docker logs` on the host too. The log group needs the same access control as
  the host's logs.

## 3. Smallest production integration path

A `fargateRunner(opts): RunnerPort` beside `containerRunner`, chosen per installation. No change to
the RunnerPort contract, RunSpec, RunRecord, the brief, or the report protocol.

- **Reuse as-is:** account choice and quota (`accounts.ts`, `choose.ts`), `workerBrief`, `AGENTS[*].script`
  and `parse`, `parseReport`, `run-files.ts` (with the task ARN, secret ARN, and nonce in `RunMeta` in
  place of the container name).
- **`start`:** list `sergeant/*` branches with `git ls-remote` on the host (no clone needed for the
  brief), create the per-run secret, register the definition, and `RunTask` with `clientToken = runId`.
  The AWS SDK (`@aws-sdk/client-ecs`, `-secrets-manager`, `-cloudwatch-logs`) would replace the CLI.
- **`status`/`cancel`/`report`:** `taskState`, `stop-task`, and `extractReport`, as in the spike.
  `isGone` becomes `MISSING`. Collect the result within the hour before ECS forgets the task, though the
  logs outlive it.
- **Instance role:** add `ecs:RunTask`/`StopTask`/`DescribeTasks`/`RegisterTaskDefinition`/
  `DeregisterTaskDefinition`, `iam:PassRole` on the execution role only, Secrets Manager
  create/delete on `sergeant/runs/*`, and `logs:GetLogEvents` on the run log group. That is all
  Terraform. The installation's existing secrets stay unreadable to the execution role.
- **Image:** push the host-built image (`deploy/host/install.sh`) to ECR on each install, tagged by
  commit. This is the one new piece of deploy plumbing.

## 4. Blockers and awkward areas

- **Live proof missing.** See section 6. Nothing here has run on AWS.
- **Workspace preparation.** Workers are fine: the task clones its own repositories with the token it
  already gets. **Reviewers are the awkward case.** Today the reviewer's read-only token checks out the
  PR *on the host* and never enters the reviewer's container (09). On Fargate either a read-only token
  enters the task (a security-model change for a human to decide) or the host ships a `git bundle` of
  the PR head (needs S3 or similar). Linear **attachments**, downloaded on the host with the Linear
  token, need a transport too: small ones fit in the per-run secret, larger ones need S3.
- **Report transport.** Framing the report in the log stream works without any new AWS resource. But
  Docker splits log lines at 16 KiB and `awslogs` does not reassemble them. Base64 report lines are
  short, but a long Claude `result` JSON line could be split, and `parse` would then miss the run's
  cost. Production should frame the agent's final JSON line as well, or use the designed `POST
  /runner/v1/runs/:id/report` (11 §4).
- **Secret size.** Secrets Manager values are capped at 64 KiB. A brief with long conversations and
  earlier reports could exceed it. The fallback is an S3 object or the brief fetched over the runner
  API.
- **Per-run task definitions.** `secrets` cannot be overridden in `RunTask`, so each run registers a
  revision. That is cheap and fast, but it leaves INACTIVE revisions; `DeleteTaskDefinitions` can
  clean them up.
- **Startup latency.** Fargate has no image cache. Every task pulls the full runner image (Node 24,
  build tools, `gh`, Claude Code, and Codex: about 1 GB+), so a cold start is likely around 1–2
  minutes, against seconds locally. This has not been measured (section 6). Possible mitigations are
  a slimmer image, a SOCI index for lazy loading, and the same region and architecture for ECR and
  Fargate. This is acceptable for runs that last tens of minutes.
- **Caching.** There is no shared dependency or git cache: every run cold-clones and cold-installs.
  For large repositories, `git clone --filter=blob:none` and the repository's own lockfile caching
  are the cheap options. A real cache (EFS, S3) is deliberately out of scope.
- **Hardening parity.** No `no-new-privileges` on Fargate (see section 1).

### Cost (list prices, not measured)

ARM64 Fargate is about $0.032 per vCPU-hour and $0.0036 per GiB-hour. A 2 vCPU / 8 GiB task costs
about $0.09/hour, or about 1.5¢ for a 10-minute run. Ephemeral storage above 20 GiB, the public IPv4
address (about $0.005/hour), and log ingestion (about $0.50/GB) are small. Model spend dominates by
orders of magnitude. The surprises to watch are the ECR data transfer if the image and the tasks are
in different regions, and NAT costs if production uses private subnets.

## 5. Running the live proof (operator, outside CI)

One-time setup, in the installation's account and region:

```sh
aws ecr create-repository --repository-name sergeant-runner
aws ecs create-cluster --cluster-name sergeant-fargate-spike
aws logs create-log-group --log-group-name /sergeant/fargate-spike
# Execution role: trust ecs-tasks.amazonaws.com; attach AmazonECSTaskExecutionRolePolicy, plus an
# inline policy allowing secretsmanager:GetSecretValue on
# arn:aws:secretsmanager:<region>:<account>:secret:sergeant/fargate-spike/*
# Security group in the default VPC: no ingress, all egress.
# Image: on the Sergeant host (arm64) or with buildx --platform linux/arm64:
docker build -t <account>.dkr.ecr.<region>.amazonaws.com/sergeant-runner:spike packages/runner/container
docker push <account>.dkr.ecr.<region>.amazonaws.com/sergeant-runner:spike
```

One run, from `packages/runner`, with a scoped worker-App token for one test repository and one
registered model credential exported in the shell (never typed as arguments):

```sh
export AWS_REGION=… SPIKE_CLUSTER=sergeant-fargate-spike SPIKE_IMAGE=<ecr uri>:spike \
  SPIKE_EXECUTION_ROLE_ARN=… SPIKE_SUBNETS=subnet-… SPIKE_SECURITY_GROUP=sg-… \
  SPIKE_GIT_NAME=… SPIKE_GIT_EMAIL=…
# GH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN already exported
node src/fargate-spike/cli.ts start  --run-id run_spike-1 --brief brief.md --repo <owner/test-repo> --model <model>
node src/fargate-spike/cli.ts status --run-id run_spike-1     # repeat while running
node src/fargate-spike/cli.ts result --run-id run_spike-1     # once STOPPED
# cancel: start run_spike-2 the same way, then
node src/fargate-spike/cli.ts cancel --run-id run_spike-2 && node src/fargate-spike/cli.ts status --run-id run_spike-2
```

`brief.md` is a normal worker brief (`workerBrief`) for a tiny change in the test repository.

## 6. Validation

**Observed:**

- `task.test.ts` passes, and the runner package's typecheck and lint pass.
- `TASK_SCRIPT` was run locally under `sh` with a stand-in agent. On a normal exit it wrote the brief,
  framed the report, and kept the agent's exit code (3). On SIGTERM mid-run it still framed the report
  the agent had written and exited 143. `extractReport` decoded both.
- `cli.ts` ran end to end against a fake `aws` executable: `start` (repeated, idempotent), `status`
  while running and after stop, `cancel`, and `result`. `result` produced a `RunRecord.parse`-valid
  succeeded record with cost from Claude's result line and the parsed report, then deleted the secret
  and the task definition. No secret value appeared in any `aws` argument, in the task definition, or
  in the overrides, and the temp files were removed.

**Not done (needs AWS):** a live Fargate run. It must show:

- a PR opened by the task;
- `status` while RUNNING;
- the terminal exit code;
- a canceled run;
- `record.json`;
- the measured `secondsToRunning` and `pullSeconds`;
- that the secret and the task definition contain no plaintext credentials (in the console or with
  `describe-task-definition`).

## 7. Recommendation

**Provisional: continue with Fargate.** The local runner's protocol carries over almost unchanged:
the same image, agent scripts, parsing, brief, and report. No gap found on paper is one that
Daytona, E2B, or Runloop would close better. The real costs are the reviewer checkout and attachment
transport, cold-start latency without image caching, and the 64 KiB secret cap, and a hosted sandbox
has those too. Make the recommendation final only after the live run in section 5 succeeds. If image
pull alone takes several minutes even after slimming the image or adding a SOCI index, revisit.
