#!/usr/bin/env bash
# Runs in the project folder after the builder finishes. Its output and exit
# code go to the judges as ground truth. Add task-specific tests here too.
set -uo pipefail
npm run typecheck && npm run lint && npm test
