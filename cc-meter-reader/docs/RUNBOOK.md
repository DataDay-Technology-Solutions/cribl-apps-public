# Runbook — build, test, package, deploy, run

Everything needed to go from a clean checkout to Meter Reader installed in a Cribl.Cloud workspace, the optional runner, and the demo rig. For how the pieces fit, see [`ARCHITECTURE.md`](ARCHITECTURE.md); for alert delivery through Cribl, [`NOTIFICATIONS.md`](NOTIFICATIONS.md); for why each choice was made, [`../DECISIONS.md`](../DECISIONS.md).

## 1. Prerequisites

- **Node.js 22.22.2 or newer** (the floor `@cribl/apps` 1.1.0 declares) and npm.
- **A Cribl.Cloud workspace with Apps, on any plan.** Installing and sharing an App, and creating notification targets, need a Workspace Administrator. The release needs neither App backend compute nor App proxies (D23).
- **For deploy, runner, lever and rig scripts only:** an API credential (client ID and secret) for the organization, kept in `.env` at the repository root. `.env` is git-ignored and never enters a stage or a package; `.env.example` lists the keys with no values:

  | Key | Meaning |
  |---|---|
  | `CRIBL_CLIENT_ID`, `CRIBL_CLIENT_SECRET` | The API credential; exchanged for a bearer token at `https://login.cribl.cloud/oauth/token` |
  | `CRIBL_ORG` | The organization id (the part after the workspace in `https://main-ORG.cribl.cloud`) |
  | `CRIBL_WORKSPACE` | The workspace name; defaults to `main` |
  | `MR_WEBHOOKS` | Optional: the runner's direct webhooks, comma-separated https URLs, each with an optional `slack:`, `generic:` or `servicenow:` prefix (default: Slack format for `hooks.slack.com`, generic JSON otherwise). They stay here: no build stores a webhook URL in KV (D57); only each one's name and host reach `meta` |
  | `MR_DEMO_WEBHOOK_URL` | Demo only: the demo webhook receiver, sent to as the direct webhook `demo-webhook-site` (Slack format). Like `MR_WEBHOOKS`, it never reaches KV |
  | `MR_RUNNER_HOST` | Optional: the name the runner reports ("Metered by the runner on HOST") and the one the single-runner check compares across machines. Without it the lock owner is `runner:PID` and the App says "the runner": the machine's own host name is never written into the org's KV, which every member the App is shared with can read |
  | `MR_DEMO_AUTHOR` | Demo only: the commit author `scripts/lever.ts` records in the timeline |

  The scripts never print these values.

## 2. Set up and run locally

```bash
npm ci
npm run dev
```

Outside Cribl there is no `CRIBL_API_URL`, so the dev build starts the in-browser Cribl emulator (`src/mock/`, MSW) and serves synthetic workspaces, metrics and KV. The emulator has no bell API, so the implicit bell is skipped quietly there (D27). It exists only in dev and test builds; every package is built with it compiled out.

Live Preview inside Cribl (`npm run dev` plus Apps → Live Preview) is the platform's intended loop. On Chrome 151 it is blocked by Local Network Access (DECISIONS D8), so this project installs packages instead (section 5).

## 3. Test

```bash
npm run typecheck                        # tsc -b over the UI, core, backend, tests and scripts
npm run lint                             # oxlint
npm run test:unit                        # core/ unit and property tests
npm run test:integration                 # sweep scenarios against the MSW Cribl emulator, request budget, performance
npm run test:coverage                    # unit tests with the coverage gate on core/
npx playwright install chromium          # once
npx playwright test --project=chromium   # end to end on port 5174 with VITE_MR_MOCK=1
npm run compliance                       # tests/compliance.test.ts (builds any missing package first)
npm test                                 # unit + integration + compliance
```

Reports land in `tests/report/` (coverage, Playwright HTML, screenshots and the beauty grid).

## 4. Package

```bash
npm run package:release -- --version 1.1.0     # release/meter-reader-1.1.0.tgz          (primary asset)
npm run package:demo -- --demo-version 1.0.N   # release/meter-reader-1.0.N-demo.tgz     (stage build; N = the next demo build)
npm run package:backend -- --version 1.1.0     # release/meter-reader-1.1.0-backend.tgz  (Enterprise variant)
npm run audit                                  # contents, grants, hosts, checksums, then the compliance test
```

