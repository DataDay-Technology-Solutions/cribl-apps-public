#!/usr/bin/env bash
# upgrade_check.sh — detect deprecated/removed pack variables that may
# have been left over from older pack versions. Operator-side validation.
set -euo pipefail

PACK_ID="cc-cardinality-reduction"
CRIBL_HOME="${CRIBL_HOME:-/opt/cribl}"

DEPRECATED=(
  "ENABLE_RAW_SCANNING:Deprecated v3.3.0 (read but ignored). Remove from pack vars."
  "STRIP_CR_METADATA:Removed v3.5.1 (had no effect since v3.0.0)."
)

echo "Scanning $CRIBL_HOME for deprecated variables on $PACK_ID..."
echo

PACK_VARS_FILE="$CRIBL_HOME/groups/default/groups/$PACK_ID/local/cribl/pack/$PACK_ID/conf.yml"
[ -f "$PACK_VARS_FILE" ] || PACK_VARS_FILE="$CRIBL_HOME/local/$PACK_ID/conf.yml"

if [ -f "$PACK_VARS_FILE" ]; then
  for entry in "${DEPRECATED[@]}"; do
    var="${entry%%:*}"
    msg="${entry#*:}"
    if grep -q "$var" "$PACK_VARS_FILE" 2>/dev/null; then
      printf '\033[33m!\033[0m %s\n  %s\n  Found in: %s\n\n' "$var" "$msg" "$PACK_VARS_FILE"
    fi
  done
  echo "Scan complete."
else
  echo "Pack vars file not found at standard locations; pack may not be locally configured."
fi

cat <<'NOTE'

--- v4.0.0 upgrade note ---
All operator-facing audit fields were renamed __cr_* -> cr_* in v4.0.0
(double-underscore fields are Cribl-internal and never reach destinations,
so saved searches built on __cr_* could not return results). After upgrading:
  * Update any downstream searches/dashboards from __cr_risk, __cr_would_modify,
    etc. to cr_risk, cr_would_modify, ... (see dashboards/splunk_savedsearches.conf
    and dashboards/example_queries.md for ready-made v4.0.0 queries).
  * Bundled sample data now lives at data/samples/ (was default/data/samples/).
NOTE
