#!/usr/bin/env bash
# Installs the installation config into <dir> (/etc/sergeant on the host), with the runner image and
# Fargate settings it needs: `install-config.sh <dir>`, run by install.sh before it restarts `serve`.
# Needs AWS_REGION and SERGEANT_CONFIG_PARAMETER, and the runner image built as sergeant-runner:local.
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

# --- Workers on Fargate (TECH-5237). Once Terraform has made its resources (terraform/fargate.tf), the
# runner image just built goes to ECR tagged by this commit, and where tasks run, with that image, goes to
# <dir>/fargate-runner.json for serve. A failed push fails the install only when the staged config runs
# workers on Fargate, before that config is installed; otherwise this host's own runner needs none of it. ---
fargate_parameter=/sergeant/v2/fargate-runner
if fargate=$(aws ssm get-parameter --region "$AWS_REGION" --name "$fargate_parameter" --query Parameter.Value --output text 2>/dev/null); then
  ecr=$(jq -r .repositoryUrl <<<"$fargate")
  image="$ecr:$(git -C "$repo" rev-parse HEAD)"
  if aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${ecr%%/*}" >/dev/null &&
    docker tag sergeant-runner:local "$image" && docker push -q "$image" >/dev/null; then
    docker logout "${ecr%%/*}" >/dev/null 2>&1 || true
    jq --arg image "$image" 'del(.repositoryUrl) + {image: $image}' <<<"$fargate" >"$staged/fargate-runner.json"
    install -m 0644 "$staged/fargate-runner.json" "$dir/fargate-runner.json"
    echo "pushed the runner image to $image"
  else
    docker logout "${ecr%%/*}" >/dev/null 2>&1 || true
    if [ "$workers" = fargate ]; then
      echo "cannot push the runner image to $image, and the new config runs workers on Fargate; the previous config stays and serve was not restarted" >&2
      exit 1
    fi
    echo "cannot push the runner image to $image; workers run on this host, so the install goes on" >&2
  fi
elif [ "$workers" = fargate ]; then
  echo "no $fargate_parameter (terraform/fargate.tf), and the new config runs workers on Fargate; the previous config stays and serve was not restarted" >&2
  exit 1
else
  echo "no $fargate_parameter yet (terraform/fargate.tf): workers can run only on this host"
fi

# The config first: a serve restarted between the two finds it current, as it is.
install -m 0644 "$staged/installation.json" "$dir/installation.json"
install -m 0644 "$staged/installation.json.version" "$dir/installation.json.version"
