# Sergeant 2 hosting

One AWS host runs `serve` (the long-running service, `packages/sergeant/src/serve.ts`) for one
installation, behind that installation's permanent HTTPS endpoint. There is no release pipeline, no
image registry, and no second environment: the host checks out a git ref of this repository and runs it.

Nothing installation-specific is committed here, and nothing lives only on an operator's machine. Two
SSM parameters the operator writes hold it: Terraform's inputs and state location
(`/sergeant/v2/infrastructure-config`, read by `terraform/init.sh`) and the installation config the
host runs with (`/sergeant/v2/installation-config`). The repository holds examples only.

| Path | What it is |
|---|---|
| `terraform/` | The host: one Graviton instance (Ubuntu 24.04, `m7g.xlarge`) in the account's default VPC, an encrypted root and a separate encrypted data volume, an Elastic IP, the hostname's A record, a security group with 443 and 80 only, and an instance role with SSM core, its own log group, `ssm:GetParameter` and `ssm:PutParameter` on the config parameter (and an explicit deny on reading every other parameter, which SSM core would otherwise allow; the write is for an approver's `sgt admin repo add | remove`), and `secretsmanager:GetSecretValue` on exactly the listed secrets (four, or up to twelve with the webhook signing secrets, the Codex credential, and model accounts), and `secretsmanager:PutSecretValue` on only the registered-accounts secret, when one is configured. |
| `terraform/init.sh` | `EXPECTED_ACCOUNT_ID=<account> ./init.sh`: refuses unless the credentials are that account, then reads the infrastructure-config parameter, refuses any shape but the expected one, writes the auto-loaded `terraform.tfvars.json`, and runs `terraform init` against its state bucket (key fixed at `v2/terraform.tfstate`), allowing only that account. Run before every plan and apply. |
| `terraform/infrastructure-config.example.json` | The shape of that parameter, exactly: `backend` (the existing state bucket and its region, nothing else) and `variables` (only `variables.tf`'s variables, `account_id` the expected account). |
| `host/sergeant-update.sh` | `sergeant-update <ref>`: fetch a ref of the public source repository anonymously and run its `install.sh`. The first boot runs it once; every update afterwards is the same command. |
| `host/sergeant-autoupdate.sh`, `.service`, `.timer`, `.path` | Every 10 minutes, run `sergeant-update` to a newer green commit of `main` if the installation config's `release` setting asks for one (Automatic updates below); and at once, an approver's `sgt admin restart` or `update` (Restart or update with `sgt` below). |
| `host/install.sh` | Idempotent install from the checkout: packages (Docker, Node 24, Caddy, the `claude` CLI at the runner image's version), the data volume, the `sergeant` user, the runner image, dependencies, the config, and a restart of `serve`. |
| `host/installation.example.json` | The shape of the installation config (`InstallationConfig`; identifiers and secret references only). |
| `host/sergeant.service`, `Caddyfile`, `cloudwatch-agent.json`, `logrotate` | The systemd unit, the HTTPS proxy, log shipping, and log rotation. |

How it fits together:

- **No SSH and no personal credential on the host.** Operators reach it with SSM (Run Command or
  Session Manager). The source repository is public, so `sergeant-update` fetches it anonymously over
  HTTPS with no credential.
- **Secrets stay in Secrets Manager.** `serve` resolves the config's secret references with the
  instance role at startup, as it does on a laptop (`secretResolver`), and holds them in memory.
- **Runs cannot reach the instance role.** IMDSv2 is required with a hop limit of 1, so a Docker
  container, one hop further away, cannot get instance credentials. A run's container still gets only
  its task owner's registered model credential and, for a worker, its scoped worker-App token.
- **State is on the data volume** (`/var/lib/sergeant/state`: `tasks/`, `runs/`, `service.lock`). It
  survives an instance replacement and Terraform refuses to destroy it (`prevent_destroy`).
- **Only `/health`, `/v1`, and the two webhook endpoints are public.** `serve` listens on
  `127.0.0.1:8080`; Caddy terminates HTTPS for the hostname (Let's Encrypt over HTTP-01) and proxies
  `/v1` without granting trust to the proxy. `serve` checks a person's Linear bearer on every
  operational `/v1` call. `/status` remains loopback-only. Caddy
  also proxies `GET /health` and `POST /webhooks/linear` and `/webhooks/github` (bodies up to 1 MB),
  nothing else. `/health` answers only `{"ok":true}`, or 503 `{"ok":false}` while stopping or after a
  failed intake; active task ids and intake errors are on `/status`, which Caddy does not proxy. A webhook endpoint answers 404
  until the installation config names its signing secret, and 401 to any delivery whose signature
  does not verify.
- **The config lives in AWS.** Every install reads the SSM parameter (default
  `/sergeant/v2/installation-config`) and replaces `/etc/sergeant/installation.json` only if it parses
  as an `InstallationConfig`; a config that does not parse stops the update before `serve` restarts.
  Changing the per-task budget or the task slots (`maxTasks`, `waitingGraceMinutes`) is: edit the
  parameter, then update (or `sgt admin restart`). Enrolling or removing a repository needs neither
  (Enrolled repositories below).
- **Logs** go to `/var/log/sergeant/serve.log` and `autoupdate.log` on the host and to CloudWatch Logs
  group `/sergeant/v2` (streams `<instance id>/serve`, `<instance id>/autoupdate`, and
  `<instance id>/first-boot`).

## RUNBOOK

Commands run from `deploy/terraform` with `AWS_PROFILE` set to the installation's account and
`EXPECTED_ACCOUNT_ID` set to that account's id, unless they say they run on the host. The expected id
is the operator's, never the parameter's: `init.sh` checks the credentials against it before reading
anything, and the state backend and the provider refuse any other account.
`ID=$(terraform output -raw instance_id)`.

### Before the first apply

1. **Terraform inputs.** Write them (shape: `terraform/infrastructure-config.example.json`) to the
   infrastructure-config parameter, from a draft `terraform/infrastructure-config.json` (untracked):

   ```sh
   aws ssm put-parameter --name /sergeant/v2/infrastructure-config --type String --overwrite \
     --value file://infrastructure-config.json
   ```

   The state bucket already exists; this configuration never creates it. `secret_names` lists every
   secret the config refers to, and nothing else: four literal names, or up to seven with the webhook
   signing secrets (Webhooks below) and the Codex credential (A Codex reviewer below), which Terraform enforces. To change an input later, put the parameter again and rerun `./init.sh`.
2. **Secrets** exist in Secrets Manager under those names: both GitHub Apps' private keys, the Linear
   agent token, and the model token.
3. **Installation config.** Write it (shape: `host/installation.example.json`; field notes in
   the root `README.md`) to the installation-config parameter. The first boot refuses to start
   without it:

   ```sh
   aws ssm put-parameter --name /sergeant/v2/installation-config --type String --overwrite \
     --value file://installation.json
   ```

4. **Control-plane App** is installed on every enrolled repository.
5. **Enrolled repositories' rulesets**: the default branch requires a pull request and declares
   required status checks, and the worker App is not a bypass actor. Without required checks Sergeant
   never merges there (see the root `README.md`).
6. **Linear**: the token acts as the agent user in `linear.agentUserId` (`live-check` verifies it).
7. **Human login** for `sgt` (below): the config's `humans`, and the callback URL on the Linear app.

### Public human API and login for `sgt` (TECH-4938, TECH-4939)

People use `sgt` from a laptop with their own Linear login, never AWS credentials (root `README.md`,
The `sgt` CLI). `serve` runs without `--trust-loopback` here. Caddy publishes `/v1`, but every
operational call still needs an admitted Linear user; `/status` is not published. Once per
installation, configure all of the following before updating the host. If `humans` is absent,
`GET /v1/auth/config` returns 404 and every operational `/v1` route returns 401, including every
mutation:

1. In the installation's Linear workspace, open the V2 agent's OAuth application (Settings, API,
   OAuth applications) and add the callback URL `http://localhost:4546/callback`. Note its client id.
   `sgt login` uses PKCE with `actor=user` and the `read` scope, so no client secret is involved and
   nothing new goes in Secrets Manager.
2. Add `humans` to the installation-config parameter: `linearClientId` (that client id, which is
   public), `teams` (the keys of the Linear teams whose members may use Sergeant), and `approvers`
   (Linear user ids of members of those teams). Then update.
3. Update the host so it rereads the installation config and installs the Caddyfile.
4. From a laptop with no AWS session or credentials, point `sgt` at the permanent HTTPS endpoint and
   sign in. `whoami` must name that person, and task listing must succeed:

   ```sh
   export SGT_API_URL=https://<hostname>
   sgt login
   sgt whoami
   sgt task list
   ```

5. From a logged-out shell, check every published operational route. Each must return `401`; the
   three POSTs must not change a task or run. Placeholder ids are sufficient because authentication
   happens before resource lookup or body parsing. Each call names a current `sgt` version, since
   `serve` refuses one that names none with `400` before it checks the login (TECH-5188):

   ```sh
   api=https://<hostname>
   v="Sergeant-Cli-Version: $(sgt --version | cut -d' ' -f2)"
   for path in /v1/whoami /v1/tasks /v1/tasks/NOT-A-TASK /v1/runs /v1/runs/not-a-run /v1/runs/not-a-run/report; do
     test "$(curl -sS -o /dev/null -w '%{http_code}' -H "$v" "$api$path")" = 401 || exit 1
   done
   for path in /v1/tasks/NOT-A-TASK/wake /v1/tasks/NOT-A-TASK/cancel /v1/runs/not-a-run/cancel; do
     test "$(curl -sS -o /dev/null -w '%{http_code}' -H "$v" -X POST "$api$path")" = 401 || exit 1
   done
   ```

`GET /v1/auth/config` is the sole unauthenticated `/v1` exception: `sgt login` needs the public
`linearClientId` from it. It exposes no task, run, user, or installation-admin data.

### Webhooks

Webhooks only make Sergeant notice a Linear or GitHub change sooner; without them every change is
still found by the intake (2 minutes) and each task's poll (1 minute). Set them up once per
installation, in this order, and expect deliveries made in between to fail harmlessly:

1. **Secrets.** Create two Secrets Manager secrets: the GitHub one with a value you generate
   (`openssl rand -hex 32`), and the Linear one, whose value is the signing secret Linear shows for the
   app's webhook (step 5; put a placeholder until then and set the real value with
   `aws secretsmanager put-secret-value`).
2. **Terraform.** Add both names to `secret_names` in the infrastructure-config parameter, then
   `./init.sh`, plan, and apply: only the instance role's secrets policy changes.
3. **Installation config.** Add `linear.webhookSecret` and `github.webhookSecret` (the two secret
   names) to the installation-config parameter.
4. **Update** the host (Update below): it installs the Caddyfile that publishes the webhook paths and
   restarts `serve`, which reads the secrets at startup. Run it again after any secret value changes.
5. **Linear.** In the V2 agent's Linear OAuth app settings, point the app's webhook at
   `https://<hostname>/webhooks/linear` (re-point it if it still targets an earlier endpoint, such as
   Sergeant 1's), enable it, and subscribe to issues, comments, and issue attachments; an agent app
   also gets agent session events. Copy its signing secret into the Linear secret, then update again.
6. **GitHub.** In the control-plane App's settings, make its webhook active with URL
   `https://<hostname>/webhooks/github` and the GitHub secret's value, and subscribe to Pull request,
   Pull request review, Pull request review comment, Issue comment, Check run, Check suite, Push, and
   Status events (its existing permissions cover them). Review and comment events only shorten the
   wait: polling reads human PR feedback either way.
7. **Check** each one's recent deliveries: Linear's webhook page and the App's Advanced tab should show
   `200`. A `401` means the secret differs (serve logs `bad signature`) or, for Linear, the delivery is
   over a minute old (serve logs `stale webhookTimestamp`: check the host's clock); a `404`, that the
   config does not name the secret or the host was not updated.

### A Codex reviewer

Reviews can come from Codex while workers stay on Claude Code (TECH-5009; details and the secret's
format in `packages/runner/README.md`, under Codex):

1. **Secret.** Store the installation's Codex Team login (or a Terros-owned OpenAI API key) in a new
   Secrets Manager secret, for example `sergeant/<installation>/codex-credential`.
2. **Terraform.** Add its name to `secret_names` in the infrastructure-config parameter, then
   `./init.sh`, plan, and apply: only the instance role's secrets policy changes.
3. **Installation config.** Add `"runners": { "reviewer": "codex-local" }` and
   `"codex": { "credentialSecret": "<the secret name>", "model": "<Codex model>" }`, put the parameter,
   then Update: it rebuilds the runner image, which carries the Codex CLI, and restarts `serve`.
4. **Check** on the host (Live check on the host below): `node src/live-check.ts --config … --repo …`
   in `packages/sergeant` now ends with `PASS codex reads the installation's credential`, and
   `node src/live-check.ts --adapter codex-local` in `packages/runner` shows only `CODEX_CREDENTIAL`
   and `GH_TOKEN` entering. Then let one controlled task reach review: its reviewer run's record
   (`/var/lib/sergeant/state/runs/<run>/record.json`) says `"provider": "openai/codex"` and has `tokens`.

To go back, remove `runners` (or set the role to `claude-code-local`) and update.

### Model accounts: each task's owner pays (TECH-5179)

Workers and reviewers run only on model accounts people register with `sgt`, and each task only on its
owner's: the issue's human assignee, who must also be the one who delegated it to Sergeant
(`packages/sergeant/src/owner.ts`); reassigning the issue hands it off: the runs stop, PRs and branches
are kept, and the issue goes back to Todo, undelegated, for the new assignee to continue or delegate
(`cancel.ts`). The model token is
Sergeant's system account: it runs reasoning, retros, and system-health work only, never a worker or
reviewer (not even the post-merge audit), so Sergeant can still tell an owner what is wrong when their
accounts are spent. The config's `modelAccounts` (TECH-5113) is ignored, with a warning at startup:
remove it, and have each person register their own subscription, personal or company-paid
(TECH-5198). Each launch runs on the owner's usable account
whose quota is furthest ahead of its weekly and 5-hour reset schedule (`packages/runner/README.md`). Every run records its `account`, and `sgt account list` shows
what each one paid for. An owner with no registered account, or none usable, gets a comment on the
issue saying what to do, and nothing starts.

1. **Registration is required.** Without it no run can start.
 Create one secret with the value `{"accounts":[]}`, for example
   `sergeant/<installation>/registered-accounts`; add its name to `secret_names` and set
   `registered_accounts_secret` to it in the infrastructure-config parameter (`./init.sh`, plan, apply:
   the role may then put that secret's value, and only that one's); and set the installation config's
   `registeredAccountsSecret` to it. Update.
2. **Check.** Someone in `humans.teams` runs `sgt account register claude` (or `codex`), which signs
   them in with the provider's own CLI: it answers with the quota it read with the credential, and
   `sgt account list` shows the account as theirs. They remove it with `sgt account remove claude`. The secret then holds every registered credential:
   treat it as the model token, readable by this host's role only.

### Taking over from Sergeant 1 (DNS)

V2 never creates or destroys the hosted zone (a data source). If an A record for the hostname already
exists, as Sergeant 1's did, the `import` block in `main.tf` takes it over on the first apply and
points it at V2's Elastic IP; with no existing record, remove that block for the first apply. When the
zone and record were Sergeant 1's, remove both from Sergeant 1's state **before** it is destroyed, so
its destroy leaves them in place. From a checkout of `v1-final`, in `deploy/terraform` with that
installation's backend configuration:

```sh
terraform state rm 'aws_route53_record.public_api[0]' aws_route53_zone.sergeant
```

Run no Sergeant 1 `apply` after V2's first apply: it would point the record back at its own address.

### Apply

```sh
EXPECTED_ACCOUNT_ID=<account> ./init.sh   # the inputs and state location, from the parameter
terraform plan -out tfplan     # first apply: the A record import (if any) and 10 new resources
terraform apply tfplan
```

`ami` and `user_data` are ignored after creation, so a newer Ubuntu image or an edited first-boot
template never replaces the running host; the values written to `/etc/sergeant/host.env` (hostname,
source repository, config parameter) are fixed then too. To change them, or to deliberately rebuild
the host, `terraform apply -replace=aws_instance.host`; the data volume and its state are reattached.

### Bootstrap

The first boot runs `sergeant-update <initial_ref>` (`main` by default) through cloud-init. It takes
several minutes (packages, the runner image, `pnpm install`), then waits for `/health`. Follow it:

```sh
aws logs tail /sergeant/v2 --follow --log-stream-name-prefix "$ID/first-boot"
```

If it stopped (the config parameter missing or invalid, say), fix the cause and run an update. Caddy
obtains the certificate once the A record resolves to the Elastic IP.

### Update

Move the host to a branch, tag, or commit, reread the config parameter, and restart `serve`. An
approver does this with `sgt admin update [<ref>]` or `sgt admin restart` and no AWS access (Restart or
update with `sgt` below); the operator's equivalent over SSM is:

```sh
CMD=$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
  --parameters 'commands=["/usr/local/sbin/sergeant-update main"],executionTimeout=["3600"]' \
  --query Command.CommandId --output text)
aws ssm wait command-executed --command-id "$CMD" --instance-id "$ID"
aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" \
  --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
```

The restart sends SIGTERM: `serve` stops intake and ends each task at its next poll (up to 15
minutes, then systemd kills it). Running worker and reviewer containers keep running and the new
process picks them up from the state dir. `cat /etc/sergeant/release` on the host shows the deployed
ref and commit. To roll back, update to the previous commit; with automatic updates on, first pause
them or remove `release` (Automatic updates, Pin or roll back), or the next tick moves the host
forward again.

**Rolling back over a task's saved state (TECH-5163).** From TECH-5163 on, a release keeps the
`state.json` keys it does not know and saves them back, so a later rollback leaves a newer release's
state for it to finish once the host moves forward. A commit from before TECH-5163 drops them the
first time it saves the task, and moving forward again does not bring them back. The one that matters
is `accepted` (TECH-5136, from #90): a task saved with it has taken its accepting turn and only
replays its ending (resolve the question thread, post the acknowledgment, set `state.json` aside),
usually within a poll. Code from before TECH-5136 drops it and, since that turn's fingerprint is
committed, neither takes the turn again nor ends the task: it sits idle with no acknowledgment and no
`accepted.json`. So before updating to a commit from before TECH-5136, on the host:

```sh
sudo grep -l '"accepted"' /var/lib/sergeant/state/tasks/*/state.json
```

Wait until it lists nothing (a task that stays listed for several polls is failing to resolve or
post: see its log), then roll back. A task stranded anyway is recovered with `sgt task wake <issue>`:
the old code takes a fresh turn, and if reasoning accepts again it ends the task as that code did.
If it does not, the issue is left for a human, who can post the acknowledgment and finish the task.

### Restart or update with `sgt` (TECH-5195)

An approver (`humans.approvers`), signed in with `sgt login`, restarts or updates the host with no AWS
access:

```sh
sgt admin restart          # reread the installation config, restart serve on the release it runs
sgt admin update           # move to what the release channel would choose (main's green head without one)
sgt admin update v2.1.0    # or to a branch, tag, or commit: only a commit on main whose v2 check passed
sgt admin status           # the release, when serve started, the last restart or update, and whether
                           # the installation-config parameter changed since serve started
```

`restart` and `update` each print the outcome when the host has one, including why it failed, waiting
out serve's restart (up to 45 minutes). `status` compares the installation-config parameter's version
`serve` has (the one it started with, moved on only by its own `sgt admin repo` changes) with the
parameter's version now; when they differ, the config changed in AWS since serve's last install, and
it says to run `sgt admin restart`. Serve runs `/etc/sergeant/installation.json` from that install, so
one systemd restarts (after a crash, say) has the version install.sh recorded beside it in
`installation.json.version`, unless that copy matches the parameter but for `repositories`. An `update` with nothing newer to install leaves serve running on its old
config, and says the same. `serve` runs nothing privileged: it logs who asked and leaves
one request, `/var/lib/sergeant/state/admin-request.json`. One action at a time: another request is
refused (409) while that one waits or the host's latest outcome is still running (an outcome left
running by a host that stopped mid-update is marked interrupted by the next tick, within 10 minutes).
The host keeps only its latest outcome, so if an automatic update replaces yours before `sgt` reads
it, `sgt` says so and exits 1. `sergeant-autoupdate.path` starts the same `sergeant-autoupdate`
service the timer does, as root, so a request never overlaps a tick. It removes the request, checks it
again, and runs `sergeant-update`: on the release the host is on for `restart`, so `install.sh`
rereads the config and restarts `serve`, or on the commit for `update`, resolved and checked against
GitHub anonymously like a tick. An update whose install fails after checking out its commit
reinstalls the previous release and records the commit in `/etc/sergeant/autoupdate-failed`, as a
tick does; an approver's update ignores that file, so naming the commit again retries it. A `paused`
release setting does not stop an approver's update, which is how to pin (Pin or roll back below). The
restart is the usual graceful one (Update above): running worker and reviewer containers keep running.

Every outcome, an approver's or an automatic update's, with who asked, is written to
`/etc/sergeant/admin-result.json` and logged to `autoupdate.log`; `serve.log` names who asked for each
request. Nothing new in AWS: no person gets AWS access and the instance role is unchanged. `serve`
offers `/v1/admin` only on a host where `sergeant-update` has written `/etc/sergeant/release`.

### Automatic updates (TECH-4959)

A systemd timer runs `sergeant-autoupdate` every 10 minutes. Each tick rereads the installation-config
parameter's `release` setting and, at most, runs `sergeant-update <sha>`:

| `release` | The host moves to |
|---|---|
| absent | nothing: it never updates itself |
| `{"channel": "main"}` | `main`'s head, once the `v2` check passed on that exact commit |
| `{"channel": "soaked", "soakMinutes": 90}` | the newest `main` commit whose `v2` run passed and was started by its push to `main` at least `soakMinutes` ago, if it is newer than the host's |
| either, with `"paused": true` | nothing, until `paused` is removed |

Which channel an installation follows is its own choice, made only in its own config parameter. A
red, running, or missing check never deploys; a soaked host compares times, not other hosts.
A tick does nothing while `sergeant-update` runs. If an update fails after checking out its commit,
the tick reinstalls the previous release and records the commit in `/etc/sergeant/autoupdate-failed`,
which later ticks skip until a newer commit qualifies (delete the file to retry it). Each tick logs
its decision to `/var/log/sergeant/autoupdate.log` (stream `<instance id>/autoupdate`); `systemctl
list-timers sergeant-autoupdate` shows the next tick.

Every install puts the timer in place, so an existing host gets it from one ordinary Update to a
commit that has it. Then set the release setting, choosing one channel:

```sh
aws ssm get-parameter --name /sergeant/v2/installation-config --query Parameter.Value --output text |
  jq '.release = {"channel": "main"}' >installation.json
# or: jq '.release = {"channel": "soaked", "soakMinutes": 90}'
aws ssm put-parameter --name /sergeant/v2/installation-config --type String --overwrite \
  --value file://installation.json
```

The next tick uses it; no update is needed. The same edit with `jq '.release.paused = true'` pauses
and `jq 'del(.release.paused)'` resumes.

**Pin or roll back.** Between two commits that both know `release` (TECH-4959 or later), pause, then
Update to the commit you want (`sgt admin update <commit>` when it is a green commit on main); resume to
unpin. A commit from before TECH-4959 rejects the unknown
`release` key, so its update stops at the config check without restarting `serve`. Before updating
to one, remove the setting entirely with the same edit and `jq 'del(.release)'` (pausing is not
enough); set it again once the host is back on a commit that knows it.

Sergeant's version comes from git, not `package.json`: the nearest `vMAJOR.MINOR.PATCH` tag, plus
the commits since it, plus the short SHA (`v2.0.0` and 37 commits later at `aad6046` is
`2.0.37+aad6046`). `sgt -v`, `/status`, and the update log all report it. Every commit on `main`
gets a higher number by itself; minor and major bumps are deliberate: a human tags `v2.1.0` (or
`v3.0.0`) on `main`, and counting restarts there. Without a tag or the history to count (a shallow
clone, no git), the version is `0.0.0+<sha>` and the update log says why; that never fails an update.

### Enrolled repositories (TECH-5193)

An approver runs `sgt admin repo add <owner/name> [--merge-method …]` or `sgt admin repo remove
<owner/name>` with their own Linear login; anyone signed in runs `sgt repo list`. `serve` refuses
a repository either GitHub App cannot reach, then rewrites the installation-config parameter (only its
`repositories`; the new version's description names the approver: `aws ssm get-parameter-history`)
and takes the list in place, without a restart; `serve.log` names the approver too. A repeated change
the parameter already has writes nothing and only brings the running list up to it. `serve` reads its
enrolled repositories from the parameter at every start, so no restart brings back an older list; it
does not start if it cannot read the parameter. Every other setting stays AWS-only, applied by an
update as before, and never appears in an answer or a log. The host's role may write that one
parameter and no other. Editing `repositories` in the parameter by hand still works.

A host gets this from an apply of the instance role's `WriteInstallationConfig` statement and one
Update to a commit that has it (the unit then reads `SERGEANT_CONFIG_PARAMETER` from
`/etc/sergeant/host.env`). Until both, `add` and `remove` answer with why they cannot.

### Change the per-task budget

The installation config's `budget` is the window each task gets when it starts; without it, 120
minutes and $25 (root `README.md`, under Commands). Add or change it in your `installation.json`, for
example `"budget": { "minutes": 45, "usd": 10 }`, put the parameter, then run an Update (above):

```sh
aws ssm put-parameter --name /sergeant/v2/installation-config --type String --overwrite \
  --value file://installation.json
```

Only tasks that start after the update get the new window. A task already running keeps the one it
started with (the log says `ignoring the budget options`); only a human's "extend" reply enlarges it.

### Change the task slots

The installation config's `maxTasks` (default 2) is how many task slots `serve` fills, and
`waitingGraceMinutes` (default 15) how long a waiting task keeps its slot before the next
task in order gets it (root `README.md`, Intake under Commands). Add or change them in your
`installation.json`, for example `"maxTasks": 4`, put the parameter, then run an Update (above):

```sh
aws ssm put-parameter --name /sergeant/v2/installation-config --type String --overwrite \
  --value file://installation.json
```

The unit file no longer passes `--max-tasks`, so the config is the single source; an explicit flag
would still win over it. Terros's hosts run 4 tasks through a stopgap systemd drop-in that overrides
`ExecStart` with `--max-tasks 4`. Once the config says `"maxTasks": 4` and an install with this change
has run, find the drop-in with `systemctl cat sergeant` (the file under
`/etc/systemd/system/sergeant.service.d/` that sets `ExecStart`), delete it, and reload, so the config
and the unit file's own `ExecStart` apply:

```sh
systemctl cat sergeant                                   # shows the drop-in's path
sudo rm /etc/systemd/system/sergeant.service.d/<drop-in>.conf
sudo systemctl daemon-reload && sudo systemctl restart sergeant
systemctl cat sergeant | grep ExecStart                  # no --max-tasks
```

### Live check on the host

Open a shell with `aws ssm start-session --target "$ID"` (needs the Session Manager plugin), then:

```sh
cat /etc/sergeant/release
systemctl status sergeant caddy --no-pager
curl -fsS "https://$(sed -n 's/^SERGEANT_HOSTNAME=//p' /etc/sergeant/host.env)/health"   # {"ok":true}, nothing more
curl -fsS http://127.0.0.1:8080/status   # loopback only: active tasks and the latest intake

# Identities, permissions, and an enrolled repository's rules (writes nothing, spends nothing).
sudo -u sergeant -H bash -c 'cd /opt/sergeant/src/packages/sergeant &&
  node src/live-check.ts --config /etc/sergeant/installation.json --repo <owner/name> [--issue <controlled issue>]'

# What a run's container sees: no host credentials, and no instance role (this must time out).
sudo -u sergeant -H bash -c 'cd /opt/sergeant/src/packages/runner && node src/live-check.ts'
sudo docker run --rm sergeant-runner:local curl -sS -m 5 -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 60'
```

Then delegate a small controlled issue to the V2 agent and watch `serve.log`: the next intake (within
two minutes) admits it. The per-feature live checks in the root `README.md` apply to `serve` as they
do to `canary`; the service's per-task state is `/var/lib/sergeant/state/tasks/<issue>/`.

### Logs

```sh
aws logs tail /sergeant/v2 --follow --log-stream-name-prefix "$ID/serve"
aws logs tail /sergeant/v2 --since 1h --log-stream-name-prefix "$ID/autoupdate"
```

On the host: `tail -f /var/log/sergeant/serve.log`, `journalctl -u sergeant -u caddy`, run records
under `/var/lib/sergeant/state/runs/`, and `sudo docker ps --filter label=sergeant.run`.

### Stop

`sudo systemctl stop sergeant` on the host stops intake and ends each task at its next poll; running
containers are left alone. `sudo systemctl start sergeant` resumes from the state dir.
