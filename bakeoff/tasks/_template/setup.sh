#!/usr/bin/env bash
# Runs in the project folder of each fresh worktree, before the builder starts,
# with network access. Builders run without network, so install everything here.
set -euo pipefail
npm ci --no-audit --no-fund
