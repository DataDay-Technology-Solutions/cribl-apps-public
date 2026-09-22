#!/usr/bin/env bash
# post_install_check.sh — after-install sanity check for cc-cardinality-reduction.
#
# Adapts to deployment topology:
#   - Single-instance: requires globally-registered samples (5/5 checks)
#   - Cluster (master/worker): samples are optional; smoke test uses a built-in (4/4 checks)
#
# Usage:
#   ./post_install_check.sh
#   CRIBL_URL=https://cribl-leader:9000 CRIBL_USER=admin CRIBL_PASS=*** ./post_install_check.sh
#   ./post_install_check.sh --strict     # treat missing samples as a failure even on cluster
#   ./post_install_check.sh --json       # machine-readable output for CI

set -euo pipefail

PACK_ID="cc-cardinality-reduction"
CRIBL_URL="${CRIBL_URL:-http://localhost:9000}"
CRIBL_USER="${CRIBL_USER:-admin}"
CRIBL_PASS="${CRIBL_PASS:-admin}"

STRICT=0
JSON=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    --json)   JSON=1 ;;
    --help|-h) sed -n '2,12p' "$0" | sed 's/^# *//'; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# In JSON mode, accumulate to a buffer and print one object at end.
declare -a J_OK=()
declare -a J_WARN=()
declare -a J_FAIL=()
green() { [ "$JSON" -eq 0 ] && printf '\033[32m✓\033[0m %s\n' "$1"; J_OK+=("$1"); }
red()   { [ "$JSON" -eq 0 ] && printf '\033[31m✗\033[0m %s\n' "$1"; J_FAIL+=("$1"); }
yellow(){ [ "$JSON" -eq 0 ] && printf '\033[33m!\033[0m %s\n' "$1"; J_WARN+=("$1"); }

emit_json_and_exit() {
  local rc=$1
  # Build JSON via python from env-vars to avoid bash array quoting hell.
  J_PASS=$(printf '%s\n' "${J_OK[@]+"${J_OK[@]}"}" | grep -v '^$' || true)
  J_WARN_LINES=$(printf '%s\n' "${J_WARN[@]+"${J_WARN[@]}"}" | grep -v '^$' || true)
  J_FAIL_LINES=$(printf '%s\n' "${J_FAIL[@]+"${J_FAIL[@]}"}" | grep -v '^$' || true)
  PASS_J="$J_PASS" WARN_J="$J_WARN_LINES" FAIL_J="$J_FAIL_LINES" \
  PV="${VERSION:-unknown}" DM="${DIST_MODE:-unknown}" \
  python3 - <<'PYEOF'
import json, os
def lines(env): return [l for l in (os.environ.get(env) or '').splitlines() if l]
fail = lines('FAIL_J')
print(json.dumps({
  'ok':           not fail,
  'pack_version': os.environ.get('PV','unknown'),
  'dist_mode':    os.environ.get('DM','unknown'),
  'pass':         lines('PASS_J'),
  'warn':         lines('WARN_J'),
  'fail':         fail,
}, indent=2))
PYEOF
  exit "$rc"
}

# 1. Auth
TOKEN=$(curl -sf -X POST "$CRIBL_URL/api/v1/auth/login" -H "Content-Type: application/json" \
  -d "{\"username\":\"$CRIBL_USER\",\"password\":\"$CRIBL_PASS\"}" 2>/dev/null \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null) || {
  red "cannot authenticate to $CRIBL_URL"
  [ "$JSON" -eq 1 ] && emit_json_and_exit 1 || exit 1
}
green "authenticated to $CRIBL_URL"

# 1a. Detect distMode (best-effort; OK to be 'unknown')
DIST_MODE=$(curl -sf --max-time 10 -H "Authorization: Bearer $TOKEN" "$CRIBL_URL/api/v1/system/info" 2>/dev/null \
  | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); items=d.get("items",[d]); i=items[0]
    print(i.get("distMode","unknown"))
except: print("unknown")' 2>/dev/null || echo unknown)
green "deployment mode: $DIST_MODE"

