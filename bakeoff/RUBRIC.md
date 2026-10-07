# Bake-off rubric

Each judge scores each entry from 0 to 10 on every criterion. The total is the weighted sum, out of 100. Edit the weights here and in `tally.mjs` (`WEIGHTS`) together.

| Key | Criterion | Weight | 10 means | 0 means |
|---|---|---|---|---|
| `correctness` | Does it work? | 35 | Every requirement in TASK.md is met and the check passes. | It doesn't build, or the check fails on the core requirement. |
| `spec_fit` | Did it build what was asked? | 20 | Every acceptance criterion is met, with no invented requirements. | It solves a different problem. |
| `repo_rules` | Does it follow the project rules? | 15 | It follows the project's AGENTS.md and CLAUDE.md rules: copy in `en.ts`, millicents, no new dependencies, no browser storage, and so on. | It breaks a "never bent" rule. |
| `code_quality` | Is the code good? | 15 | It reads like the surrounding code: clear names, no dead code, sound error handling. | It's hard to follow or brittle. |
| `tests` | Is it tested? | 10 | Tests cover the new behavior and its edge cases, and they pass. | No tests, or the tests don't exercise the change. |
| `scope` | Did it stay in scope? | 5 | The diff touches only what the task needs. | Unrelated rewrites, reformatting or stray files. |

## Hard rules for judges

- **A failing check caps `correctness` at 4.** The check result in the packet is ground truth. Don't argue with it.
- **Breaking a "never bent" rule caps `repo_rules` at 2.** Quote the rule.
- **Score only what you can see.** If you can't verify something from the packet, say so in `notes` and don't give credit for it.
- **Every score below 10 needs a reason.** Cite a file and line from the diff where you can.
- **Score each entry on its own merits first.** Only after scoring both entries, pick `winner`: A, B or tie. A tie is allowed only when the totals are within 3 points.
