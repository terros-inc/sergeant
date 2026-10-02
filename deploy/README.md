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
| `terraform/` | The host: one Graviton instance (Ubuntu 24.04, `m7g.xlarge`) in the account's default VPC, an encrypted root and a separate encrypted data volume, an Elastic IP, the hostname's A record, a security group with 443 and 80 only, and an instance role with SSM core, its own log group, `ssm:GetParameter` on the config parameter (and an explicit deny on every other parameter, which SSM core would otherwise allow), and `secretsmanager:GetSecretValue` on exactly the four listed secrets. |
| `terraform/init.sh` | `EXPECTED_ACCOUNT_ID=<account> ./init.sh`: refuses unless the credentials are that account, then reads the infrastructure-config parameter, refuses any shape but the expected one, writes the auto-loaded `terraform.tfvars.json`, and runs `terraform init` against its state bucket (key fixed at `v2/terraform.tfstate`), allowing only that account. Run before every plan and apply. |
| `terraform/infrastructure-config.example.json` | The shape of that parameter, exactly: `backend` (the existing state bucket and its region, nothing else) and `variables` (only `variables.tf`'s variables, `account_id` the expected account). |
| `host/sergeant-update.sh` | `sergeant-update <ref>`: fetch a ref of the public source repository anonymously and run its `install.sh`. The first boot runs it once; every update afterwards is the same command. |
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
  the model token and, for a worker, its scoped worker-App token.
- **State is on the data volume** (`/var/lib/sergeant/state`: `tasks/`, `runs/`, `service.lock`). It
  survives an instance replacement and Terraform refuses to destroy it (`prevent_destroy`).
- **Only `/health` is public.** `serve` listens on `127.0.0.1:8080`; Caddy terminates HTTPS for the
  hostname (Let's Encrypt over HTTP-01) and proxies `/health`, nothing else. `/health` answers only
  `{"ok":true}`, or 503 `{"ok":false}` while stopping or after a failed intake; active task ids and
  intake errors are on `/status`, which Caddy does not proxy.
- **The config lives in AWS.** Every install reads the SSM parameter (default
  `/sergeant/v2/installation-config`) and replaces `/etc/sergeant/installation.json` only if it parses
  as an `InstallationConfig`; a config that does not parse stops the update before `serve` restarts.
  Enrolling a repository is: edit the parameter, then update.
- **Logs** go to `/var/log/sergeant/serve.log` on the host and to CloudWatch Logs group `/sergeant/v2`
  (streams `<instance id>/serve` and `<instance id>/first-boot`).

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
   secret the config refers to, and nothing else: exactly four literal names, which Terraform
   enforces. To change an input later, put the parameter again and rerun `./init.sh`.
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

Move the host to a branch, tag, or commit, reread the config parameter, and restart `serve`:

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
ref and commit. To roll back, update to the previous commit.

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
```

On the host: `tail -f /var/log/sergeant/serve.log`, `journalctl -u sergeant -u caddy`, run records
under `/var/lib/sergeant/state/runs/`, and `sudo docker ps --filter label=sergeant.run`.

### Stop

`sudo systemctl stop sergeant` on the host stops intake and ends each task at its next poll; running
containers are left alone. `sudo systemctl start sergeant` resumes from the state dir.
