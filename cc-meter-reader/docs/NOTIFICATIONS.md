# Alert delivery through Cribl (DECISIONS D23)

On Standard and free Cribl.Cloud plans an App cannot declare `proxies.yml` ("App proxies require an enterprise license/plan"), so the UI runtime cannot POST to Slack or a webhook directly. Meter Reader delivers through Cribl instead. This file records what was measured live, what was built on it, and what is still open.

Measured on 2026-09-26 between 08:00 and 08:25 UTC, on Cribl.Cloud 4.20.1 (the dedicated build org, workspace `main`, Standard license), with the org's admin API credential (`scripts/cribl-api.mjs`). Every URL, token and the demo receiver's id are redacted below.

## 1. What works, live

| Path | Works? | How it was proven | Used by |
|---|---|---|---|
| **Bell**: `POST /system/messages` | **Yes** | Posted, listed, read back, deleted (§2.1). Posted again through `core/delivery.ts` (`sendChannelTest`) and it showed up in `GET /system/messages` | `'cribl-bell'` channel, on by default |
| **Notification target via the Search notification relay**: saved search + notification, then `POST /search/notifications` | **Yes** | A webhook target (`mrd_webhook_site`) received the forwarded event at the demo receiver. The first send was by hand (§2.3); the second went through `ensureRelay` and `sendChannelTest` in the product code (§2.4) | `'cribl-target'` channel |
| `POST /notification-targets/{id}/test` with a custom message | **No** | `405 "Target does not support connection check"` for a webhook target. The body schema is only `{ testEmails }` (for SMTP targets) | not used |
| `POST /m/default_search/search/notifications` (group-scoped form) | **No** | Express 404 `Cannot POST /api/v1/search/notifications`. Only the Leader-level path exists | not used |
| Direct webhook from the UI on this plan | **No** (D23) | No `proxies.yml` is possible on this plan | `'webhook'` channel: the runner only (D57: no build stores a webhook URL, so the Enterprise variant has none either) |
| Direct webhook from the runner (`scripts/runner.ts`) | **Yes** | It delivers to the demo receiver every sweep, from `MR_DEMO_WEBHOOK_URL` in its `.env` (D57) | `'webhook'` channel, `SweepDeps.envWebhooks` |

**Not verified yet:** every call above ran with the admin credential. Whether the App proxy honors these grants for a **member** (a non-admin user shared the App) is still unproven. That needs a deployed build with the new `policies.yml`; see §6. `GET /a/meter-reader/notification-targets` and `GET /a/meter-reader/system/messages` (the App-scoped form) answer 200 for the admin. That shows the paths route through the App scope, but it says nothing about policy enforcement, because the admin already holds every permission.

## 2. Spike log: requests and responses

### 2.1 The bell: `/system/messages` (BulletinMessage)

| Request | Response |
|---|---|
| `GET /system/messages` | `200 {"items":[{"severity":"error","title":"…","text":"…","time":1790208744375,"id":"0aa60db1-…"}],"count":1}` |
| `POST /system/messages` `{"id":"mrd_test_1790409691","severity":"warn","title":"[meter-reader-demo] Savings dropped: Payments API sampling","text":"$25 a day · $9,125 a year · commit a1f3c9e by s.koelpin","time":1790409691000}` | `200 {"items":[<the same message>],"count":1}`. It then lists first in `GET /system/messages` |
| `GET /system/messages/mrd_test_1790409691` | `200 {"items":[<message>],"count":1}` |
| `POST` with the **same id** (new severity and text) | `409 {"status":"error","message":"Entity with \"mrd_test_1790409691\" ID already exists."}` and the stored message is unchanged |
| `PATCH /system/messages/mrd_test_1790409691` | `405 {"status":"error","message":"Updating messages is not supported."}` |
| `DELETE /system/messages/mrd_test_1790409691` | `200 {"items":[<deleted message>],"count":1}`, then `GET` of it answers `404 "Item 'mrd_test_1790409691' not found"` |
| `DELETE` again | `200 {"items":[],"count":0}` (idempotent) |
| `POST` without `time` | `200`: the Leader fills `time` itself |
| `POST` with `"severity":"high"` | `400 … "allowedValues":["info","warn","error","fatal"]`. The spec's `success` is **not** accepted by the live validator |

