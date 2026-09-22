#!/bin/bash
# DataTap Installer
#
# Auto-detect:     bash install.sh
# Named container: bash install.sh cribl-stream
# Named + port:    bash install.sh cribl-stream 9001

set -e

CONTAINER="${1:-$(docker ps --format "{{.Names}}" 2>/dev/null | grep -i cribl | head -1)}"
PORT="${2:-}"

if [ -z "$CONTAINER" ]; then
  echo ""
  echo "  No Cribl container found."
  echo "  Usage: bash install.sh [container-name] [port]"
  exit 1
fi

[ -z "$PORT" ] && PORT=$(docker port "$CONTAINER" 9000 2>/dev/null | head -1 | cut -d: -f2)
[ -z "$PORT" ] && PORT=9001

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/pack"

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║   DataTap — On-Demand Streaming Data ║"
echo "  ╚══════════════════════════════════════╝"
echo ""
echo "  Container: $CONTAINER → localhost:$PORT"
echo ""

# --- Copy everything, then one restart ---
echo "  Copying files..."
docker exec "$CONTAINER" mkdir -p /opt/cribl/local/cribl/pipelines/datatap_generate 2>/dev/null

# Samples
for f in "$DIR"/default/data/samples/datatap_*.json; do
  docker cp "$f" "$CONTAINER:/opt/cribl/data/samples/" 2>/dev/null
done

# Config
docker cp "$DIR/default/cribl/samples.yml" "$CONTAINER:/opt/cribl/local/cribl/samples.yml"
docker cp "$DIR/default/cribl/inputs_standalone.yml" "$CONTAINER:/opt/cribl/local/cribl/inputs.yml"

# Pipeline (disk-based — loads on restart)
docker cp "$DIR/default/cribl/pipelines/datatap_generate/conf.yml" \
  "$CONTAINER:/opt/cribl/local/cribl/pipelines/datatap_generate/conf.yml"

echo "  ✓ Copied $(ls "$DIR"/default/data/samples/datatap_*.json | wc -l | tr -d ' ') samples + config + pipeline"

# --- Single restart ---
echo "  Restarting Cribl..."
docker restart "$CONTAINER" > /dev/null 2>&1
WAIT=0
while [ $WAIT -lt 30 ]; do
  sleep 3
  WAIT=$((WAIT + 3))
  curl -sf "http://localhost:$PORT/api/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"admin"}' > /dev/null 2>&1 && break
done
echo "  ✓ Cribl ready (${WAIT}s)"

# --- Done ---
echo ""
echo "  ══════════════════════════════════════"
echo "  ✓ DataTap installed!"
echo ""
echo "  datatap-top10 is streaming now."
echo "  UI: http://localhost:$PORT/stream/inputs/datagen"
echo ""
echo "  15 source categories available."
echo "  Enable any in Sources > Datagen."
echo "  ══════════════════════════════════════"
echo ""