`--version` defaults to the `version` in `package.json`; bump that first for a release, so the compliance test's "package.json version equals the release package" check holds. **Demo versions are plain numeric and must go up with every build installed on the same org** (D22): the Leader's upgrade check refuses a pre-release such as `1.0.0-demo` over `1.0.0`, so the demo marker lives in the file name and the display name. The compliance test checks every `*-demo.tgz` at the top of `release/` against the current `config/demo/policies.yml`; move superseded demo builds into the git-ignored `build/superseded/` rather than deleting them (`release/*.tgz` is ignored only at the top level).

What `scripts/package.mjs` does for each variant:

1. Copies the repository into `.stage/pkg-VARIANT`, leaving out `node_modules`, `.git`, build output, `tests/report`, the local planning folder and every `.env` file, and links the real packages into a private `node_modules`.
2. Overlays the variant's declarations:
   - **release**: `config/policies.yml` as committed; no `proxies.yml` (App proxies need an Enterprise plan, D23); any `config/backend.yml` or `config/schedules.yml` removed.
   - **backend**: the Enterprise variant: the release plus `config/enterprise/backend.yml` and `schedules.yml`; no `proxies.yml` (D57: no build posts to a webhook host); `apps build` bundles `backend/`.
   - **demo**: `config/demo/policies.yml` as `config/policies.yml`; no `proxies.yml`.
3. Sets the stage's `package.json` version and display name (`Meter Reader`, or `Meter Reader (demo build)` for the demo) and runs `npm run build` (`tsc -b && vite build && apps build`) with `VITE_MR_BUILD` (`release` or `demo`), `VITE_MR_RUNTIME` (`ui` or `backend`) and `VITE_MR_MOCK=0`. Because the stage runs `tsc -b`, a type error anywhere in the working tree fails the package build.
4. Packs the stage with `createAppPack` from `@cribl/apps/package`, writes the archive into `release/`, checks its manifest and prints its size, file count and SHA-256. The stage is deleted on success and kept for inspection on failure (`--keep-stage` keeps it always; `--verbose` streams the build).

The working tree is never modified. `--ref GIT-REF` builds from exactly one commit instead of the working tree.

## 5. Deploy

**Through the Apps API** (what the build uses):

```bash
node scripts/deploy.mjs release/meter-reader-1.1.0.tgz
```

It uploads the package (`PUT /apps`), prints the pre-install check (the data the Review App screen shows: declared permissions, hosts and backend functions), then installs it (`POST /apps`) or, when `meter-reader` is already installed, upgrades it (`PATCH /apps/meter-reader`). For a backend package it then polls the backend status until it is live. An upgrade keeps the App's KV data (measured on every demo upgrade, `docs/LIVE_VALIDATION.md`). Cribl's Apps admin guide says an upgrade also preserves the App's **Share** settings (not yet re-measured here).

**Through the UI** (what a judge or customer does): **Apps → Add App → Import from File**, choose the `.tgz`, review, confirm. The Review App screen for the release shows the reads, the metrics query, the preview dry run and the four notification writes, and no host.

**After the first install:**

1. Share the App with the members who should open it: **Apps → Installed**, the App row's menu (⋯) → **Share**, give **App user** on the **Members** or **Teams** tab, and save (Cribl's Apps admin guide). The members it is shared with get the grants in `default/policies.yml` while they use the App.
2. Open Meter Reader: **Tour with sample data**, or **Settings → Prices** to meter real flows. The Cribl notification bell receives alerts with no setup; **Settings → Where to send alerts → Cribl notifications (bell) → Send a test alert** proves it.
3. Optional: to reach Slack, PagerDuty, email or a webhook, create a notification target in Cribl (**Settings → Notification targets**), then in Meter Reader select **Add endpoint**, pick the target and confirm **Connect**. Connect creates the saved search `meter_reader_alert_relay` (never scheduled) in `default_search` and one notification `meter_reader_relay_TARGET`; both can be deleted in Cribl Search at any time. Then **Send a test alert**.
4. Nothing to authorize under **App Settings → External API Access**: no package declares a proxy host (D23, D57). Direct webhooks are the runner's, from its `.env`.

**After a deploy that changes `policies.yml`:** as a non-admin member the App is shared with, run the bell test and a target test in Settings. If the App proxy refuses them (403), the Settings test says so; the runner still delivers with its credential. (Open item, `NOTIFICATIONS.md` §6.)

