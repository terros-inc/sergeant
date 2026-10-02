#!/usr/bin/env bash
# Moves the Sergeant 2 host to a git ref and reinstalls from it: `sergeant-update <branch|tag|sha>`,
# as root (over SSM; see deploy/README.md). Installed at /usr/local/sbin/sergeant-update by the
# first boot and refreshed by every install, so the version that runs is the last one installed.
#
# The source repository is public, so the host fetches it anonymously over HTTPS: no credential is
# used or stored for the source.
set -euo pipefail
ref=${1:?usage: sergeant-update <git ref>}
export HOME=${HOME:-/root}
set -a
# shellcheck source=/dev/null
. /etc/sergeant/host.env
set +a
src=/opt/sergeant/src

# One update at a time; install.sh inherits the lock.
exec 9>/run/sergeant-update.lock
flock -n 9 || { echo "another sergeant-update is running" >&2; exit 1; }

# What this script needs before any source exists.
missing=()
for tool in git curl unzip; do command -v "$tool" >/dev/null || missing+=("$tool"); done
if [ ${#missing[@]} -gt 0 ]; then
  apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -yq "${missing[@]}"
fi
if ! command -v aws >/dev/null; then
  tmp=$(mktemp -d)
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "$tmp/awscli.zip"
  unzip -q "$tmp/awscli.zip" -d "$tmp"
  "$tmp/aws/install" --update
  rm -rf "$tmp"
fi

# The installation config must exist before anything is checked out; install.sh validates it.
aws ssm get-parameter --region "$AWS_REGION" --name "$SERGEANT_CONFIG_PARAMETER" \
  --query Parameter.Value --output text >/dev/null || {
  echo "cannot read the installation config parameter $SERGEANT_CONFIG_PARAMETER (README, Before the first apply)" >&2
  exit 1
}

mkdir -p "$src"
[ -d "$src/.git" ] || git init -q "$src"
git -C "$src" remote remove origin 2>/dev/null || true
git -C "$src" remote add origin "$SERGEANT_SOURCE_REPOSITORY_URL.git"
git -C "$src" fetch -q --depth 1 origin "$ref"
git -C "$src" checkout -q --force --detach FETCH_HEAD
git -C "$src" clean -qfdx -e node_modules
printf 'ref=%s\nsha=%s\nat=%s\n' "$ref" "$(git -C "$src" rev-parse HEAD)" "$(date -u +%FT%TZ)" >/etc/sergeant/release
echo "checked out $ref at $(git -C "$src" rev-parse --short HEAD)"

exec "$src/deploy/host/install.sh"
