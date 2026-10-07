# AGENTS.md: cribl-apps-public

This file is for coding agents that read `AGENTS.md`, such as OpenAI Codex CLI. Claude Code reads `CLAUDE.md`. Both agents follow the same rules. Where a project has a `CLAUDE.md`, that file is the source of truth, and this file only points to it.

## Before you change anything

1. Find the project you're working in and read its own `AGENTS.md` and `CLAUDE.md`. Read both, even when the nested `AGENTS.md` already loaded:
   - `cc-meter-reader/`: `AGENTS.md` is the Cribl App Platform guide and outranks everything else. `CLAUDE.md` gives the reading order, the commands and "Rules that are never bent". Those rules are binding on you exactly as written.
   - `cc-cardinality-reduction/`: read its `README.md`, `UPGRADING.md` and `CHANGELOG.md`. The pipeline lives in `default/pipelines/cardinality_reduction/conf.yml`.
   - `cribl-datatap/`: read its `README.md`.
2. Where a document says "Claude", read it as "the agent". Where it names a Claude Code tool, use the equivalent you have.

## Ground rules for every project

- Change only the files the task needs, and commit only those. Never commit `.env`, credentials, `*.tgz` or `*.crbl` files.
- Before you report a task as done, run the project's own checks. For `cc-meter-reader` that is `npm run typecheck && npm run lint && npm test`. If a check fails, say so and include the output.
- Don't add dependencies unless the project's rules allow it.
- Never act on a live Cribl instance or call a Cribl API unless the task asks you to.
- Commits use Conventional Commits. Never push to `main`, tag, or publish a release. Those wait for the project owner.

## Claude vs ChatGPT bake-off

`bakeoff/` is a contest harness. Claude Code and Codex build the same task, and both of them then judge the two entries without knowing which agent wrote which. If you are running as a **builder**, work only from `TASK.md` and stay inside your worktree. If you are running as a **judge**, follow `bakeoff/judge-prompt.md`: score only what is in the packet and don't try to guess which agent wrote which entry.
