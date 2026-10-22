# Sergeant 2 hosting

One AWS host runs `serve` (the long-running service, `packages/sergeant/src/serve.ts`) for one
installation, behind that installation's permanent HTTPS endpoint. There is no release pipeline and no
second environment: the host checks out a git ref of this repository and runs it. The one registry is
for workers on Fargate: each install pushes the runner image it built there (Workers on Fargate below).

Nothing installation-specific is committed here, and nothing lives only on an operator's machine. Two
SSM parameters the operator writes hold it: Terraform's inputs and state location
(`/sergeant/v2/infrastructure-config`, read by `terraform/init.sh`) and the installation config the
host runs with (`/sergeant/v2/installation-config`). The repository holds examples only.

| Path | What it is |
|---|---|
| `terraform/` | The host: one Graviton instance (Ubuntu 24.04, `m7g.xlarge` by default; smaller with workers on Fargate) in the account's default VPC, an encrypted root and a separate encrypted data volume, an Elastic IP, the hostname's A record, a security group with 443 and 80 only, and an instance role with SSM core, its own log group, `ssm:GetParameter` and `ssm:PutParameter` on the config parameter (and an explicit deny on reading every other parameter, which SSM core would otherwise allow; the write is for an approver's `sgt admin repo add | remove`), and `secretsmanager:GetSecretValue` on exactly the listed secrets (four, or six with the webhook signing secrets, plus an adopted registered-accounts secret if it stays listed); and the registered-accounts secret (`{"accounts":[]}` at first, an existing one adopted), with `secretsmanager:GetSecretValue` and `secretsmanager:PutSecretValue` on only it. |
| `terraform/fargate.tf` | Workers on ECS Fargate (TECH-5237): the runner image's ECR repository, the `sergeant-v2-runs` cluster and security group (no ingress), the `/sergeant/v2/runs` log group, the tasks' execution role (it reads only `sergeant/runs/*` secrets, pulls the image, and writes the run logs; there is no task role), the host's permissions to run, stop, and collect tasks, and the `/sergeant/v2/fargate-runner` parameter telling the host where they run. Workers use it only once the installation config says so. |
| `terraform/init.sh` | `EXPECTED_ACCOUNT_ID=<account> ./init.sh`: refuses unless the credentials are that account, then reads the infrastructure-config parameter, refuses any shape but the expected one, writes the auto-loaded `terraform.tfvars.json`, and runs `terraform init` against its state bucket (key fixed at `v2/terraform.tfstate`), allowing only that account. Run before every plan and apply. |
| `terraform/infrastructure-config.example.json` | The shape of that parameter, exactly: `backend` (the existing state bucket and its region, nothing else) and `variables` (only `variables.tf`'s variables, `account_id` the expected account). |
| `host/sergeant-update.sh` | `sergeant-update <ref>`: fetch a ref of the public source repository anonymously and run its `install.sh`. The first boot runs it once; every update afterwards is the same command. |
| `host/sergeant-autoupdate.sh`, `.service`, `.timer`, `.path` | Every 10 minutes, run `sergeant-update` to a newer green commit of `main` if the installation config's `release` setting asks for one (Automatic updates below); and at once, an approver's `sgt admin restart` or `update` (Restart or update with `sgt` below). |
| `host/install.sh` | Idempotent install from the checkout: packages (Docker, Node 24, Caddy, the `claude` CLI at the runner image's version), the data volume, the `sergeant` user, the runner image, dependencies, the config, and a restart of `serve`. |
| `host/install-config.sh` | Run by `install.sh`: the installation config from its parameter, validated and staged, installed only once the runner image and `/etc/sergeant/fargate-runner.json` a Fargate config needs are ready (Workers on Fargate below). |
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
  survives an instance replacement and Terraform refuses to destroy it (`prevent_destroy`). A run's
  `workspace/` checkout is removed when the run ends, and `serve` removes any ended run's workspace
  left behind each time it starts (TECH-5229); the run's records and report stay. `sgt admin status`
  shows the `runs/` directory's size and the volume's free space.
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
  parameter, then update (or `sgt admin restart`). Enrolling or removing a repository, or setting a
  repository's own budget, needs neither (Enrolled repositories below).
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
   secret the config refers to, and nothing else: four literal names, or up to six with the webhook
   signing secrets (Webhooks below), seven with the public-data denylist (`publicDataDenylistSecret`
   below), eight with the CI rerun App's key (`github.ciRerunApp` below), and nine if an adopted
   registered-accounts secret stays listed, which Terraform enforces. Codex needs no secret here (A Codex reviewer below).
   The registered-accounts secret is not one of them: Terraform creates it (Model accounts below).
   To change an input later, put the parameter again and rerun `./init.sh`.
2. **Secrets** exist in Secrets Manager under those names: both GitHub Apps' private keys, the Linear
   agent token, and the model token.
3. **Installation config.** Write it (shape: `host/installation.example.json`; field notes in
   Installation config below) to the installation-config parameter. The first boot refuses to start
   without it:

   ```sh
   aws ssm put-parameter --name /sergeant/v2/installation-config --type String --overwrite \
     --value file://installation.json
   ```

4. **Control-plane App** is installed on every enrolled repository.
5. **Enrolled repositories' rulesets**: the default branch requires a pull request and declares
   required status checks, and the worker App is not a bypass actor. Without required checks Sergeant
   never merges there (GitHub Apps and rulesets below, which has a ruleset to copy).
6. **Linear**: the token acts as the agent user in `linear.agentUserId` (`live-check` verifies it).
7. **Human login** for `sgt` (below): the config's `humans`, and the callback URL on the Linear app.
8. **Delegations through Linear's MCP connector** (optional): set `linear.delegatingAppIds` when
   anyone works through an assistant that delegates issues to Sergeant with Linear's MCP connector.
   Without it, Sergeant refuses every issue an assistant delegates (or creates already delegated)
   through the connector, commenting that Linear's history does not show the assignee delegating it.
   The connector uses one global OAuth client id, the same in every Linear workspace
   (`f69dcc4d4c3c994d8f7f1475b2b23a11`, confirmed in two workspaces), so the installation config
   usually needs only:

   ```json
   "linear": { "delegatingAppIds": ["f69dcc4d4c3c994d8f7f1475b2b23a11"] }
   ```

   To confirm the id, read the `botActor.id` on a delegation the connector made (the issue's history
   in Linear's API), or Sergeant's refusal comment on such an issue, which names the app and its id
   (TECH-5321): "delegated through the app … (id `…`)". How an app's delegation is matched to the
   assignee, and its known issue (TECH-5280), are in
   [`docs/design/07-linear-contract.md` §5](../docs/design/07-linear-contract.md#5-intake-and-admission),
   item 8: list only apps you trust to report the user they acted for. A flagged match logs a
   `warning:` line and is noted as `owner.warning` in the task's `state.json`. On an
   existing installation, add the field to the installation-config parameter, then restart or update
   (Restart or update with `sgt` below); an issue refused before then needs delegating again.

### Public human API and login for `sgt` (TECH-4938, TECH-4939)

People use `sgt` from a laptop with their own Linear login, never AWS credentials
([`docs/sgt.md`](../docs/sgt.md)); the API's rules are under The client API below. `serve` runs without `--trust-loopback` here. Caddy publishes `/v1`, but every
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

   Someone who uses more than one installation picks it by URL ([`docs/sgt.md`](../docs/sgt.md) §3).
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

**On an existing installation** set up before `humans`, the same steps apply, with these differences:

- The OAuth application may already list `http://localhost:4546/callback` (another installation
  sharing the app, or an earlier attempt); then leave it. Its client id is on the same page, under
  Settings, API, OAuth applications.
- `teams` takes team keys (the prefix of the team's issue identifiers, such as `ENG`), not team names
  or ids. `approvers` takes Linear user ids from this installation's own Linear workspace: the same
  person has a different id in every workspace, and an id from another one never matches.
- Until `humans` is live, `sgt admin` cannot sign in, so step 3's update goes over SSM (Update below).
- It is live once `GET /v1/auth/config` answers `200` with `{"linear":{"clientId":"…"}}` instead of
  `404`:

  ```sh
  curl -sS -H "Sergeant-Cli-Version: $(sgt --version | cut -d' ' -f2)" https://<hostname>/v1/auth/config
  ```

### Webhooks

Webhooks are Sergeant's primary signal, and polling only their backup (TECH-5942): how often a task
polls is under The service below, and it does not change when deliveries stop, since falling back to
fast polling would multiply Linear and GitHub load at the worst time. Without webhooks every change
is still found, but up to 15 minutes late. `sgt admin status` shows each source's deliveries and whether it is delivering
(one accepted in the last 30 minutes); a source refused 5 times in a row, or with no delivery accepted for 6 hours (its secret configured but never
delivered to included), is logged once as `WARNING: <source> webhook: ...` and shown there as an
alert until a delivery is accepted. Set them up once per installation, in this order, and expect
deliveries made in between to fail harmlessly:

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
   `200`, serve logs `<source> webhook: first delivery accepted`, and `sgt admin status` shows the
   source `delivering`. A `401` means the secret differs (serve logs `bad signature`) or, for Linear, the delivery is
   over a minute old (serve logs `stale webhookTimestamp`: check the host's clock); a `404`, that the
   config does not name the secret or the host was not updated.

A host that slowed polling itself through a systemd drop-in overriding `ExecStart` with
`--poll-seconds 900` no longer needs it once an install with TECH-5942 has run: the default already
polls every 15 minutes, and the drop-in would also slow the polls that must stay fast (a run in flight,
a mergeability being computed, a merge retry). Find it with `systemctl cat sergeant`, delete it, and
reload, as for `--max-tasks` below, then check that `systemctl cat sergeant | grep ExecStart` shows no
`--poll-seconds`.

### A Codex reviewer

Registering a Codex account is all it takes (TECH-5390): there is no installation setting to turn
Codex on. Every installation accepts `sgt account register codex` as well as `claude`, and the runner
image always carries both CLIs. Codex runs, like every run, use only the task owner's registered
accounts (Model accounts below); the installation has no Codex credential (TECH-5184). Details are in
`packages/runner/README.md`, under Codex.

Which provider works and which reviews is chosen for each run from the owner's registered accounts and
their live quota ([`docs/design/04-runner-contract.md` §10](../docs/design/04-runner-contract.md#10-adapters),
Provider by quota; the `sergeant:codex` label forces Codex for that issue's workers, TECH-5084). There
is no setting for either choice: an older config's `runners.worker`/`runners.reviewer` is ignored, and
serve logs a deprecation warning for it.

- **Model.** Codex runs `gpt-5.6-sol`, the model the installations ran before it became the default,
  unless the config's optional `"codex": { "model": "<Codex model>" }` names another. `serve`'s
  `--worker-model`/`--reviewer-model` name only Claude Code's model for that role.
- **Check** on the host (Live check on the host below): `node src/live-check.ts --adapter codex-local`
  in `packages/runner` shows only `CODEX_CREDENTIAL` and `GH_TOKEN` entering. Then let one controlled
  task whose owner registered a Codex account reach review: its reviewer run's record
  (`/var/lib/sergeant/state/runs/<run>/record.json`) says `"provider": "openai/codex"`, `"model":
  "gpt-5.6-sol"` (or the config's `codex.model`), and has `tokens`. This only confirms the default
  after the update; nothing else needs changing.

To stop a person's runs using Codex, they remove their Codex account (`sgt account remove codex`).

### Workers on Fargate (TECH-5237)

Workers can run as one ECS Fargate task each, with their own 2 vCPU and 8 GiB, so they stop
competing with the host for CPU and memory. Reviewers stay on the host. How a run works is in
`packages/runner/README.md`, under Fargate. A new installation and an existing one take the same
steps, in this order; each one needs the one before it.

1. **Apply** (Apply above). The plan adds `terraform/fargate.tf`'s resources and an inline policy on
   the host's role, and changes the host's deny on other parameters to let it read
   `/sergeant/v2/fargate-runner`. Nothing is imported: the TECH-5231 spike's hand-made resources
   (ECR `sergeant-runner`, cluster `sergeant-fargate-spike`, log group `/sergeant/fargate-spike`, role
   `sergeant-fargate-spike-exec`, security group `sergeant-fargate-spike`) have other names and are
   deleted by hand once workers run here.
2. **Update** the host (Update below). The install now pushes the runner image it built to
   `sergeant-v2-runner`, tagged by the installed commit, and writes `/etc/sergeant/fargate-runner.json`
   (`pushed the runner image to …` in its output). Workers still run on the host. On an installation
   whose config has no `humans` yet, `sgt admin update` cannot sign in: run this update over SSM
   (`sergeant-update main`, the operator's command under Update).
3. **Turn it on.** Add `"workerBackend": "fargate"` to the installation config's `runners`, put the
   parameter, and update (or `sgt admin restart`). `serve` logs `workers run on Fargate; Fargate image …`
   at startup (`grep 'workers run on' /var/log/sergeant/serve.log | tail -1` on the host, or the
   `<instance id>/serve` log stream; `workers run on this host` means the config did not take), and
   refuses to start if `/etc/sergeant/fargate-runner.json` is missing. From then on an
   install whose push fails stops before installing the new config or restarting `serve`, so the
   previous installation stays on disk (`host/install-config.sh`, TECH-5273).
4. **Live check.** Let one controlled worker run start. Its `runs/<run>/run.json` says
   `"backend": "fargate"`, and `launch.json` names its task. While it runs:

   ```sh
   aws ecs describe-tasks --cluster sergeant-v2-runs --tasks <taskArn> --query 'tasks[0].{status: lastStatus, cpu: cpu, memory: memory}'
   aws secretsmanager list-secrets --filters Key=name,Values=sergeant/runs/ --query 'SecretList[].Name'   # this run's only
   aws ecs describe-task-definition --task-definition <taskDefinitionArn from launch.json> \
     --query 'taskDefinition.{taskRole: taskRoleArn, secrets: containerDefinitions[0].secrets}'  # no task role; valueFrom only
   ```

   Once it ends, its `record.json` has its status, `costUsd`, and report, and the secret list is
   empty. Then stop a second controlled task while its worker runs (`sgt` or undelegating it): the run
   records `canceled` once ECS shows its task `STOPPED` (`UserInitiated`), and its secret is gone.

To go back, remove `workerBackend` (or set it to `local`) and update: new workers start on the host,
and runs already on Fargate are still read, stopped, and collected there.

**A smaller host.** With workers on Fargate the host runs only `serve`, reasoning, the reviewer
containers, and each install's runner-image build, so the default `m7g.xlarge` (sized for workers on
the host) is more than it needs. `t4g.large` (2 vCPU, 8 GiB) is enough; 4 GiB is too tight for a
reviewer installing a monorepo's dependencies. Set `instance_type` in the infrastructure-config
parameter, `./init.sh`, plan, and apply: the plan changes the instance in place, which AWS does by
stopping and starting it, so `serve` is down for a few minutes and restarts at boot; the Elastic IP,
the data volume, and the state on it are kept. Go back to a larger type before turning Fargate off.

A worker's brief, the issue's files, and its two credentials travel in its secret, which Secrets
Manager caps at 64 KiB: files that do not fit are left out and named in the brief as not downloaded,
and a brief that does not fit alone fails the start with an error saying so.

### Model accounts: each task's owner pays (TECH-5179)

Workers and reviewers run only on model accounts people register with `sgt`, and each task only on its
owner's (who that is, and the handoff when the issue is reassigned, are in
[`docs/design/07-linear-contract.md` §5](../docs/design/07-linear-contract.md#5-intake-and-admission)
and §8). The model token is
Sergeant's system account: it runs reasoning, retros, and system-health work only, never a worker or
reviewer (not even the post-merge audit), so Sergeant can still tell an owner what is wrong when their
accounts are spent. Each person registers their own subscription, personal or company-paid
(TECH-5198); the installation config has no model accounts or Codex credential of its own, and a
config that still names `modelAccounts` or `codex.credentialSecret` does not parse (TECH-5184).
Which of the owner's accounts a launch uses is in
[`docs/design/04-runner-contract.md` §10](../docs/design/04-runner-contract.md#10-adapters). Every run records its `account`, and `sgt account list` shows
what each one paid for. An owner with no registered account, or none usable, gets a comment on the
issue saying what to do, and nothing starts.

1. **Registration is required.** Without it no run can start, and it works out of the box
   (TECH-5204): Terraform creates the secret `registered_accounts_secret` names
   (`sergeant/v2/registered-accounts` by default) with the value `{"accounts":[]}`, lets the role
   read and put that secret's value, and only that one's, and the first boot gives its name to the
   host, where `serve` uses it unless the installation config sets `registeredAccountsSecret`.
   Terraform never changes the value afterwards: the host owns it, and the initial value stays in
   a version labelled `sergeant-initial`, never current once someone registers.
   - **A host first booted before TECH-5204** never learns the name: the first boot writes it to
     `/etc/sergeant/host.env`, which nothing rewrites afterwards (Apply above). After the apply that
     creates the secret, `sgt account register` still answers "This Sergeant isn't set up for account
     registration yet". Set the installation config's `registeredAccountsSecret` to the secret's name
     (`terraform output -raw registered_accounts_secret` once an apply has recorded that output;
     `sergeant/v2/registered-accounts` unless `registered_accounts_secret` says otherwise), put the parameter, and run `sgt admin restart` (or
     an update). Registration works from that restart on.
   - **An existing secret** (made by hand before TECH-5204, under another name) is adopted, not
     recreated: with `registered_accounts_secret` naming it, the next plan shows it imported (its description and tags updated in place) and a
     `sergeant-initial` version added beside the current one, which stays current. It may stay in `secret_names` (the reason `secret_names` accepts up to nine names) or leave it: the role reads and writes it through its own grant either way.
   - **Another name, later, is unsupported.** Changing `registered_accounts_secret` would replace the
     secret, which holds every registered credential, so its `prevent_destroy` makes the plan fail
     and nothing changes. Keep the name the first apply used. On the host, leave the installation
     config's `registeredAccountsSecret` unset or equal to it: the role may write no other secret.
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
terraform plan -out tfplan     # first apply: the A record import (if any) and 21 new resources (12 before fargate.tf)
terraform apply tfplan
```

`ami` and `user_data` are ignored after creation, so a newer Ubuntu image or an edited first-boot
template never replaces the running host; the values written to `/etc/sergeant/host.env` (hostname,
source repository, config parameter, registered-accounts secret) are fixed then too. To change them, or to deliberately rebuild
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

The restart sends SIGTERM: `serve` stops intake and ends each task at its next poll, but exits after
an internal five-second deadline if graceful shutdown stalls; systemd has a 15-second final backstop.
Running worker and reviewer containers keep running and the new
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
sgt admin status           # the release, when serve started, the last restart or update, whether
                           # the installation-config parameter changed since serve started, each
                           # webhook source's health, and GitHub and Linear API calls by source
sgt admin api --hours 24   # what spent the GitHub and Linear API budgets: calls by source and endpoint,
                           # budget history, rate-limit pauses and the tasks they paused, warnings
```

`restart` and `update` each print the outcome when the host has one, including why it failed, waiting
out serve's restart (up to 45 minutes). `status` compares the installation-config parameter's version
`serve` has (the one it started with, moved on only by its own `sgt admin repo` and `sgt admin retro` changes) with the
parameter's version now; when they differ, the config changed in AWS since serve's last install, and
it says to run `sgt admin restart`. Serve runs `/etc/sergeant/installation.json` from that install, so
one systemd restarts (after a crash, say) has the version install.sh recorded beside it in
`installation.json.version`, unless that copy matches the parameter but for `repositories` and `retro`. An `update` with nothing newer to install leaves serve running on its old
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

An approver runs `sgt admin repo add <owner/name> [--merge-method …] [--merge-policy sergeant|human]`
or `sgt admin repo remove <owner/name>` with their own Linear login; anyone signed in runs `sgt repo
list`, which shows each repository's merge policy. A repository enrolled without `--merge-policy` is
`human`: Sergeant never approves or merges in it (TECH-5244). `--merge-policy` on a repository already
enrolled sets its policy, so an entry from before TECH-5244 (with no policy, so `human`) becomes
Sergeant-merged only by `sgt admin repo add <owner/name> --merge-policy sergeant`. `serve` refuses
a repository either GitHub App cannot reach, then rewrites the installation-config parameter (only its
`repositories`; the new version's description names the approver: `aws ssm get-parameter-history`)
and takes the list in place, without a restart; `serve.log` names the approver too. A repeated change
the parameter already has writes nothing and only brings the running list up to it. `serve` reads its
enrolled repositories and its retro target (none once an approver turned retros off) from the
parameter at every start, so no restart brings back an older list or target (TECH-5940); it does not
start if it cannot read the parameter. An approver sets a repository's own budget the same way (`sgt
admin repo budget`, Change the per-task budget below). Every other setting but `retro` (`sgt admin
retro`) stays AWS-only, applied by an update as before, and never appears in an answer or a log. The host's role may write that one
parameter and no other. Editing `repositories` in the parameter by hand still works.

A host gets this from an apply of the instance role's `WriteInstallationConfig` statement and one
Update to a commit that has it (the unit then reads `SERGEANT_CONFIG_PARAMETER` from
`/etc/sergeant/host.env`). Until both, `add` and `remove` answer with why they cannot.

### Change the per-task budget

The installation config's `budget` is the window each task gets when it starts; without it, 120
minutes and $25 (Budget below). Add or change it in your `installation.json`, for
example `"budget": { "minutes": 45, "usd": 10 }`, put the parameter, then run an Update (above):

```sh
aws ssm put-parameter --name /sergeant/v2/installation-config --type String --overwrite \
  --value file://installation.json
```

Only tasks that start after the update get the new window. A task already running keeps the one it
started with (the log says `ignoring the budget options`) until its next fresh window (Budget below).

A repository whose builds, tests, and CI need a longer (or cheaper) window gets its own `budget`
(TECH-6606). An approver sets it with their Linear login, no AWS access and no restart:

```sh
sgt admin repo budget owner/ios --wall-minutes 180               # only the time; its cost stays as it was
sgt admin repo budget owner/ios --cost-usd 40                    # only the cost
sgt admin repo budget owner/ios --wall-minutes 180 --cost-usd 40 # both
sgt admin repo budget owner/ios --cost-usd default               # clear one: the installation's applies again
sgt repo list                                                    # each repository's window, its own fields marked (own)
```

Each flag changes only its field, a positive number or `default`; the repository must be enrolled.
`serve` writes only that repository's `budget` in the installation-config parameter, the approver named
in the new version's description as for `sgt admin repo add`, and takes it at once. It applies to a
task once the task has a run in that repository, from the task's next budget window on (Budget below).
Editing the entry by hand still works, for example
`"owner/ios": { "mergeMethod": "squash", "budget": { "wallMinutes": 180, "costUsd": 40 } }`, put and
updated as above.

### Change the task slots

The installation config's `maxTasks` (default 2) is how many task slots `serve` fills, and
`waitingGraceMinutes` (default 15) how long a waiting task keeps its slot before the next
task in order gets it (Intake, under The service below). Add or change them in your
`installation.json`, for example `"maxTasks": 4`, put the parameter, then run an Update (above):

```sh
aws ssm put-parameter --name /sergeant/v2/installation-config --type String --overwrite \
  --value file://installation.json
```

The unit file no longer passes `--max-tasks`, so the config is the single source; an explicit flag
would still win over it. If your host was given more slots through a systemd drop-in that overrides
`ExecStart` with `--max-tasks <n>`, then once the config says `"maxTasks": <n>` and an install with this
change has run, find the drop-in with `systemctl cat sergeant` (the file under
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

After every deploy, run the post-deploy smoke check: it reads each live Linear and GitHub query added
since V2, writing nothing, and checks the host serves the version just installed. To close a "check
the first live use" ticket, cite natural-use evidence from Sergeant's own records
([docs/live-verification.md](../docs/live-verification.md)):

```sh
sudo -u sergeant -H bash -c 'cd /opt/sergeant/src/packages/sergeant &&
  node src/smoke.ts --config /etc/sergeant/installation.json --repo <owner/name> --issue <issue> --pr <number>'
sudo -u sergeant node /opt/sergeant/src/packages/sergeant/src/evidence.ts --match '<regex>' --since <deploy time>
```

Then delegate a small controlled issue to the V2 agent and watch `serve.log`: the next intake (within
two minutes) admits it. The per-feature live checks (below) apply to `serve` as they
do to `canary`; the service's per-task state is `/var/lib/sergeant/state/tasks/<issue>/`.

### Logs

```sh
aws logs tail /sergeant/v2 --follow --log-stream-name-prefix "$ID/serve"
aws logs tail /sergeant/v2 --since 1h --log-stream-name-prefix "$ID/autoupdate"
```

On the host: `tail -f /var/log/sergeant/serve.log`, `journalctl -u sergeant -u caddy`, run records
under `/var/lib/sergeant/state/runs/`, and `sudo docker ps --filter label=sergeant.run`.

### Stop

`sudo systemctl stop sergeant` on the host stops intake and gives each task up to five seconds to end; running
containers are left alone. `sudo systemctl start sergeant` resumes from the state dir.

## Reference

What `serve` does and how it is configured, for operators. Users start at
[`docs/onboarding-user.md`](../docs/onboarding-user.md); the `sgt` reference is [`docs/sgt.md`](../docs/sgt.md).

### Installation config

The installation config holds identifiers and secret references only (AWS Secrets Manager ids,
resolved with the configured AWS profile and region on a laptop, or the instance role on the host); no
credential is ever printed, and no ambient `gh`, Linear, or Claude login is used. Its shape is
`InstallationConfig` in `packages/sergeant/src/config.ts` (example: `host/installation.example.json`):

```json
{
  "secrets": { "awsRegion": "us-west-2", "awsProfile": "<profile>" },
  "linear": {
    "tokenSecret": "<V2 Linear agent token secret id>",
    "agentUserId": "<V2 agent user id>",
    "reviewerProfiles": { "github-login": "https://linear.app/<workspace>/profiles/<user>" }
  },
  "github": {
    "controlPlaneApp": { "appId": 1, "installationId": 2, "privateKeySecret": "<secret id>" },
    "workerApp": { "appId": 3, "installationId": 4, "privateKeySecret": "<secret id>" },
    "ciRerunApp": { "appId": 5, "installationId": 6, "privateKeySecret": "<secret id>" }
  },
  "repositories": { "owner/name": { "mergeMethod": "squash", "mergePolicy": "sergeant", "ciRerunWorkflows": [".github/workflows/ci.yml"] } },
  "modelTokenSecret": "<Sergeant model token secret id>",
  "gitIdentity": { "name": "<human name>", "email": "<human email>" }
}
```

- **`repositories.<owner/name>.mergePolicy`** says who merges in it, `sergeant` or `human`, and a
  repository without one is `human`; the human handoff is in
  [`docs/design/08-github-contract.md` §7](../docs/design/08-github-contract.md#7-merging). A repository's
  `"observedChecksFallback": true` treats every check observed on the exact head as required (GitHub
  Apps and rulesets below).
- **`github.ciRerunApp`** (optional, TECH-5839) is a separate GitHub App, never the worker App, with
  actions write and metadata read on the enrolled repositories. Only `serve` holds its key (add the key's
  secret name to `secret_names` too); it reruns the failed jobs of a workflow run a worker asked for in
  its report, after Sergeant checks the request (`docs/design/08-github-contract.md` §6). Without it,
  every rerun request is refused and recorded as such.
- **`repositories.<owner/name>.ciRerunWorkflows`** (optional, default none) lists the workflow files,
  such as `.github/workflows/ci.yml`, whose failed runs on a task's PR may be rerun. List only ordinary
  CI, never a deployment or other privileged workflow.
- **`repositories.<owner/name>.actionsRetentionDays`** (optional, default 90, GitHub's default) is
  the repository's Actions "artifact and log retention" in days. GitHub deletes a workflow run's check
  results with the run, so a required check missing on a commit that has been the PR's head for longer
  than this counts as expired, and Sergeant re-runs CI on that same head (`docs/design/08-github-contract.md` §6). Set it for a
  repository that keeps runs for less than 90 days.
- **`repositories.<owner/name>.budget`** (optional) replaces the installation's `budget` for tasks
  working in that repository, field by field: `"budget": { "wallMinutes": 180, "costUsd": 40 }`
  (positive numbers, each optional; a field unset keeps the installation's; Budget below). Approvers
  set it with `sgt admin repo budget` (Change the per-task budget above).
- **`linear.tokenSecret`** must act as `agentUserId` (checked at startup); every Linear read and write
  uses it. It needs permission to create issues, issue relations, and documents, and to edit issue
  labels (follow-ups, feedback, and retros below).
- **`linear.otherAgentUserIds`** (optional) lists other agents' users (such as Sergeant 1's) whose
  comments are not human input.
- **`linear.delegatingAppIds`** (optional) lists Linear app ids (`botActor.id`), such as Linear's MCP
  connector (`f69dcc4d4c3c994d8f7f1475b2b23a11` in every workspace), whose delegations count as the
  assignee's own (Before the first apply above, step 8).
- **`gitIdentity`** is only the fallback commit identity (TECH-5593). A run's commits are authored and
  committed as the person who requested it: the task owner, by the name and Linear login email they
  registered their model account with (`sgt account register`), so GitHub attaches each commit to the
  GitHub account that has that email verified. `gitIdentity` is used only for a run on an account no
  signed-in person registered. A person whose Linear email is not a verified email of their GitHub
  account gets commits GitHub attaches to nobody; they add it under GitHub's email settings. No
  identity is ever an agent's, and no agent co-author trailer is added.
- **`linear.reviewerProfiles`** (optional) maps GitHub logins to Linear profile URLs. Sergeant puts the
  URL in a re-review request so Linear renders a real user mention and sends an Inbox notification; a
  missing mapping or failed lookup leaves the plain `@github-login` text. The same mapping names the
  GitHub account a task's PRs are assigned to ([08 §10](../docs/design/08-github-contract.md#10-humans-on-github))
  and whose review a human-merge handoff requests; without it neither happens.
- **`review.auditSampleRate`** (optional, 0 to 1, default 0.2) is the fraction of merged heads that
  skipped fresh review which get an audit review (Review telemetry below).
- **`repositories.<owner/name>.mergedAuditSampleRate`** (optional, 0 to 1, absent 0),
  **`review.auditOwner`** (optional, a Linear user id, no default) and **`review.qualityBudgetUsdPerDay`**
  (optional, default 25): the daily merged-PR audit, who pays for it, and its cap
  ([design 06 §8](../docs/design/06-review.md#8-calibration-sampling-unf-641-preserved)). Approvers set
  a repository's rate with `sgt admin repo audit-rate <owner/name> <0..1>`. Each finished audit gets
  a `<state dir>/reviews.jsonl` line and one nonblocking comment on its PR, filtered on a public
  repository (TECH-6618).
- **`budget`** (optional) is the budget window a task gets when it starts or a human answers one of its
  questions, for `serve` and `canary` alike: `"budget": { "minutes": 45, "usd": 10 }` (positive
  numbers, each optional; unset, 120 minutes and $25; Budget below).
- **`maxTasks`** (optional, a positive integer, default 2) is how many task slots `serve` fills, and
  **`waitingGraceMinutes`** (optional, default 15) how long a waiting task keeps its slot; `serve
  --max-tasks` and `--waiting-grace-minutes` win over them (Intake below).
- **`linear.webhookSecret`** and **`github.webhookSecret`** (optional) are the signing secrets of the
  Linear app's and the control-plane App's webhooks; `serve` has each webhook endpoint only when its
  secret is set (Webhooks above).
- **`humans`** (optional) says who may use `sgt` and the client API, each with their own Linear login:
  `{ "linearClientId": "<the Linear OAuth app's client id>", "teams": ["<team key>"], "approvers":
  ["<Linear user id>"] }`. Without it the API fails closed (Public human API and login for
  `sgt` above).
- **`release`** (optional) makes the host update itself to green commits of `main`: `{ "channel":
  "main" }` or `{ "channel": "soaked", "soakMinutes": 90 }`, with `"paused": true` to stop (Automatic
  updates above).
- **`runners`** (optional): `"workerBackend": "fargate"` runs workers on Fargate (Workers on Fargate
  above). Which agent, Claude Code or Codex, runs a worker or reviewer is never set here: each run's
  comes from its task owner's registered accounts (A Codex reviewer above, TECH-5390). `"worker"` and
  `"reviewer"` are deprecated and ignored: an older config that sets them still loads, and serve logs a
  warning for each until it is removed.
- **`codex`** (optional): `"model"` overrides the model Codex runs, `gpt-5.6-sol` by default. A Codex
  run's cost is estimated from its tokens at OpenAI's list price for its model; optional
  `codex.prices`, `{ "<model>": { "input": 1.25, "cachedInput": 0.125, "output": 10 } }` in USD per
  million tokens, adds or replaces a model's price, and a model with none counts as unknown cost
  ([`packages/runner/README.md`](../packages/runner/README.md#codex-codex-local-tech-5009)). People
  register Codex accounts with or without it.
- **`retro`** (optional) is the Sergeant project's Linear id and the team its issues are filed in
  (Follow-ups, Sergeant feedback, and retros below).
- **`registeredAccountsSecret`** (optional) names the registered-accounts secret (Model accounts above).
- **`publicDataDenylistSecret`** (optional, TECH-5914) names a secret whose value is the customer
  names, one per line, that a worker's push to a public repository must not carry. Add the name to
  `secret_names` too. Each worker gets the list as `PUBLIC_DATA_DENYLIST`, read only by the pre-push
  hook the runner image installs in its clones (`packages/runner/container/check-public-data.mjs`); the
  hook also refuses Terros IDs, emails, and phone numbers, with or without the list. The core reads it
  too, to filter the model-written text of its own comments on a public repository (the readiness
  reason, [design 08 §12](../docs/design/08-github-contract.md#12-readiness-and-agreement); audit
  findings, [design 06 §8](../docs/design/06-review.md#8-calibration-sampling-unf-641-preserved)); without
  it those comments carry fixed text only. Keep the same list
  as the `PUBLIC_DATA_DENYLIST` Actions secret of each public repository whose CI runs that check,
  written there on one line with commas, so Actions masks it whole in the public log.

### GitHub Apps and rulesets

Each App's permissions, what neither may hold, and why the ruleset's required approving review is
what keeps the worker App from merging its own PR are in
[`docs/design/08-github-contract.md` §1](../docs/design/08-github-contract.md#1-github-identities-per-installation);
§2 there is the enrollment checklist. Only the base branch's declared required checks count toward a
merge (ruleset `required_status_checks`), so a repository with none cannot be merged; a repository's
`"observedChecksFallback": true` instead treats every check observed on the exact head as required.

**A ruleset for a newly enrolled repository.** Someone with admin on the repository creates it once,
before or right after `sgt admin repo add`. It covers the default branch: no deletion or force push, a
pull request with one approving review (stale ones dismissed on a new push), one required check from
GitHub Actions (`integration_id` 15368), and the repository admin role (`RepositoryRole` 5) as an
`always` bypass actor, so the owner can still merge their own PRs; the worker App is no admin, so it
cannot bypass. Prefer one aggregate job as the required check over listing every job, so the ruleset
need not change when the workflow does; `CI complete` below is that job's name (the check's name is
the job's `name`):

```sh
cat >ruleset.json <<'EOF'
{
  "name": "sergeant",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [{ "actor_type": "RepositoryRole", "actor_id": 5, "bypass_mode": "always" }],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1, "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": false, "require_last_push_approval": false,
        "required_review_thread_resolution": false } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [{ "context": "CI complete", "integration_id": 15368 }] } }
  ]
}
EOF
gh api -X POST repos/<owner>/<repo>/rulesets --input ruleset.json
```

The aggregate job, in the repository's workflow, fails when any job it waits for failed or was canceled:

```yaml
  ci-complete:
    name: CI complete
    needs: [build, test]   # every other job
    if: always()
    runs-on: ubuntu-latest
    steps:
      - if: contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled')
        run: exit 1
```

Once the ruleset is on, every PR to the default branch, not only Sergeant's, needs an approving review
or an admin's bypass to merge. `live-check --repo <owner/name>` (Live check on the host above, or
Manual commands below) then confirms it: an approving review required, required checks declared, and
no bypass for the worker App.

### Manual commands: `live-check`, `smoke`, `evidence`, `canary`, and `serve`

These are manual and never run from tests or CI. Each takes an installation config file.

`live-check` confirms the identities and an enrolled repository's ruleset without writing anything or
spending model money, and fails if the base branch does not require an approving review:

```sh
pnpm --filter @terros/sergeant live-check --config <file> --repo owner/name [--issue <issue>] [--pr 45]
```

`smoke` is the post-deploy smoke check, and `evidence` searches a state directory for natural-use
evidence. Both write nothing ([docs/live-verification.md](../docs/live-verification.md)):

```sh
pnpm --filter @terros/sergeant smoke --config <file> [--repo owner/name] [--issue <issue>] [--pr 45] [--no-status] [--api https://<host>]
pnpm --filter @terros/sergeant evidence --match '<regex>' [--since <time>] [--issue <issue>] --state-dir <dir>
```

`canary` runs one task's loop for one explicitly selected issue. It reads and writes live Linear and
GitHub, launches real model sessions, and costs money. Re-running the same command resumes from
`<dir>/state.json`; `touch <dir>/STOP` stops it.

```sh
docker build -t sergeant-runner:local packages/runner/container
pnpm --filter @terros/sergeant canary --config <file> --issue <issue> --repo owner/name --dir <state dir>
```

`serve` is the long-running service (The service below):

```sh
pnpm --filter @terros/sergeant serve --config <file> --state-dir <dir> [--port 8080] [--max-tasks 2] [--waiting-grace-minutes 15] [--config-parameter <SSM name>] [--trust-loopback]
```

### How a task runs

- **Delegation.** A task works on the issue only while it is delegated to `agentUserId`: before
  anything starts, on every poll, and again from a live read before each start, merge, and the outcome
  comment (Gate rule A1), and only while it is not in Backlog, Canceled, or Done (A2; Done after
  Sergeant's own closing merge is the normal end).
- **Stopping.** A task either runs or is stopped, and every stop takes one path: the issue undelegated
  or reassigned, moved by a human to Backlog, Canceled, or Done, or `sgt task cancel` (a reassignment
  is a handoff that keeps the PRs open and puts the issue back in Todo, undelegated). The stop is
  recorded in `<dir>/cancel.json` first, and from then on the loop takes no turn and makes no effect:
  it keeps retrying each run's cancellation, and treats a run whose status it cannot read as still
  running, until the runner confirms every run stopped; then it closes the task's open PRs (only those
  the worker App opened) with a short comment, posts one comment on the issue saying it stopped and
  which PRs it closed, and sets `state.json` aside. Nothing resumes a stopped task: the issue delegated
  and in Todo again starts a fresh one, with a new budget.
- **Workers, successors, and the merge.** Workers push their branches and open PRs with a worker-App
  token scoped to their run's repositories; the merge is one control-plane action: fresh exact-head
  PR, check, and Linear reads, the Gate, and GitHub's SHA-guarded merge. A blocking review finding or
  a failed required check wakes a turn that may start a successor worker (one at a time, R1) on the
  same PR; its brief carries the PRs with their check states and the earlier runs' reports and
  findings, the newest whole ([05 §2](../docs/design/05-brief-report-protocol.md#2-the-brief)). The fix is a new head, so the merge again needs a fresh approving review of it or the
  worker's waiver for it (M6). No turn count bounds the iterations: the budget window does. The runner
  cannot resume a worker's session, so every continuation is a successor.
- **Outcome comment.** After the merge, the agent posts one outcome comment (PR, reviewed head,
  observed required checks, merge result, known gaps), keyed by the issue and the merge so a rerun
  never posts it twice; Linear's GitHub integration moves the issue to Done.
- **Questions.** Reasoning may ask a human (`ask_human`): the agent posts one question comment, keyed
  by the issue and the conversation revision it was asked from, and the loop then takes no turn and
  makes no effect until a human comments or edits the issue. No timeout decides for the human; `STOP`
  or undelegation still ends the loop. The wait is never stored locally: a restart finds the question
  on the issue.
- **Closing without a PR** (`close_issue`, Gate rules C1–C4) is in
  [`docs/design/07-linear-contract.md` §6](../docs/design/07-linear-contract.md#6-budget-asks-and-fresh-windows),
  "Nothing to change"; the loop then ends `accepted`.
- **Run ids.** A run's id is saved before the runner starts it, so a crash in between still leaves a
  run the loop cancels; one the runner never started is dropped once a cancel confirms it.

### Budget

Each task has a budget window, saved in `state.json` with the task's start before anything else
happens. It is the installation config's `budget`, each field unset defaulting to 120 minutes and $25;
`canary`'s `--budget-minutes` and `--budget-usd` override the config's for its task. A restart keeps
the stored window and logs that it ignores a different one, so changing the config's `budget` affects
only tasks that start afterward, and their next fresh window. What the window counts, what opens a
fresh one (the loop logs `a human answered (...)` or `unblocked (was waiting on ...)`, then `a fresh
budget window ...`), and the budget question with its accept-as-is reply are in
[`docs/design/07-linear-contract.md` §6](../docs/design/07-linear-contract.md#6-budget-asks-and-fresh-windows).

A repository's own `budget` (`repositories.<owner/name>.budget`, TECH-5219) replaces the stored
window's fields for a task once it has a run in that repository: `state.json` records the
repositories each worker or reviewer was started in, and every poll measures the window, from its
start, with those repositories' budgets applied. A field a repository leaves unset keeps the
installation's; over several repositories the largest of each field holds. TECH-6606: like the
installation's `budget`, the repositories' budgets are the ones a window opened with: it keeps every
enrolled repository's own `budget` of that moment in `state.json`, so a change (`sgt admin repo
budget`, or an edit and Update) reaches only windows that open after it, and a task's current window
keeps what it has until its next fresh one. A window that opened before TECH-6606 has none kept and
reads each repository's `budget` at every poll until then. `canary` applies its repository's `budget`
before its own flags.

Once either is exhausted, no run, message, follow-up, or merge happens (Gate rule B1, checked before
every effect and again right after its live reads), and running runs are canceled until the runner
confirms it. After an accept-as-is reply, an `accepted.json` marker keeps intake from starting the
issue afresh while it stays delegated and in Todo; moving the issue out of Todo (or undelegating it,
or `sgt task wake`) clears it.

The outcome comment after a merge is the one effect B1 does not hold back: it reports a merge that
already happened, and withholding it would hide the merge from the human.

### Follow-ups, Sergeant feedback, and retros

When a follow-up issue is filed, the **Sergeant feedback** comment after a merge, and the **Sergeant
retro** across tasks are in
[`docs/design/07-linear-contract.md` §11](../docs/design/07-linear-contract.md#11-follow-up-issues). Filed
follow-ups are kept in `state.json`, shown to every later turn, and listed in the outcome comment. The
`sergeant-feedback` label must already exist (a workspace label, or one in the issue's team);
Sergeant never creates it. Retros need the installation config's `retro`
(`packages/sergeant/src/retro.ts`); `<dir>/retro.json` only keeps an answer whose filing or posting
failed, so the retry pays for no second answer.

### Review telemetry

Review quality is telemetry, never a gate ([`docs/design/06-review.md`](../docs/design/06-review.md)
§8–9). Every reviewer run that finishes, whether or not the task ever merges, is written as a line of
`<dir>/reviews.jsonl`: trigger (`required` or `audit`), mode (a separate fresh run), reviewer and
implementer provider and model, whether their vendors are the same, the heads reviewed, the verdict,
finding counts, the must-fix (blocking) findings verbatim, the merged head once there is one, and the
resulting change (`resultingMutation`: `true` when a worker's report lists one of its findings `fixed`
in `addressedFindings`, `false` when it had none or workers answered them and fixed none, otherwise
`"unknown"`; a head changing after a review is not counted). A review is written again only when one of
those later facts changes, so the last line per run id holds.

A merged head that no fresh review approved skipped review; a stable hash of the head picks
`review.auditSampleRate` of those for an **audit review**, a separate fresh reviewer of exactly the
merged head, started only after the merge so it can never hold one up. After observing Done the loop
waits for any review still running, the audit included, and records it; an audit's must-fix findings on
merged code also go to `<dir>/audit-followups.jsonl` and an `AUDIT FOLLOW-UP` log line for a human to
act on (nothing is reopened or reverted, and an audit finding gives the task no turn to propose a
`create_followup`; what does reopen a merged task is in
[design 07 §7](../docs/design/07-linear-contract.md#7-completion-prs-automation-and-done)). To compare review modes across runs:

```sh
cat <state dirs>/reviews.jsonl | jq -s 'reduce .[] as $f ({}; .[$f.runId] = $f) | [.[]] | group_by([.trigger, .vendor])
  | map({trigger: .[0].trigger, vendor: .[0].vendor, reviews: length, withMustFix: map(select(.findings.blocking > 0)) | length,
    ledToChange: map(select(.resultingMutation == true)) | length, unknown: map(select(.resultingMutation == "unknown")) | length})'
```

### The service

`serve` runs Sergeant unattended: one process that works every open issue delegated to the agent, in
every repository the installation config enrolls, with nobody starting an issue by hand. It is a thin
shell over the canary's per-task loop, not a workflow engine:

- **Intake** lists open (not completed or canceled) issues delegated to `agentUserId` every
  `--intake-seconds` (120) and runs each one's loop in one of `maxTasks` (2) task slots. A free slot
  goes to the highest-ordered task that wants one: by Linear status, In Review, then In Progress, then
  Todo; then by priority, Urgent to none; then newest first. Finishing work beats starting it. A task
  asked to wake (`sgt task wake`) goes first. A task holds its slot while it runs a worker, a reviewer,
  or a reasoning turn, and while it waits on anything (a question, a budget reply, CI, mergeability, a
  human merge, an unreadable runner) for up to `waitingGraceMinutes` (15). Answered within the grace,
  it continues at once; past it, its slot goes to the next task quietly, with nothing posted in Linear,
  and its loop keeps polling without a slot. Once it has work again, it queues for a slot in the same
  order as new work, so In Progress goes ahead of Todo. `GET /status` lists the released tasks under
  `released`.
- **Starting.** Linear's list only discovers new work, and a task starts only from Todo: an issue in
  Triage or Backlog waits until a human moves it there. A Todo issue with a Linear "blocked by" issue
  that is neither completed nor canceled waits too, logging `<issue> waiting on blocker <issue>`, and
  starts at the first intake after its last blocker finishes; one with more than 20 inverse relations
  waits as if blocked, since Sergeant reads only 20. A task already under way is not held back.
  Starting it moves the issue from Todo to In Progress, the only state Sergeant moves an issue to.
- **Resuming.** Every intake also resumes each local task (`state.json`) with no loop, whether or not
  Linear lists it, into a free slot in the same order, or with no slot until it has work to do. Its
  loop's own live checks then continue it, stop it (undelegated, or in Backlog, Canceled, or Done
  without its closing PR merged), or see it through after the merge; a stop never needs a task slot,
  and a task seen through is not resumed again. A loop that ends (idle, a failed read) is admitted
  again while the issue is still delegated, at the first intake after a webhook names it, a human's
  `sgt task wake`, or 15 minutes after it ended (TECH-5942): an unchanged task takes no turn, a
  changed one does. A failed intake is logged and retried next interval.
- **Each task loop** is the canary's: it re-reads its runs, the PRs Linear links to the issue or a
  worker reported, with their checks, and the Linear conversation, and takes a reasoning turn only when
  they changed, so a missed webhook costs only latency. It polls every 15 minutes, or every
  `--poll-seconds` (60) while a run is in flight, GitHub is still computing a PR's mergeability, or a
  merge retry is pending (TECH-5942); its PRs are reread every 15 minutes unless an event names one. Its state is
  `<state dir>/tasks/<issue>/`; runs live under `<state dir>/runs/`.
- **Webhooks** are the primary signal, never the source of truth. `POST /webhooks/linear` and
  `POST /webhooks/github` refuse a delivery whose signature (HMAC-SHA256 of the body,
  `Linear-Signature` or `X-Hub-Signature-256`) does not verify, before parsing it, and a Linear
  delivery whose signed `webhookTimestamp` is over a minute from now. A verified event about an issue's
  delegation, state, title, description, labels, comments, attachments, or relations, or a PR's
  changes, pushes, reviews, check runs and suites, or statuses, names the issue or PR it is about; each
  task loop watching that issue, PR, or head ends its wait and rereads, and a delegated issue with no
  loop, or a delegation change to or from the agent, runs an intake now. Nothing else happens: no event
  owes a turn or is recorded, repeated events coalesce (each loop, and intake, wakes at most once per 5
  seconds), an issue or PR no task watches is ignored, and the polls still find every change.
- **Post-merge feedback** is swept every 30 minutes
  ([`docs/design/07-linear-contract.md` §11](../docs/design/07-linear-contract.md#11-follow-up-issues)).
  `<state dir>/feedback.json` records what was judged and failed attempts, and its `since` (the first
  sweep) keeps feedback from before the rollout out.
- **API usage** (TECH-6208). `<state dir>/api-usage.json` keeps 7 days of serve's GitHub and Linear
  API calls per hour by source and endpoint, the budgets their responses report (sampled every 5
  minutes), GitHub's budget windows, rate-limit pauses with the tasks they paused, and low-budget
  warnings; serve saves it every minute and when it stops, and `sgt admin api` shows it. A budget
  below 15% of its limit before its reset logs `WARNING: <provider> <budget> API budget low: …` once
  per window. Workers and reviewers use the worker App's installation, a budget of its own; calls
  anything else makes on the control-plane App's budget show as a window's `other`. Deleting the
  file loses only this history; an unreadable one is set aside and counting starts afresh.
- **Signals and restarts.** SIGINT or SIGTERM stops intake, closes the HTTP listener and connections,
  and asks each loop to end at its next poll. If that has not completed in five seconds the process
  exits; a second signal exits at once. A restart rereads Linear, GitHub, the runner, and each
  task's `state.json`, and continues, accepting some repeated work. One process serves a state
  directory: it holds an OS file lock on `<state dir>/service.lock` (released when it exits, however
  it exits), and a second start is refused while it does. `GET /health` on `--host` (127.0.0.1) and
  `--port` (8080) reports the process alive, the tasks running, and the last intake.

### The client API

The same port answers the client API under `/v1` (the slice of
[`docs/design/11-apis-cli.md`](../docs/design/11-apis-cli.md) §2 that `sgt` and `sgt-mcp` use):

- **Tasks and runs.** Task and run reads, `POST /v1/tasks/:ref/wake`, `/v1/tasks/:ref/cancel`, and
  `/v1/runs/:id/cancel`. A wake ends the task loop's wait and owes it one turn, behind every hold the
  loop keeps. A task cancel removes the agent's delegation and then takes the task's one stop (How a
  task runs above); it answers with any run the runner has not yet confirmed, and `serve` keeps driving
  the recorded stop at each intake, across a restart, until it has. A run cancel is the runner's
  confirmed cancel, noted on the issue so the next turn does not just restart it.
- **Client version.** Before anything else, every `/v1` call must name a client version
  (`Sergeant-Cli-Version`) no older than the oldest `sgt` this `serve` supports, or it is refused with
  `400` and "Run `sgt update`", so a too-old `sgt` changes nothing.
- **Callers.** Every `/v1` call names its caller and fails closed without one: a bearer Linear access
  token from `sgt login`, which `serve` reads back from Linear on every call and admits only for an
  active user of the agent's own Linear workspace, not an agent, in one of `humans.teams`; those listed
  in `humans.approvers` are approvers too. Wakes and cancels are logged with the caller's name, and a
  cancel's note on the issue names them. Only `GET /v1/auth/config`, the public client id `sgt login`
  starts with, needs no caller.
- **Approvers.** `/v1/whoami` says whether the caller is an approver. Only an approver (or the loopback
  operator) may `POST /v1/accounts/remove-person` to remove everything one person registered, restart
  or update the host through `/v1/admin` (Restart or update with `sgt` above), or `POST
  /v1/repositories/add` or `/remove` to change the enrolled repositories, which every caller may `GET
  /v1/repositories`. A change is refused unless both GitHub Apps reach the repository; it rewrites only
  `repositories` in the installation-config parameter (`--config-parameter`, else
  `SERGEANT_CONFIG_PARAMETER`), naming the caller in the parameter version's description, and `serve`
  takes it in place. With a parameter, `serve` reads its enrolled repositories from it at startup
  rather than from `--config`, so a restart keeps every change (Enrolled repositories above).
- **Loopback.** For development on one machine, `--trust-loopback` also admits a caller on the host
  with no login, as an operator; it is refused unless `--host` is `127.0.0.1` or `::1` (not a name
  such as `localhost`), and never covers a request relayed by a proxy or naming a non-loopback `Host`.
  Posts must be JSON, so a cross-site form cannot post.

### Per-feature live checks

Manual checks against live Linear and GitHub, run with `canary` (or `serve`, whose per-task state is
`<state dir>/tasks/<issue>/`) on small controlled issues in a canary repository, once the agent's
Linear app, both GitHub Apps, and the canary repository's ruleset exist. They cost model money.

**Delegation and the outcome comment.**

1. Put the agent's Linear user id in `linear.agentUserId` and any other agent's user (such as Sergeant
   1's) in `linear.otherAgentUserIds`.
2. Create a small controlled issue in the canary repository's team and delegate it to the agent.
   `live-check --issue <it>` must pass, including `issue is delegated to the V2 agent`.
3. Undelegated or delegated to another agent, `canary --issue <it>` stops at once with
   `CANARY RESULT {"outcome":"stopped",...}` and nothing is started.
4. Delegated to the agent, run `canary` through to the merge. Expect exactly one comment, authored by
   the agent, with the PR link, reviewed head, required checks, merge SHA, and known gaps, then the
   issue moving to Done through the GitHub integration (`CANARY RESULT {"outcome":"done",...}`).
   Running the same command again posts nothing more.
5. On a second controlled issue, reassign it to another agent (or remove the delegate) while a turn is
   deciding or a worker is running: the loop stops, cancels the running run, merges nothing, and posts
   nothing.

**Successor workers.** On a controlled issue whose objective invites a fixable mistake (or after a
human pushes a deliberately failing commit to the worker's PR):

1. Run `canary` until a reviewer returns `changes_requested` with a blocking finding, or a required
   check fails on the PR head. The next turn starts one successor worker; its
   `<dir>/runs/<runId>/workspace/sergeant-brief.md` lists the PR, the failing check, and the finding.
2. The successor pushes to the same PR (no second PR, no second worker running), and the loop merges
   only after a fresh approving review of the new head, or the successor's own waiver for that exact
   head, with required checks green (`CANARY RESULT {"outcome":"done",...}`).

**Questions.** On a controlled issue whose description leaves a real product choice open (for example
"retain or purge X; the owner decides"):

1. Run `canary`. Expect one comment from the agent headed **Question for you**, then only `waiting:`
   log lines: no run started, no merge, and no `idle` stop.
2. Stop the loop (`touch <dir>/STOP`), remove `STOP`, and run it again: still exactly one question
   comment, and it keeps waiting.
3. Reply on the issue in your own words. The next poll takes a turn that interprets the reply and
   continues the work (or asks one short clarifying question, which waits the same way).

**Follow-ups.** On a controlled issue whose change invites a minor, out-of-scope observation:

1. Run `canary` until a reviewer approves with a `non_blocking` finding, or the worker's report lists
   a `followups` entry. In the turn that merges (or earlier), `turns.jsonl` shows a
   `create_followup <key>: done {"identifier":...}` outcome.
2. In Linear, exactly one new issue exists for it: in the origin issue's team and project, with no
   delegate, assigned as `docs/design/07-linear-contract.md` §11 says, a description that stands alone and links back, and a `related` (or
   blocked-by) relation to the origin. The outcome comment lists it under "Follow-ups filed".
3. Rerun the same command, and once more with `state.json` restored from before that turn: no second
   issue or relation appears.

**Review telemetry and audits.** With `"review": { "auditSampleRate": 1 }` in the installation config,
on a controlled issue whose change is small enough that the worker skips review (a one-line docs fix,
say):

1. Run `canary` through the merge. The worker's report says `review.required: false` with a reason,
   and the merge relies on it (`not_required`).
2. After the outcome comment, the log shows `audit review run_audit-<hash> started` (one id per
   repository, PR and head, [06 §8](../docs/design/06-review.md#8-calibration-sampling-unf-641-preserved)),
   and the loop waits for it after the issue reaches Done. Its brief
   (`<dir>/runs/run_audit-<hash>/workspace/sergeant-brief.md`) names the merged head and the skip reason.
3. `<dir>/reviews.jsonl` ends with one `"trigger":"audit"` line for it; any blocking finding is also in
   `<dir>/audit-followups.jsonl` and an `AUDIT FOLLOW-UP` log line. `CANARY RESULT` stays `"done"`.
4. With `auditSampleRate` 0, or on an issue whose head a fresh review approved, no audit starts, and
   the last `reviews.jsonl` line of each reviewer run is `"trigger":"required"` with `merged` set.
5. On an issue whose first review requests changes, the successor's report lists the finding in
   `addressedFindings`, and that review's last line says `"resultingMutation":true`.

**Budget.** On a controlled issue whose work takes more than a few minutes:

1. Run `canary --budget-minutes 5`. Once a worker is running and five minutes have passed, expect
   `budget exhausted (active time exhausted (5 minutes of work in this window))` and `canceled run_...` log lines, `docker ps` showing
   no `sergeant-run_*` container, and one **Question for you** comment from the agent with the spend,
   the runs (the worker `canceled`), any PR, and the extend / accept-as-is options. No run starts and
   nothing merges while it waits.
2. Reply "extend". The loop logs `a human answered (...): a fresh budget window ...`, and the next turn
   resumes the work in it. Replying "accept as-is" instead ends the loop `accepted`, with no further
   question, the PR left open, the issue left in its state, and one comment saying Sergeant has stopped
   and the PR and issue are the human's to merge or close.
3. With `--budget-usd 1`, the first finished run's reported cost exhausts the spend instead
   (`spent $... of $1.00`), with the same question.
4. On another issue, undelegate it while a worker runs: the loop logs `canceled run_...` and stops only
   after that; stopping Docker first (or making `docker stop` fail) keeps it retrying, not stopped.
5. Kill the canary (Ctrl-C) while the budget question is unanswered and rerun it with
   `--budget-minutes 120`: it logs `ignoring the budget options`, posts no second question, and still
   waits for the reply.
