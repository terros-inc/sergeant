#!/usr/bin/env bash
# Moves the host to a newer green commit of main when the installation config's `release` setting
# says to (deploy/README.md, Automatic updates). Run as root every 10 minutes by
# sergeant-autoupdate.timer; installed at /usr/local/sbin/sergeant-autoupdate by install.sh. Each tick
# logs its decision (/var/log/sergeant/autoupdate.log, shipped to the log group) and makes one
# anonymous GitHub API call; the source repository is public.
#
#   release: { "channel": "main" }                          main's head, once its v2 check passed
#   release: { "channel": "soaked", "soakMinutes": 90 }     the newest green main commit pushed at
#                                                           least soakMinutes ago
#   "paused": true in either, or no `release` at all        never update
set -euo pipefail
export HOME=${HOME:-/root}
set -a
# shellcheck source=/dev/null
. /etc/sergeant/host.env
set +a
api=https://api.github.com/repos/${SERGEANT_SOURCE_REPOSITORY_URL#https://github.com/}
failed=/etc/sergeant/autoupdate-failed

log() { echo "$(date -u +%FT%TZ) $*"; }
# Run in $(...), so its failure is logged to stderr (the same log file).
github() {
  curl -fsS --max-time 30 -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' "$api/$1" ||
    { log "cannot read $api/$1; not updating" >&2; exit 1; }
}

# A function, so bash has read all of it before install.sh replaces this file mid-update.
main() {
  # Read every tick, so a pause takes effect without an update.
  config=$(aws ssm get-parameter --region "$AWS_REGION" --name "$SERGEANT_CONFIG_PARAMETER" \
    --query Parameter.Value --output text) || { log "cannot read $SERGEANT_CONFIG_PARAMETER; not updating"; exit 1; }
  release=$(jq -c '.release // empty' <<<"$config")
  [ -n "$release" ] || { log "no release setting; not updating"; exit 0; }
  [ "$(jq -r '.paused // false' <<<"$release")" != true ] || { log "paused; not updating"; exit 0; }
  channel=$(jq -r '.channel' <<<"$release")
  soak=$(jq -r '.soakMinutes // empty' <<<"$release")
  case $channel in
    main) ;;
    soaked) [[ $soak =~ ^[1-9][0-9]*$ ]] || { log "release.soakMinutes must be a positive integer; not updating"; exit 1; } ;;
    *) log "unknown release.channel '$channel'; not updating"; exit 1 ;;
  esac

  # sergeant-update holds this lock for the whole update.
  flock -n /run/sergeant-update.lock true || { log "sergeant-update is running; not updating"; exit 0; }
  current=$(sed -n 's/^sha=//p' /etc/sergeant/release 2>/dev/null || true)

  if [ "$channel" = main ]; then
    # The latest v2 check run on main's head, from GitHub Actions (app 15368) only.
    runs=$(github "commits/main/check-runs?check_name=v2&app_id=15368")
    head=$(jq -r '.check_runs[0].head_sha // empty' <<<"$runs")
    state=$(jq -r '.check_runs[0] | .conclusion // .status // empty' <<<"$runs")
    [ -n "$head" ] || { log "main's head has no v2 check yet; not updating"; exit 0; }
    [ "$state" = success ] || { log "main's head $head: v2 is $state; not updating"; exit 0; }
    target=$head
  else
    # Successful v2 runs of pushes to main, newest first; a run is created when its commit lands on main.
    runs=$(github "actions/workflows/v2.yml/runs?branch=main&event=push&status=success&per_page=100")
    read -r target newer < <(jq -r --arg cutoff "$(date -u -d "-$soak minutes" +%FT%TZ)" --arg current "$current" '
      .workflow_runs as $runs
      | ([$runs[] | select(.created_at <= $cutoff)][0]) as $t
      | if $t == null then "none false"
        else "\($t.head_sha) \(any($runs[]; .head_sha == $current and .created_at > $t.created_at))" end' <<<"$runs")
    [ "$target" != none ] || { log "no green main commit has soaked $soak minutes; not updating"; exit 0; }
    [ "$newer" = false ] || { log "on $current, newer than the soaked $target; not updating"; exit 0; }
  fi

  [ "$target" != "$current" ] || { log "up to date at $current ($channel)"; exit 0; }
  [ "$target" != "$(cat "$failed" 2>/dev/null)" ] ||
    { log "$target failed to install before; waiting for a newer commit (rm $failed to retry)"; exit 0; }

  log "updating ${current:-nothing} to $target ($channel)"
  if /usr/local/sbin/sergeant-update "$target"; then
    log "updated to $target"
    rm -f "$failed"
    exit 0
  fi
  # sergeant-update records the release once it has checked the commit out; before that nothing changed.
  if [ "$(sed -n 's/^sha=//p' /etc/sergeant/release 2>/dev/null)" = "$current" ]; then
    log "update to $target did not start; retrying next tick"
    exit 1
  fi
  echo "$target" >"$failed"
  if [ -z "$current" ]; then
    log "update to $target failed and there is no previous release to go back to"
  elif /usr/local/sbin/sergeant-update "$current"; then
    log "update to $target failed; reinstalled $current"
  else
    log "update to $target failed, and so did reinstalling $current; needs an operator"
  fi
  exit 1
}
main
