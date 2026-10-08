#!/usr/bin/env bash
# sarge snapshot: the non-Linear half of a /sarge run, in one call.
# Prints four sections: OPEN PRS, TASK STATE (each task's latest service event),
# SERVER (load, memory, workers, deployed vs main), QUOTA (Sergeant's registered accounts from its latest launch, then accounts-axi).
# Linear data (issues, comments, relations) comes from the linear-terros MCP, not from here.
#
# ⚠️  WARNING: This script executes commands on the production Sergeant host via AWS Systems Manager (SSM).
#     All SSM commands run directly on the server identified by SARGE_INSTANCE_ID.
#
# Usage: snapshot.sh [--since <minutes>]   (task-state lookback, default 120)
#
# Required environment variables (no defaults; set these explicitly):
#   SARGE_REPO           GitHub repository (e.g., terros-inc/sergeant)
#   SARGE_AWS_PROFILE    AWS profile name (e.g., terros-sergeant)
#   SARGE_REGION         AWS region (e.g., us-west-2)
#   SARGE_INSTANCE_ID    EC2 instance ID (e.g., i-0abc123def456789)
#   SARGE_LOG_GROUP      CloudWatch log group (e.g., /sergeant/v2)
#   SARGE_SSO_SESSION    AWS SSO session name (e.g., terros)
set -uo pipefail

SINCE=120
REVIEWS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="${2:-120}"; shift 2 ;;
    --reviews) REVIEWS="${2:-}"; shift 2 ;;  # comma-separated TECH ids: print only Sergeant's review telemetry
    *) shift ;;
  esac
done

# Require all configuration via environment variables
REPO="${SARGE_REPO:?SARGE_REPO not set}"
export AWS_PROFILE="${SARGE_AWS_PROFILE:?SARGE_AWS_PROFILE not set}"
export AWS_REGION="${SARGE_REGION:?SARGE_REGION not set}"
ID="${SARGE_INSTANCE_ID:?SARGE_INSTANCE_ID not set}"
LG="${SARGE_LOG_GROUP:?SARGE_LOG_GROUP not set}"
SSO="${SARGE_SSO_SESSION:?SARGE_SSO_SESSION not set}"

if [ -n "$REVIEWS" ]; then
  # Sergeant's own review records (reviews.jsonl) per task, read-only, one line per review.
  # ⚠️  This sends a Python script to the production host and executes it via SSM.
  PY=$(cat <<'EOF'
import json, sys, os
for t in sys.argv[1].split(","):
    f = "/var/lib/sergeant/state/tasks/%s/reviews.jsonl" % t.strip()
    if not os.path.exists(f):
        print(t, "no Sergeant review records"); continue
    for l in open(f):
        if not l.strip(): continue
        r = json.loads(l)
        subj = ",".join("#%s@%s" % (s.get("number"), s.get("headSha", "")[:7]) for s in r.get("subject", []))
        m = r.get("merged") or {}
        fd = r.get("findings") or {}
        print(t, r.get("trigger"), r.get("verdict"), "blocking=%s nonBlocking=%s" % (fd.get("blocking"), fd.get("nonBlocking")),
              "vendor=%s" % r.get("vendor"), "reviewed=" + subj, ("merged@" + m.get("headSha", "")[:7]) if m else "")
EOF
)
  B64=$(printf '%s' "$PY" | base64 | tr -d '\n')
  CMD=$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
    --parameters "commands=[\"echo $B64 | base64 -d > /tmp/sarge-rv.py && python3 /tmp/sarge-rv.py $REVIEWS\"]" \
    --query Command.CommandId --output text 2>/dev/null)
  [ -n "$CMD" ] && aws ssm wait command-executed --command-id "$CMD" --instance-id "$ID" 2>/dev/null
  [ -n "$CMD" ] && aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" --query StandardOutputContent --output text
  exit 0
fi

echo "== OPEN PRS ($REPO)"
gh pr list --repo "$REPO" --state open --limit 50 \
  --json number,title,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt \
  --jq '.[] | "#\(.number)\t\(.mergeStateStatus)\t\(.reviewDecision // "-")\tchecks=" + ([.statusCheckRollup[] | .conclusion // .status] | join(",")) + "\tupd=\(.updatedAt[11:16])Z\t\(.title[:70])"' \
  || echo "(gh failed)"

echo
echo "== TASK STATE (latest service event per task, last ${SINCE}m)"
aws logs tail "$LG" --log-stream-name-prefix "$ID/serve" --since "${SINCE}m" 2>/dev/null \
  | grep -E "\] [A-Z]+-[0-9]+: " \
  | sed -E 's/^[^[]*\[([^]]*)\] ([A-Z]+-[0-9]+): /\1 \2 /' \
  | grep -v -E '^[^ ]+ [A-Z]+-[0-9]+   ' \
  | awk '{ last[$2] = substr($1,12,5) "Z " substr($0, index($0,$3), 160) } END { for (k in last) print k, last[k] }' \
  | sort \
  || echo "(log read failed - AWS SSO may need: aws sso login --sso-session $SSO)"

echo
echo "== SERVER ($ID)"
# ⚠️  This executes shell commands on the production host via SSM.
CMD=$(aws ssm send-command --instance-ids "$ID" --document-name AWS-RunShellScript \
  --parameters '{"commands":["nproc | sed s/^/cpus=/","uptime | sed s/.*load/load/","free -m | awk \"/Mem/{print \\\"mem_used_mb=\\\" \\$3 \\\" of \\\" \\$2}\"","echo workers=$(docker ps -q | wc -l)","grep -h ^sha= /etc/sergeant/release 2>/dev/null | cut -c1-12","df -h / | tail -1 | tr -s \" \" | cut -d\" \" -f2,5 | sed s/^/disk_size_used=/","curl -s -m5 http://127.0.0.1:8080/status | head -c 700"]}' \
  --query Command.CommandId --output text 2>/dev/null)
if [ -n "$CMD" ]; then
  aws ssm wait command-executed --command-id "$CMD" --instance-id "$ID" 2>/dev/null
  aws ssm get-command-invocation --command-id "$CMD" --instance-id "$ID" --query StandardOutputContent --output text
else
  echo "(ssm failed - AWS SSO may need: aws sso login --sso-session $SSO)"
fi
echo "main=$(gh api "repos/$REPO/commits/main" --jq .sha 2>/dev/null | cut -c1-12)"
aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value="$ID" \
  --start-time "$(date -u -v-1H +%FT%TZ 2>/dev/null || date -u -d '1 hour ago' +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 3600 --statistics Average Maximum \
  --query 'Datapoints[0].[Average,Maximum]' --output text 2>/dev/null \
  | awk '{ printf "cpu_last_hour avg=%.0f%% max=%.0f%%\n", $1, $2 }'

echo
echo "== QUOTA (Sergeant's registered accounts, as read at its latest launch)"
python3 "$(dirname "$0")/quota-from-sergeant.py"
echo "== QUOTA (laptop logins, accounts-axi; Claude may read unknown when its local login has expired)"
for a in $(accounts-axi list 2>/dev/null | awk -F, '/^  [a-zA-Z]+,/{ sub(/^  /,"",$1); print $1 }'); do
  accounts-axi quota "$a" --full 2>/dev/null | grep -E "^  $a,"
done
