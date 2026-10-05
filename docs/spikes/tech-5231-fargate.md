# Spike: one Sergeant worker on ECS Fargate (TECH-5231)

Question: can Sergeant run a normal worker in an ECS Fargate task with a small, clean execution
boundary? Target shape if yes:
`serve on the EC2 control plane -> ECS RunTask -> isolated Fargate worker -> PR/report -> task exits`.

**Status: done. One real worker ran end to end on Fargate.** An operator ran section 5's procedure
live on 2026-10-04 (about 11:10 PM PT), in us-west-2 on ARM64, with this spike driver. Section 6
has the measured results and section 7 the final recommendation: continue with Fargate.

> **Since TECH-5237** the spike driver (`cli.ts`, `brief.ts`) is gone: its pieces became the
> production `fargateRunner` in `packages/runner/src/fargate/` over the AWS SDK, with Terraform in
> `deploy/terraform/fargate.tf` (`packages/runner/README.md`, Fargate). Section 5's procedure ran
> against the driver as it was then, before TECH-5237's commit.

## 1. What was built

Standalone, in `packages/runner/src/fargate-spike/`. It is not wired into `serve`, and it does not
change `containerRunner`:

| File | What it does |
|---|---|
| `task.ts` | Pure pieces: the task definition, the in-task wrapper script (`TASK_SCRIPT`), ECS task state from `describe-tasks`, the terminal status, and report extraction from log lines. |
| `task.test.ts` | Unit tests for those pieces: loss vs unknown, cancel vs failed start, report framing, and no credential values in the task definition. |
| `cli.ts` | Manual control-plane driver over the `aws` CLI: `start`, `status`, `cancel`, `result`. No new dependency. |
| `launch.ts` | `start`'s steps, resumable at each AWS effect (section 4), behind a small interface `cli.ts` implements with the `aws` CLI. |
| `launch.test.ts` | Failure tests for `start` against an in-memory AWS: a failure at each step leaves no secret and no task, and a rerun starts exactly one task. |
| `brief.ts` | Renders the normal worker brief (`workerBrief`) from a worker RunSpec in JSON, for `start --brief`. |

The runner image's `/workspace` is now created owned by `node`. The local runner bind-mounts over
it, so only a Fargate task, which clones into the image's own directory, sees the difference.

How a run works:

1. **Start (control plane).** `cli.ts start` reads `GH_TOKEN` and the adapter's model credential
   (`CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_CREDENTIAL`) from its own environment. It creates **one
   Secrets Manager secret per run** (`sergeant/fargate-spike/<runId>`) holding the brief and those two
   values as JSON keys. It writes the secret string to a 0600 temp file and passes it as `file://`,
   so no value is ever on a command line. It then registers a task definition whose `secrets` point at
   those keys and calls `RunTask` with a client token kept in the run's record (idempotent) and
   `--started-by <runId>` (findable by `list-tasks`). `launch.json` names each of these before it can
   exist, so a failed `start` can be rerun (section 4).
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
   deregisters the task definition. CloudWatch delivers a stopped task's last lines a few seconds
   late, so while the frame may still arrive, `result` throws and the caller retries. A task that died
   before its frame (a clone failure, an OOM kill) gets a failed record after at most two minutes, or
   at once with `--force` (section 5.4).

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
checked every argv, and the live run confirmed that the definition and overrides carried only secret
references (section 6). ECS resolves the references as the task starts and injects them as
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
  brief), create the per-run secret, register the definition, and `RunTask` with a client token
  recorded in `RunMeta`. Each step resumable, as the spike's `launch.ts` does (section 4).
  The AWS SDK (`@aws-sdk/client-ecs`, `-secrets-manager`, `-cloudwatch-logs`) would replace the CLI.
- **`status`/`cancel`/`report`:** `taskState`, `stop-task`, and `extractReport`, as in the spike.
  `isGone` becomes `MISSING`. Collect the result within the hour before ECS forgets the task, though the
  logs outlive it.
- **Instance role:** add `ecs:RunTask`/`StopTask`/`DescribeTasks`/`ListTasks`/`RegisterTaskDefinition`/
  `DeregisterTaskDefinition`, `iam:PassRole` on the execution role only, Secrets Manager
  create/put-value/delete on `sergeant/runs/*`, and `logs:GetLogEvents` on the run log group. That is all
  Terraform. The installation's existing secrets stay unreadable to the execution role.
