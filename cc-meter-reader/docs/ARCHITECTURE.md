# Architecture

Meter Reader is one TypeScript codebase with three ways to run its meter (DECISIONS D11, D12b, D23, D24):

| Runtime | What runs the sweep | Package |
|---|---|---|
| **The open tab** (primary) | the App iframe, every 30 s while a Meter Reader tab is open, as the signed-in member | the release, `meter-reader-X.Y.Z.tgz` |
| **The runner** (optional, customer-hosted) | `scripts/runner.ts`, a Node process on a machine the customer owns, every minute, with an org API credential | none: it writes to the installed App's KV |
| **The Enterprise variant** (optional) | a scheduled backend function, every minute, with the App-wide grants | `meter-reader-X.Y.Z-backend.tgz` |

All three call `runSweep()` in `core/sweep.ts` and deliver through `core/delivery.ts`, so they can never disagree about a number or a message. All three take the KV lock `lock/meter` and skip minutes `meta` says are metered, so any mix of them never counts a minute twice.

## The open tab (the release)

```text
+--------------------------------- Cribl.Cloud workspace (any plan) --------------------------------+
|                                                                                                    |
|  Cribl shell (Leader UI) -- theme, identity, URL sync (postMessage) --+                            |
|                                                                       v                            |
|  +------------------ App iframe: Meter Reader (React + Capra, sandboxed) ------------------------+ |
|  |  views     Receipt . Presenter . Flow . What if . Ledger . Settings . First run . Story      | |
|  |  state     hydrate: meta + settings + snapshot + prices, one batch; writes gated by          | |
|  |            hasHydrated                                                                        | |
|  |  live      reads snapshot + meta from KV every 10 s (5 s presenter, 60 s hidden)             | |
|  |  meter     every 30 s: core runSweep() as the signed-in member  -----------------------+     | |
|  |            (holds lock/meter; meters each completed minute once; catches up to 24 h   |     | |
|  |             of missed minutes when reopened; delivers through core/delivery.ts)        |     | |
|  +----------------------------------------------------------------------------------------|-----+ |
|                                                        platform fetch proxy               |       |
|                                                        (member auth, App scope)           v       |
|  +------------------------------ Leader API --------------------------------------------------+   |
|  |  GET  /products/stream/groups                          Worker Groups                       |   |
|  |  GET  /m/:gid/system/inputs, /system/outputs,          the configuration walked into      |   |
|  |       /pipelines, /routes                              priced flows                        |   |
|  |  POST /system/metrics/query  (a read)                  bytes per input, output, route,     |   |
|  |                                                        per minute                          |   |
|  |  GET  /m/:gid/version, /version/files, /version/show   the commit timeline                 |   |
|  |  POST /m/:gid/preview  (mode 'pipe'; a dry run)        What if: bytes in vs out            |   |
|  |  POST /system/messages                                 the notification bell               |   |
|  |  GET  /notification-targets                            the target picker (id, type, desc)  |   |
|  |  GET/POST /m/default_search/search/saved[/:id[/notifications]]                             |   |
|  |                                                        the alert relay (created on Connect)|   |
|  |  POST /search/notifications  (Leader-level)            forward an alert to a target        |   |
|  |  KV   /kvstore/...  (App-scoped)                       settings, prices, snapshot,         |   |
|  |                                                        rollups, incidents, lock            |   |
|  +--------------------------------------------------------------------------------------------+   |
|                                                                                                    |
|  Cribl notification service ---> bell (Cribl header)                                               |
|                             ---> notification targets: Slack . PagerDuty . email . SNS . webhook   |
|                                  (configured by an administrator; secrets stay in Cribl)           |
+----------------------------------------------------------------------------------------------------+
```

No `proxies.yml`: Standard-plan Leaders refuse App proxies (D23), so the open tab never posts outside Cribl.

## The runner (customer-hosted)

