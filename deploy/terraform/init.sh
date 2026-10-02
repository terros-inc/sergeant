#!/usr/bin/env bash
# Reads this installation's Terraform inputs from SSM and initializes against its state, so an
# operator needs AWS credentials and nothing else on disk. Rerun before every plan and apply: it
# rewrites terraform.tfvars.json (untracked, auto-loaded) from the parameter.
#
#   EXPECTED_ACCOUNT_ID=<installation account> ./init.sh
#
# The expected account is the operator's own statement of which installation they mean, so it never
# comes from the parameter: the caller's account must match it before anything is read, and the state
# backend and the provider refuse any other. The parameter (default /sergeant/v2/infrastructure-config,
# in AWS_REGION or us-west-2) holds exactly {"backend": {bucket, region}, "variables": {...}}:
# infrastructure-config.example.json.
set -euo pipefail
cd "$(dirname "$0")"

expected=${EXPECTED_ACCOUNT_ID:?set EXPECTED_ACCOUNT_ID to the installation account}
caller=$(aws sts get-caller-identity --query Account --output text)
if [[ "$caller" != "$expected" ]]; then
  echo "these credentials are account $caller, not $expected; refusing" >&2
  exit 1
fi

parameter=${SERGEANT_INFRASTRUCTURE_PARAMETER:-/sergeant/v2/infrastructure-config}
config=$(aws ssm get-parameter --region "${AWS_REGION:-us-west-2}" --name "$parameter" \
  --query Parameter.Value --output text)

# Exactly the expected shape: backend has only the bucket and region (the state key is fixed in
# versions.tf, and no credential or endpoint setting can reach Terraform), and variables names only
# this configuration's variables, for the expected account.
declared=$(sed -n 's/^variable "\(.*\)" {$/\1/p' variables.tf | jq -R . | jq -s .)
jq -e --arg account "$expected" --argjson declared "$declared" '
  type == "object" and keys == ["backend", "variables"]
  and (.backend | type == "object" and keys == ["bucket", "region"] and all(.[]; type == "string" and length > 0))
  and (.variables | type == "object" and (keys - $declared) == [] and .account_id == $account)
' <<<"$config" >/dev/null || {
  echo "$parameter must be {\"backend\": {bucket, region}, \"variables\": {...}} naming only variables.tf's variables, with account_id $expected" >&2
  exit 1
}

jq '.variables' <<<"$config" >terraform.tfvars.json
terraform init -reconfigure -input=false \
  -backend-config="bucket=$(jq -r .backend.bucket <<<"$config")" \
  -backend-config="region=$(jq -r .backend.region <<<"$config")" \
  -backend-config="allowed_account_ids=[\"$expected\"]"