The backend package installs only on organizations with App backend compute; elsewhere the install fails with "App backend compute requires an enterprise license/plan" (or "App proxies require an enterprise license/plan"), and the release package is the one to use.

## 6. The runner (optional; D24)

The runner is the third runtime: the same `core/` sweep, run once a minute from a machine you own, writing into the installed App's KV. Use it when a workspace has no App backend compute and should keep metering with no Meter Reader tab open.

```bash
npx tsx scripts/runner.ts --once        # one sweep, print the summary
npx tsx scripts/runner.ts --weekly      # send the weekly receipt now (the seven days before today)
nohup bash scripts/runner-supervise.sh >> logs/runner.out 2>&1 &   # sweep every minute (25 s after the boundary) forever, restarted with back-off; weekly receipt once after Monday 12:00 UTC
pgrep -fl scripts/runner.ts             # is it running? (logs/runner.pid names the one that holds this machine)
tail -f logs/runner.log                 # one line per sweep: calls, ms, minutes, backfilled, opened, closed, notified
cat logs/runner.heartbeat.json          # the last sweep's summary, ok, and the reason when it is not ok
npx tsx scripts/runner.ts --setup --demo-org ORG   # DEMO ORG ONLY: prints the plan, then seeds the illustrative prices,
                                                   # demo mode and the demo webhook; ORG must equal CRIBL_ORG in .env
```

- **One runner.** The loop refuses to start (exit 3, the reason in `logs/runner.log` and on stderr) while `logs/runner.pid` names a live runner on this machine, or while a runner on another *named* host (`MR_RUNNER_HOST`) metered the org in the last 90 s; `--force` skips the org check. The supervisor stops for good on exit 3 instead of restarting it.
- **Logs.** `logs/runner.log` is the one log (rolled over to `runner.log.1` at 5 MB). The runner echoes it to the terminal only when run interactively, so `runner.out` (nohup, launchd) holds only what the process itself printed on a crash.
- **Heartbeat.** `logs/runner.heartbeat.json` after every sweep: `ok` is false on any error — a rate-limit back-off included — and after 3 `locked` skips in a row (something else holds the meter, so this runner meters nothing); `reason` says which. `"skipped":"current"` is healthy.