**Consequences for the design.** A message id is write-once: an alert cannot be "updated in place". Updating would mean DELETE then POST, and AGENTS.md forbids an unconfirmed DELETE on a timer. So each alert **state** gets its own id, `meter-reader-<incident id>-<high|medium|info|closed>`. A cooldown re-send of the same state answers 409. That is read as "already in the bell" and logged as **208** (delivered) with detail `already in the bell (409)`, so the incident card shows it as sent. Nothing in the App ever deletes a bell message.

### 2.2 Notification targets: `/notification-targets`

| Request | Response |
|---|---|
| `GET /notification-targets` | `200 {"items":[{"id":"system_notifications","type":"bulletin_message","severity":"warn","text":"Notification has been triggered","title":"Notification","onBackpressure":"drop","status":{…}}],"count":1}`. Every org has this built-in bell target |
| `POST /notification-targets` `{"id":"mrd_webhook_site","type":"webhook"}` | `400 … "missingProperty":"url"` |
| `POST /notification-targets` `{"id":"mrd_webhook_site","type":"webhook","url":"<demo receiver>","method":"POST","format":"ndjson","description":"[meter-reader-demo] Meter Reader demo receiver (webhook.site)"}` | `200`, target created with `status.health: "Green"` |
| `POST /notification-targets/mrd_webhook_site/test` `{}` or with a custom message | `405 "Target does not support connection check"` |

**Security note.** `GET /notification-targets` returns each target's **full configuration**, including a webhook or Slack URL in plain text. The App keeps only `id`, `type` and `description` (`listTargets` in `core/adapters/cribl-notify.ts`, unit-tested), and never stores or renders anything else. Granting `GET /notification-targets` in `policies.yml` still lets any member the App is shared with read those URLs through the App's API scope. An administrator should know this at install. The alternative is to drop that grant: members then type the target id, a fallback the editor already has (§3.3).

### 2.3 The Search notification relay: `POST /search/notifications`

Schema `SearchNotification` (`Forward a Search Notification … (Cribl.Cloud only)`, `x-cribl-internal: false`).

| Request | Response |
|---|---|
| `POST /m/default_search/search/notifications` | `404 Cannot POST /api/v1/search/notifications` (no group-scoped route) |
| `POST /search/notifications` `{notificationId:"mrd_nope", …}` before any search notification existed | `500 "Failed to process search notification."`. The notification service logs `No receivers registered yet` |
| `POST /m/default_search/search/saved` `{"id":"mrd_alert_relay","name":…,"description":"[meter-reader-demo] …","query":"print relay=\"meter-reader\"","earliest":"-1m","latest":"now","schedule":{"enabled":false}}` | `200` saved search |
| `POST /m/default_search/search/saved/mrd_alert_relay/notifications` `{"id":"mrd_alert_relay_webhook","condition":"search","conf":{"savedQueryId":"mrd_alert_relay","message":"Meter Reader alert","triggerType":"resultsCount","triggerComparator":">","triggerCount":0},"targets":["mrd_webhook_site"]}` | `201`. It is also listed by `GET /notifications` and `GET /m/default_search/notifications` with `group:"default_search"` |
| `POST /search/notifications` (any body, with the notification now existing) | `200 {"items":[{"message":"Search notification request forwarded."}],"count":1}` |

**What gets delivered.** A 200 does not mean delivery. The first five forwards (ids like `mrd_spike_<ms>`) were accepted and silently dropped. One real scheduled run of the saved search (temporarily `* * * * *`, then switched off again) delivered this NDJSON event to the webhook target, which shows the shape Search itself sends:

