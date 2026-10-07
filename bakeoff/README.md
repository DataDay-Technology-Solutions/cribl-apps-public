# Claude vs ChatGPT bake-off

Claude Code and OpenAI Codex (ChatGPT) build the same task from the same commit. Then both of them judge the two entries without knowing which agent wrote which, and a script reveals who built what and tallies the scores.

```
TASK.md ─┬─ run-build.sh <task> claude ─► claude.patch  claude.check.txt
         └─ run-build.sh <task> codex  ─► codex.patch   codex.check.txt
                                   │
                judge.sh <task>  ──┤  packet: A.patch / B.patch (anonymized, 2 passes, A↔B swapped)
                                   ├─► Codex judge  ─┐
                                   └─► Claude judge ─┴─► tally.mjs ─► RESULTS.md
```

## One-time setup on your machine

1. **Install Codex CLI and sign in with your ChatGPT plan.** No API key is needed.
   ```bash
   npm i -g @openai/codex        # or: brew install --cask codex
   codex login                   # opens the browser; pick "Sign in with ChatGPT"
   codex login status
   ```
2. **Trust this repo.** Run `codex` once in the repo root and answer yes to the trust prompt. Codex then loads `.codex/config.toml` from the repo: it can edit inside the workspace, it asks before anything leaves it, and it has no network from the sandbox.
3. **Pick your model.** In an interactive session, `/model` lists what your plan offers. To make a choice stick, set `model = "…"` and `model_reasoning_effort = "high"` in `~/.codex/config.toml`. The repo deliberately doesn't pin a model, so each person's plan decides.
4. **Check everything.** Run `codex doctor`. Claude Code needs no changes: `claude` must be on your PATH and signed in.

## Using Codex the way you use Claude Code

| Claude Code | Codex CLI |
|---|---|
| `CLAUDE.md` | `AGENTS.md`. The root file points Codex at each project's `CLAUDE.md`, so both follow one set of rules. |
| `claude` | `codex` |
| `claude -p "…"` | `codex exec "…"` |
| `--permission-mode acceptEdits` | `--sandbox workspace-write` (this repo's default) |
| `--permission-mode plan` | `--sandbox read-only` |
| `/model`, `/resume`, `/review` | `/model`, `codex resume`, `/review` (or `codex review`) |
| MCP servers in `.mcp.json` | `codex mcp add …` (writes `~/.codex/config.toml`) |
| `--json-schema` | `--output-schema file.json` |

## Running a round

1. **Write the task.** Copy `tasks/_template/` to `tasks/<task-id>/` and fill in `TASK.md`. Set `**Project:**` to the folder the builder works in. `setup.sh` runs before each build, with network, so install dependencies there. `check.sh` runs after each build, and its exit code is what judges treat as ground truth, so put the task's real acceptance tests in it.
2. **Build both entries.** You can run the two builds in parallel, in two terminals:
   ```bash
   bakeoff/run-build.sh <task-id> claude
   bakeoff/run-build.sh <task-id> codex
   ```
   Each build gets its own worktree under `bakeoff/runs/<task-id>/wt-<builder>`, at the same base commit (`BASE_REF`, default `HEAD`). To set the models, use `CLAUDE_MODEL=…` and `CODEX_MODEL=…`.
3. **Judge and tally them.**
   ```bash
   bakeoff/judge.sh <task-id>          # PASSES=1 for half the cost; JUDGES=codex to use one judge
   ```
   The results land in `bakeoff/runs/<task-id>/RESULTS.md`, with an overall score, a score from each judge, per-criterion means, votes, and every judge note after the unblinding. To re-tally without judging again, run `node bakeoff/tally.mjs <task-id>`.
4. **Clean up.** Run `git worktree remove --force bakeoff/runs/<task-id>/wt-claude`, then the same for `wt-codex`. Everything under `runs/` is git-ignored.

## Fairness rules built in

- **Same start.** Both builders get the same commit, prompt and `setup.sh`, and the same no-commit, no-push instruction. The first build of a task fixes `base.sha`.
- **Blind judging.** Entries are labeled A and B. Vendor and model names are scrubbed from the agents' summaries, and the A/B key stays outside the packet.
- **Position bias cancelled.** The default is two passes, with A and B swapped in the second.
- **Self-preference flagged.** Each judge is scored separately. If a judge picks its own builder in every pass, `RESULTS.md` says so and you can weigh the other judge more heavily.
- **Ground truth beats opinion.** A failing `check.sh` caps `correctness` at 4 (see `RUBRIC.md`).

Blinding isn't perfect, because coding style can give an agent away. Treat close results (within 3 points) as a tie, and run several tasks before drawing conclusions.
