#!/usr/bin/env python3
"""Print each Sergeant-registered account's quota as Sergeant read it at its latest launch.

Sergeant reads every registered account's live quota (weekly and 5-hour windows) right before each
worker or reviewer launch, with long-lived setup-token credentials, so this works even when the
laptop's own Claude logins have expired. Reset times print in local time.

Required environment variables:
  SGT_API_URL    Sergeant API base URL (e.g., https://sergeant.terros.com)
"""
import json
import os
import subprocess
import sys
from datetime import datetime

# Require explicit configuration
api_url = os.environ.get("SGT_API_URL")
if not api_url:
    print("  SGT_API_URL not set", file=sys.stderr)
    sys.exit(1)

env = dict(os.environ)
env["SGT_API_URL"] = api_url


def sgt(*args):
    out = subprocess.run(["sgt", "--json", *args], capture_output=True, text=True, env=env).stdout
    return json.loads(out)


def when(window):
    if not window or not window.get("resetsAt"):
        return "?"
    dt = datetime.fromisoformat(window["resetsAt"].replace("Z", "+00:00")).astimezone()
    return dt.strftime("%a %-I:%M %p %Z")


def pct(window):
    return f"{window['remainingPercent']:g}%" if window else "unknown"


try:
    listed = sgt("run", "list")
except Exception:
    print("  could not list runs")
    raise SystemExit(0)

runs = listed if isinstance(listed, list) else listed.get("runs", [])

# Sort runs by start time (newest first) to find the most recent run with quota readings,
# rather than relying on task id order which can skip newer runs on older tickets.
runs_sorted = sorted(runs, key=lambda r: r.get("startedAt", ""), reverse=True)

for r in runs_sorted:
    try:
        run = sgt("run", "show", r["runId"])
    except Exception:
        continue
    run = run.get("run", run)
    readings = (run.get("providerChoice") or {}).get("readings")
    if not readings:
        continue
    read_at = readings[0].get("readAt", "?")
    print(f"  (read at {read_at})")
    for q in readings:
        name = q["account"].split(":")[-1]
        w, f = q.get("weekly"), q.get("fiveHour")
        print(f"  {name}: week {pct(w)} left (resets {when(w)}), 5-hour {pct(f)} left (resets {when(f)})")
    break
else:
    print("  no recent run with quota readings")
