# Adversarial review (wave 3a) — findings

Adversarial review of Meter Reader, read-only: I edited no repo files and only created throwaway probes under `<scratchpad>/review/` (a scratch directory outside the repository).

The worst finding: when the tab's sweep lands in the first ~6 s after a minute ends, it meters that minute as empty. Nothing is ever detected and the Meter stops ticking, which breaks the break-the-trim demo beat. Line numbers are against b87432a plus the working tree at about 08:15Z; other builders were editing `core/sweep.ts`, `core/snapshot.ts` and `core/rollups.ts` during the review.

**FINDINGS (most severe first)**

**1. CRITICAL, confirmed (live probe + emulator probe): the newest minute is metered before the Leader has its data.**
- **Where:** `core/sweep.ts:453` (`windowEnd = minuteFloor(nowMs)`), `:464` (the cheap check makes that early sweep the only one for the minute), `:864` (a minute with no rows is treated as zero traffic), `:896` (the late-minute rewrite that later fills the minute skips detection), `:921`/`:932` (the empty minute gives ratio null and feeds cost 0 into the spike baseline). Also `core/snapshot.ts:348` (`ratePerSecM` comes from the empty minute) and `src/state/meterLoop.ts:118-124` (the 30 s tick phase is fixed per session).
- **Evidence:** read-only live metrics queries returned no rows for the just-ended minute at +1 s, +5 s and +6 s. Data was there at +7 s and +10 s (minutes 08:11, 08:15, 08:16).
- **Emulator result:** I replayed the break-the-trim beat with that lag.
  - Tab sweeping at boundary +3 s: 0 incidents, `snapshot.ratePerSecM` = 0, last-minute payments inB = 0.
  - Tab sweeping at +20 s: 1 incident and normal ticking.
- **Scenario:** a tab whose tick phase falls in the first ~6 s after the minute (about 20–25% of sessions) is affected every minute.
  - In the release, where the tab is the only runtime, nothing is ever detected and the Meter never ticks.
  - On stage, that same tab also beats the runner (which sweeps at :08), so pressing B never alerts.
  - The runner's own margin is only 1–2 s (data first visible at +6–7 s).
- **Fix:** meter only minutes that ended at least 20 s ago in `runSweep` for every runtime (`windowEnd = minuteFloor(nowMs - 20_000)`). Hold `meteredThrough` when the newest minute has no rows but the previous one had traffic. Move the runner to :25.

**2. HIGH: every webhook the tab sends goes through an App proxy that has no host.**
- **Confidence:** the code path is confirmed. The platform side is confirmed by `GET /apps/meter-reader/proxies` → `{"items":[],"count":0}`, plus D23.
- **Three paths, all using the platform fetch:**
  - (a) Demo Console W / "Weekly receipt now" (`src/demo/client.ts:325-338`, sender at `:525`). This fails every time, and there is no runner-side weekly command.
  - (b) Settings "Send a test alert" (`src/views/Settings/NotificationsSection.tsx:81`).
  - (c) Incident alerts whenever the tab wins the lock (its fixed phase is under 8 s, so it wins every minute or never).
- **Compounding defect:** `core/sweep.ts:1055-1071` stamps `lastNotifiedAt` even when every attempt failed. That silences the runner, which can deliver, for `cooldownMinutes` (60), and the card shows "delivery blocked".
- **Fix:** keep a separate `lastAttemptAt` with a short failure cooldown, and set `lastNotifiedAt` only on a 2xx. In the ui runtime, skip step 8 (and W) while a runner sweep is fresh (`meta.lastSweepOwner`/`lastSweepMode` less than 90 s old). Add a runner weekly command for the stage.

**3. HIGH, confirmed (emulator probe): the first run meters an hour at $0 before prices exist.**
- **Where:** `src/state/meterLoop.ts:23-30` (no gate on prices), `core/sweep.ts:639` (60-minute seed), `core/pricing.ts:219-224` (the annualized denominator counts the unpriced minutes). The button copy "Set prices and start metering" (`src/copy/en.ts:377`) implies the opposite.
- **Probe:** saving prices 2 minutes after opening the app, then 60 minutes of metering, gives today $11.47 instead of $21.82 and annualized $49,412 instead of $95,572. D25's first-price backfill never applies in the UI runtime. This is the judge's exact path.
- **Fix:** gate `shouldMeter` (or stop advancing `meteredThrough`) until a prices document exists. The first sweep after Save then prices the seed hour at the first price.

