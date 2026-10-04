#!/usr/bin/env bash
# Installs the checked-out Sergeant 2 onto this host and (re)starts `serve`. Run by
# `sergeant-update <ref>` (as root) after it checks out the ref; safe to rerun. Ubuntu 24.04, arm64.
set -euo pipefail
export HOME=${HOME:-/root} DEBIAN_FRONTEND=noninteractive COREPACK_ENABLE_DOWNLOAD_PROMPT=0
set -a
# shellcheck source=/dev/null
. /etc/sergeant/host.env
set +a
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
data=/var/lib/sergeant

# --- Packages: Docker, git, Caddy, Node 24 (with corepack for the pinned pnpm), the claude CLI. ---
apt-get update -q
apt-get install -yq docker.io docker-buildx caddy git jq curl gnupg ca-certificates
if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -yq nodejs
fi
corepack enable
# Reasoning runs the same Claude Code version as the runner image.
claude_version=$(sed -n 's/^ARG CLAUDE_CODE_VERSION=//p' "$repo/packages/runner/container/Dockerfile")
if ! claude --version 2>/dev/null | grep -q "^$claude_version "; then
  npm install -g --no-fund --no-audit "@anthropic-ai/claude-code@$claude_version"
fi
if ! command -v amazon-cloudwatch-agent-ctl >/dev/null; then
  curl -fsSL https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb -o /tmp/cwagent.deb
  apt-get install -yq /tmp/cwagent.deb
  rm -f /tmp/cwagent.deb
fi

# --- The data volume: the service state dir. Formatted only if it holds no filesystem. ---
device=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${SERGEANT_DATA_VOLUME_ID//-/}
for _ in $(seq 120); do [ -e "$device" ] && break; sleep 5; done
[ -e "$device" ] || { echo "data volume $SERGEANT_DATA_VOLUME_ID is not attached" >&2; exit 1; }
probe=0
blkid -p "$device" >/dev/null || probe=$?
if [ "$probe" -eq 2 ]; then # nothing on it: a new volume
  mkfs.ext4 -q -L sergeant-data "$device"
elif [ "$probe" -ne 0 ]; then
  echo "cannot probe the data volume (blkid exit $probe); not touching it" >&2
  exit 1
fi
grep -q "^LABEL=sergeant-data " /etc/fstab || echo "LABEL=sergeant-data $data ext4 defaults,nofail 0 2" >>/etc/fstab
mkdir -p "$data"
mountpoint -q "$data" || mount "$data"

# --- The service user. Its uid must be 1000, the runner image's `node` user, so a run's container can
# write the workspace the service creates and the service can read what the run wrote. ---
if ! id sergeant >/dev/null 2>&1; then
  if getent passwd 1000 >/dev/null; then
    echo "uid 1000 belongs to $(getent passwd 1000 | cut -d: -f1); the sergeant user needs it" >&2
    exit 1
  fi
  useradd --uid 1000 --create-home --shell /usr/sbin/nologin sergeant
fi
usermod -aG docker sergeant
install -d -o sergeant -g sergeant "$data/state"
install -d -m 0755 /var/log/sergeant

# --- The runner image and the source's dependencies. ---
systemctl enable --now docker
docker build -q -t sergeant-runner:local "$repo/packages/runner/container"
(cd "$repo" && corepack pnpm install --frozen-lockfile --config.confirmModulesPurge=false)
# Sergeant's version from git; a fallback (no tag, shallow clone) is logged, never fatal.
version=$(cd "$repo/packages/contracts" && node --input-type=module -e \
  'const v = (await import("./src/version.ts")).sergeantVersion(); console.log(v.version + (v.fallback ? ` (fallback: ${v.fallback})` : ""))') ||
  version="unknown (the version check failed)"
echo "installing Sergeant $version"

# --- Host configuration from this checkout. ---
install -m 0755 "$here/sergeant-update.sh" /usr/local/sbin/sergeant-update
install -m 0755 "$here/sergeant-autoupdate.sh" /usr/local/sbin/sergeant-autoupdate
install -m 0644 "$here/sergeant.service" "$here/sergeant-autoupdate.service" "$here/sergeant-autoupdate.timer" \
  "$here/sergeant-autoupdate.path" /etc/systemd/system/
install -m 0644 "$here/logrotate" /etc/logrotate.d/sergeant
sed "s/__HOSTNAME__/$SERGEANT_HOSTNAME/" "$here/Caddyfile" >/tmp/Caddyfile
if ! cmp -s /tmp/Caddyfile /etc/caddy/Caddyfile; then
  mv /tmp/Caddyfile /etc/caddy/Caddyfile
  systemctl restart caddy
fi
systemctl enable --now caddy
sed "s#__LOG_GROUP__#$SERGEANT_LOG_GROUP#" "$here/cloudwatch-agent.json" >/opt/aws/amazon-cloudwatch-agent/etc/sergeant.json
amazon-cloudwatch-agent-ctl -a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/etc/sergeant.json >/dev/null

# --- The installation config (identifiers and secret references only) from its SSM parameter. A
# config that does not parse never replaces the running service's. ---
aws ssm get-parameter --region "$AWS_REGION" --name "$SERGEANT_CONFIG_PARAMETER" \
  --query Parameter.Value --output text >/tmp/installation.json
if ! (cd "$repo/packages/sergeant" &&
  node --input-type=module -e 'await (await import("./src/config.ts")).loadConfig(process.argv[1])' /tmp/installation.json); then
  echo "$SERGEANT_CONFIG_PARAMETER is not a valid installation config; serve was not restarted" >&2
  exit 1
fi
install -m 0644 /tmp/installation.json /etc/sergeant/installation.json
rm -f /tmp/installation.json

# --- Restart serve. SIGTERM lets each task end at its next poll; running workers keep running and
# the new process picks them up. ---
systemctl daemon-reload
systemctl enable sergeant
# Ticks do nothing until the installation config has a `release` setting. Starting the timer starts
# no tick, so it leaves alone the one that may be running this install.
systemctl enable --now sergeant-autoupdate.timer
# An approver's `sgt admin` request starts a run at once (TECH-5195). If this install is that run, the
# unit is already active, so starting the path unit starts nothing.
systemctl enable --now sergeant-autoupdate.path
systemctl restart sergeant
for _ in $(seq 60); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "serve is up at $version: $(curl -sS http://127.0.0.1:8080/status)"
    exit 0
  fi
  sleep 5
done
echo "serve is not healthy at /health; last log lines:" >&2
tail -n 40 /var/log/sergeant/serve.log >&2
exit 1
