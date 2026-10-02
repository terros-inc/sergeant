#!/usr/bin/env bash
# Moves the Sergeant 2 host to a git ref and reinstalls from it: `sergeant-update <branch|tag|sha>`,
# as root (over SSM; see deploy/README.md). Installed at /usr/local/sbin/sergeant-update by the
# first boot and refreshed by every install, so the version that runs is the last one installed.
#
# The host holds no personal credential: it fetches with a short-lived installation token of the
# control-plane GitHub App named in the installation config (the SSM parameter), narrowed to the
# source repository with contents read, so a private repository works too. The token goes to git
# through the environment, never a command line, and is not stored.
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
for tool in git jq curl openssl unzip; do command -v "$tool" >/dev/null || missing+=("$tool"); done
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

config=$(aws ssm get-parameter --region "$AWS_REGION" --name "$SERGEANT_CONFIG_PARAMETER" \
  --query Parameter.Value --output text) || {
  echo "cannot read the installation config parameter $SERGEANT_CONFIG_PARAMETER (README, Before the first apply)" >&2
  exit 1
}
app_id=$(jq -er .github.controlPlaneApp.appId <<<"$config")
installation_id=$(jq -er .github.controlPlaneApp.installationId <<<"$config")
key_secret=$(jq -er .github.controlPlaneApp.privateKeySecret <<<"$config")
repository=${SERGEANT_SOURCE_REPOSITORY_URL#https://github.com/}

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
key=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$key_secret" \
  --query SecretString --output text)
now=$(date +%s)
claims=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$app_id")
unsigned="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url).$(printf '%s' "$claims" | b64url)"
jwt="$unsigned.$(printf '%s' "$unsigned" | openssl dgst -sha256 -binary -sign <(printf '%s\n' "$key") | b64url)"
unset key
body=$(jq -nc --arg repo "${repository#*/}" '{repositories: [$repo], permissions: {contents: "read"}}')
if ! response=$(curl -fsS -X POST --data "$body" \
  -H "Accept: application/vnd.github+json" -H @<(printf 'Authorization: Bearer %s\n' "$jwt") \
  "https://api.github.com/app/installations/$installation_id/access_tokens"); then
  echo "could not mint a token for $repository: is the control-plane App installed on it?" >&2
  exit 1
fi
token=$(jq -r .token <<<"$response")

mkdir -p "$src"
[ -d "$src/.git" ] || git init -q "$src"
git -C "$src" remote remove origin 2>/dev/null || true
git -C "$src" remote add origin "$SERGEANT_SOURCE_REPOSITORY_URL.git"
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com/.extraheader \
  GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$token" | openssl base64 -A)" \
  git -C "$src" fetch -q --depth 1 origin "$ref"
unset token
git -C "$src" checkout -q --force --detach FETCH_HEAD
git -C "$src" clean -qfdx -e node_modules
printf 'ref=%s\nsha=%s\nat=%s\n' "$ref" "$(git -C "$src" rev-parse HEAD)" "$(date -u +%FT%TZ)" >/etc/sergeant/release
echo "checked out $ref at $(git -C "$src" rev-parse --short HEAD)"

exec "$src/deploy/host/install.sh"