**4. HIGH, confirmed (tgz listing + grep): the README contradicts the packages and advertises features the release lacks.**
- **Proxies:** `README.md:20,99,135,141,357` say `hooks.slack.com`/`default/proxies.yml` ship and that admins authorize hosts under External API Access. `release/meter-reader-1.0.0.tgz` and `1.0.1-demo.tgz` contain only `default/policies.yml`.
- **Weekly receipt:** `README.md:62` promises "Weekly receipt now" and an automatic Monday send. `shouldAutoSendWeekly` (`core/weekly.ts:57`) has no caller, `runWeeklyReceipt` is called only by the demo console, and copy key `receipt.sendWeekly` is unused.
- **Scenario:** a Standard-plan judge follows setup steps 4–5, gets a 403, and finds no weekly button.
- **Fix:** rewrite the Setup, Permissions and Weekly sections per D23, and either wire the weekly button and auto-send or drop the claims.

**5. MEDIUM, confirmed (fault-injection probe): totals lose a minute for good when a sweep dies between the minute-doc writes and the totals write.**
- **Where:** `core/sweep.ts:883` (a new minute that already has rows counts as "replaced") and `:1081` vs `:1104` (minute docs are written before totals).
- **Probe:** one injected failure on the `totals` PUT left stored rows above totals by exactly one minute (whp 63,169 mc, saved 17,918 mc; 67 vs 68 minutes).
- **Triggers:** closing or navigating the tab mid-sweep, or a KV 5xx/429 on the hour fold.
- **Side effect:** notifications (step 8) were already sent while the incident docs were not written. If baselines also failed, the next sweep re-opens the incident under a new id and notifies again.
- **Fix:** keep a cursor inside the totals doc and decide new vs replaced from it; or write totals first.

**6. MEDIUM, confirmed (emulator probe): after a gap, the annualized figure averages calendar days instead of metered minutes.**
- **Where:** `core/pricing.ts:204-217`.
- **Probe:** 30 minutes open, closed 40 h, then reopened. Day 9/29 had 989 of 1440 minutes metered, and annualized came out $65,631 instead of $95,494 (−31%), captioned "from the last 1 day". Gaps are normal for judges using the tab runtime.
- **Fix:** annualize Σsaved / Σminutes × 525,600 over the last 30 days using `byDay[].minutes`, which is already stored.

**7. MEDIUM, confirmed by code: volatile levers run without confirmation (AGENTS.md:78-91).**
- **Where:** `src/demo/keyboard.ts:25-61` and `src/demo/actions.tsx:206-244`.
- **What fires on one key or button:** 1/A/2/3/G PATCH the whole route table, then commit and deploy. V, R, S and C also write. 0 (Reset everything) PATCHes pipelines and inputs, commits, deploys, writes settings and closes incidents.
- Only B and Full show a confirmation (`actions.tsx:209`, `:256`). Non-full scenes start unconfirmed and then PATCH on timers.
- `src/components/IncidentTakeover/IncidentTakeover.tsx:10-11` lets the keypress that dismisses the takeover also reach the lever keys, so pressing 0/1/2/3 to dismiss pulls a lever.
- **Fix:** send every lever through `confirmThen`, and consume the dismiss keypress in the takeover.

**8. MEDIUM, confirmed by code: the Demo Console resumes a saved scene on mount and runs its next lever step with no user action.**
- **Where:** `src/views/Demo/index.tsx:105-107` → `src/demo/sceneRunner.ts:288-293` (`adopt()` → `evaluate()`).
- **Scenario:** a scene left in demo/state (phone closed mid-scene) gets restored, reverted or rate-set, committed and deployed as soon as anyone opens the console. AGENTS.md forbids writes on page load.
- **Fix:** ask "Resume scene?" and expire stale scenes.