```json
{"id":"SEARCH_NOTIFICATION_mrd_alert_relay_webhook_1790410086079","severity":"info","_raw":"Meter Reader alert",
 "title":"Scheduled search notification","_time":1790410086079,"now":1790410086079,"group":"default_search",
 "searchId":"mrd_alert_relay.1790410080800.7de2qu","savedQueryId":"mrd_alert_relay","searchResultsUrl":"https://<org>/search/…",
 "notificationId":"mrd_alert_relay_webhook","tenantId":"<org>","message":"Meter Reader alert",
 "origin_metadata":{"itemType":"link","id":"mrd_alert_relay.1790410080800.7de2qu","type":"search","product":"search","groupId":""},
 "cribl_notification":"mrd_alert_relay_webhook","cribl_pipe":"mrd_alert_relay_webhook"}
```

Bisecting forwarded bodies found the rule:

| Forwarded `id` | Other fields | Delivered? |
|---|---|---|
| `SEARCH_NOTIFICATION_mrd_alert_relay_webhook_<ms>` | full replica with our title and message | yes |
| same, no `tenantId` | | yes |
| `mrd_inc_abc_<ms>` (custom) | everything else real | **no** |
| `SEARCH_NOTIFICATION_mrd_alert_relay_webhook_<ms>` | custom `searchId`, no `origin_metadata` | yes |
| none | | **no** |
| `SEARCH_NOTIFICATION_meter-reader_inc_7f3a_<ms>` (other notification id) | | **no** |
| `mrd_alert_relay_webhook_<ms>` (no prefix) | | **no** |
| `SEARCH_NOTIFICATION_mrd_alert_relay_webhook_mrN_<ms>` | only `{id, notificationId, message}` | **yes** |
| an exact duplicate of a delivered id | | yes, again (no de-duplication) |

- **Rule:** the notification service routes a forwarded event only when `id` starts with `SEARCH_NOTIFICATION_<notificationId>_`. The minimal body is `{ id, notificationId, message }`.
- **Payload:** extra fields ride along unchanged to a webhook target. `"meter_reader": {…}` arrived intact.
- **Duplicates:** the platform does not de-duplicate, so the App never retries a forward.
- **Missing relay:** with at least one search notification in the org, a forward to an unknown `notificationId` also answers **200** and is dropped (measured again after the product relay existed). That is why the router **checks the relay first** (`GET /m/default_search/search/saved/meter_reader_alert_relay`, once per sweep per target) and logs `relay_missing` (404) instead of forwarding blind.
- **Side effect:** every search notification also upserts **one** bell entry whose id is the notification id, whose title comes from the `system_notifications` target ("Notification"), and whose text is the latest message. It is replaced on each send, not accumulated, even when the notification's `targets` do not list `system_notifications`.

### 2.4 The product code, live (08:22 UTC)

`scratchpad/live-verify.ts` (not in the repo) ran the adapter and router with the admin credential:

- `relayState('mrd_webhook_site')` gave `missing`. `sendChannelTest` on a target endpoint then logged `404 relay_missing` without forwarding.
- `ensureRelay('mrd_webhook_site')` gave `ok, 201, created: [saved search meter_reader_alert_relay, notification meter_reader_relay_mrd_webhook_site]`. A second call gave `ok, 200, created: []`.
- `sendChannelTest` (target) gave `200`, and the receiver got `SEARCH_NOTIFICATION_meter_reader_relay_mrd_webhook_site_inc_test00_test_<ms>` with `title`, `severity:"error"`, the multi-line `message` (title, ratio and money, commit, caught-in, Ledger link) and `meter_reader` (the canonical payload).
- `sendChannelTest` (bell) gave `200`, and `GET /system/messages` listed `{"id":"meter-reader-test-<ms>","severity":"error","title":"Test: Savings dropped: Payments API sampling","text":"$25 a day · $9,125 a year · commit a1f3c9e by meter-reader"}`.
- `postBell` twice with one id gave `200`, then `409 → ok, "already in the bell"`.

### 2.5 The live runner, unprompted (08:35 UTC)

The runner was restarted at 08:34:57 UTC by someone else, so it now runs the new sweep. Its next sweep delivered a real recovery through the **default** bell, with no bell endpoint stored in settings:
- `notify/log` has `{endpointId:"demo-webhook-site", event:"incident.closed", status:200, at:"…08:35:10.584Z"}` and then `{endpointId:"cribl-bell", event:"incident.closed", status:200, at:"…08:35:11.051Z"}`.
- `GET /system/messages/meter-reader-inc_bb03ce-closed` gave `{"severity":"info","title":"Recovered: Savings dropped: AWS VPC Flow Logs","text":"$1 a day · $195 a year · commit 603840d by <API client id>","id":"meter-reader-inc_bb03ce-closed"}`.