```text
machine the customer owns                         Cribl.Cloud workspace
+-------------------------------+                 +-----------------------------------------------+
| npx tsx scripts/runner.ts     |  bearer token   |  Leader API (same calls as the tab, as the    |
|   every minute at :25         | --------------> |  credential's role)                           |
|   core runSweep()             |                 |  App KV at /api/v1/a/meter-reader/kvstore     |
|   core/delivery.ts            |                 |  bell, targets via the relay                  |
|   .env: org API credential    |                 +-----------------------------------------------+
|   logs/runner.log, heartbeat  | --- direct webhooks (Slack Block Kit / JSON) ---> any host
+-------------------------------+
```

The runner writes the same KV documents the tab does, so an open tab shows its numbers and simply finds each minute already metered. `meta.lastSweepOwner` records which runtime ran the last sweep (`runner:HOST:PID`), and while a runner or backend has swept in the last 90 s an open tab leaves notifications and the Monday receipt to it (it can reach direct webhooks; the tab cannot without App proxies). It sweeps at :25 because every runtime meters a minute only 20 s after it ends (`SETTLE_MS`), and sends the weekly receipt once after Monday 12:00 UTC (`--weekly` sends it now). The runner is optional and customer-run; on the demo organization it is what keeps metering with no tab open.

## One sweep (`core/sweep.ts`)

```text
lock/meter ─► reads (settings, prices, inventory, baselines, timeline, totals, snapshot, open incidents)
   │
   ├─► range: every whole minute since meta.meteredThrough that ended ≥ 20 s ago (max 24 h), plus a rewrite of
   │   the minute before; a trailing empty minute after one with traffic is held back up to 3 min
   ├─► refresh when due and in budget: inventory (10 min / new commit), timeline (5 min)
   ├─► metrics: one query each for inputs, outputs and routes over the whole range, per minute
   │
   └─► per minute, oldest first:
         attribution (route bytes, FINAL cascade, then reconciled to the exact Source and Destination
         counters, D20) ─► pricing (millicents, the price version in force, the first price for older
         history, D25, the counterfactual) ─► minute rows ─► running totals ─► baselines and detection
         ($5/day floor, D26; catch-up minutes flagged) ─► before an unmatched regression: one more
         timeline refresh
   │
   ├─► notifications through core/delivery.ts: resolveEndpoints() adds the implicit bell (D27), then per
   │   endpoint: bell (write-once id per alert state, D28) | target (relay checked once, forwarded with
   │   the SEARCH_NOTIFICATION_ prefix, never retried, D29) | direct webhook (the runner only, URLs from its .env, D57);
   │   cooldown, notify/log
   └─► writes inside the 100 s time budget: rollups, folds, totals, baselines, timeline, incidents,
       key expiry, snapshot (≤ 90 KB), meta ─► release the lock
```

Every Leader call, KV and notifications included, passes one metered transport: planned under 35 calls (about 23 measured live, about 1 second), retried once on HTTP 429 after 5 seconds, stopped on a second 429. Documents over 90 KB are gzip + base64 chunked (`core/kv.ts`), because the Leader refuses KV values above about 100 KB.

## Alert delivery (`core/delivery.ts`)

```text
incident / recovery / test / weekly receipt
        │
        ▼
resolveEndpoints(settings.notifications) ── stored endpoints + the implicit bell (unless one is stored)
        │
        ├── channel 'cribl-bell'   ─► POST /system/messages  {id: meter-reader-INCIDENT-STATE, severity, title, text}
        │                              409 = already in the bell (logged 208); 5xx retried; 404/405/401/403 on
        │                              the implicit bell = skipped quietly once per sweep
        ├── channel 'cribl-target' ─► GET /m/default_search/search/saved/meter_reader_alert_relay (once)
        │                              missing ─► relay_missing (404), nothing forwarded
        │                              present ─► POST /search/notifications
        │                                         {id: SEARCH_NOTIFICATION_meter_reader_relay_TARGET_..., message, meter_reader}
        │                                         never retried (Cribl does not de-duplicate)
        └── channel 'webhook'      ─► POST to the URL (Slack Block Kit or JSON); runner and Enterprise only
```

