#!/usr/bin/env bash
# Moves the host to a newer green commit of main when the installation config's `release` setting
# says to (deploy/README.md, Automatic updates), or does what an approver asked through `sgt admin`
# (TECH-5195). Run as root by sergeant-autoupdate.service: every 10 minutes from its timer, and as soon
# as serve leaves a request, from its path unit; installed at /usr/local/sbin/sergeant-autoupdate by
# install.sh. Each run logs its decision (/var/log/sergeant/autoupdate.log, shipped to the log group)
# and makes at most a few anonymous GitHub API calls; the source repository is public.
#
#   release: { "channel": "main" }                          main's head, once its v2 check passed
#   release: { "channel": "soaked", "soakMinutes": 90 }     the newest green main commit pushed at
#                                                           least soakMinutes ago
#   "paused": true in either, or no `release` at all        never update by itself
#
# An approver's request (serve writes it to $request, contracts' admin.ts) is taken before any tick:
#
#   restart         sergeant-update to the release the host is on: reread the config, restart serve
#   update [<ref>]  sergeant-update to <ref>, which must be a commit on main whose v2 check passed;
#                   without one, what the release channel would choose (`main` when there is none),
#                   even while paused
#
# An update, an approver's or automatic, writes its outcome to $result for `sgt admin status`.
set -euo pipefail
export HOME=${HOME:-/root}
set -a
# shellcheck source=/dev/null
. /etc/sergeant/host.env
set +a
api=https://api.github.com/repos/${SERGEANT_SOURCE_REPOSITORY_URL#https://github.com/}
failed=/etc/sergeant/autoupdate-failed
request=/var/lib/sergeant/state/admin-request.json
result=/etc/sergeant/admin-result.json
# What the outcome names; `action` is set once there is an outcome to record.
id='' action='' ref='' by='' started='' output=''

log() { echo "$(date -u +%FT%TZ) $*"; }

# Ends this run: logs why and, once there is an outcome to record, records it.
finish() { # <outcome> <exit status> <message>
  log "$3"
  [ -z "$action" ] || record "$1" "$3"
  exit "$2"
}

record() { # <outcome> <message>
  jq -n --arg id "$id" --arg action "$action" --arg ref "$ref" --arg by "$by" --arg outcome "$1" --arg message "$2" \
    --arg startedAt "$started" --arg sha "$(sed -n 's/^sha=//p' /etc/sergeant/release 2>/dev/null)" --arg output "$output" '
    {$id, $action, $ref, $by, $outcome, $message, $startedAt, $sha, $output}
    | with_entries(select(.value != ""))
    | if $outcome == "running" then . else .finishedAt = (now | todate) end' >"$result.tmp"
  mv "$result.tmp" "$result"
}

# Sets `got` to the API's answer, or ends the run.
github() {
  got=$(curl -fsS --max-time 30 -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$api/$1") ||
    finish failed 1 "cannot read $api/$1; not updating"
}

# sergeant-update, its output in the log and its last lines kept for the outcome.
install() { # <sha>
  local status=0 out
  out=$(mktemp)
  /usr/local/sbin/sergeant-update "$1" 2>&1 | tee "$out" || status=$?
  output=$(tail -n 20 "$out")
  rm -f "$out"
  return "$status"
}

# Sets `target` to what the release channel chooses, or ends the run.
choose() { # <channel> <soakMinutes>
  local channel=$1 soak=$2 runs newer
  case $channel in
    main) ;;
    soaked) [[ $soak =~ ^[1-9][0-9]*$ ]] || finish failed 1 "release.soakMinutes must be a positive integer; not updating" ;;
    *) finish failed 1 "unknown release.channel '$channel'; not updating" ;;
  esac
  if [ "$channel" = main ]; then
    # The latest v2 check run on main's head, from GitHub Actions (app 15368) only.
    github "commits/main/check-runs?check_name=v2&app_id=15368"
    target=$(jq -r '.check_runs[0].head_sha // empty' <<<"$got")
    local state
    state=$(jq -r '.check_runs[0] | .conclusion // .status // empty' <<<"$got")
    [ -n "$target" ] || finish unchanged 0 "main's head has no v2 check yet; not updating"
    [ "$state" = success ] || finish unchanged 0 "main's head $target: v2 is $state; not updating"
  else
    # Successful v2 runs of pushes to main, newest first; a run is created when its commit lands on main.
    github "actions/workflows/v2.yml/runs?branch=main&event=push&status=success&per_page=100"
    runs=$got
    read -r target newer < <(jq -r --arg cutoff "$(date -u -d "-$soak minutes" +%FT%TZ)" --arg current "$current" '
      .workflow_runs as $runs
      | ([$runs[] | select(.created_at <= $cutoff)][0]) as $t
      | if $t == null then "none false"
        else "\($t.head_sha) \(any($runs[]; .head_sha == $current and .created_at > $t.created_at))" end' <<<"$runs")
    [ "$target" != none ] || finish unchanged 0 "no green main commit has soaked $soak minutes; not updating"
    [ "$newer" = false ] || finish unchanged 0 "on $current, newer than the soaked $target; not updating"
  fi
}

# Sets `target` to the commit an approver named, or ends the run: only a green commit on main deploys.
resolve() { # <ref>
  github "commits/$1"
  target=$(jq -r '.sha // empty' <<<"$got")
  [ -n "$target" ] || finish failed 1 "GitHub has no commit for $1"
  github "compare/$target...main?per_page=1"
  [[ $(jq -r '.status' <<<"$got") =~ ^(ahead|identical)$ ]] || finish failed 1 "$1 ($target) is not a commit on main; not updating"
  github "commits/$target/check-runs?check_name=v2&app_id=15368"
  local state
  state=$(jq -r '.check_runs[0] | .conclusion // .status // empty' <<<"$got")
  [ "$state" = success ] || finish failed 1 "$1 ($target): v2 is ${state:-missing}, not green; not updating"
}

