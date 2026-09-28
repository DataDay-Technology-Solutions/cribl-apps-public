# Core fixes (wave 3a) — builder report

All three fixes are in and the full test suite passes. `npx tsc -b` now shows 6 errors, but all of them are in another builder's unfinished, untracked files, not in anything I changed. Nothing is committed, and the live runner (pids 17483/17506/17507) is still running.

**Tests**
- `npx vitest run`: 1012 of 1012 pass (987 before; 25 new).
- The swap tests catch the bug: against the old `core/snapshot.ts`, 8 of the new unit tests and both integration tests fail. In the emulated swap the old code read the route's volume per day about 97% low.
- Unit coverage of `core/`: 99.52% of lines and 93.34% of branches, above the thresholds.
- Playwright, chromium only (port 5174, mock mode): 74 passed, 8 skipped. The 1920 and mobile runs were not done.
- `npx tsc -b` was clean when I started. The 6 errors now are 4 in `scripts/live-demo-run.ts` (`LeverResult.deployedAt`) and 2 in `src/story/beats.ts` (`Commit` is missing `files`/`source`). I only added `Meta.lastSweepOwner`, which neither file uses.

**Fix 1: thin ribbon after Apply**
- **What changed:** each current flow now builds its per-day figures and its sparkline from all the stored rows for its route. That means rows under any pipeline that share the same group, input, route and destination. The last-minute figures (bytes, money, ratio, hourly rate) still come from the current pipeline only.
- **Knock-on effects:**
  - Destination totals and each route's place in top savers no longer drop after a swap.
  - Revert works the same way: the restored pipeline keeps the pack's minutes in its hour.
  - A route that now sends to a different destination is not merged with its old history.
  - When two current flows share one route identity, the old rows go to only one of them, so nothing is counted twice.
- **Files:**
  - `core/snapshot.ts`: new `routeIdentity` and `routeHistoryKeys`, used in `buildSnapshot`.
  - `core/rollups.ts`: new `poolMinuteRows`, which merges rows by minute and sums any minute two keys both hold.

**Fix 2: default runtime for the Enterprise backend build**
- `src/lib/env.ts` reads `VITE_MR_RUNTIME` and exposes `runtimeFromEnv` and `DEFAULT_RUNTIME` ('backend' only when the flag says so, otherwise 'ui'). The type declaration for the flag lives in this file, so `globals.d.ts` is untouched.
- `core/settings.ts`: `defaultSettings(nowIso, tz, runtime = 'ui')`.
- A stored settings document still overrides this default. So an existing install already saved as 'ui' will not switch to 'backend' on its own.

**Fix 3: who metered the last sweep**
- Each completed sweep now writes `meta.lastSweepOwner` (the lock owner it ran as). A failed sweep keeps the previous owner.
- `src/state/selectors.ts` gains:
  - `sweepOwnerKind(meta)`, returning 'tab', 'runner', 'backend' or 'unknown'.
  - `sweepOwnerHost(meta)`, which reads a host from an owner of the form `runner:<host>:<pid>`.
  - `sweepOwner(state)`, which returns 'unknown' while sample or replay data is showing.
- No screen uses these yet.

**package.json:** added `"license": "Apache-2.0"` and `tags.product: ["stream"]`. The app platform's package check allows both fields, and the compliance test passes.

**Files outside my ownership** (small additions, each needed by the task):
- `core/types.ts:349`: `lastSweepOwner?: string` on `Meta`.
- `core/sweep.ts:1206`: `lastSweepOwner: d.owner` (the one-line change the task allowed).
- `src/state/runtime.ts:19,84`: imports `DEFAULT_RUNTIME` and passes it to `defaultSettings`.

**New and extended tests:**
- New: `tests/integration/route-history.test.ts` (real sweep, then Apply the pack, then Revert), `tests/unit/runtime-owner.test.ts`.
- Extended: `tests/unit/snapshot.test.ts`, `tests/unit/rollups.test.ts`, `tests/unit/settings.test.ts`.

**Open issues**
1. **The live org will show 'unknown' for the owner for now.** The running runner still has the old sweep code loaded, so it doesn't write `lastSweepOwner` yet. That changes only after the runner is restarted on the new code and the demo build is redeployed with UI that uses the selector.
2. **No host for the runner yet.** `scripts/runner.ts:61` uses the owner `runner:${process.pid}`, so the host lookup finds nothing. Changing it to `` `runner:${os.hostname()}:${process.pid}` `` would fix that, at the next scheduled runner restart.
3. **Nothing on screen uses Fix 3 yet.** The Footer and Settings wording ("Metered by the runner on <host>" / "Metered by this tab") and its copy in `en.ts` belong to other builders.
4. **What-if side effect.** `core/whatif.ts` `findSimilarStream` works out its reduction ratio from the per-day figures. For up to an hour after a swap, those figures now mix in the old pipeline. If it picks a route that just switched to the pack as its "similar stream", the ratio it quotes will read low. `measureActual` is unaffected because it reads the last minute only. This is for the what-if owner.
5. **Visible change in the Demo Console.** Each stream's paid per day now covers a full hour instead of just the pack minutes. Saved per day still ramps up over the hour after Apply the pack.
6. **Suggested DECISIONS entry** (I don't own that file): minute rows for the same group, input, route and destination are pooled across pipeline swaps for the hourly projections and the sparkline. Last-minute figures stay the current pipeline's.