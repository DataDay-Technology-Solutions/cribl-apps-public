#!/usr/bin/env bash
# wizard.sh — interactive setup for first-time operators. Suggests values for
# the pack's 12 variables based on destination + traffic shape.
set -euo pipefail

cat <<INTRO
=== Cardinality Reduction Pack — Setup Wizard ===

This wizard suggests values for all 12 pack variables based on your
environment. It does NOT write to Cribl directly; the variables already ship
pre-created with the pack — you only edit their values in the Cribl UI.

INTRO

read -p "Destination type [splunk/prometheus/datadog/chronicle/elastic/loki/object_storage]: " DEST
read -p "Primary traffic [logs/metrics/mixed]: " TRAFFIC
read -p "Risk appetite [conservative/balanced/aggressive]: " RISK
read -p "Production-ready or evaluating? [eval/prod]: " STAGE

echo
echo "=== Recommended values for the 12 pack variables ==="
echo

# --- 1. DRY_RUN + 6. VERBOSE_AUDIT_METADATA (driven by STAGE) ---
case "$STAGE" in
  eval)
    echo "DRY_RUN=true                        # keep on while reviewing cr_would_modify at your destination"
    echo "VERBOSE_AUDIT_METADATA=true         # see cr_categories + cr_match_count while evaluating"
    ;;
  prod)
    echo "DRY_RUN=false                       # only flip after auditing in a lower environment first!"
    echo "VERBOSE_AUDIT_METADATA=false        # production: minimal byte cost (cr_risk/cr_route_tier still emitted)"
    ;;
  *)
    # Unrecognized stage (typo, 'production', etc.) — default to the pack's
    # safe posture (audit mode) so a bad answer never yields a recommendation
    # set that silently OMITS DRY_RUN, the single most safety-critical var.
    echo "DRY_RUN=true                        # (unrecognized stage '$STAGE' — defaulting to safe audit mode)"
    echo "VERBOSE_AUDIT_METADATA=true         # see cr_categories + cr_match_count while you evaluate"
    ;;
esac

# --- 2. DESTINATION_TYPE ---
echo "DESTINATION_TYPE='$DEST'"
case "$DEST" in
  splunk|prometheus|datadog|chronicle|elastic|loki|object_storage) ;;
  *) echo "  # ⚠ '$DEST' is not a recognized destination — the engine will tag events cr_dest_type_unknown."
     echo "  #   Use one of: splunk / prometheus / datadog / chronicle / elastic / loki / object_storage" ;;
esac

# --- 3. MODE (driven by RISK) ---
case "$RISK" in
  conservative) echo "MODE='safe'                         # high-confidence patterns only" ;;
  balanced)     echo "MODE='safe'                         # high-confidence patterns only" ;;
  aggressive)   echo "MODE='aggressive'                   # also catches 8-15 char hex, bare IPs, IP:port" ;;
  *)            echo "MODE='safe'                         # (unrecognized risk '$RISK' — defaulting to safe)" ;;
esac

# --- 4. FIELD_WHITELIST / 5. FIELDS_TO_DROP (always operator-specific) ---
echo "FIELD_WHITELIST=''                  # FILL IN: every field you actively query/group by (e.g. customer_id,endpoint)"
echo "FIELDS_TO_DROP=''                   # optional: fields to drop entirely in live mode (e.g. user_agent,referer)"

# --- 7. ENABLE_RAW_MODIFICATION (destination-driven) ---
if [ "$DEST" = "splunk" ]; then
  echo "ENABLE_RAW_MODIFICATION=true        # Splunk indexes _raw — replace high-cardinality values there too"
else
  echo "ENABLE_RAW_MODIFICATION=true        # safe default; only matters where the destination indexes _raw"
fi

# --- 8. ENABLE_HISTOGRAM_OPTIMIZATION + 11. ENABLE_AGGREGATION (traffic-driven) ---
case "$TRAFFIC" in
  logs)
    echo "ENABLE_HISTOGRAM_OPTIMIZATION=false # not relevant for logs"
    echo "ENABLE_AGGREGATION=false            # EXPERIMENTAL — leave off"
    ;;
  metrics)
    echo "ENABLE_HISTOGRAM_OPTIMIZATION=true  # keeps the 11 SLO-aligned buckets in live mode"
    echo "ENABLE_AGGREGATION=false            # EXPERIMENTAL — enable only after testing on high-cardinality counters"
    ;;
  mixed)
    echo "ENABLE_HISTOGRAM_OPTIMIZATION=true  # default, harmless on logs"
    echo "ENABLE_AGGREGATION=false            # EXPERIMENTAL — leave off until tested"
    ;;
  *)
    echo "ENABLE_HISTOGRAM_OPTIMIZATION=true  # (unrecognized traffic '$TRAFFIC' — safe default)"
    echo "ENABLE_AGGREGATION=false            # EXPERIMENTAL — safe default"
    ;;
esac

# --- 9. ENABLE_PII_DETECTION / 10. DROP_SPLUNK_NOISE_FIELDS ---
echo "ENABLE_PII_DETECTION=false          # opt-in only — patterns can hit non-PII numerics"
if [ "$DEST" = "splunk" ]; then
  echo "DROP_SPLUNK_NOISE_FIELDS=false      # consider true once live: drops punct/linecount/eventtype"
else
  echo "DROP_SPLUNK_NOISE_FIELDS=false      # Splunk-specific; leave off"
fi

# --- 12. AGGREGATION_WINDOW ---
echo "AGGREGATION_WINDOW='60s'            # only used if ENABLE_AGGREGATION=true"

cat <<OUTRO

=== How to apply ===
All 12 variables ship pre-created with the pack — there is nothing to create.
Edit their values in:

  Cribl UI → Packs → cc-cardinality-reduction → Settings → Variables
  (the pack-scoped Knowledge > Variables page)

then commit & deploy. Start with DRY_RUN=true and review the cr_* audit
fields at your destination before going live.
OUTRO