- **Image:** push the host-built image (`deploy/host/install.sh`) to ECR on each install, tagged by
  commit. This is the one new piece of deploy plumbing.

## 4. Blockers and awkward areas

- **Stranded secret on a failed `start` (confirmed live, now fixed in the spike driver).** In the live
  run, a `start` that failed at `RegisterTaskDefinition` (a bad role ARN) left
  `sergeant/fargate-spike/<runId>` holding both credentials, the worker token and the model
  credential, with no recorded ARN and nothing to delete it; the operator deleted it by hand. And
  since any existing `launch.json` counted as "already launched", a `RunTask` that failed or lost its
  answer left a run that nothing could find, cancel, or clean up. The spike's `start` (`launch.ts`)
  is now resumable at every external effect:
  - `launch.json` records the deterministic secret name, the nonce, the `RunTask` client token, and
    the task's command and network before the secret is created. A rerun takes over a secret an
    earlier `start` created but did not record (`put-secret-value`) rather than failing on the name.
  - It records the task definition's ARN as soon as it is registered.
  - It records that `RunTask` was sent before sending it. A `launch.json` without a `taskArn` is not
    "already launched": a rerun looks the task up by `startedBy` (`list-tasks`, running or stopped)
    and, if none is found, sends the same `RunTask` with the same client token, so it cannot start
    a second task.
  - When the failure is definitely before any task (at the secret, at the definition, or a
    `RunTask` that ECS rejected or answered with no task), `start` deletes the secret by name,
    deregisters the definition, and drops `launch.json`, so a rerun starts clean. After a lost or
    ambiguous `RunTask` answer it keeps them, and says so, until a rerun's lookup settles it.

  `launch.test.ts` covers a rejected and a lost answer at each step. A production `start` must do the
  same with its RunMeta record. One leftover is harmless: a `RegisterTaskDefinition` whose answer is
  lost leaves an unrecorded revision, which holds only a reference to the deleted secret.
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
- **Startup latency.** Fargate has no image cache, so every task pulls the full runner image (Node 24,
  build tools, `gh`, Claude Code, and Codex). Measured live: `secondsToRunning` 35–38 s, of which
  `pullSeconds` was 14 s, for the full runner image. That is better than this report's earlier
  estimate of 1–2 minutes, but still slower than seconds locally. A slimmer image or a SOCI index for
  lazy loading could cut the pull if startup ever matters.
- **Caching.** There is no shared dependency or git cache: every run cold-clones and cold-installs.
  For large repositories, `git clone --filter=blob:none` and the repository's own lockfile caching
  are the cheap options. A real cache (EFS, S3) is deliberately out of scope.
- **Hardening parity.** No `no-new-privileges` on Fargate (see section 1).

### Cost

Measured live: $0.08 of model spend per run; the Fargate cost is negligible. For scale, at list
prices ARM64 Fargate is about $0.032 per vCPU-hour and $0.0036 per GiB-hour, so a 2 vCPU / 8 GiB
task costs about $0.09/hour. Ephemeral storage above 20 GiB, the public IPv4 address (about
$0.005/hour), and log ingestion (about $0.50/GB) are small. The surprises to watch are the ECR data
transfer if the image and the tasks are in different regions, and NAT costs if production uses
private subnets.

## 5. Running the live proof (operator, outside CI)

Done once (section 6); kept so the run can be repeated. It needs someone with admin-level AWS access
to the installation's account (ECR, ECS, IAM, EC2, Logs, Secrets Manager, and SSM read). It also
needs Node 24 and `pnpm install` in a checkout of this repository, bash, Docker able to build arm64
images (the Sergeant host, or `buildx --platform linux/arm64`), and `jq`, `openssl`, and `curl`.
Every command below runs from the checkout's root unless it says otherwise. No credential is ever
typed as an argument: each one goes from a command's output into an environment variable.

### 5.1 One-time setup