That message was left in the bell: it is the product working.

## 3. What was built

### 3.1 Core
- **`core/adapters/cribl-notify.ts`** calls the Leader APIs above over `CriblHttp` and never throws. `BudgetExceeded`, `RateLimited` and transport errors become outcomes with codes (`budget`, `rate_limited`, `network_error`). The functions:
  - `postBell`
  - `listTargets` and `pickableTargets`, which reduce each target to id, type and description
  - `relayState`, a single GET
  - `ensureRelay`: create-only, 409 counts as present, never PATCH or DELETE
  - `forwardViaTarget`, which sends the measured prefix id
  - `classifyCribl`: 401/403 → `not_permitted`, 404/405 → `not_available`, 400 → `invalid_request`, 5xx → retryable
- **`core/delivery.ts`** is the router, with one call shape for three channels. Each returns `DeliveryLog[]` shaped like the webhook adapter's:
  - `cribl-bell`:
    - Title = the incident title (`Recovered: ` or `Test: ` when those apply).
    - Text = the one-line money and commit summary. Since rules round 2 (D62, commit db72dc7) its money follows the incident card's rule on every channel (the bell, a target's plain text, Slack, ServiceNow): an open regression reads `$X a day · $Y a year if left`, a spike `$X a day above normal while it lasts`, a recovery `$X a day above normal while it lasted · N min · ≈ $Z in all`, and budget pace carries no year. The requests and responses in §2 are verbatim from before that change (for example the recovery in §2.5, `$1 a day · $195 a year`).
    - Severity high → error, medium → warn, info → info. Recoveries, good news and receipts are always info.
    - The per-state id and the 409 → 208 rule from §2.1.
    - A 5xx is retried with the webhook back-off (2 s, 8 s). This is safe because ids are write-once.
  - `cribl-target`: the relay is checked once per router, then the alert is forwarded. The endpoint stores **only `criblTargetId`**, so no secret sits in App KV. The message is plain text (`incidentPlainText` or `receiptText`). There are no retries.
  - `webhook`: the unchanged SPEC 12.3 adapter. A 403 is `host_not_authorized`.
  - **On by default:** `resolveEndpoints(settings.notifications)` appends an **implicit** bell (medium and up, enabled) unless a bell endpoint is stored. The implicit bell is best effort. On a Leader without the API (404/405) or a refusal (401/403) it is skipped quietly, once per sweep. It never becomes a failed delivery the member never asked for. That is also why the mock emulator, which has no bell, needs no change. Testing the bell from Settings always reports the outcome.
