#!/usr/bin/env bash
# scripts/runner-health.sh — deep health check for the hosted runner (an Automic job; see docs/RUNBOOK.md).
#
# "Is the process alive" is not health. The runner is healthy when, within the last few minutes, it
# actually completed a sweep against the Leader and wrote the result: this checks the heartbeat the
# runner writes after every sweep (logs/runner.heartbeat.json), that the sweep it reports succeeded,
# that the process launchd keeps alive is really there, and that the Leader is still reachable from
# this host with the credential in .env (a token exchange, no writes). Exit 0 = healthy; anything
# else names what broke on stdout, which Automic captures and alerts on (state change only).
#
#   bash scripts/runner-health.sh              # from the runner's checkout (cd's to its root)
#   MR_HEARTBEAT_MAX_AGE_SEC=150 bash scripts/runner-health.sh
#
# Bounded: every network step has a timeout well under Automic's job timeout, so a hanging Leader is
# reported as "Leader unreachable", never as the job timing out.
#
# Founder-build r1 core-13 (M7, #28/#32): deliveries are health too. The heartbeat carries each endpoint's run of
# failed deliveries; `deliveryOk: false` (one endpoint failed 3 in a row, e.g. a webhook receiver answering 429) is a
# FAIL here. The script keeps its last state in logs/runner-health.state and prints `STATE OK -> FAIL` / `STATE FAIL ->
# OK` only when it changes, so whatever alerts on this output alerts on the transition, never on every poll.
# Dry run against a fixture (tests): MR_HEALTH_ROOT=<dir with logs/> MR_HEALTH_SKIP_PROCESS=1 MR_HEALTH_SKIP_LEADER=1.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || { echo "FAIL cannot cd to the runner root"; exit 2; }
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
ROOT="${MR_HEALTH_ROOT:-$PWD}"

MAX_AGE="${MR_HEARTBEAT_MAX_AGE_SEC:-150}"
HB="$ROOT/logs/runner.heartbeat.json"
STATE_FILE="$ROOT/logs/runner-health.state"
fail=0
say() { echo "$1"; }

# 1. Heartbeat freshness and result
if [ ! -f "$HB" ]; then
  say "FAIL no heartbeat file ($HB): the runner has never completed a sweep here"; fail=1
else
  now=$(date -u +%s)
  at=$(node -e 'const h=require(process.argv[1]);process.stdout.write(String(Math.floor(Date.parse(h.at)/1000)))' "$HB" 2>/dev/null || echo 0)
  ok=$(node -e 'const h=require(process.argv[1]);process.stdout.write(String(h.ok))' "$HB" 2>/dev/null || echo unknown)
  age=$(( now - at ))
  if [ "$at" = 0 ] || [ "$age" -gt "$MAX_AGE" ]; then say "FAIL heartbeat is ${age}s old (max ${MAX_AGE}s): the runner is not sweeping"; fail=1; fi
  if [ "$ok" != "true" ]; then say "FAIL the last sweep reported ok=${ok}: $(node -e 'const h=require(process.argv[1]);process.stdout.write(String(h.reason||h.error||""))' "$HB" 2>/dev/null)"; fail=1; fi
  # 1b. Deliveries (core-13, M7): a heartbeat from before it has no deliveryOk and is not a delivery failure.
  dok=$(node -e 'const h=require(process.argv[1]);process.stdout.write(String(h.deliveryOk))' "$HB" 2>/dev/null || echo unknown)
  if [ "$dok" = "false" ]; then say "FAIL deliveries: $(node -e 'const h=require(process.argv[1]);process.stdout.write(String(h.deliveryReason||"an endpoint keeps failing"))' "$HB" 2>/dev/null)"; fail=1; fi
fi

# 2. The process launchd keeps alive
if [ "${MR_HEALTH_SKIP_PROCESS:-0}" != 1 ] && ! pgrep -f "scripts/runner.ts" >/dev/null 2>&1; then say "FAIL no runner process (scripts/runner.ts)"; fail=1; fi

# 3. The Leader is reachable with the credential (token exchange only; 20 s cap)
if [ "${MR_HEALTH_SKIP_LEADER:-0}" = 1 ]; then
  :
elif [ -f .env ]; then
  # macOS has no `timeout`; the check bounds itself (20 s) so a hanging Leader reads as unreachable.
  if ! node --input-type=module -e '
    setTimeout(() => { console.log("FAIL Leader did not answer within 20 s"); process.exit(3); }, 20_000).unref();
    const { loadEnv, api } = await import("./scripts/cribl-api.mjs");
    loadEnv();
    const r = await api("GET", "/system/info");
    if (r.status !== 200) { console.log(`FAIL Leader answered ${r.status} to GET /system/info`); process.exit(1); }
    process.exit(0);
  ' >/tmp/mr-health.$$ 2>&1; then head -3 /tmp/mr-health.$$; say "FAIL Leader unreachable or credential rejected"; fail=1; fi
  rm -f /tmp/mr-health.$$
else
  say "FAIL no .env with the org credential"; fail=1
fi

# 4. State change (core-13): print a transition line only when OK/FAIL flips (never per failed poll).
state=$([ "$fail" = 0 ] && echo OK || echo FAIL)
prev=$(cat "$STATE_FILE" 2>/dev/null || echo "")
if [ -n "$prev" ] && [ "$prev" != "$state" ]; then say "STATE $prev -> $state"; fi
mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null && echo "$state" > "$STATE_FILE" 2>/dev/null

if [ "$fail" = 0 ]; then
  say "OK runner heartbeat ${age}s old, last sweep ok, deliveries ok, process alive, Leader reachable"
  exit 0
fi
exit 1
