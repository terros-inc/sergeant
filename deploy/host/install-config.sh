#!/usr/bin/env bash
# Installs the installation config into <dir> (/etc/sergeant on the host), with the runner image and
# Fargate settings it needs: `install-config.sh <dir>`, run by install.sh before it restarts `serve`.
# Needs AWS_REGION and SERGEANT_CONFIG_PARAMETER. It builds and pushes the two Fargate images only
# after Terraform's settings exist; the ordinary local base image was already built by install.sh.
# A failure leaves <dir> with the previous installation, so a serve systemd restarts later still finds
# a coherent one (TECH-5273).
set -euo pipefail
dir=${1:?usage: install-config.sh <dir>}
repo=$(cd "$(dirname "$0")/../.." && pwd)
staged=$(mktemp -d)
trap 'rm -rf "$staged"' EXIT

# --- The installation config (identifiers and secret references only) from its SSM parameter, staged
# until everything it needs is ready. A config that does not parse never replaces the running service's.
# Its version goes beside it, read in the same call, so a serve systemd restarts later can tell which
# version it runs (TECH-5206). ---
aws ssm get-parameter --region "$AWS_REGION" --name "$SERGEANT_CONFIG_PARAMETER" \
  --query 'Parameter.{value: Value, version: Version}' --output json >"$staged/parameter.json"
jq -r .value "$staged/parameter.json" >"$staged/installation.json"
jq -r .version "$staged/parameter.json" >"$staged/installation.json.version"
if ! (cd "$repo/packages/sergeant" &&
  node --input-type=module -e 'await (await import("./src/config.ts")).loadConfig(process.argv[1])' "$staged/installation.json"); then
  echo "$SERGEANT_CONFIG_PARAMETER is not a valid installation config; serve was not restarted" >&2
  exit 1
fi
workers=$(jq -r '.runners.workerBackend // "local"' "$staged/installation.json")

# A local installation still reads an existing Fargate file to collect runs that started there. When
# this release first replaces the single-image shape, keep that old image only for those existing
# runs; a later Fargate install must publish both current images before it can enable new launches.
validate_fargate() {
  (cd "$repo/packages/runner" &&
    node --input-type=module -e 'const { FargateSettings } = await import("./src/fargate/aws.ts"); FargateSettings.parse(JSON.parse(await (await import("node:fs/promises")).readFile(process.argv[1], "utf8")))' "$1")
}
stage_existing_fargate() {
  local current="$dir/fargate-runner.json"
  [ -e "$current" ] || return 0
  if validate_fargate "$current" >/dev/null 2>&1; then
    return 0
  fi
  if ! jq -e '
    (.region | type == "string" and length > 0) and
    (.cluster | type == "string" and length > 0) and
    (.subnets | type == "array" and length > 0) and
    (.securityGroup | type == "string" and length > 0) and
    (.executionRoleArn | type == "string" and length > 0) and
    (.logGroup | type == "string" and length > 0) and
    (.taskFamily | type == "string" and length > 0) and
    (.image | type == "string" and length > 0)
  ' "$current" >/dev/null 2>&1; then
    echo "$current is neither the current nor legacy Fargate settings shape; serve was not restarted" >&2
    exit 1
  fi
  jq '{
    region, cluster, subnets, securityGroup, executionRoleArn, logGroup,
    profiles: {
      base: {
        taskFamily: .taskFamily, image: .image, cpu: (.cpu // "2048"), memory: (.memory // "8192"),
        architecture: "ARM64", ephemeralStorageGiB: 21
      },
      android: {
        taskFamily: .taskFamily, image: .image, cpu: "4096", memory: "16384",
        architecture: "X86_64", ephemeralStorageGiB: 50
      }
    }
  }' "$current" >"$staged/fargate-runner.json"
}

# --- Workers on Fargate (TECH-5237). Once Terraform has made its resources (terraform/fargate.tf), the
# runner image just built goes to ECR tagged by this commit, and where tasks run, with that image, goes to
# <dir>/fargate-runner.json for serve. A failed push fails the install only when the staged config runs
# workers on Fargate, before that config is installed; otherwise this host's own runner needs none of it. ---
fargate_parameter=/sergeant/v2/fargate-runner
if fargate=$(aws ssm get-parameter --region "$AWS_REGION" --name "$fargate_parameter" --query Parameter.Value --output text 2>/dev/null); then
  ecr=$(jq -r .repositoryUrl <<<"$fargate")
  sha=$(git -C "$repo" rev-parse HEAD)
  base_image="$ecr:$sha-base"
  android_image="$ecr:$sha-android"
  builder=sergeant-multiarch
  if aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${ecr%%/*}" >/dev/null &&
    { docker buildx inspect "$builder" >/dev/null 2>&1 || docker buildx create --name "$builder" --driver docker-container >/dev/null; } &&
    docker buildx build --builder "$builder" --quiet --platform linux/arm64,linux/amd64 --push -t "$base_image" "$repo/packages/runner/container" >/dev/null &&
    docker buildx build --builder "$builder" --quiet --platform linux/amd64 --push -t "$android_image" \
      --build-arg "BASE_IMAGE=$base_image" -f "$repo/packages/runner/container/Dockerfile.android" "$repo/packages/runner/container" >/dev/null; then
    docker logout "${ecr%%/*}" >/dev/null 2>&1 || true
    jq --arg base "$base_image" --arg android "$android_image" \
      'del(.repositoryUrl) | .profiles.base.image = $base | .profiles.android.image = $android' <<<"$fargate" >"$staged/fargate-runner.json"
    echo "pushed the base runner image to $base_image and Android runner image to $android_image"
  else
    docker logout "${ecr%%/*}" >/dev/null 2>&1 || true
    if [ "$workers" = fargate ]; then
      echo "cannot push the runner images, and the new config runs workers on Fargate; the previous config stays and serve was not restarted" >&2
      exit 1
    fi
    stage_existing_fargate
    echo "cannot push the runner images; workers run on this host, so the install goes on" >&2
  fi
elif [ "$workers" = fargate ]; then
  echo "no $fargate_parameter (terraform/fargate.tf), and the new config runs workers on Fargate; the previous config stays and serve was not restarted" >&2
  exit 1
else
  stage_existing_fargate
  echo "no $fargate_parameter yet (terraform/fargate.tf): workers can run only on this host"
fi

# The Fargate settings first: new code can read the migrated shape if serve restarts between writes.
if [ -e "$staged/fargate-runner.json" ]; then
  validate_fargate "$staged/fargate-runner.json"
  install -m 0644 "$staged/fargate-runner.json" "$dir/.fargate-runner.json.new"
  mv -f "$dir/.fargate-runner.json.new" "$dir/fargate-runner.json"
fi
install -m 0644 "$staged/installation.json" "$dir/installation.json"
install -m 0644 "$staged/installation.json.version" "$dir/installation.json.version"
