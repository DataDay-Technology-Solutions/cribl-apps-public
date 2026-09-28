#!/usr/bin/env bash
# Keeps scripts/runner.ts running on a machine without launchd (the demo org's runner is a launchd agent: RUNBOOK 6.1).
# Restarts it after an exit with exponential back-off (10 s, 20 s, 40 s … at most 5 min; back to 10 s after a run of
# 10 minutes or more), and stops for good when the runner refuses to start because another one is running (exit 3).
#
#   Start:   nohup bash scripts/runner-supervise.sh >> logs/runner.out 2>&1 &
#   Stop:    pkill -f runner-supervise.sh; pkill -f scripts/runner.ts      (the supervisor first, or it restarts it)
#   Pinned:  MR_RUNNER_DIR=~/srv/meter-reader bash scripts/runner-supervise.sh
#            runs the runner from that checkout (a `git archive` of a commit, RUNBOOK 6.1) instead of this working
#            tree, so an edit in progress here never reaches the org. Without it, a warning is logged when core/ or
#            scripts/ have uncommitted changes.
set -u
ROOT="${MR_RUNNER_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT" || exit 1
LOG_DIR="${MR_RUNNER_LOG_DIR:-logs}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/runner.log"
say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) supervisor: $1" >> "$LOG"; }

if [ -z "${MR_RUNNER_DIR:-}" ] && command -v git >/dev/null 2>&1 && [ -n "$(git status --porcelain -- core scripts 2>/dev/null)" ]; then
  say "warning: running from a working tree with uncommitted changes in core/ or scripts/; set MR_RUNNER_DIR to a pinned checkout"
fi

delay=10
MAX_DELAY=300
HEALTHY_RUN=600
while true; do
  started=$(date +%s)
  npx tsx scripts/runner.ts
  code=$?
  ran=$(( $(date +%s) - started ))
  if [ "$code" -eq 3 ]; then
    say "runner exited with code 3 (another runner is running); not restarting"
    exit 3
  fi
  if [ "$ran" -ge "$HEALTHY_RUN" ]; then delay=10; fi
  say "runner exited with code ${code} after ${ran} s; restarting in ${delay} s"
  sleep "$delay"
  delay=$(( delay * 2 ))
  if [ "$delay" -gt "$MAX_DELAY" ]; then delay=$MAX_DELAY; fi
done