```sh
export AWS_REGION=us-west-2                      # the installation's region
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
ECR=$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/sergeant-runner

aws ecr create-repository --repository-name sergeant-runner
aws ecs create-cluster --cluster-name sergeant-fargate-spike
aws logs create-log-group --log-group-name /sergeant/fargate-spike

# Execution role, used by ECS itself (image pull, logs, the run's secret), never by the run.
aws iam create-role --role-name sergeant-fargate-spike-execution --assume-role-policy-document '{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Principal": { "Service": "ecs-tasks.amazonaws.com" }, "Action": "sts:AssumeRole" }]
}'
aws iam attach-role-policy --role-name sergeant-fargate-spike-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name sergeant-fargate-spike-execution --policy-name run-secrets --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{ \"Effect\": \"Allow\", \"Action\": \"secretsmanager:GetSecretValue\",
    \"Resource\": \"arn:aws:secretsmanager:$AWS_REGION:$ACCOUNT:secret:sergeant/fargate-spike/*\" }]
}"

# Network: the default VPC's default subnets (public), and a new security group, which has no
# ingress and all egress by default.
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' --output text | tr '\t' ',')
SG=$(aws ec2 create-security-group --group-name sergeant-fargate-spike --vpc-id $VPC \
  --description "Sergeant Fargate spike: no ingress" --query GroupId --output text)

# The runner image, arm64, from main's Dockerfile.
aws ecr get-login-password | docker login --username AWS --password-stdin ${ECR%%/*}
docker build -t $ECR:spike packages/runner/container      # on an x86 machine: docker buildx build --platform linux/arm64 --push -t $ECR:spike packages/runner/container
docker push $ECR:spike
```

Then set what `cli.ts` reads. Use the installation's own git identity, the one `serve` gives runs:

```sh
export SPIKE_CLUSTER=sergeant-fargate-spike SPIKE_IMAGE=$ECR:spike \
  SPIKE_EXECUTION_ROLE_ARN=arn:aws:iam::$ACCOUNT:role/sergeant-fargate-spike-execution \
  SPIKE_SUBNETS=$SUBNETS SPIKE_SECURITY_GROUP=$SG \
  SPIKE_GIT_NAME='<installation git name>' SPIKE_GIT_EMAIL='<installation git email>'
```

### 5.2 The run's credentials

Pick one test repository that the worker App is installed on, where a throwaway PR is fine (`TEST_REPO`,
`<owner>/<name>`). Then mint its scoped worker-App token, as the runner's `runTokens` does: a
one-hour installation token for that repository only, with a worker's permissions. The App's ids and
key come from the installation config (`SERGEANT_CONFIG_PARAMETER` and
`SERGEANT_REGISTERED_ACCOUNTS_SECRET` are in `/etc/sergeant/host.env` on the host). Mint it within
the hour before `start`, and again for a later run:

```sh
export TEST_REPO=<owner>/<name> SERGEANT_CONFIG_PARAMETER=<from host.env>
cfg=$(aws ssm get-parameter --name "$SERGEANT_CONFIG_PARAMETER" --query Parameter.Value --output text)
APP_ID=$(jq -r .github.workerApp.appId <<<"$cfg")
INSTALLATION_ID=$(jq -r .github.workerApp.installationId <<<"$cfg")
key=$(mktemp) && chmod 600 "$key"
aws secretsmanager get-secret-value --secret-id "$(jq -r .github.workerApp.privateKeySecret <<<"$cfg")" \
  --query SecretString --output text >"$key"
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s)
unsigned="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url).$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now-60)) $((now+540)) "$APP_ID" | b64url)"
jwt="$unsigned.$(printf '%s' "$unsigned" | openssl dgst -sha256 -sign "$key" | b64url)"
rm -f "$key"
# The JWT goes to curl on stdin (-H @-), so it is not in curl's argv either.
export GH_TOKEN=$(printf 'Authorization: Bearer %s\n' "$jwt" | curl -fsS -X POST -H @- \
  -H 'Accept: application/vnd.github+json' \
  -d "{\"repositories\":[\"${TEST_REPO#*/}\"],\"permissions\":{\"contents\":\"write\",\"pull_requests\":\"write\",\"checks\":\"read\",\"actions\":\"read\",\"metadata\":\"read\"}}" \
  "https://api.github.com/app/installations/$INSTALLATION_ID/access_tokens" | jq -r .token)
unset jwt
[ -n "$GH_TOKEN" ] && [ "$GH_TOKEN" != null ] && echo "worker token minted"
```

Then take one registered model account: your own, registered with `sgt account register claude`
(docs/sgt.md), from the registered-accounts secret (Terros: `sergeant/terros/registered-accounts`):

```sh
export CLAUDE_CODE_OAUTH_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id "${SERGEANT_REGISTERED_ACCOUNTS_SECRET:-sergeant/terros/registered-accounts}" --query SecretString --output text |
  jq -r --arg email '<your email>' '.accounts[] | select(.email == $email and .adapter == "claude-code-local" and .accountName == "claude") | .credential')
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo "model credential found"
# For Codex: .adapter == "codex-local" and .accountName == "codex", into CODEX_CREDENTIAL, and pass
# --adapter codex-local to start.
```