# 2. Pack installed?
# v3.18.1: every API response gets parsed via a python helper that is robust
# to empty/non-JSON responses (Cribl returns HTML on overload). On parse
# error the helper returns 'API_ERROR' and we fail clean rather than dumping
# a python traceback.
PACKS_RAW=$(curl -sf --max-time 10 -H "Authorization: Bearer $TOKEN" "$CRIBL_URL/api/v1/packs" 2>/dev/null || echo "")
VERSION=$(printf '%s' "$PACKS_RAW" | python3 -c "
import sys,json
try:
    items = json.load(sys.stdin).get('items',[])
    for p in items:
        if p.get('id') == '$PACK_ID':
            print(p.get('version','?')); break
    else: print('NOT_INSTALLED')
except Exception: print('API_ERROR')" 2>/dev/null)
if [ "$VERSION" = "API_ERROR" ] || [ -z "$VERSION" ]; then
  red "API call to /api/v1/packs returned non-JSON (Cribl unreachable or overloaded)"
  [ "$JSON" -eq 1 ] && emit_json_and_exit 1 || exit 1
fi
if [ "$VERSION" = "NOT_INSTALLED" ]; then
  red "pack '$PACK_ID' not installed"
  [ "$JSON" -eq 1 ] && emit_json_and_exit 1 || exit 1
fi
green "pack '$PACK_ID' installed at v$VERSION"

# 3. Pipeline loads with all 7 functions?
PIPELINES_RAW=$(curl -sf --max-time 10 -H "Authorization: Bearer $TOKEN" "$CRIBL_URL/api/v1/p/$PACK_ID/pipelines" 2>/dev/null || echo "")
PIPE_INFO=$(printf '%s' "$PIPELINES_RAW" | python3 -c "
import sys,json
try:
    items = json.load(sys.stdin).get('items',[])
    for p in items:
        if p.get('id')=='cardinality_reduction':
            print(len(p.get('conf',{}).get('functions',[]))); break
    else: print('MISSING')
except Exception: print('API_ERROR')" 2>/dev/null)
if [ "$PIPE_INFO" = "API_ERROR" ] || [ -z "$PIPE_INFO" ]; then
  red "API call to /api/v1/p/$PACK_ID/pipelines returned non-JSON (Cribl unreachable or overloaded)"
  [ "$JSON" -eq 1 ] && emit_json_and_exit 1 || exit 1
fi
if [ "$PIPE_INFO" = "MISSING" ]; then
  red "cardinality_reduction pipeline NOT visible in pack scope"
  [ "$JSON" -eq 1 ] && emit_json_and_exit 1 || exit 1
fi
[ "$PIPE_INFO" -eq 7 ] \
  && green "pipeline loads with $PIPE_INFO functions" \
  || yellow "pipeline has $PIPE_INFO functions; expected 7"

# 4. Samples registered globally? (different expectation per topology)
MISSING=0
for sid in cardinality_test_data enterprise_1000 histogram_samples \
           k8s_prometheus_100 k8s_structured_100 kubernetes_events \
           log_events_mixed metric_name_samples mixed_enterprise_100 otel_metrics; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" \
    "$CRIBL_URL/api/v1/system/samples/$sid" 2>/dev/null || echo 000)
  [ "$STATUS" = "200" ] || MISSING=$((MISSING+1))
done

case "$DIST_MODE" in
  single)
    if [ "$MISSING" -eq 0 ]; then
      green "all 10 bundled samples registered globally"
    else
      yellow "$MISSING/10 samples missing — run tests/cc-cardinality-reduction/install-samples.sh on this host (samples ship in data/samples/)"
      [ "$STRICT" -eq 1 ] && { red "strict mode: missing samples"; [ "$JSON" -eq 1 ] && emit_json_and_exit 1 || exit 1; }
    fi
    ;;
  master|cluster|worker)
    if [ "$MISSING" -eq 0 ]; then
      green "all 10 bundled samples registered globally (unusual on cluster — fine)"
    elif [ "$MISSING" -eq 10 ]; then
      green "samples not registered globally (expected on production cluster)"
    else
      yellow "$MISSING/10 samples missing — partial install. Run tests/cc-cardinality-reduction/install-samples.sh --force or remove leftovers."
      [ "$STRICT" -eq 1 ] && { red "strict mode: partial samples"; [ "$JSON" -eq 1 ] && emit_json_and_exit 1 || exit 1; }
    fi
    ;;
  *)
    [ "$MISSING" -eq 0 ] && green "all 10 samples registered globally" \
                        || yellow "$MISSING/10 samples missing (distMode=$DIST_MODE)"
    ;;
esac

# 5. Smoke test — pipeline runs cleanly
# Use a pack-bundled sample if available, else fall back to apache_common (Cribl built-in).
SMOKE_SAMPLE="log_events_mixed"
if [ "$MISSING" -ne 0 ] && [ "$DIST_MODE" != "single" ]; then
  SMOKE_SAMPLE="apache_common"   # built-in always available
fi

RESP=$(curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"mode\":\"pipe\",\"pipelineId\":\"cardinality_reduction\",\"sampleId\":\"$SMOKE_SAMPLE\"}" \
  "$CRIBL_URL/api/v1/p/$PACK_ID/preview" 2>/dev/null) || {
  red "/preview failed for $SMOKE_SAMPLE — pipeline may have a runtime error"
  [ "$JSON" -eq 1 ] && emit_json_and_exit 1 || exit 1
}
COUNT=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin).get('count',0))")
# v4.0.0: audit fields renamed __cr_* → cr_* (double-underscore fields are
# Cribl-internal and stripped before destinations). The smoke test checks the
# destination-visible event field cr_risk.
TAGGED=$(echo "$RESP" | python3 -c "import sys,json; items=json.load(sys.stdin)['items']; print(sum(1 for e in items if 'cr_risk' in e))")
if [ "$COUNT" -gt 0 ] && [ "$TAGGED" = "$COUNT" ]; then
  green "smoke test: $SMOKE_SAMPLE → $COUNT events, all tagged with cr_risk"
else
  red "smoke test failed: count=$COUNT tagged=$TAGGED on $SMOKE_SAMPLE"
  [ "$JSON" -eq 1 ] && emit_json_and_exit 1 || exit 1
fi

# 6. Recent engine errors (best-effort, single-instance docker only)
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -q cribl 2>/dev/null; then
  CONTAINER=$(docker ps --format '{{.Names}}' | grep cribl | head -1)
  ERR=$(docker exec "$CONTAINER" sh -c 'tail -2000 /opt/cribl/log/worker/0/cribl.log 2>/dev/null | grep -cE "pipe:cardinality_reduction.*failed to load" || true' 2>/dev/null | tr -d '[:space:]')
  ERR=${ERR:-0}
  if [ "$ERR" -eq 0 ]; then
    green "no engine load-errors in worker 0 logs"
  else
    yellow "$ERR pipeline-load errors in worker 0 logs — investigate with tools/doctor.sh"
  fi
fi

[ "$JSON" -eq 1 ] && emit_json_and_exit 0
echo
green "all checks passed — pack is healthy"