# Installs `target`; if that fails after checking it out, reinstalls the release the host was on.
deploy() { # <who, for the log>
  [ "$target" != "$current" ] || finish unchanged 0 "up to date at $current ($1)"
  if [ -z "$action" ]; then
    [ "$target" != "$(cat "$failed" 2>/dev/null)" ] ||
      finish unchanged 0 "$target failed to install before; waiting for a newer commit (rm $failed to retry)"
    action=automatic by="the release channel ($1)" started=$(date -u +%FT%TZ)
  fi
  log "updating ${current:-nothing} to $target ($1)"
  record running "updating ${current:-nothing} to $target"
  if install "$target"; then
    rm -f "$failed"
    output=''
    finish succeeded 0 "updated ${current:-nothing} to $target"
  fi
  # sergeant-update records the release once it has checked the commit out; before that nothing changed.
  if [ "$(sed -n 's/^sha=//p' /etc/sergeant/release 2>/dev/null)" = "$current" ]; then
    finish failed 1 "update to $target did not start: $(tail -n 1 <<<"$output")"
  fi
  echo "$target" >"$failed"
  [ -n "$current" ] || finish failed 1 "update to $target failed and there is no previous release to go back to"
  # The outcome keeps the failed update's output, which says why, not the reinstall's.
  local why=$output
  if install "$current"; then
    output=$why
    finish failed 1 "update to $target failed; reinstalled $current"
  fi
  output=$why
  finish failed 1 "update to $target failed, and so did reinstalling $current; needs an operator"
}

# Takes an approver's request, so no later run repeats it, whatever happens next. serve wrote it; it is
# checked again here, and only its id, action, ref, and who asked are used. A valid one is recorded
# running before it is removed, so a waiting `sgt` never sees it neither pending nor running.
take() {
  local body asked
  if [ -L "$request" ] || [ ! -f "$request" ]; then
    rm -rf -- "$request"
    finish failed 1 "ignoring an admin request that is not a plain file"
  fi
  body=$(head -c 4096 "$request")
  id=$(jq -r '.id // empty' <<<"$body" 2>/dev/null) || true
  [[ $id =~ ^[A-Za-z0-9-]{1,64}$ ]] || { drop; finish failed 1 "ignoring an admin request with no valid id"; }
  by=$(jq -r '.by // empty' <<<"$body" | tr -d '[:cntrl:]' | cut -c1-200)
  ref=$(jq -r '.ref // empty' <<<"$body")
  asked=$(jq -r '.action // empty' <<<"$body")
  started=$(date -u +%FT%TZ)
  action=update # until it is known, so a refusal below is still recorded for the request
  [[ $asked =~ ^(restart|update)$ ]] || { drop; finish failed 1 "ignoring admin request $id: unknown action '$asked'"; }
  action=$asked
  [ -z "$ref" ] || { [[ $ref =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$ ]] && [[ $ref != *..* ]]; } ||
    { drop; finish failed 1 "admin request $id: '$ref' is not a branch, tag, or commit sha"; }
  log "admin $action${ref:+ to $ref} by ${by:-unknown} ($id)"
  # Removed even if recording fails: a request left in place would start this unit again at once.
  record running "taken by the host" || true
  drop
}

drop() { rm -f -- "$request"; }

# Does what the approver asked; every way out records its outcome.
requested() {
  flock -n /run/sergeant-update.lock true || finish failed 1 "another sergeant-update is running; try again once it finishes"
  if [ "$action" = restart ]; then
    [ -n "$current" ] || finish failed 1 "no release is installed to restart"
    install "$current" || finish failed 1 "restarting on $current failed"
    output=''
    finish succeeded 0 "reread the installation config and restarted serve on $current"
  fi
  if [ -n "$ref" ]; then
    resolve "$ref"
  else
    local setting=${release:-null}
    choose "$(jq -r '.channel // "main"' <<<"$setting")" "$(jq -r '.soakMinutes // empty' <<<"$setting")"
  fi
  deploy "requested by ${by:-unknown}"
}

# A function, so bash has read all of it before install.sh replaces this file mid-update.
main() {
  # Runs never overlap (one service unit), so an outcome still running is one the host stopped.
  if [ "$(jq -r '.outcome // empty' "$result" 2>/dev/null)" = running ]; then
    jq '.outcome = "failed" | .message = "interrupted before it finished" | .finishedAt = (now | todate)' "$result" >"$result.tmp" &&
      mv "$result.tmp" "$result"
  fi
  if [ -e "$request" ] || [ -L "$request" ]; then take; fi
  # Read every run, so a pause takes effect without an update.
  config=$(aws ssm get-parameter --region "$AWS_REGION" --name "$SERGEANT_CONFIG_PARAMETER" \
    --query Parameter.Value --output text) || finish failed 1 "cannot read $SERGEANT_CONFIG_PARAMETER; not updating"
  release=$(jq -c '.release // empty' <<<"$config")
  current=$(sed -n 's/^sha=//p' /etc/sergeant/release 2>/dev/null || true)
  [ -z "$action" ] || requested

  [ -n "$release" ] || finish unchanged 0 "no release setting; not updating"
  [ "$(jq -r '.paused // false' <<<"$release")" != true ] || finish unchanged 0 "paused; not updating"
  # sergeant-update holds this lock for the whole update.
  flock -n /run/sergeant-update.lock true || finish unchanged 0 "sergeant-update is running; not updating"
  local channel
  channel=$(jq -r '.channel' <<<"$release")
  choose "$channel" "$(jq -r '.soakMinutes // empty' <<<"$release")"
  deploy "$channel"
}
main