- **`core/sweep.ts`** (the minimal wiring) swaps its one `deliver()` call for `router.deliver(...)` over the sweep's **metered** transport, so bell and relay calls count toward the call budget. The candidate list is `resolveEndpoints(...)`.
- **`core/types.ts`** (additive only) gives `NotificationEndpoint` two new optional fields: `channel?: 'webhook' | 'cribl-bell' | 'cribl-target'` and `criblTargetId?: string`.
- **`core/settings.ts`** (additive, not in this builder's OWN list, required): `normalizeEndpoint` keeps `channel` and `criblTargetId`. `validateSettings` asks Cribl channels for no URL, and asks a target for its id (`notifications[i].criblTargetId`). Without these edits a Cribl endpoint would not survive one save and hydrate cycle.

### 3.2 Settings → Where to send alerts
- **Cribl notifications (bell).** Its own row at the top, "no setup", on by default, with a minimum severity and "Send a test alert". It is stored in settings only once changed, so an untouched install keeps `notifications: []`.
- **Cribl notification target**, the only list channel since D57 (1.0.14 / 1.1.0): the "Send through" choice and the direct-webhook editor were removed, because a webhook URL is a credential and App KV cannot hold one encrypted and readable. (Before D57 a list endpoint could also be a direct webhook, chosen with a radio group.)
  - Targets are listed **lazily**, the first time a target endpoint is on screen, so the mock emulator never sees the call during the normal flows.
  - If the listing is refused, the member types the target id instead.
  - The chosen target's relay state is shown as Connected, Not connected yet or checking. **Connect** opens the shared `ConfirmModal`, which names both objects before anything is written (AGENTS.md), then calls `ensureRelay`.
  - The target test forwards one test alert and shows the plain text the target receives.
- Webhook endpoints are unchanged: masked URL, format, weekly receipt, test with a Slack preview.
- Copy lives in `src/components/EndpointEditor/copy.ts` for now, because `src/copy/en.ts` belongs to another builder. **Migrate it** to `settings.notify.channels.*`.

### 3.3 Policies (`config/policies.yml`, `config/demo/policies.yml`)

| Grant | Why |
|---|---|
| `POST /system/messages` | the bell |
| `GET /notification-targets` | the target picker (id, type and description kept; see the security note in §2.2) |
| `GET /m/default_search/search/saved/meter_reader_alert_relay` | the relay state: this one saved search, nothing else |
| `POST /m/default_search/search/saved` | create the relay saved search, only on a confirmed Connect |
| `POST /m/default_search/search/saved/meter_reader_alert_relay/notifications` | create one relay notification per target, only on a confirmed Connect; the relay is the only saved search a notification can be attached to |
| `POST /search/notifications` | forward an alert (Leader-level; this is the one `/search/` path that is **not** under `/m/default_search`, measured) |

**What the write grants allow (mirrors the README's "What a shared member could do with these grants").** A grant names a path and a method, never a body, and the platform grants every declared path to each member the App is shared with, for any request made through the App's API scope, not only for the requests Meter Reader's code makes. Meter Reader's code only creates the never-scheduled relay, one notification per target, a bell message per alert state and forwards of its own alerts; the grants themselves allow any body. So a member who calls those paths directly could post any message to the bell (`POST /system/messages`), create any saved search in Cribl Search, scheduled or not, and the saved-search schema lets that saved search carry its own notifications to a notification target an administrator already configured (`POST /m/default_search/search/saved`; not tried live), per `SavedQuerySchedule.notifications.items` in the 4.20.1 OpenAPI spec, attach a notification to Meter Reader's relay saved search and to no other saved search (`POST /m/default_search/search/saved/meter_reader_alert_relay/notifications`), and forward any text to the targets of any Search notification in the workspace, not only the relay's (`POST /search/notifications`), as §2.3 measured: the spike's own notification, on a saved search that was not the relay, delivered the same way. None of the four can replace or delete an existing Cribl object (a POST with an id that exists answers 409, §2.1), and none can create a notification target.

**Literal relay grants (EPIC_AUDIT P1-N01).** The relay's read and its notification grant name the Search group and the relay's id literally, because both are fixed in `core/adapters/cribl-notify.ts` (`SEARCH_GROUP`, `RELAY_SAVED_SEARCH_ID`); `tests/compliance.test.ts` holds every Search grant equal to the adapter's own paths. With the old `:gid`/`:id` form a member could read any saved search in any group and attach a notification to any saved search, sending that search's results to a target; now the read reaches the relay alone and a notification can be attached to the relay alone. The create (`POST …/search/saved`) and the forward (`POST /search/notifications`) cannot be narrowed by path: the new saved search's id and the notification id travel in the body. Every group-scoped policy object quoted from the reference Apps in `docs/platform/config-apis.md` §10 writes the group as a placeholder (`:gid` or `*`), so a literal group segment has no precedent there: the Leader accepted it at install (demo 1.0.11, 9/27, and every build since; `docs/LIVE_VALIDATION.md`); whether the App proxy matches it for a member is the clean-install test's member step (`docs/LIVE_VALIDATION.md`, "Still to run"). An administrator bypasses the policy matcher (`docs/PLATFORM_NOTES.md`, "Runtime frame"), so only a non-admin member proves it, and a stage demo run as an administrator does not depend on it. If it is refused, the three grants go back to `/m/:gid/search/saved/:id`, `/m/:gid/search/saved` and `/m/:gid/search/saved/:id/notifications`, and the disclosure above is the control.

`tests/compliance.test.ts` lists the four POSTs exactly as `NOTIFICATION_WRITES` (D30). The release must declare exactly those writes besides the metrics query and the dry-run POSTs (`DRY_RUN_POSTS`: the What-if `POST /m/:gid/preview`, sent with `mode: 'pipe'` only), so any new write fails the test until it is documented there and has its own README row.

## 4. Objects left in the live org

| Object | Id | Why it stays |
|---|---|---|
| Notification target (webhook → demo receiver) | `mrd_webhook_site` | The demo's target, described `[meter-reader-demo] …` |
| Saved search (never scheduled) | `meter_reader_alert_relay` | The product's relay, created by `ensureRelay`. It carries the product name, not `mrd_`: every customer install creates this same id |
| Search notification | `meter_reader_relay_mrd_webhook_site` | The relay for `mrd_webhook_site`, created by `ensureRelay` |

Removed:
- the spike saved search `mrd_alert_relay` and its notification `mrd_alert_relay_webhook`
- every test bell message (`mrd_test_*`, `meter-reader-verify-409`, `meter-reader-test-*`)
- the bell entries the relay upserted (`mrd_alert_relay_webhook`, `meter_reader_relay_mrd_webhook_site`)

The only message in the bell now is the platform's own.

## 5. Tests

- **`tests/unit/cribl-notify.test.ts`** covers the adapter: status mapping, write-once 409, target reduction (no secrets), relay ids and bodies, `ensureRelay` create-only, the forward's prefix id and "no retry".
- **`tests/unit/delivery.test.ts`** covers:
  - channels and the implicit bell
  - rendering and the per-state bell ids
  - the router per channel: 409 → 208, retries, quiet skip, relay check once per pass, `relay_missing` without forwarding, the webhook policy kept
  - `sendChannelTest`
  - three sweeps through `runSweep` with the emulator: a target plus the default bell both recorded on the incident; no trace of the bell without a bell API; a stored, switched-off bell honored
  - the settings round-trip and validation per channel
  - the EndpointEditor model
- **`tests/unit/notifications-channels.test.tsx`** renders Settings with a fake Leader:
  - the bell row makes no calls on mount; its test and a refusal
  - the bell is stored only once changed
  - targets load lazily without secrets
  - Connect confirms first and then creates exactly the two objects
  - the target test goes through the relay
  - the typed-id fallback
  - a new endpoint switched to a target stores only its id
- **Playwright** (`tests/e2e/settings.spec.ts`, Chromium and mobile) still passes, including the contrast check. Capra's selected toggle-button style measures 4.2:1, which is why the channel choice is a radio group.

## 6. Open items

Status 2026-09-27 (rules round, docs pass): every item is **resolved** except item 4, the member-path verification, which is the last step of the owner's clean-install test. Items 1 and 2 were resolved on 26 September; items 3 and 5 to 8 on 27 September, each checked against the code named below. The text of each resolved item is kept short; git history holds the original notes.

1. **Resolved.** The README lists every grant below in "How it uses the platform → Cribl API endpoints", explains what the release can write (D30), states the `GET /notification-targets` exposure and the admin-only verification, and no longer calls the release read-only or describes a packaged `hooks.slack.com` proxy (it is the Enterprise variant's host). `tests/compliance.test.ts` now also checks that each `NOTIFICATION_WRITES` entry has its own README row. The rows as originally proposed:
   ```
   | POST | `/system/messages` | Posts each alert to the Cribl notification bell (one message per alert state; never updates or deletes) | Yes: `createBulletinMessage`, `x-cribl-internal: false` |
   | GET | `/notification-targets` | Lists the notification targets an administrator configured, for the Settings picker (keeps id, type and description only) | Yes: `getNotificationTarget` |
   | GET | `/m/:gid/search/saved/:id` | Reads the alert relay saved search (`default_search`) to see whether a target is connected | Yes: `getSavedQueryById` (Cribl.Cloud only) |
   | POST | `/m/:gid/search/saved` | Creates the never-scheduled relay saved search, only when a member confirms Connect | Yes: `createSavedQuery` (Cribl.Cloud only) |
   | POST | `/m/:gid/search/saved/:id/notifications` | Creates one relay notification per target, only when a member confirms Connect | Yes: `createSavedQueryNotificationsById` (Cribl.Cloud only) |
   | POST | `/search/notifications` | Hands one alert to Cribl's notification service for that target | Yes: `createSearchNotifications` (Cribl.Cloud only) |
   ```
   Also update the stale sentences: "Read-only: `default/policies.yml` holds GETs plus the metrics query" and the `hooks.slack.com` proxy row (D23). (Done.)
2. **Resolved.** The packages were rebuilt from the working tree with the notification grants (and the What-if dry-run grants the flow builder added): `meter-reader-1.0.0.tgz`, `meter-reader-1.0.2-demo.tgz` (D22: plain numeric) and `meter-reader-1.0.0-backend.tgz`; the superseded `1.0.0-demo` and `1.0.1-demo` builds moved to `build/superseded/` (git-ignored). None of them is deployed yet: the org still runs demo 1.0.1, which predates these grants, so item 4 waits for that deploy.
3. **Resolved (27 Sep).** `core/weekly.ts` no longer calls the webhook `deliver()` with `ep.url`: the weekly receipt and the test send both go through `createDeliveryRouter` (`core/weekly.ts:15` imports it, `:83` builds the router, `:196` and `:279` deliver through it), so the receipt and `sendTest` reach the bell and notification targets like every alert. The implicit bell now defaults to `weeklyReceipt: true` (`core/delivery.ts`), and the endpoint editor has a **Weekly receipt** switch on Cribl channels (`src/components/EndpointEditor/EndpointEditor.tsx`).
4. **Open: member-path verification.** As a non-admin member, run the Settings bell test and a target test, and **Connect** a target whose relay notification does not exist yet (it exercises the literal notification grant). If the App proxy refuses `POST /search/notifications` or `/m/default_search/search/saved*` for members, the target channel is runner-only on that plan, and the UI already says why ("Cribl refused the request (403)…"). The Leader already accepted the literal relay grants at install (demo 1.0.11 to 1.0.14). The steps are listed in `docs/LIVE_VALIDATION.md`, "Still to run", and in the owner's clean-install test, step 8.
5. **Resolved (27 Sep).** The live runner runs the 1.0.15 tree (`0fa69d0`, restarted 22:02 UTC; `docs/LIVE_VALIDATION.md`, Installs) and posts to the bell by default next to the demo receiver from its `.env` (D57). A `cribl-target` endpoint on stage stays a demo-day choice; the relay is connected (§4). Commit authors from API clients still read as `<client id>@clients` in bell and target text; a change made from the App carries the member's full name.
6. **Resolved (27 Sep).** No "through Cribl's proxy" string is left in `src/` or `core/` (grep, 27 Sep), and `DECLARED_HOSTS` is empty in `tests/compliance.test.ts`: the direct-webhook editor and the Enterprise `proxies.yml` went with D57.
7. **Resolved (27 Sep).** `src/components/IncidentCard/model.ts:182` recognizes the implicit bell by `BELL_ENDPOINT_ID` (and any stored endpoint by `channelOf`), so a delivery to it reads as the Cribl bell, not "Sent to cribl-bell ✓".
8. **Decided (27 Sep).**
   - **`GET /notification-targets` is kept for the target picker.** The reasoning is in the README, "What an administrator should know before sharing the App": the Source and Destination reads, without which nothing can be metered, already hand the same members every Source's and Destination's configuration with its credentials decrypted, so the targets list does not change who the App should be shared with. The App keeps only id, type and description and lists targets only when a member presses **Load targets**. Dropping it stays one grant in both policy files plus the **Load targets** button.
   - **Bell volume.** The bell gets one entry per alert state, and the App never removes one (`AGENTS.md` forbids an unconfirmed DELETE). The README's Engineering notes ("Bell volume") and Troubleshooting say so: members switch the bell off or raise its minimum severity in Settings, and an administrator clears entries in Cribl.
