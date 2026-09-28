#!/usr/bin/env sh
# Apply the Meter Reader demo rig (SPEC 14). Thin wrapper; the logic and every safety rule live in
# scripts/rig/apply.mjs (see docs/RIG.md). Arguments pass through, e.g.:
#   demo/rig/apply.sh                                  # upsert every mrd_ object (pending only)
#   demo/rig/apply.sh --commit --deploy --exclude-blocked
set -eu
cd "$(dirname "$0")/../.."
exec node scripts/rig/apply.mjs "$@"