### 5.3 The brief

`brief.ts` renders the normal worker brief (`workerBrief`) from a worker RunSpec, listing the
repository's `sergeant/*` branches with `GH_TOKEN` as the runner does. Write a spec for a tiny change
(the issue fields only feed the brief; nothing reads Linear):

```sh
cat >/tmp/spike-spec.json <<EOF
{
  "runId": "run_spike-1",
  "owner": { "id": "operator", "name": "<your name>" },
  "repositories": ["$TEST_REPO"],
  "objective": "Fargate spike run: make the tiny change the task asks for, open a ready PR, and write your report.",
  "conversation": {
    "issue": {
      "id": "spike", "identifier": "TECH-5234", "url": "https://linear.app/terros/issue/TECH-5234",
      "title": "Fargate spike: tiny change",
      "description": "Add one line to README.md saying this repository was touched by a Sergeant Fargate spike run.",
      "state": "In Progress", "stateType": "started", "delegate": null, "linkedPullRequests": []
    },
    "humanComments": [], "agentComments": []
  }
}
EOF
cd packages/runner
node src/fargate-spike/brief.ts /tmp/spike-spec.json >/tmp/brief-1.md
jq '.runId = "run_spike-2"' /tmp/spike-spec.json >/tmp/spike-spec-2.json
node src/fargate-spike/brief.ts /tmp/spike-spec-2.json >/tmp/brief-2.md
```

### 5.4 The runs

Still in `packages/runner`, with everything above exported. `--model` is the model the installation's
workers use:

```sh
# 1. A full run: start, status while running, terminal status and exit code, result.
node src/fargate-spike/cli.ts start  --run-id run_spike-1 --brief /tmp/brief-1.md --repo $TEST_REPO --model <model>
node src/fargate-spike/cli.ts status --run-id run_spike-1     # repeat: PROVISIONING, PENDING, RUNNING, then stopped with exitCode
node src/fargate-spike/cli.ts result --run-id run_spike-1     # once stopped; retry if it says the report is not in the logs yet

# 2. A canceled run: start, cancel once RUNNING, then status and result, which also cleans it up.
node src/fargate-spike/cli.ts start  --run-id run_spike-2 --brief /tmp/brief-2.md --repo $TEST_REPO --model <model>
node src/fargate-spike/cli.ts status --run-id run_spike-2     # until RUNNING
node src/fargate-spike/cli.ts cancel --run-id run_spike-2
node src/fargate-spike/cli.ts status --run-id run_spike-2     # until stopped, canceled: true
node src/fargate-spike/cli.ts result --run-id run_spike-2     # writes its canceled record.json
```

`result` waits for the report frame only when the task might still have one on the way: it stopped
with an exit code, was not canceled, exited 0 or got as far as its agent (`sergeant: workspace ready`),
and stopped under two minutes ago. Otherwise, as after a clone failure (exit 70), an unwritable workspace
(71), or an OOM kill (137), it records a failed run without a report. `--force` records the run at
once. Either way it deletes the run's secret and deregisters its task definition.

Each run leaves `fargate-spike-runs/<runId>/` with `launch.json`, `record.json`, and `report.md`.
Then check that nothing is left and nothing leaked:

```sh
aws secretsmanager list-secrets --filters Key=name,Values=sergeant/fargate-spike/ --query 'SecretList[].Name'   # []
aws ecs list-task-definitions --family-prefix sergeant-fargate-spike --status ACTIVE                           # none
aws ecs describe-task-definition --task-definition "$(jq -r .taskDefinitionArn fargate-spike-runs/run_spike-1/launch.json)" \
  --query 'taskDefinition.containerDefinitions[0].{secrets: secrets, env: environment[].name}'                  # valueFrom only
aws logs filter-log-events --log-group-name /sergeant/fargate-spike --filter-pattern '"ghs_"' --query 'events[].logStreamName'  # []
```

Afterwards, remove the setup: the ECR repository, the cluster, the log group, the role, and the
security group.

## 6. Validation

**Live run (operator, 2026-10-04 about 11:10 PM PT, us-west-2, ARM64, this spike driver):**

