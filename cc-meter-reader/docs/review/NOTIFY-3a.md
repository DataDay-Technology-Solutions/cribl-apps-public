# Cribl-native delivery (wave 3a) — builder report

Meter Reader can now send alerts through Cribl itself: the notification bell and administrator-configured notification targets both work live. Three compliance tests fail. The README needs six new grant rows, and the `release/*.tgz` packages need rebuilding after the policy change. I don't own either, so both are left for whoever does.

**Which Cribl delivery paths work live** (Cribl.Cloud 4.20.1, Standard plan, admin credential)

| Path | Result |
|---|---|
| Bell, `POST /system/messages` | Works. Proven by hand, through the product code, and by the live runner (below). |
| Notification target via a Search relay: a never-scheduled saved search with one notification per target, then `POST /search/notifications` | Works. The webhook target `mrd_webhook_site` received a test alert sent through the product code. |
| `POST /notification-targets/{id}/test` with a custom message | Does not work: 405 "Target does not support connection check". |
| `POST /m/default_search/search/notifications` | Does not work: 404. Only the Leader-level `/search/notifications` exists, despite the AGENTS.md rule that `/search/` paths go under `/m/default_search`. |
| Direct webhook | Works from the runner only; not from the UI on this plan (D23). |

- **Bell ids are write-once:** re-posting an id gives 409 and PATCH gives 405. Each alert state gets its own id (`meter-reader-<incident>-<severity|closed>`). A repeat of the same state is logged as 208 "already in the bell" so the incident card shows it as sent. Nothing in the App deletes a bell message.
- **Relay routing rule:** Cribl delivers a forwarded alert only when its `id` starts with `SEARCH_NOTIFICATION_<notificationId>_`. Any other id gets a 200 and is silently dropped. A forward to a relay that doesn't exist also gets a 200 and is dropped, so the router checks the relay first and logs `relay_missing`.
- **Duplicates:** Cribl does not de-duplicate forwarded alerts, so target sends are never retried.
- **Extra bell entry:** every relay send also updates one extra bell entry titled "Notification" (one per relay, replaced each time rather than piling up).
- **Live runner:** someone restarted `scripts/runner.ts` at 08:34:57Z, so it now runs this code. At 08:35:11Z it delivered a real recovery to both `demo-webhook-site` and the default bell, each at 200 (message `meter-reader-inc_bb03ce-closed`). I did not stop the runner and did not touch KV or live settings.
- **Not verified:** everything above ran with the admin credential. Whether a non-admin member can make these calls through the App needs a deploy with the new policies.

**Files changed**

Outside my OWN list:
- `core/settings.ts`: two additive hunks, required. `validateSettings` (about line 200) no longer asks Cribl endpoints for a URL and asks target endpoints for a target id. `normalizeEndpoint` (about line 300) keeps `channel` and `criblTargetId`. Another builder is editing this file at the same time; if they rewrite it, these hunks must be re-applied.
- `tests/unit/notifications-channels.test.tsx`: new file.

Permitted edits:
- `core/sweep.ts`: the one `deliver()` call now goes through the router over the sweep's metered transport.
- `core/types.ts`: optional `channel` and `criblTargetId` on `NotificationEndpoint`.
- `tests/compliance.test.ts`: a `NOTIFICATION_WRITES` list of exactly four POSTs.

Owned:
- `core/adapters/cribl-notify.ts` and `core/delivery.ts` (new).
- `tests/unit/cribl-notify.test.ts` and `tests/unit/delivery.test.ts` (new).
- `src/components/EndpointEditor/`: `model.ts`, `EndpointEditor.tsx`, `EndpointEditor.css`, `index.ts`, plus new `BellRow.tsx` and `copy.ts`.
- `src/views/Settings/NotificationsSection.tsx`.
- `config/policies.yml` and `config/demo/policies.yml`: additions only.
- `docs/NOTIFICATIONS.md`: every request and response from the spike.

**What was built**
- **Bell on by default:** it is added automatically unless a bell endpoint is stored. Where a Leader has no bell API or refuses it, it is skipped quietly once per sweep. That is why the mock emulator needed no change.
- **Settings:** a bell row ("no setup") at the top. Each list endpoint chooses "Cribl notification target" or "Direct webhook"; new endpoints start as webhooks, which the existing end-to-end tests expect.
- **Targets:** the picker loads only once a target endpoint is on screen. The App keeps only each target's id, type and description. "Connect" asks for confirmation and names both relay objects before creating anything.
- **Test buttons:** every channel has its own test button.
- **Policies added:**
  - `POST /system/messages`
  - `GET /notification-targets`
  - `GET /m/:gid/search/saved/:id`
  - `POST /m/:gid/search/saved`
  - `POST /m/:gid/search/saved/:id/notifications`
  - `POST /search/notifications`

