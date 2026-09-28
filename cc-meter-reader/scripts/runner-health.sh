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

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || { echo "FAIL cannot cd to the runner root"; exit 2; }
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

MAX_AGE="${MR_HEARTBEAT_MAX_AGE_SEC:-150}"
HB=logs/runner.heartbeat.json
fail=0
say() { echo "$1"; }

# 1. Heartbeat freshness and result
if [ ! -f "$HB" ]; then
  say "FAIL no heartbeat file ($HB): the runner has never completed a sweep here"; fail=1
else
  now=$(date -u +%s)
  at=$(node -e 'const h=require(process.argv[1]);process.stdout.write(String(Math.floor(Date.parse(h.at)/1000)))' "$PWD/$HB" 2>/dev/null || echo 0)
  ok=$(node -e 'const h=require(process.argv[1]);process.stdout.write(String(h.ok))' "$PWD/$HB" 2>/dev/null || echo unknown)
  age=$(( now - at ))
  if [ "$at" = 0 ] || [ "$age" -gt "$MAX_AGE" ]; then say "FAIL heartbeat is ${age}s old (max ${MAX_AGE}s): the runner is not sweeping"; fail=1; fi
  if [ "$ok" != "true" ]; then say "FAIL the last sweep reported ok=${ok}: $(node -e 'const h=require(process.argv[1]);process.stdout.write(String(h.reason||h.error||""))' "$PWD/$HB" 2>/dev/null)"; fail=1; fi
fi

# 2. The process launchd keeps alive
if ! pgrep -f "scripts/runner.ts" >/dev/null 2>&1; then say "FAIL no runner process (scripts/runner.ts)"; fail=1; fi

# 3. The Leader is reachable with the credential (token exchange only; 20 s cap)
if [ -f .env ]; then
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

if [ "$fail" = 0 ]; then
  say "OK runner heartbeat ${age}s old, last sweep ok, process alive, Leader reachable"
  exit 0
fi
exit 1