- **Credential.** The `.env` API credential must be able to read the configuration, the version history and metrics, and to write the App's KV (`/api/v1/a/meter-reader/kvstore`); to deliver to the bell and targets it also needs the notification permissions the release grants, and it reads `GET /apps/meter-reader` every 10 minutes so `meta` (and the footer) carry the installed App's version and build. An admin credential covers all of it; `NOTIFICATIONS.md` §2 records every notification call it makes.
- **It coexists with open tabs.** The KV lock `lock/meter` serializes the runner with any tab, and a minute `meta` says is metered is never metered again. `meta.lastSweepOwner` names who ran the last sweep (`runner:HOST:PID` for a runner with `MR_RUNNER_HOST`, `runner:PID` without). Every runtime meters a minute only 20 s after it ends (the metrics store has no rows for a just-ended minute for 6–7 s), which is why the runner sweeps at :25.
- **The lock on a slow Leader.** `lock/meter` lives 130 s: the sweep's 100 s time budget plus 30 s. A sweep that reaches its writes with less than 45 s of the lock left renews it (a read and a write; a normal ~1 s sweep never does), so a slow sweep — about 4.5 s a Leader call — keeps it through its last write instead of losing it to a tab's tick at 95 s. If another runtime holds the lock by then (its clock ran ahead and it took the lock as expired), the sweep abandons its writes, leaves `meta` and the lock alone and reports `lock_lost` (EPIC_AUDIT P1-E02).
- **Delivery.** It uses the same router as the tab (the bell by default, connected targets) and also posts the direct webhooks named in its `.env` (`MR_WEBHOOKS`, `MR_DEMO_WEBHOOK_URL`; D57), because it runs outside the App proxy. It logs them at start by name and host, writes only those names and hosts to `meta.deliveryWebhooks` (Settings lists them), and at start removes any webhook URL an older build stored in the App's settings. While it is sweeping (a sweep in the last 90 s), open tabs leave all notifications and the Monday receipt to it. Cribl channels go first, then direct webhooks; a direct webhook gets one attempt a sweep (the next sweep is its retry), and one that does not answer within 10 s is skipped for the rest of that sweep, so a dead host costs one timeout a sweep, not ~40 s an incident, and the healthy endpoints still get every alert on time (EPIC_AUDIT P1-E07).
- **A minute a tab metered first.** Like the tab, the runner reads `meta` before anything else and stops when the last settled minute is already metered (`"skipped":"current"` in `logs/runner.log`, 1–2 calls instead of a ~22-call sweep that meters nothing). When a tab metered it, the runner checks in — one `meta` write, `deliveryOwner`/`deliveryOwnerAt` — so tabs keep leaving delivery to it; a tab that left alerts to deliver sets `meta.deliveryDeferredAt`, and the runner then sweeps in full that same minute and sends them (EPIC_AUDIT P1-E05). Sweep now never takes the shortcut.
- **Budget.** About 23 Leader calls and about 1 second per sweep, measured live; a catch-up after a gap costs more (95 minutes: 45 calls).
- **Catching up after an outage.** A sweep meters every minute since the cursor, reaching back at most 46 h (two hours inside the ~2 days the Leader keeps metrics), and at most 24 h of it per sweep — the next sweep continues (`catchUpRemainingMinutes` on the sweep line), so the worst sweep costs what a 24 h backfill always did (~76 calls). Anything older than 46 h when metering resumes was never metered: the sweep logs it and records it in `meta.gaps` (`{from, to, minutes}`), and the figures over a range that overlaps it are that much lower (EPIC_AUDIT P1-E04).
- **Rate limits.** On a 429 the sweep waits the Leader's `Retry-After` (at most 60 s; 5 s when it sends none) and retries that call once; a second 429 stops it, and it waits for the window to reopen before it records the failure in `meta` and releases the lock. A sweep the limit stopped backs off: the next 2, 4, 8, then 16 minutes are skipped (`"skipped":"backoff","error":"rate_limited"`, no Leader call). `meta.rateLimitedSince` and `meta.rateLimitedUntil` say since when and until when, for every runtime: tabs back off too. A sweep whose retry got past its 429 completes and schedules nothing (it only extends the streak the UI reports), so contention for the Leader's allowance never delays an alert. Under a 15-a-minute limit that is under 200 calls an hour instead of 1,250, and the first sweep after the limit lifts meters the whole backlog (EPIC_AUDIT P1-E01).
- **Direct webhooks.** The runner posts a direct webhook only to its https URL on a public host and never follows a redirect; loopback, private, link-local and carrier-grade NAT addresses (and `localhost`, `.local` and single-label names) are refused before any attempt (`host_not_authorized` in the delivery log). Set `MR_WEBHOOK_HOSTS=hooks.slack.com,webhook.site` (process environment or `.env`) to allow only the hosts you name; unset, any public host in `MR_WEBHOOKS` is allowed.
- **Worker groups.** Every runtime lists the Stream worker groups (`GET /products/stream/groups`, the declared grant; never the deprecated `/master/groups`) at least once an hour. A listed group the inventory lacks is read on the next sweep whatever the call plan, up to 8 a sweep and `default` first, so an org with many groups meters them all from the first minutes; a group with a newer commit is re-read; the 10-minute refresh re-reads the least recently read groups the plan fits, and a refresh that fits nothing is logged and stamped in `meta.inventorySkippedAt`. `meta.groupsKnown` (the listing) against `meta.groupsMetered` (the inventory) is "N of M worker groups metered" (EPIC_AUDIT P0-02, P0-03).
- **On the demo org, do not stop it or reset the App's KV casually**: it is what meters the rig. Restart it (the `nohup` line above) after changing `core/`, so it runs the new code.

### 6.1 Hosting it (the demo org runs on an always-on machine since 2026-09-26)

A runner on a laptop stops when the lid closes. The demo org's runner is a **launchd KeepAlive agent on an always-on machine**, watched by a deep health job; the same shape works for any host you own.

