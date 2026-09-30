# Live validation log (the dedicated Cribl.Cloud build org, Cribl 4.20.1, Standard plan)

Every entry is a real run against the live demo rig (≈450 GB/day of synthetic Datagen traffic), metered by
`scripts/runner.ts` (D24) into the installed App's KV, with the levers pulled through `scripts/lever.ts`
(the same `core/demo/levers.ts` the Demo Console calls). Demo profile on (1-minute confirmation, labelled).

## Installs
| When (UTC) | What | Result |
|---|---|---|
| 09-26 07:4x | `PUT /apps` + `POST /apps` release `meter-reader-1.0.0.tgz` (no proxies.yml, D23) | installed; Review data = GET-only grants + `POST /system/metrics/query` |
| 09-26 07:4x | `PATCH /apps/meter-reader` demo `meter-reader-1.0.1-demo.tgz` (displayName "Meter Reader (demo build)") | upgraded over the release (SPEC 18) |
| 09-26 (morning) | demo 1.0.2 … 1.0.6, each with `scripts/deploy.mjs` (Apps API) | upgraded in place; the runner's metering history survived each (D22: plain numeric demo versions) |
| 09-26 ≈16:00 | demo 1.0.7 | upgraded; the org reports 1.0.7; "Load demo prices" checked by hand in the real shell |
| 09-26 22:05 | demo 1.0.8 | upgraded; the org reports 1.0.8 |
| 09-27 00:25 | demo 1.0.9 (the Report card) | upgraded; the org reports 1.0.9 |
| 09-27 04:22 | demo 1.0.10 (wave 1) | upgraded; the org reports 1.0.10 |
| 09-27 09:15 | demo 1.0.11 (wave 2), the **first build whose `default/policies.yml` carries the three literal relay paths** (`/m/default_search/search/saved/meter_reader_alert_relay` GET, `/m/default_search/search/saved` POST, `/m/default_search/search/saved/meter_reader_alert_relay/notifications` POST; checked in the package's `default/policies.yml`) | **the Leader accepted the literal relay grants at install**; the org reports 1.0.11 |
| 09-27 12:25 | demo 1.0.12 (wave 3), same literal relay paths | upgraded; the org reports 1.0.12 |
| 09-27 16:36 | demo 1.0.13 (name, leftovers, Flow colour, D54), same literal relay paths | upgraded; the org reports 1.0.13 (Apps API GET: version 1.0.13, displayName "Meter Reader (demo build)") |
| 09-27 19:32 | demo 1.0.14 (the rules round: D56–D59), same literal relay paths | upgraded; the org reports 1.0.14. The runner, updated to the same tree at 19:33, removed the one direct-webhook URL an older build had stored in the App's `settings` ("removed 1 stored webhook endpoint(s) or URL(s) from App KV (D57); 0 left"), now reads the demo receiver from its `.env` and names it in `meta.deliveryWebhooks` ("Demo receiver (webhook.site)"). `runner.ts --weekly` at 19:34: sent 2 of 2 (the Cribl bell 200, the demo webhook 200); `notify/log` holds no URL. Metering history carried over (sweeps continued at :25) |
| 09-27 22:01 | demo 1.0.15 (rules round 3: D61–D63, target ids refused, commit credit by route-table hunks, third-party notices in the package), same literal relay paths | upgraded; the org reports 1.0.15 (Apps API GET: version 1.0.15, displayName "Meter Reader (demo build)", 22:01:54 UTC). The runner, updated to the same tree (`0fa69d0`) at 22:02, started with the demo receiver from its `.env`, found nothing in `settings` to remove, and swept at :25 (24–29 calls); its heartbeat reads `appVersion 1.0.15 build demo` and `runner-health.sh` OK. KV `settings` holds no endpoint and no URL outside the presenter QR link; `meta.appVersion` 1.0.15. Metering history carried over |
| 09-28 00:36 | demo 1.0.16 (rules round 4: token, key and password shapes refused, the first sweep sized from its own walk, every channel's money worded like the card, a recovered drop netted with its revert, the estate counted before the fold, the list-price net, API clients named, the Meter Reader icon), same literal relay paths | upgraded; the org reports 1.0.16 (Apps API GET: version 1.0.16, displayName "Meter Reader (demo build)", 00:36 UTC). The runner, updated to the same tree (`2493fb6`) at 00:36, started with the demo receiver from its `.env` and swept at :25 (24–27 calls); its heartbeat reads `appVersion 1.0.16 build demo` and `runner-health.sh` OK. KV `settings` holds no endpoint and no URL outside the presenter QR link; `meta.appVersion` 1.0.16. Metering history carried over (`collectingSince` still 09-26 06:20 UTC) |

## Break the trim → alert → restore (Tier 0 payoff)

Rows are numbered 1–9 in the order they ran; every time is UTC on 2026-09-26. **Logged as** is the label each run was first recorded under: each session numbered its own runs, so those labels skip 3, 5 and 6, and `DECISIONS.md` and older notes cite them ("run 10" is row 9). No row has been removed: this file's git history shows rows only added, or completed in place when a run finished. Every row is one break → alert → restore cycle, and every one was caught, named its commit and closed itself.

| # | Logged as | Break (deploy returned) | Incident opened | Caught in | Before → after | $/day · $/year | Commit named | Webhook | Restore deployed | Closed itself |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 08:00:00.5 | 08:02:08 | **2:07** | 0.744 → 0.495 | $25 · $9,119 | `143836d` "demo: break the trim on mrd_pay_sample" · s.koelpin · matched by changed file | 200 (Slack Block Kit) | 08:02:32 | 08:04:08 (96 s), recovery webhook 200 |
| 2 | 1 live | 08:12:57 | 08:15:08 | **2:11** | 0.744 → 0.496 | $25 · $9,070 | `c1a5678` "demo: break the trim on mrd_pay_sample" · s.koelpin · matched by files ✓ | 1 new | 08:15:15 | 08:17:08 (113 s), recovery webhooks +1 |
| 3 | 2 live | 08:25:38 | 08:27:08 | **1:30** | 0.744 → 0.511 | $23 · $8,533 | `e02156a` "demo: break the trim on mrd_pay_sample" · s.koelpin · matched by files ✓ | 1 new | 08:27:17 | 08:29:07 (110 s), recovery webhooks +1 |
| 4 | 4 replay (recorded to `demo/sample/replay.json`) | 08:53:41.3 | 08:55:08.0 | **1:27** | recorded to demo/sample/replay.json | — | `8537f6e` · s.koelpin | webhook + Cribl bell | 08:55:49.0 | 08:57:08.0 (79 s; recovery delivered to both). The replay plays these at +18 s, +108 s, +145 s and +230 s from its own start, so its offsets are not the caught-in |
| 5 | 1 post-3b (settle 20 s, runner :25) | 10:24:11 | 10:26:25 | **2:13** | 0.748 → 0.495 | $25 · $9,241 | `736c3f8` "demo: break the trim on mrd_pay_sample" · s.koelpin · matched by files ✓ | 1 new | 10:26:41 | 10:28:25 (104 s), recovery webhooks +1 |
| 6 | 7 **member path, from the Demo Console in the real Cribl iframe as Steve** | 14:39:xx (10:39 ET) | 14:41:25 | **1:43** | 0.755 → 0.528 | $23 · $8,281 | `805b12c` "demo: break the trim on mrd_pay_sample" · **Steve Koelpin** (full name from getCriblUser) · change to this route ✓ | webhook.site ✓ + Cribl notifications ✓ | 14:44:3x via Restore + confirm | 14:46:25 (≈ 110 s), recovered · closed itself (green card) |
| 7 | 8 **presenter takeover, live in the real Cribl shell** (break via lever CLI while ?present=1 was on screen) | 14:56:30 | 14:58:26 | **1:55** | 0.76 → 0.49 | $26 · $9,521 | `4dbd2f6` "demo: break the trim on mrd_pay_sample" · s.koelpin · change to this route ✓ | webhook ✓ (card flipped to "Sent to Demo receiver ✓ 10:58:25 AM") + bell | 14:59:14 | 15:01:25 (131 s): green takeover "Recovered · savings back to 77% · closed itself · Alert open for 2:55" seen live on the presenter |
| 8 | 9 presets $2.25/GB, demo 1.0.5 | 15:38:55 | 15:40:25 | **1:30** | 0.756 → 0.586 | $17 · $6,174 | `067a05a` "demo: break the trim on mrd_pay_sample" · s.koelpin · matched by files ✓ | 1 new | 15:40:33 | 15:42:25 (112 s), recovery webhooks +1 |
| 9 | 10 presets $2.25/GB + D45 deepening | 15:50:54 | 15:52:25 | **1:30** | 0.756 → 0.584 at open (partial minute) | $17 · $6,132 at open → **$23.86 · $8,708 settled** (closed incident's impactPerDayM 2,385,870; D45 deepening proven live) | `86238cf` "demo: break the trim on mrd_pay_sample" · s.koelpin · matched by files ✓ | 1 new | 15:52:32 | 15:54:25 (113 s), recovery webhooks +1 |

**Across the nine:** caught in 1:27 to 2:13 (median 1:43); closed itself 79 to 131 seconds after the restore deployed (median 110 s; row 4, the recorded run, is the fastest).

## Who Cribl records as the commit author (read 28 Sep, 07:35 UTC)

A GET-only read of the demo org's version log (`GET /m/default/version?count=1000`: 46 commits from 24 Sep 00:09Z to 27 Sep 16:46Z) through `scripts/cribl-api.mjs`. Only the **shape** of each author field is recorded here, never a value: no name, email address or client id.

| Commit | How it was made | `author_name` (what the App prints first, `core/adapters/version.ts`) | `author_email` |
|---|---|---|---|
| `805b12c` break, `0d7af2d` restore (row 6) | the Demo Console in the Cribl shell, signed in as the member | the member's **full name** | an email address |
| `5943ac6`, `e9e18e0` (27 Sep, the two Dispensary packs applied) | Cribl's Routes editor, as the member | the same member's **full name** | the same email address |
| the other eight breaks (rows 1–5, 7–9, including the latest, `86238cf`), and every other `demo:` commit | `scripts/lever.ts` with the org credential in `.env` | an **API client** (`<id>@clients`, one client id) | a single token |

- **What an alert names.** A break pressed from the Demo Console is recorded under the member who pressed it, both in Cribl's version control and in the timeline entry the Demo Console writes (the member's name from `getCriblUser`). The same holds for a change made in Cribl's own editors.
- **The terminal lever is different.** `scripts/lever.ts` writes its own timeline entry under `MR_DEMO_AUTHOR` (default `s.koelpin`), which is why rows 1–5 and 7–9 read "s.koelpin". Cribl recorded those commits under the API client.
- **Where the email address shows.** On these commits it is only in `author_email`, which the App shows only when `author_name` is empty.

## Enterprise variant: the packaged bundles, run locally (27 Sep; not the platform runtime)

The build organization has no App backend compute, so the Enterprise variant has never run on a Cribl backend. The scaffold's `backendPreviewPlugin` cannot stand in: it runs endpoints only in the engine that Cribl's Live Preview page sends over its websocket (`@cribl/apps/lib/preview/preview.js`, the `deploy` message carries `LocalComputeEngine`), which needs a Cribl organization with backend compute. What was run instead, on the packaged bundles of `meter-reader-1.1.0-backend.tgz` as built from `484d9b4`; the committed package, rebuilt from `495a0a6` for a README change, carries byte-identical bundles (`cmp`, 27 Sep):

- **Bundles.** `apps build` bundles each endpoint and loads it to prove it exports `onRequest` (`@cribl/apps/lib/build/backendBuild.js`). Sizes in the package: `meter.js` 264,749 B, `weeklyReceipt.js` 125,728 B, `sendTest.js` 105,671 B, against the 5 MB cap per bundle (`MAX_BACKEND_SCRIPT_BYTES`).
- **Invocation.** Each bundle was loaded from the extracted package with Node's `require` and its `onRequest` called with the schedule's body (`{ scheduleId, scheduledFor, mode: 'scheduled' }`), against the in-repository Leader emulator (`tests/integration/harness.ts`, a world started three hours earlier with the notification APIs on), one minute apart on the real clock. Every Leader and KV call was counted at `fetch`.

| Invocation | Status | Minutes metered | Calls in all (KV GET · KV PUT · other KV · Leader) | Leader calls |
|---|---|---|---|---|
| `meter`, first scheduled run | 200 | 60 (the seed hour) | 35 (15 · 10 · 2 · 8) | groups, inputs, outputs, pipelines, routes (1 each), metrics query ×3 |
| `meter`, next minute | 200 | 1 | 27 (13 · 8 · 0 · 6) | version, version/show ×2, metrics query ×3 |
| `meter`, steady state | 200 | 1 | 22 (12 · 7 · 0 · 3) | metrics query ×3 |
| `weeklyReceipt`, scheduled | 200 | — | 20 (15 · 4 · 0 · 1) | `POST /system/messages` ×1 (sent 1: the bell) |

Every invocation stays under the 50 calls a minute an App backend gets by default. Durations against the emulator (5–26 ms) say nothing about a real Leader and are not claimed; the closest live figure is the runner's, about 23 calls and about 1 second a sweep on the build organization, running the same `core/` sweep.

## Clean installs through the Cribl UI (a second organization, 27–28 Sep)

The release installed the way a judge or customer installs it, through the Cribl UI, on a fresh Standard-plan Cribl.Cloud organization separate from the build org, one that had never had Meter Reader (no Apps, no traffic before). The package was `meter-reader-1.1.0.tgz` as first built (sha256 `d3126f7c…5a6c`); the committed 1.1.0 package (`34d4ada6…`) was rebuilt from it for a README change only, and every later release carries the same `default/policies.yml` (`config/policies.yml` unchanged since 1.1.0). Run as an Organization administrator.

| When (UTC) | What | Result |
|---|---|---|
| 09-28 02:24 | Install 1: **Apps → Build my own App ▾ → Import from File** (the empty Apps page has no **Add App** yet), App ID blank, Overwrite off → **Import** → Review App → **Install** | Review App: "17 Cribl API permissions", the same list as `config/policies.yml` (the reads, the metrics query, the preview and the four notification writes, the relay read on its literal path). Listed as Meter Reader · meter-reader · 1.1.0; the first run opened on the first-run card, "Not metering yet", every first KV read a 404 (an empty store). The tour (9 beats), Story mode, every view on sample data, and the empty state after **Clear sample data** checked |
| 09-28 03:00–03:25 | On install 1: a Datagen Source (`syslog.log`, 100 then 1,000 events a second) → a pipeline with one Drop (`Math.random() < 0.5`) → DevNull, on a Final route above the default route, one Commit & Deploy; DevNull priced by hand in **Settings → Prices**; the bell's **Send a test alert** | The untagged Datagen read nothing saved: 1.1.0 metered a Datagen only when its description held `[meter-reader-demo]` or its id started `mrd_` (fixed in 1.1.1, D67). Tagged, the flow was priced about 80 s after the deploy, 50% saved, its would-have-paid, paid and saved consistent with bytes × price to the dollar. The bell test answered 200 and showed in the bell within about 35 s (Cribl's own poll). Prices, the Cribl cost and the bell settings survived four reloads |
| 09-28 03:25–03:29 | Delete (typed DELETE) → install 2, the same file and path | "App deleted."; the uninstall cleared the App's KV (every first-run read a 404 again). Review App: 17 permissions. Import → listed in 55 s including the review; the first real flow in the Ledger 8.9 s after **Start the meter** |
| 09-28 03:29–03:31 | Delete → install 3, the same file and path | 17 permissions; listed 18 s after **Import**; first real flow 8.7 s after **Start the meter**; left installed |

Not covered by these runs: a non-admin member the App is shared with, a notification target, and an import of 1.1.1 or later (below).

## Still to run (as of 9/29)

Checks that need a second workspace, a non-admin member or a measurement. An administrator bypasses the policy matcher (`docs/PLATFORM_NOTES.md`, "Runtime frame"), so a grant is proven only by a **non-admin** member the App is shared with; the stage demo, run as an administrator, does not depend on these results. The owner's clean-install kit covers the first three.

| Check | How | Closes | Status |
|---|---|---|---|
| The **literal relay grants** are accepted at install | Install a build whose `default/policies.yml` names the three literal `default_search` paths | EPIC_AUDIT P1-N01 | **Done 9/27–28**: demo 1.0.11, 1.0.12, 1.0.13, 1.0.14, 1.0.15 and 1.0.16 installed with them (Installs above) |
| The current **release** `.tgz` installs in a clean workspace | **Apps → Import from File** (under **Build my own App ▾** on a workspace with no Apps, **Add App** otherwise) with the current `release/meter-reader-X.Y.Z.tgz` (sha256 in `release/SHA256SUMS`), as the release (not the demo build), in a second organization that has never had Meter Reader; screenshot the Review App screen into `docs/evidence/` | P1-N04, the README checklist | **Done for 1.1.0, 27–28 Sep**: three UI imports on a fresh second organization (Clean installs through the Cribl UI, above). 1.1.4, whose grants are the same, still to be imported the same way: the owner's clean-install test |
| The relay grants are honored **for a non-admin member** | As a member the App is shared with: Settings → Where to send alerts → the bell's **Send a test alert**; a target endpoint's connection check (the literal GET); **Connect** on a target without a relay notification yet (the literal notification POST); **Send a test alert** on that target (the forward). Record each status | P1-N01, P1-N04 | owner's clean-install test, step 8 |
| **Sharing survives an upgrade** | Note who the App is shared with, upgrade, check again | the README's upgrade note | not run here; Cribl's Apps admin guide says an upgrade preserves the App's Share settings (`docs/platform/insights-and-apps-docs.md`) |
| The **member-context Leader rate** | From a non-admin member's open App, in the developer console of the App's frame, a read-only loop that reads the App's `meta` KV document (`${window.CRIBL_API_URL}/kvstore/meta`, the way the App reads it) about 150 times inside one minute; log each status and any `Retry-After`: the first 429, if any, is the ceiling. The `?diag=1` panel only displays state and calls nothing | P1-N05 (`docs/PLATFORM_NOTES.md` §8 Q6) | not run |
| The **KV key count** | One `POST /kvstore/keys` listing of the App's keys; record the count next to the README's derived figure | the README's key count | **Done 9/27 20:04 UTC**: 42 keys, about 38 hours after metering began (`meta.collectingSince` 2026-09-26 06:20 UTC, no gaps): 11 single documents (`meta`, `settings`, `prices`, `lock/meter`, `totals`, `inventory`, `timeline`, `notify/log`, `snapshot`, `demo/state`, `baselines`), 26 `roll/min` hours, 2 `roll/hour` days, 1 `roll/day` month and 2 `incidents` days, as the retention predicts at that age; no chunk keys. Read-only listing with the org credential, run once |
| A **Slack notification target** | An administrator creates one Slack target; Connect it; **Send a test alert**; screenshot Slack into `docs/evidence/` | P1-N04 | not run (a webhook target is proven, §4 of `docs/NOTIFICATIONS.md`) |
