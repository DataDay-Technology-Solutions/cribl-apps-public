#!/usr/bin/env bash
# Judge both entries blind: bakeoff/judge.sh <task-id>
#
# Builds an anonymized packet (A/B, with vendor names scrubbed from the
# agents' summaries) and has both Codex and Claude score it against
# RUBRIC.md. The packet runs PASSES times (default 2), swapping A and B, so
# that the order the entries appear in can't decide the winner. The A/B
# mapping is written to key.pN.json, outside the packet the judges see.
#
# Env: PASSES (1 or 2), JUDGES (default "codex claude"),
#      CLAUDE_MODEL / CODEX_MODEL.
set -euo pipefail

task=${1:?usage: judge.sh <task-id>}
here=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
run=$here/runs/$task
for b in claude codex; do
  [[ -f $run/$b.patch ]] || { echo "missing $run/$b.patch; run run-build.sh $task $b first" >&2; exit 2; }
done

passes=${PASSES:-2}
judges=${JUDGES:-codex claude}
schema=$here/verdict.schema.json
prompt=$(cat "$here/judge-prompt.md")
project=$(sed -n 's/^\*\*Project:\*\* *`\([^`]*\)`.*/\1/p' "$here/tasks/$task/TASK.md" | head -1)
mkdir -p "$run/verdicts"

scrub() { sed -E 's/(Claude Code|Claude|Anthropic|OpenAI Codex|Codex|ChatGPT|OpenAI|GPT-?[0-9][A-Za-z0-9.-]*|Opus|Sonnet|Haiku)/[agent]/Ig'; }

# Pass 1 flips a coin; pass 2 swaps it.
if (( RANDOM % 2 )); then first=claude; second=codex; else first=codex; second=claude; fi

for p in $(seq 1 "$passes"); do
  if (( p % 2 )); then a=$first; b=$second; else a=$second; b=$first; fi
  printf '{"A":"%s","B":"%s"}\n' "$a" "$b" > "$run/key.p$p.json"

  pk=$run/packet.p$p
  rm -rf "$pk" && mkdir -p "$pk"
  cp "$here/tasks/$task/TASK.md" "$here/RUBRIC.md" "$pk/"
  if [[ -n $project && -f $root/$project/CLAUDE.md ]]; then cp "$root/$project/CLAUDE.md" "$pk/RULES.md"; fi
  for slot in A B; do
    who=$([[ $slot == A ]] && echo "$a" || echo "$b")
    cp "$run/$who.patch" "$pk/$slot.patch"
    cp "$run/$who.check.txt" "$pk/$slot.check.txt"
    scrub < "$run/$who.summary.md" > "$pk/$slot.summary.md" 2>/dev/null || echo "(no summary)" > "$pk/$slot.summary.md"
  done

  for j in $judges; do
    out=$run/verdicts/$j.p$p.json
    echo "[judge $j] pass $p"
    case $j in
      codex)
        codex exec -C "$pk" --sandbox read-only --skip-git-repo-check --ephemeral \
          --output-schema "$schema" -o "$out" ${CODEX_MODEL:+-m "$CODEX_MODEL"} "$prompt" \
          > "$run/verdicts/$j.p$p.log" 2>&1 &
        ;;
      claude)
        (cd "$pk" && claude -p "$prompt" --permission-mode dontAsk --allowedTools Read Glob Grep \
          --output-format json --json-schema "$(cat "$schema")" ${CLAUDE_MODEL:+--model "$CLAUDE_MODEL"}) \
          > "$out" 2> "$run/verdicts/$j.p$p.log" &
        ;;
      *) echo "unknown judge $j" >&2; exit 2 ;;
    esac
  done
  wait
done

node "$here/tally.mjs" "$task"