```bash
# on your Mac: ship the committed tree (never the working tree) and the credential
git archive --format=tar dev | ssh HOST 'mkdir -p ~/srv/meter-reader && tar -x -C ~/srv/meter-reader'
scp .env HOST:~/srv/meter-reader/.env && ssh HOST 'chmod 600 ~/srv/meter-reader/.env'
ssh HOST 'cd ~/srv/meter-reader && PATH=/opt/homebrew/bin:$PATH npm ci --no-audit --no-fund'
# the agent: node_modules/.bin/tsx scripts/runner.ts, WorkingDirectory ~/srv/meter-reader, KeepAlive, ThrottleInterval 10,
# EnvironmentVariables PATH (launchd has none) and HOME; stdout/err to logs/runner.out — see the plist in this section's history
ssh HOST 'launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ddt.meter-reader-runner.plist'
# restart after a code change: bootout + bootstrap, never kickstart (launchd caches the old plist)
ssh HOST 'launchctl bootout gui/$(id -u)/com.ddt.meter-reader-runner; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ddt.meter-reader-runner.plist'
```

- **Name the host.** `MR_RUNNER_HOST=ops-box` in the host's `.env` (the runner reads `.env`, not the process environment) sets `meta.lastSweepOwner` to `runner:ops-box:<pid>`, which the App's footer shows as "metered by the runner on ops-box". Without it the owner is `runner:<pid>` and the footer says only "the runner"; the machine's host name is never used.
- **Move, don't duplicate.** Two runners on one org serialize on `lock/meter` and the second meters nothing, but they double the Leader calls. Stop the old one once the new one's heartbeat is green.
- **Health is a job, not a hope.** `scripts/runner-health.sh` is the deep check: heartbeat younger than 150 s and `ok`, the process alive, the Leader reachable with the credential (a bounded token exchange). On the demo org's host it runs as a scheduled job every 5 min that alerts on a change of state, so its silence pages and opens a task, and its recovery closes the task. Run it by hand: `bash scripts/runner-health.sh` in the runner's checkout.
- **Update it** by repeating the `git archive` line and the bootout/bootstrap pair. `.env` and `logs/` survive because the archive never contains them.

### 6.2 Start, stop, restart, upgrade

Run the runner from a **pinned checkout** — a `git archive` of a commit, as in 6.1 — never from the working tree you edit: a runner started from a working tree runs whatever is half-written there the next time it restarts. The supervisor takes `MR_RUNNER_DIR=<checkout>` for that, and logs a warning when it runs from a working tree with uncommitted changes in `core/` or `scripts/`.