**Tests**
- `npx tsc -b` is clean apart from existing errors in another builder's `scripts/live-demo-run.ts`.
- `npx vitest run`: 1105 of 1108 pass. The 3 failures are all in `tests/compliance.test.ts`: the README grants test, and the two tests that compare `release/*.tgz` with the policies files.
  - A release package I built into a scratch folder had policies equal to `config/policies.yml`, exactly the four notification writes, and no `proxies.yml`.
- Core coverage: 100% of lines on both new modules; overall 98.8% lines, 93.5% branches.
- Playwright on port 5174 (mock):
  - Full Chromium run: 79 passed, 8 skipped, before my last UI change (the channel choice became a radio group because Capra's selected toggle measured 4.20:1 contrast).
  - `settings.spec.ts`, the only spec that touches this section, passed again on Chromium and mobile after that change.

**Objects in the live org**
- **Kept:**
  - Target `mrd_webhook_site` (description tagged `[meter-reader-demo]`).
  - Saved search `meter_reader_alert_relay` and notification `meter_reader_relay_mrd_webhook_site`. These were created by the product code; they carry product names rather than `mrd_` because every customer install creates the same ids. The target is connected and ready if you want the target path on stage.
- **Removed:** all spike objects and test bell messages.

**Decisions for Steve**
1. **Keep or drop `GET /notification-targets`.** The grant lets any member the App is shared with read every target's full configuration, including Slack and webhook URLs in plain text. Dropping it means members type the target id, which the editor already supports.
2. **Bell volume.** The bell gets one entry per alert state and the App never removes them, because AGENTS.md forbids an unconfirmed DELETE. On a demo day the rig opens and closes incidents continuously, so the bell will fill up. Members can switch it off or raise its minimum severity in Settings.

**Open issues** (most urgent first)
1. **Presenter will say "Sent to cribl-bell ✓".** `IncidentCard` `endpointName()` looks names up only in stored settings, so the default bell shows its id instead of "Cribl notifications". This will appear on the presenter takeover now that the runner is live.
2. **README rows.** Add the six grant rows (with real OpenAPI operation ids) given in `docs/NOTIFICATIONS.md` §6.1. Also fix the sentences that still call the release read-only and still describe the `hooks.slack.com` proxy.
3. **Rebuild the packages** with `npm run package:release` and `package:demo`.
4. **`core/weekly.ts`.**
   - The weekly receipt skips Cribl endpoints: they are stored with `weeklyReceipt: false` and line 129 filters on it.
   - The backend variant's `sendTest` (about line 254) would log `invalid_url` for them.
   - Swap both calls for the router to send receipts to the bell and targets.
5. **Member-path check after the next deploy:** as a non-admin member, run a bell test and a target test.
6. **Copy.**
   - The channel strings in `EndpointEditor/copy.ts` should move to `src/copy/en.ts`.
   - `settings.notify.description` still says alerts go "through Cribl's proxy".
7. **"Declared" badge.** The `hooks.slack.com` badge and hint are true only for the Enterprise variant under D23. I left them because two tests I don't own assert them.
8. **Commit authors from API clients** show as `<client id>@clients` in bell and target text.

**Suggested `DECISIONS.md` rows** (evidence in `docs/NOTIFICATIONS.md`)
- **D27:** The bell is on by default through automatic resolution in the router, skipped quietly where the API is missing or refused (§3.1, §2.5).
- **D28:** Bell ids are write-once per alert state; a 409 is logged as 208 "already in the bell"; the App never deletes (§2.1).
- **D29:** Targets go through a Search relay (a never-scheduled saved search plus one notification per target), created only on a confirmed Connect. Forwards must use the `SEARCH_NOTIFICATION_<notificationId>_` id prefix, are never retried, and are checked for a relay first. `/search/notifications` is Leader-level (§2.3, §2.4).
- **D30:** The release's only non-read grants are the four notification POSTs, enforced by `NOTIFICATION_WRITES` in the compliance test (§3.3).