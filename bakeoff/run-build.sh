#!/usr/bin/env bash
# Build one bake-off entry: bakeoff/run-build.sh <task-id> <claude|codex>
#
# Each builder gets a fresh git worktree at the same base commit, the same
# TASK.md as its prompt, and the same setup. Afterwards this captures the
# diff, the agent's final message, the wall time and the check output under
# bakeoff/runs/<task-id>/.
#
# Env: BASE_REF (default HEAD, fixed for a task on its first build),
#      CLAUDE_MODEL / CODEX_MODEL (default: each CLI's own default).
set -euo pipefail

task=${1:?usage: run-build.sh <task-id> <claude|codex>}
builder=${2:?usage: run-build.sh <task-id> <claude|codex>}
case $builder in claude|codex) ;; *) echo "builder must be claude or codex" >&2; exit 2 ;; esac

here=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel)
task_dir=$here/tasks/$task
[[ -f $task_dir/TASK.md ]] || { echo "no $task_dir/TASK.md" >&2; exit 2; }

run=$here/runs/$task
mkdir -p "$run"
# Both builders must start from the same commit, so the first build fixes it.
if [[ -f $run/base.sha ]]; then
  base=$(cat "$run/base.sha")
else
  base=$(git -C "$root" rev-parse "${BASE_REF:-HEAD}")
  echo "$base" > "$run/base.sha"
fi

project=$(sed -n 's/^\*\*Project:\*\* *`\([^`]*\)`.*/\1/p' "$task_dir/TASK.md" | head -1)
wt=$run/wt-$builder
[[ -e $wt ]] && { echo "$wt exists; remove it with: git worktree remove --force $wt" >&2; exit 2; }
git -C "$root" worktree add --detach "$wt" "$base" >/dev/null
workdir=$wt/${project:-.}

if [[ -x $task_dir/setup.sh ]]; then
  echo "[$builder] setup"
  (cd "$workdir" && "$task_dir/setup.sh") > "$run/$builder.setup.log" 2>&1
fi

prompt="$(cat "$task_dir/TASK.md")

---
You are working in $workdir. Make the change there and verify it, but don't commit, push or open a pull request. Finish with a short summary: what you changed, how you verified it, and anything left undone."

echo "[$builder] building from ${base:0:12} in ${project:-repo root}"
start=$(date +%s)
case $builder in
  claude)
    (cd "$workdir" && claude -p "$prompt" --permission-mode auto --output-format json \
      ${CLAUDE_MODEL:+--model "$CLAUDE_MODEL"}) > "$run/claude.raw.json" || true
    node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(r.result??""))' \
      "$run/claude.raw.json" > "$run/claude.summary.md" || true
    ;;
  codex)
    codex exec -C "$workdir" --sandbox workspace-write --json \
      -o "$run/codex.summary.md" ${CODEX_MODEL:+-m "$CODEX_MODEL"} "$prompt" \
      > "$run/codex.events.jsonl" || true
    ;;
esac
seconds=$(( $(date +%s) - start ))

# Stage everything, new files included, so the patch is the whole entry.
git -C "$wt" add -A
git -C "$wt" diff --cached "$base" > "$run/$builder.patch"

if [[ -x $task_dir/check.sh ]]; then
  echo "[$builder] check"
  set +e
  (cd "$workdir" && "$task_dir/check.sh") > "$run/$builder.check.txt" 2>&1
  code=$?
  set -e
  echo "exit code: $code" >> "$run/$builder.check.txt"
else
  code=null
  echo "no check.sh for this task" > "$run/$builder.check.txt"
fi

printf '{"builder":"%s","base":"%s","seconds":%s,"check_exit":%s,"patch_lines":%s}\n' \
  "$builder" "$base" "$seconds" "$code" "$(wc -l < "$run/$builder.patch")" > "$run/$builder.meta.json"
echo "[$builder] done in ${seconds}s, check exit $code -> $run"
