#!/usr/bin/env bash
# doctor.sh — diagnostic dump for support tickets. Collects pack version,
# Cribl version, pipeline status, sample registration, and worker errors.
#
# In cluster deployments, scans logs from multiple workers (not just worker 0).
#
# Usage:
#   ./doctor.sh                  # default — scans worker 0 (single-instance)
#   ./doctor.sh --worker 5       # scan worker 5 only
#   ./doctor.sh --all-workers    # scan workers 0..11 in parallel and aggregate
#   ./doctor.sh --help

set -euo pipefail
cd "$(dirname "$0")"

CRIBL_URL="${CRIBL_URL:-http://localhost:9000}"
CRIBL_USER="${CRIBL_USER:-admin}"
CRIBL_PASS="${CRIBL_PASS:-admin}"

WORKER_MODE="single"   # single | specific | all
WORKER_ID="0"
for arg in "$@"; do
  case "$arg" in
    --worker) WORKER_MODE="specific"; shift; WORKER_ID="${1:-0}"; ;;
    --worker=*) WORKER_MODE="specific"; WORKER_ID="${arg#*=}";;
    --all-workers) WORKER_MODE="all";;
    --help|-h) sed -n '2,12p' "$0" | sed 's/^# *//'; exit 0;;
  esac
done

OUT=/tmp/cr-doctor-$(date +%Y%m%d-%H%M%S).txt
{
  echo "=== Cribl Cardinality Reduction Pack — Doctor Report ==="
  echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Mode: worker=$WORKER_MODE${WORKER_MODE:+:$WORKER_ID}"
  echo

  # v3.20.1: capture curl separately (|| true) so a connection failure doesn't
  # trip `set -e`, then parse. The old form piped curl→python with a trailing
  # `|| echo NONE`; under `pipefail` a failed curl made BOTH python print NONE
  # AND the fallback fire, yielding a two-line "NONE\nNONE" that defeated the
  # `= NONE` guard below and let a newline-tainted token reach the auth header,
  # killing the script silently — exactly when an operator runs doctor because
  # Cribl is already unreachable. Normalize to a single line, default NONE.
  LOGIN_RESP=$(curl -s --max-time 10 -X POST "$CRIBL_URL/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$CRIBL_USER\",\"password\":\"$CRIBL_PASS\"}" 2>/dev/null) || true
  TOKEN=$(printf '%s' "$LOGIN_RESP" | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["token"])
except: print("NONE")' 2>/dev/null || true)
  TOKEN=$(printf '%s' "$TOKEN" | head -1)
  [ -z "$TOKEN" ] && TOKEN=NONE
  if [ "$TOKEN" = "NONE" ]; then
    # To stderr so the message reaches the operator's terminal — the report
    # block below redirects stdout to $OUT, which we never finish writing here.
    echo "AUTH FAIL — cannot reach Cribl at $CRIBL_URL (or bad credentials)." >&2
    echo "  Set CRIBL_URL / CRIBL_USER / CRIBL_PASS env vars and retry." >&2
    exit 1
  fi

  echo "--- Cribl version ---"
  curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "$CRIBL_URL/api/v1/system/info" 2>/dev/null \
    | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); items=d.get("items",[d]); i=items[0]
    print(f"  version: {i.get(\"BUILD\",{}).get(\"VERSION\",\"?\")}")
    print(f"  distMode: {i.get(\"distMode\",\"?\")}")
    print(f"  hostname: {i.get(\"hostname\",\"?\")}")
except: print("  (unable to parse)")' 2>/dev/null

  echo
  echo "--- Pack ---"
  curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "$CRIBL_URL/api/v1/packs" 2>/dev/null \
    | python3 -c 'import sys,json
for p in json.load(sys.stdin).get("items",[]):
    if "cardinality" in p.get("id",""):
        print(f"  id: {p[\"id\"]}")
        print(f"  version: {p[\"version\"]}")
        print(f"  source: {p.get(\"source\",\"?\")}")' 2>/dev/null

  echo
  echo "--- Pipeline functions ---"
  curl -s --max-time 10 -H "Authorization: Bearer $TOKEN" "$CRIBL_URL/api/v1/p/cc-cardinality-reduction/pipelines" 2>/dev/null \
    | python3 -c 'import sys,json
for p in json.load(sys.stdin).get("items",[]):
    if p.get("id")=="cardinality_reduction":
        fns = p.get("conf",{}).get("functions",[])
        print(f"  {len(fns)} functions:")
        for i,f in enumerate(fns):
          print(f"    {i+1}. {f.get(\"id\")} ({f.get(\"description\",\"\")[:50]})")' 2>/dev/null

  echo
  echo "--- Sample-registration status ---"
  for sid in cardinality_test_data log_events_mixed enterprise_1000; do
    STATUS=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" \
      "$CRIBL_URL/api/v1/system/samples/$sid" 2>/dev/null || echo 000)
    echo "  $sid: HTTP $STATUS"
  done

  echo
  echo "--- Worker errors (last 200 lines, filtered) ---"
  scan_worker() {
    local wid="$1"
    if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q cribl 2>/dev/null; then
      local CONTAINER
      CONTAINER=$(docker ps --format '{{.Names}}' | grep cribl | head -1)
      echo "  [worker $wid]"
      docker exec "$CONTAINER" sh -c "tail -200 /opt/cribl/log/worker/$wid/cribl.log 2>/dev/null | grep -iE 'cardinality_reduction.*(error|warn|failed)' | tail -10" 2>/dev/null \
        | sed 's/^/    /' || echo "    (no log access)"
    elif [ -d "/opt/cribl/log/worker/$wid" ]; then
      echo "  [worker $wid]"
      tail -200 "/opt/cribl/log/worker/$wid/cribl.log" 2>/dev/null | grep -iE 'cardinality_reduction.*(error|warn|failed)' | tail -10 \
        | sed 's/^/    /' || echo "    (no errors)"
    else
      echo "  (worker $wid not found locally; on-leader-only? check via Cribl UI)"
    fi
  }

  case "$WORKER_MODE" in
    single|specific) scan_worker "$WORKER_ID" ;;
    all)
      # Loop-2 (v3.18.3): discover actual worker count instead of hardcoded 12.
      # Try the API first; fall back to filesystem; finally to 12 if neither works.
      WORKER_COUNT=$(curl -s --max-time 5 -H "Authorization: Bearer $TOKEN" \
        "$CRIBL_URL/api/v1/master/workers" 2>/dev/null \
        | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); items=d.get("items",[])
    # Each item is a worker process
    print(len(items) if items else 0)
except: print(0)' 2>/dev/null || echo 0)
      if [ "${WORKER_COUNT:-0}" -eq 0 ]; then
        # Fallback: probe local filesystem (single-instance Docker)
        if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q cribl 2>/dev/null; then
          CONTAINER=$(docker ps --format '{{.Names}}' | grep cribl | head -1)
          WORKER_COUNT=$(docker exec "$CONTAINER" sh -c 'ls -1 /opt/cribl/log/worker/ 2>/dev/null | grep -c "^[0-9]\+$"' 2>/dev/null || echo 0)
        fi
      fi
      [ "${WORKER_COUNT:-0}" -eq 0 ] && WORKER_COUNT=12
      echo "  Detected $WORKER_COUNT worker(s); scanning all..."
      for wid in $(seq 0 $((WORKER_COUNT - 1))); do
        scan_worker "$wid"
      done
      ;;
  esac
} > "$OUT"

echo "Report written to: $OUT"
echo
head -80 "$OUT"
echo "..."
echo "(see $OUT for full report)"