Connect (Settings, after a confirmation that names both objects) calls `ensureRelay`: create the saved search `meter_reader_alert_relay` (never scheduled) and the notification `meter_reader_relay_TARGET`, create-only, never PATCH or DELETE. Evidence for every rule: [`NOTIFICATIONS.md`](NOTIFICATIONS.md).

## The Enterprise variant (optional package)

```text
config/enterprise/schedules.yml ── * * * * *  (UTC) ──► backend fn `meter` ─────────► core runSweep()  (the same code)
                                ── 0 12 * * 1 (UTC) ──► backend fn `weeklyReceipt` ─► core weekly receipt
UI "Sweep now" (≤ once per 30 s) ─────────────────────► POST /endpoints/meter
UI live mode ─────────────────────────────────────────► reads snapshot + meta only; never starts a sweep on a timer
(no proxies.yml: no build declares an external host, D57; alerts leave through the Cribl bell and notification targets)
```

Backend functions run with the App-wide grants in `policies.yml` (the same list as the release), never with the caller's roles. Timeouts stay at or under 120 seconds and the package declares 2 of the 10 schedules an App may have. It installs only where App backend compute is available; its scheduled run has not been exercised live (the build org is on the Standard plan).

## Packages from one commit

```text
                       +--> release   config/policies.yml; no proxies.yml, backend.yml or schedules.yml (D23);
                       |              VITE_MR_BUILD=release, VITE_MR_RUNTIME=ui     -> meter-reader-X.Y.Z.tgz
repo --(scripts/       |
        package.mjs)---+--> backend   release + config/enterprise/{backend,schedules,proxies}.yml + backend/
   staged copy in      |              bundles; VITE_MR_RUNTIME=backend               -> meter-reader-X.Y.Z-backend.tgz
   .stage/pkg-<v>      |
                       +--> demo      config/demo/policies.yml (release grants + lever writes), Demo Console
                                      compiled in, VITE_MR_BUILD=demo, "Meter Reader (demo build)", plain
                                      numeric version (D22)                         -> meter-reader-N.N.N-demo.tgz
```

`tests/compliance.test.ts` opens all three archives: the release grants only reads, the metrics query, dry-run POSTs and exactly `NOTIFICATION_WRITES`, declares no host and bundles no demo or mock code; the demo carries its marker, is a superset of the release grants and is never the primary asset; the Enterprise variant declares no demo endpoint, stays inside the platform limits and is the only package with a host.

## Where things live

| Concern | Module |
|---|---|
| The contract (every type, KV document, payload) | `core/types.ts` |
| Money: prices, counterfactual, per-minute pricing, headline | `core/pricing.ts`, `core/presets.ts`, `core/format.ts` |
| Routing table → flows; metrics → flows; reconciliation | `core/flows.ts`, `core/adapters/metrics.ts`, `core/adapters/config.ts` |
| Rollups, retention, running totals, route history across pipeline swaps | `core/rollups.ts`, `core/snapshot.ts` |
| Baselines, detection, incidents | `core/baseline.ts`, `core/detector.ts`, `core/incidents.ts` |
| Commit timeline and matching | `core/timeline.ts`, `core/adapters/version.ts` |
| What-if projections | `core/whatif.ts` |
| Alert delivery: router, Cribl channels, webhooks, payloads, weekly receipt | `core/delivery.ts`, `core/adapters/cribl-notify.ts`, `core/adapters/webhook.ts`, `core/payloads.ts`, `core/receipt.ts`, `core/weekly.ts` |
| KV documents, chunking, migrations, the lock | `core/kv.ts`, `core/codec.ts` |
| One sweep | `core/sweep.ts` |
| Open-tab runtime loop, live polling, hydration | `src/state/meterLoop.ts`, `src/state/live.ts`, `src/state/hydrate.ts` |
| Runner runtime | `scripts/runner.ts` (with `scripts/cribl-api.mjs` for the credential) |
| Demo levers (demo build and `scripts/lever.ts` only) | `core/demo/levers.ts` |
| Backend endpoints (Enterprise variant only) | `backend/meter.ts`, `backend/weeklyReceipt.ts`, `backend/sendTest.ts` |