| Verb | Under launchd (an always-on Mac) | Under the supervisor (a laptop, any Unix host) |
|---|---|---|
| **Start** | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ddt.meter-reader-runner.plist` | `MR_RUNNER_DIR=~/srv/meter-reader nohup bash ~/srv/meter-reader/scripts/runner-supervise.sh >> ~/srv/meter-reader/logs/runner.out 2>&1 &` |
| **Stop** | `launchctl bootout gui/$(id -u)/com.ddt.meter-reader-runner` (SIGTERM: the runner logs `runner stopping (SIGTERM)` and removes its pidfile) | `pkill -f runner-supervise.sh; pkill -f scripts/runner.ts` — the supervisor first, or it restarts the runner |
| **Restart** | bootout, then bootstrap — never `kickstart` (launchd caches the old plist) | Stop, then Start. After a crash the supervisor restarts it by itself: 10 s, 20 s, 40 s … at most 5 min, back to 10 s after a run of 10 minutes |
| **Upgrade** | `git archive` the new commit over the checkout, `npm ci` if `package-lock.json` changed, then Restart | The same, into the `MR_RUNNER_DIR` checkout, then Restart |

After any of them: `tail -3 logs/runner.log` shows `runner started (pid …, owner …)` and a sweep line within a minute, and `bash scripts/runner-health.sh` prints `OK`. A start refused with exit 3 names the runner already metering — stop that one first (**Move, don't duplicate**).

## 7. The demo rig

The rig is six demo-tagged Datagen Sources, eight pipelines, four DevNull destinations and six routes, all with ids starting `mrd_` and descriptions containing `[meter-reader-demo]`. Details and measurements: [`RIG.md`](RIG.md).

```bash
node scripts/rig/apply.mjs --dry-run            # what would be written
node scripts/rig/apply.mjs --commit --deploy    # upsert every rig object, commit ONLY the rig's files, deploy
node scripts/rig/verify.mjs                     # GB/day and route ratios per source over the last 10 minutes
node scripts/rig/verify.mjs --capture --strict  # also the true byte ratios; exit 1 when a source is out of band
node scripts/rig/remove.mjs                     # list what would be removed
node scripts/rig/remove.mjs --yes --commit --deploy
```

Every rig commit passes an explicit file list; a shared file is included only when every changed line belongs to an `mrd_` object. A fresh organization must commit its group key with `inputs.yml` once before Datagen Sources can run (DECISIONS D19; `node scripts/rig/probe-secrets.mjs` must print DECRYPTS). Then install the release, upgrade to the demo package (section 5) to get the Demo Console, and start the runner (section 6).

**Levers from a terminal** (the same `core/demo/levers.ts` the Demo Console calls; demo-tagged objects only; each is a commit and a deploy):

```bash
npx tsx scripts/lever.ts break   mrd_pay_sample
npx tsx scripts/lever.ts restore mrd_pay_sample
npx tsx scripts/lever.ts apply   mrd_windows_workstations [aggressive]
npx tsx scripts/lever.ts revert  mrd_windows_workstations
npx tsx scripts/lever.ts baselines     # reset baselines
npx tsx scripts/lever.ts reset         # reset everything the levers changed
```

Before a showtime, run `reset` so no stale incident from a deliberate change is left open, and wait for the runner's next sweep.

## 8. Release checklist

1. `package.json` version bumped; `CHANGELOG.md` has the new `## [vX.Y.Z]` entry; the README's App Metadata version matches.
2. `npm run typecheck && npm run lint && npm test` and `npx playwright test` green.
3. `npm run package:release`, `package:demo -- --demo-version N.N.N`, `package:backend`; superseded demo builds moved to `build/superseded/`; then `npm run audit` green.
4. Install the release package in a clean workspace through **Import from File** and confirm the Review App screen shows the reads, the metrics query, the preview dry run and the four notification writes, and no host and no backend. Run the bell test as a non-admin member.
5. Force-add the release and Enterprise packages (`git add -f release/meter-reader-X.Y.Z.tgz release/meter-reader-X.Y.Z-backend.tgz`; they are git-ignored while they are rebuilt constantly) and commit them with `release/SHA256SUMS` (`shasum -a 256` of both), after every file the packages carry (README, `config/`, `package.json`) is final: `tests/compliance.test.ts` holds the committed packages to the tree, so a later README change makes them stale. Hackathon rule 3.2 wants the packaged App committed in the repository; `scripts/publish-public.sh` carries them into the public export through `git ls-files` and prints their sha256. The demo package is never committed or published. Tagging `vX.Y.Z`, the GitHub Release (the release package as the primary asset) and any mirror publication happen only with the project owner's approval.

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Cribl refused the request (403)…" on a bell or target test | The member's App grants do not cover the notification calls, or the App was installed before they were added. Upgrade to the current release and share the App again; the runner delivers meanwhile. |
| "This workspace has no such Cribl API" | The Leader has no bell or Search notification API (not Cribl.Cloud, or an older version). The implicit bell is skipped quietly; use the runner's direct webhook. |
| A target test logs `relay_missing` (404) | The relay was never connected, or someone deleted it in Cribl Search. Select **Connect** on that endpoint again. |
| A forward answers 200 but nothing arrives | Cribl drops forwards whose id lacks the `SEARCH_NOTIFICATION_` + notification id prefix, or whose notification does not exist; the router checks the relay first, so check the target's own configuration and health in Cribl. |
| The bell fills with Meter Reader entries | One entry per alert state, never deleted by the App (D28). Switch the bell off or raise its minimum severity in Settings; clear entries in Cribl. |
| A direct webhook never fires | Direct webhooks are the runner's alone (D57): check its start-up line in `logs/runner.log` ("direct webhooks from .env: N (…)"), the URL in `MR_WEBHOOKS`, and `MR_WEBHOOK_HOSTS` if set (`host_not_authorized` in the delivery log). From the App, use a notification target. |
| "Couldn't read metrics for GROUP: your role can't view them" | The member lacks Monitoring access in that group, or the App is not shared with them. Share the App, or grant the role. |
| Saved by Cribl stays at $0 | No destination is priced yet ("N destinations are unpriced"). Set prices under Settings → Prices. |
| HTTP 413 from the KV store | A value over about 100 KB. `core/kv.ts` chunks documents above 90 KB; anything writing KV must go through it. |
| Every sweep fails with `KV PUT roll/… failed: HTTP 507` (or another 5xx) and `meta.meteredThrough` stops | The App's KV store refuses writes (full). `meta.kvWriteFailingSince` says since when; the sweep after the first refusal runs the key expiry pass before anything else (then hourly while it lasts), which deletes minute docs older than 25 h, hour docs older than 32 days and incident docs older than 31 days, and `meta.kvDatedKeys` counts what is left. If the store stays full with nothing expired, free space in it; the first sweeps that can write again meter everything since the cursor (up to 46 h, 24 h a sweep) and clear the marker (EPIC_AUDIT P1-E03). |
| "App backend compute requires an enterprise license/plan" or "App proxies require an enterprise license/plan" | The Enterprise variant on an organization without them. Install the release package. |
| "Can't upgrade to version X, because it doesn't satisfy >Y constraint" | A demo build whose version is not higher than the installed one. Build with a higher `--demo-version` (D22). |
| `"skipped":"current"` in `logs/runner.log` | Healthy: a tab metered the minute first; the runner checked in (1–2 calls) and leaves it. |
| `"skipped":"locked"` (no error) | Another runtime held `lock/meter` for this minute — a tab mid-sweep, or a second runner. Once is normal. Three in a row turn the heartbeat unhealthy ("lock/meter refused 3 sweeps in a row"): look for a second runner (`meta.lastSweepOwner` in the diagnostics panel, `pgrep -fl scripts/runner.ts` on each host). |
| **Stuck lock:** every runtime reports `locked` for more than ~2 minutes | `lock/meter` is written with a 130 s life and renewed only by the sweep that holds it, so a runtime that died mid-sweep frees it within 130 s by itself. Longer means a live holder: a runtime whose clock runs minutes ahead writes an expiry in the future — check the clocks of the runner's host and the browsers. |
| `"skipped":"rate_limited","error":"rate_limited"` | The Leader answered 429 twice in one sweep. The sweep waited for the limit's window, recorded it (`meta.consecutiveRateLimited`, `meta.rateLimitedSince`) and backs off. Other clients of the same credential or Leader are spending the allowance: tabs left open on a presenter screen, scripts, another runner. |
| `"skipped":"backoff","error":"rate_limited"` | Inside the back-off after rate-limited sweeps (2, 4, 8, then 16 minutes; `meta.rateLimitedUntil`). No Leader call is made. The first sweep after it meters everything since the cursor; nothing is lost. The heartbeat reports it as not ok, so the health job alerts while it lasts. |
| `"skipped":"budget","error":"budget"` | A caller-set hard call budget ran out mid-sweep (the runner sets none; a lever or a test may). Nothing was written; the next sweep meters the same minutes. |
| `"error":"time_budget"` | The sweep passed its 100 s time budget before its writes and abandoned them (only `meta.sweepErrors` counts it). The Leader answers slowly: compare `ms` with `calls`. The next sweep retries the same minutes. |
| `"error":"no inventory: every config read failed and none is stored"` | A first sweep could read no worker group's configuration (403 on `/m/GROUP/…`, or `GET /products/stream/groups` failing). Check the credential's permissions (RUNBOOK section 6, Credential) and the Leader's reachability. |
| `"held":N` on a sweep line | N empty minutes right after a minute with traffic were held back: the Leader may not have them yet. They are metered on a later sweep (as quiet once they are 3 minutes old). Not an error. |
| `"skipped":"no_prices"` | No prices document yet: nothing is metered until Settings → Prices is saved; the inventory is kept fresh for that screen. |
| `KV PUT … failed: HTTP 413` | A value over the store's ~100 KB cap. `core/kv.ts` chunks documents above 90 KB, so this means something wrote KV outside it; the sweep treats it like the 507 row below. |
| `"skipped":"locked","error":"lock_lost"` in `logs/runner.log` | The sweep was so slow that another runtime took `lock/meter` before its writes; it wrote nothing and that runtime meters the minutes. Once is harmless. Repeated, the Leader answers calls in seconds: compare `ms` with `calls` in the log, and check the clocks of the runner's host and the browsers (a clock minutes ahead takes the lock early). |
| The runner's heartbeat is stale | `pgrep -f scripts/runner.ts`; read the tail of `logs/runner.log`; restart it with the `nohup` line in section 6. An expired credential shows as 401 lines. |
| A package build fails | The stage is kept at `.stage/pkg-VARIANT`; rerun with `--verbose`, fix the error in the working tree (a type error anywhere fails `tsc -b`), and package again. |