**9. MEDIUM, confirmed live: a stale open incident will show on stage.**
- `inc_bb03ce` is a high-severity "Savings dropped: AWS VPC Flow Logs" at $0.53/day, opened 06:42Z on catch-up before D26.
- Its frozen baseline is 0.297, but the route was deliberately returned to passthrough (ratio 0), so `core/detector.ts:162-174` can never close it. The snapshot shows `openIncidents` = 1 and the vpc_flow flow in state `regression`.
- **General defect:** a deliberate change leaves an incident open forever.
- **Fix:** run Reset everything before showtime; add an "accept new normal" action or auto-close with a re-learned baseline.

**10. LOW, confirmed live: the footer reads "vrunner-demo" and "Meters every 30 seconds while open" while the runner does the metering.**
- `scripts/runner.ts:62` writes `appVersion: 'runner'` (live `meta.appVersion` = "runner"), which `src/components/Shell/Footer.tsx:13,38` passes to `src/lib/env.ts:28-33`. `Footer.tsx:42` takes the runtime text from `settings.runtime`.
- **Fix:** have the runner write the package version, and base the footer text on the in-progress `meta.lastSweepOwner`.

**11. LOW, confirmed live: the Receipt view warns "1 destination has no price" on the demo and on every fresh org.**
- The built-in `devnull` has no price entry, and `core/pricing.ts:119` treats a missing entry as unpriced even for `FREE_OUTPUT_TYPES` (`core/presets.ts:41`). Live `unpricedOutputIds` = ['devnull'].
- **Fix:** a free output type with no entry counts as priced at $0; or price `devnull` in `runner --setup`.

**12. LOW, confirmed by code: the Presenter and Receipt screens disagree on the annualized caption.**
- `src/views/Presenter/index.tsx:36` rounds before the ≥ 1 test, so 12–24 h of partial data reads "from the last 1 day".
- `src/views/Receipt/text.ts:27-28` tests the raw value and says "partial".
- **Fix:** test the raw `annualizedFromDays`.

**13. LOW, confirmed by code: Slack alerts for catch-up incidents say "caught in 2 min" and never mention catch-up.**
- `caughtInSec` is computed at the historical minute's end (`core/sweep.ts:910`, `core/detector.ts:214`). `core/payloads.ts:203-206` only annotates the demo profile.
- Live `notify/log` shows catch-up regressions were delivered.
- **Fix:** add "caught on catch-up" and base caught-in on detection time.

**14. LOW, confirmed (bundle grep): the release bundle contains a `getContext('2d')` canvas call.**
- It is the `qrcode` library's canvas renderer, unused (the QR is drawn as an SVG path), in `static/assets/Presenter-*.js`. A judge grepping for canvas will hit it.
- **Fix:** import only the encoder.

**15. LOW, plausible (not verified against Slack): the Slack top-level `text` fallback is not escaped.**
- `core/payloads.ts:208`; the title can carry `route.name`. The blocks themselves are escaped.

**CLEARED (no finding)**
- No HTML-injection sinks: no `dangerouslySetInnerHTML` or `innerHTML`. The Slack preview renders links as plain spans and the QR is an SVG path.
- A saved webhook URL is never shown in full.
- No browser storage in the release bundle.
- No demo or mock code (MSW, levers, Demo Console) in the release bundle.
- Release policies are GET plus the metrics query only.
- Levers refuse any object without `[meter-reader-demo]` and always commit an explicit file list.

**FILES CHANGED:** none.

**TESTS**
- `npx vitest run`: 54 files, 1012 tests pass.
- `npx tsc -b` fails only in other builders' untracked, in-progress files: `src/story/beats.ts` (4 errors) and `scripts/live-demo-run.ts` (4 errors).

**OPEN ISSUES**
- The live runner (pid 17507, started 07:58:17Z) is running code older than the working-tree edits to `core/sweep.ts` (08:07:14Z) and `core/snapshot.ts` (08:07:09Z). Restart it after those land.
- Before showtime: run Reset everything, set a $0 price on `devnull`, and do not rely on the tab or W for webhooks.