- **Successful run** (`run_spike-1c`): exit 0, about 1 minute of run time. The task cloned a scratch
  repository, ran Claude (`claude-sonnet-5-5`), and opened a PR:
  https://github.com/trevorallred/sergeant-fargate-test/pull/1. `result` wrote a
  `RunRecord.parse`-valid succeeded record with the report, then deleted the secret and the task
  definition.
- **Cold start:** `secondsToRunning` 35–38 s, of which `pullSeconds` was 14 s, for the full runner
  image. This report had estimated 1–2 minutes.
- **Status while running:** PENDING → RUNNING, then stopped with exit code 0. `setupSeconds` was
  3.4–20.7 s.
- **Cancel** (`run_spike-2`, canceled about 15 s after RUNNING): `stopCode` UserInitiated, exit 143,
  status `canceled`, `report: false` (the agent had not written one yet). A repeated `cancel`
  answered `alreadyEnded`, and a repeated `result` was stable.
- **Idempotent start:** a repeated `start` for a launched run answered "already launched".
- **Credentials:** the task definition and the overrides carried only secret references. No spike
  secret remained afterwards.
- **Token scoping:** a run whose GitHub token lacked write access (`run_spike-1b`) reported `blocked`
  correctly: its push got a 403, and it did not look for other credentials.
- **Cost:** $0.08 of model spend per run; Fargate is negligible.
- **Stranded secret (known issue):** a `start` that failed at `RegisterTaskDefinition` (a bad role
  ARN) left `sergeant/fargate-spike/<runId>` holding both credentials. The operator deleted it by
  hand. Fixed since in the spike driver's `start`; see section 4.

Every task runs with the task definition's explicit `cpu`/`memory` on Fargate capacity (section 1),
so the runs did not use the Sergeant EC2 host's CPU.

**Offline, before the live run:**

- `task.test.ts` passes, and the runner package's typecheck and lint pass.
- After the live run, for the stranded-secret fix: `launch.test.ts` passes. Against the fake `aws`
  executable, a `start` that failed at `RegisterTaskDefinition` left no secret and no `launch.json`,
  and its rerun started one task; a `start` whose `RunTask` answer was lost kept the secret and the
  definition, `status` said to rerun `start`, and the rerun found the task by `startedBy` without a
  second `RunTask`. Not yet run against real AWS.
- `result` against a fake `aws`, for a task stopped with exit 70 and no frame: it wrote a
  `RunRecord.parse`-valid failed record (`no report written; exit 70 …`), deleted the secret, and
  deregistered the definition. For exit 137 after `sergeant: workspace ready`, it asked for a retry
  within the grace period, and recorded the failed run after it or with `--force`.
- `TASK_SCRIPT` under `sh`: an agent whose output lacks a final newline still leaves the BEGIN marker
  on its own line; an unwritable workspace exits 71 before any clone; a missing repository exits 70.
- `brief.ts` rendered a worker brief from section 5.3's spec, with the repository's `sergeant/*`
  branches listed through the token.
- The worker-token JWT commands of section 5.2 made a JWT that verifies with RS256 against a test key.
  Minting from the real worker App was not run.
- `TASK_SCRIPT` was run locally under `sh` with a stand-in agent. On a normal exit it wrote the brief,
  framed the report, and kept the agent's exit code (3). On SIGTERM mid-run it still framed the report
  the agent had written and exited 143. `extractReport` decoded both.
- `cli.ts` ran end to end against a fake `aws` executable: `start` (repeated, idempotent), `status`
  while running and after stop, `cancel`, and `result`. `result` produced a `RunRecord.parse`-valid
  succeeded record with cost from Claude's result line and the parsed report, then deleted the secret
  and the task definition. No secret value appeared in any `aws` argument, in the task definition, or
  in the overrides, and the temp files were removed.

## 7. Recommendation

**Continue with Fargate**, now backed by a live run (us-west-2, ARM64). A real worker ran end to end
in an isolated Fargate task with its own CPU and memory, opened a PR, and returned a
`RunRecord.parse`-valid record, and start, status, cancel, and result all worked. The local runner's
protocol carried over almost unchanged: the same image, agent scripts, parsing, brief, and report.
Cold start was 35–38 s, with a 14 s image pull, and Fargate's cost is negligible next to model spend.
No gap found is one that Daytona, E2B, or Runloop would close better. The real costs are the reviewer
checkout and attachment transport, the 64 KiB secret cap, and a `start` that must be resumable at
each AWS step so a failure strands no credentials (section 4); the spike's `start` now shows how.
