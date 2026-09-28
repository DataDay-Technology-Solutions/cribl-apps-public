# Cribl Insights vs. Meter Reader, and Apps platform docs (PRD spike item o)

Researched 2026-09-25 against docs.cribl.io (current doc version 4.20, per `<meta name=current-version content="4.20">`).

## How to read the citations

- **Docs**: every docs.cribl.io page has a raw Markdown twin (the page's "Copy for LLM" / "View as Markdown" button, `data-md-url`). A citation like `insights/data.md:118` means line 118 of `https://docs.cribl.io/insights/data.md` as fetched on 2026-09-25. The HTML page is the same path without `.md` (for example `https://docs.cribl.io/insights/data/`).
- **API reference**: `api/<product>/<section>.md:<line>` means `https://docs.cribl.io/cribl-as-code/api-reference/control-plane/<product>/<section>.md`. `api/management-plane.md` is `https://docs.cribl.io/cribl-as-code/api-reference/management-plane.md`.
- **Release notes**: `insights-rn/release-vNNNN.md` or `release-vNNNN.md` means `https://docs.cribl.io/insights/release-notes/release-vNNNN.md`. I read 4.16.0 through 4.20.1.
- **Reference apps**: repo-relative `repo/path:line` under the session `ref/` clones.
- **AGENTS.md**: `AGENTS.md:<line>` in this project. AGENTS.md outranks the docs for this build. Where the two disagree, both are shown (section 9).
- **Limitation**: everything below comes from the docs and the reference code. I did not inspect a live Cribl.Cloud Insights UI, so "not in the docs" does not prove "not in the product". Anything I inferred is marked **INFERRED**.

---

## 1. Does Insights show a price or dollar cost for data flows? **No.**

**Evidence that it is absent.** I grepped all 18 Insights pages (`about, enable, system, data, alerts, monitors, metrics-reference, activity, muting-rules, notifications, targets, email-target, aws-sns-target, pagerduty-target, slack-target, webhook-target, templates, policies`) for `dollar|$N|USD|price|pricing|cost|credit|bill|invoice|spend|saving|forecast|estimat`. Every hit is one of the following, and none is a per-flow price:

| Hit | Quote | What it actually is |
|---|---|---|
| `insights/enable.md:23` | "Paid tiers are 7 days, 1 month, 3 months, and 1 year. For pricing details, see [Insights Pricing](https://cribl.io/pricing/plan/?product=cribl-insights)." | The price of Insights itself (retention tiers) |
| `insights/enable.md:56` | "Enabling Insights can incur costs." | The same |
| `insights/system.md:206` | "**CPU*Hours** charts search compute consumption over time" | Compute units, not dollars |
| `insights/system.md:210-211` | "For credit consumption and invoices, see [Track Product Usage and Credit Consumption](https://docs.cribl.io/billing-licensing/finops-center)." | Insights sends you elsewhere for money |
| `insights/system.md:281,302` | "**Cost Control:** Identify heavy datasets…" / "identify the top datasets driving storage costs" | Advice about Lake storage **volume**; no $ figure is shown |
| `insights/about.md:32` | "Analyze trends for scaling decisions and to optimize infrastructure costs." | Marketing copy |
| `insights/metrics-reference.md:88` | "`search_cpu_time_billable` \| counter \| seconds \| Billable CPU time." | The closest cost-shaped metric. Its unit is **seconds** |
| `insights/metrics-reference.md:104-105` | `lake_byos_metrics_to_generate` / `_generated`: "billing-metric generation backlog" | Health of Lake's billing pipeline, not a cost |
| `insights/metrics-reference.md:185` | "`metrics_packet_reducer_packets_reduced` … (the savings from reduction)" | Internal metrics-pipeline packets, not dollars |

The Insights control-plane API also has no cost field. Its sections are Data Insights, Insights Apps, Monitor History, Monitors, Silences and System Insights (`api/cribl-insights.md:9-14`). Grepping them for `cost|price|dollar|credit` returns nothing.

**Where dollars do live: the FinOps Center and the Management Plane billing API.**

- **Credit-to-dollar rate**: "In Cribl.Cloud, one credit equals one US dollar." (`billing-licensing/finops-center.md:209`)
- **Rates**: Stream "0.32 Credits/GB per Cloud Worker", "0.26 Credits/GB per Hybrid Worker"; Edge "0.21 Credits/GB per Edge Node"; Lake ".05 Credits/GB if Cloud Worker managed by Cribl", ".02 Credits/GB if self-managed" (`finops-center.md:217-220`). These are list rates; the "Stream" row also says "(infrastructure pricing based on region)". **INFERRED:** a contract's effective rate may differ.
- **Only ingress is billed**: "We charge on ingress (data in), but you never pay for egress (data out)" (`finops-center.md:191-193`).
- **Finest granularity**: per product, per Workspace, and "The 10 Worker Groups with the most data usage in GB." (`finops-center.md:94-96`). **No Source, Pipeline, Route or Destination granularity is documented anywhere in FinOps.**
- **API**: base URL `https://gateway.cribl.cloud` (`api/management-plane.md:12`).
  - `GET /v1/organizations/{organizationId}/billing/credits/timeseries` (`:514`): "broken down by dimensions such as product and usage type" (`:516`). The `window` enum is `monthly|daily` (`:531-532`). The date range is limited to "6 months for daily, 7 years for monthly" (`:523-525`).
  - Also `…/billing/credits/stats` (`:575`), `…/billing/credits/contracts-utilization` (`:454`) and `…/billing/credits/grants` (`:622`).
  - Response item shape (`:1564-1574`):
    ```json
    { "date": "2025-05-01T00:00:00.000Z", "credits": 147722.92,
      "dimensions": [ { "dimension": "stream", "credits": 42150.5 } ] }
    ```
- **Freshness**: "Cribl.Cloud refreshes credit data every five minutes" (`finops-center.md:247-248`).
- **A shipped app already reads this API**. `cc-cribl-executive-dashboard/config/proxies.yml:20-40` declares `login.cribl.cloud` (`/oauth/token`, `Authorization: "'Basic ' + kv.finopsBasic"`) and `gateway.cribl.cloud` (`/v1/organizations/`, `Authorization: "'Bearer ' + kv.finopsToken"`).

**Conclusion (INFERRED):** Cribl publishes $/GB rates and org-level credit time series. It does not attribute dollars to individual Sources, Pipelines, Routes or Destinations. That per-flow attribution is the gap Meter Reader would fill, by multiplying per-component bytes by the documented rate.

---

## 2. Any counterfactual ("what would this have cost / saved if…")? **No.**

Data Insights' **Compare** mode compares two windows of actual data. It does not model a what-if. Verbatim (`insights/data.md:118`):

> "Use **Compare** to see how the current time range's metrics differ from the same-length window at an earlier point in time. This is helpful to validate recent changes, confirm regressions, or distinguish new issues from normal historical patterns. Select a **Comparison period** to see the current metric value on each map card, with a percentage change versus the comparison period. Both periods are plotted on the same charts so you can quickly see increases, decreases, or pattern changes. The **Comparison period** controls how far back the earlier window starts."

Related before/after wording, all still actual-vs-actual:

- "**Validate Changes:** Compare windows before and after a configuration change to ensure stability." (`insights/system.md:24`)
- "Compare metrics across time windows to confirm the impact of configuration or deployment changes." (`insights/data.md:32`)
- The only forecast in the pages I fetched is FinOps' "3-month consumption forecasting based on the current credit consumption" (`finops-center.md:91-92`). It is org- and product-level, and it is a trend projection, not a counterfactual.

---

## 3. Does any alert name a commit or an author? **No.**

- **Template variables are the only alert context.** The docs list them exhaustively (`insights/templates.md:166-188`): `{{monitor_id}}`, `{{monitor_name}}`, `{{description}}`, `{{status}}` ("For example: `firing` or `cleared`"), `{{value}}`, `{{labels}}` / `{{labels.<k>}}`, `{{fired_at}}` ("Unix timestamp in milliseconds"), `{{workspace_name}}`, `{{__policyId}}` and `{{metadata.<field>}}`. None of them is a commit, a config version or an author.
- **Webhook custom-format expression fields** (`insights/webhook-target.md:37-52`): `starttime`, `endtime`, `_time`, `cribl_host`, `cribl_notification`, and `origin_metadata` (`type` of `"output"` or `"input"`, `id`, `subType`). No commit or author.
- **Monitor API schema has no author field.** `POST /alert/monitors` accepts `id, name, description, enabled, firing_after, ok_after, isDefault, notification_policies, notifications_enabled, params, product, query{metricName, labelFilters[], operation{operation, byWithoutClause}, timeRange}, rules[], schedule_interval_seconds, silences[], sqlOverride{instant, range}` (`api/cribl-insights/monitors.md:104-160`).
  - The only `created_by` in the Insights API is on **silences** (muting rules): "Username or identifier of who created this alert silence." (`api/cribl-insights/silences.md:107`).
- **Closest thing in Stream: Monitoring's config-change markers.**
  - "Vertical lines across each chart display configuration changes. Click anywhere on the line to view summary information including time, data, and configuration versions." (`stream/monitoring.md:41`)
  - "Dots on the daily usage bar graph represent configuration changes in the system." (`stream/monitoring.md:226`)
  - This requires git: "you must have `git` installed in order for the [Monitoring] > **Licensing** page to display configuration change markers." (`stream/monitoring.md:232`)
  - The markers show *configuration versions*. The docs do not say they show an author.
  - "Except for these configuration change markers, Monitoring data does not persist across Cribl Stream restarts." (`stream/monitoring.md:43`)
- **Where commit and author data is exposed: the Stream Version Control API.**
  - `GET /version`: "List the commit history… Analogous to `git log` for the Cribl configuration" (`api/cribl-stream/version-control.md:33-35`).
  - `GitLogResult` fields: `author_email`, `author_name`, `body`, `date` ("ISO 8601 format with timezone offset"), `hash` ("Full SHA-1 hash"), `message`, `refs` (`version-control.md:1445-1470`).
  - Diffs: `GET /version/diff` (`:314`) and `GET /version/show` (`:588`).
  - **INFERRED:** Meter Reader could join commit timestamps from this API to metric time series. Insights does not.

---

## 4. Any scheduled dollar receipt, digest or report? **No.**

- Insights notifications are sent only when an alert changes state: "For each state change:" (`insights/notifications.md:24`).
- **Policies time notifications but do not schedule reports.** They offer "**Alert grouping delay (minutes)**: The number of minutes to wait after the first matching alert before sending the initial notification" (`insights/policies.md:78`). Line 109 also names "**Wait to Group Alerts**", "**Ongoing Alert Interval**" and "**Alert Reminder Interval**", but the create-policy field list (`:49-78`) documents only the grouping delay. There is no cron, digest or report option.
- **Muting rules** have a **Scheduled** status (`insights/muting-rules.md:65,71`). That means a *suppression* window scheduled for the future, not a scheduled send.
- **Stream Monitoring > Reports** is a pull-only "Top Talkers" view: "your five highest-volume Sources, Destinations, Pipelines, Routes, and Packs… ranks all components by events throughput. Sources and Destinations get separate rankings by bytes in and out" (`stream/monitoring.md:240`). It is not scheduled and shows no dollars.
- **FinOps invoices** are monthly and pull-only: "You can download **Final** invoices as JSON or CSV" (`finops-center.md:155`); "You can download your monthly Cribl.Cloud invoices as CSV or JSON files." (`:172`). Nothing is emailed or scheduled per flow.
- **INFERRED:** a scheduled dollar receipt would be new. The Apps platform supports this via `config/schedules.yml` plus a backend function (section 8).

---

## 5. What notification targets exist?

"Target Types" (`insights/targets.md:16-20`):

- "[Email] messages: custom SMTP or, in Cribl.Cloud on an Enterprise plan, the preconfigured `system_email` target."
- "[Amazon SNS] topics."
- "[PagerDuty] accounts."
- "[Slack] channels."
- "[Webhook] connections."

Notes on each:

- **Microsoft Teams, Opsgenie and ServiceNow are not listed.** The only generic route is the Webhook target.
- **Targets are shared across products**: "Notification targets are shared across the Cribl Product Suite." (`targets.md:12`)
- **Template types** are `Webhook, PagerDuty, Slack, SNS, SMTP` (`insights/templates.md:64-68`).
- **Slack** is configured by "**Webhook URL**: Add the full URL of your Slack Incoming Webhook" (`insights/slack-target.md:19-20`).
- **Webhook**:
  - Method: "`POST` (the default), `PUT`, or `PATCH`" (`webhook-target.md:20`).
  - Format: "`NDJSON` … `JSON Array` … `Custom`", where Custom adds Source expression, Batch expression and Content type (`:22-31`).
  - Auth: "**None** / **Auth token** / **Basic**" (`:56-58`).
  - Default retry: status ">= 400 and <= 500 → Drop", "> 500 → Retry" (`:72-75`).
- **Email recipients** come from the template, not the target (`insights/email-target.md:18-26`). The built-in `default_email` template content is (`insights/templates.md:102-109`):
  ```json
  { "to": "{{metadata.to}}", "cc": "{{metadata.cc}}", "bcc": "{{metadata.bcc}}",
    "subject": "[{{status}}] {{monitor_name}}",
    "body": "Severity: {{labels.severity}}\n\nMonitor: {{monitor_name}}\n\n..." }
  ```
- **API**: `GET|POST /notification-targets`, `GET|PATCH|DELETE /notification-targets/{id}`, `POST /notification-targets/{id}/test` (`api/cribl-core/notification-targets.md:33,89,154,209,264,330`). The schema field `type` has no documented enum (`:107,506`).

---

## 6. What does the Data Insights map show?

**Scope.** Data Insights covers Stream only: "an interactive topology view of your Cribl Stream data flows, showing how data moves from Sources through Pre-Processing Pipelines, Routes/QuickConnect, and Post-Processing Pipelines to Destinations, with metrics for volume, freshness, and shape." (`insights/data.md:10`)

**Columns, left to right** (`insights/data.md:58-62`, verbatim):

- "**Source**: Ingest points producing Events, Bytes In and Freshness In, and (when enabled) Shape, which reflects the number of fields per event."
- "**Pre-Processing Pipeline**: The first processing stage … Expect changes in volume and Shape here as fields are extracted or dropped."
- "**Routes / QuickConnect**: Data routing/branching layer that directs events to Pipelines and Destinations. Use this column to verify that Sources connect to the expected paths."
- "**Post-Processing Pipeline**: Where transformations, enrichment, and reduction occur. You can expect divergence between Events and Bytes In vs. Out…"
- "**Destination**: Egress targets showing Events, Bytes Out, and related Freshness at the boundary."

So the flow is **Source → Pre-Processing Pipeline → Route/QuickConnect → Post-Processing Pipeline → Destination**. The docs describe the Routes column as topology verification and do not list byte metrics for it. **INFERRED:** Route cards may still show the selected metric, because the metric controls "choose what each map card and sparkline shows" (`data.md:133`). Unverified live.

**Metric families** (`data.md:134-138`): **None**; **Volume** ("events and bytes in and out"); **Freshness** ("age of events"); **Shape** ("minimum and maximum number of fields per event"). Display modes are "Max In/Max Out" and "Min In/Min Out" (`:139-145`). Details-pane tabs are Events, Bytes, Freshness, Shape, Alerts and a PQ sidecar (`:156-165`).

**No cost or dollar metric is offered on the map.**

**Caveats that matter for any $/GB math** (`data.md:102-104`):

- "Bytes In (Source) and Bytes Out (Destination) don't match because Data Insights accounts for compression, formatting, and protocol overhead at the Destination."
- "When you filter the map by Source, the Destination still displays the full aggregated volume if an Aggregation Function is used in the Pipeline."
- "If a Pipeline or QuickConnect is used by multiple Sources or Destinations, it appears as a distinct map card for each connection."

**How Stream counts bytes** (`stream/monitoring.md:59-87`):

- Byte charts show "uncompressed amounts".
- "Bytes in gets counted after deserializing and event breaking."
- Destinations count "the outgoing payload (typically a JSON string) prior to compression."
- Routes: "**Bytes Out** estimates the event size after the Route's Pipeline has processed the event."

**Underlying metric names** (`insights/metrics-reference.md:113-127,159-161`):

- `total_in_bytes` ("Bytes received, per Source (input)") and `total_out_bytes` ("Bytes sent, per Destination (output)")
- `in_bytes` / `out_bytes` ("Bytes into a specific component (Pipeline, Route, or Pack)")
- `pipe_in_bytes` / `pipe_out_bytes`
- `total_dropped_events` ("labels: `output`, `output_type`, `__worker_group`")
- `pipe_dropped_events`, `route_dropped_events`

**Namespace gotcha for Data Insights series** (`insights/monitors.md:58-66`): Data Insights series share metric names with system series and are told apart by the `namespace` label. "Entering `data-insights` as the value selects the Data Insights series." Without that filter, results "can … over-count (for example, roughly double the values you expect)."

**Other Insights facts that constrain Meter Reader:**

- **Availability**: "Insights is available to Workspace Admins within Enterprise Cribl.Cloud Organizations … and is not available for on-prem deployments." Free retention is "**48-hour**" (`insights/about.md:18-20`).
- **Timeline**: all of Insights (System, Data and Alerts) first shipped together in 4.16: "Introducing Cribl Insights to the Cribl Suite" (`https://docs.cribl.io/insights/release-notes/release-v4160.md:6,10-14`). Alerts on the Data Insights map arrived in 4.19: "You can now see and act on alerts directly from the Data Insights map" (`release-v4190.md:30`).
- **Insights has a permissions layer**: 4.20 "adds Permissions for Insights and its sub-products" (`release-v4200.md:6,25-27`).

---

## 7. Monitoring and metrics APIs: is `/system/metrics/query` documented? **Yes.**

### `POST /system/metrics/query` is in the public Cribl Core API reference

- **Location**: Cribl Core › Diagnostics and Monitoring (`api/cribl-core/diagnostics-and-monitoring.md:523-531`). The heading is "Aggregate raw system metrics", `operationId` `createSystemMetricsQuery`: "Aggregate raw system metrics using filter expressions, dimension-based grouping, and time-based splitting."
- **Request `SystemMetricsQueryRequest`** (`:1534-1552`):
  ```json
  {
    "aggs": { "aggregations": ["string"], "splitBys": ["string"], "cumulative": true, "timeWindowSeconds": 0 },
    "alwaysBounds": true, "earliest": "string", "latest": "string",
    "namespace": "string", "source": "linux", "where": "string"
  }
  ```
  - `aggs.aggregations` is required.
  - `aggs` is `oneOf` { `timeWindowSeconds` required } xor { `cumulative` required } (`:1578-1592`).
  - `earliest` / `latest` accept "a relative time string (for example, `-1h`) or a timestamp in Unix time (milliseconds)" (`:1599-1600`).
  - `source` enum is `linux|windows` (`:2149-2150`).
- **Response `CriblEventEnvelop`** (`:1508-1515`): `{ "results": [ { "_raw": "string" } ] }`. The docs give **no field-level shape** for result rows.
- **Siblings**:
  - `GET /system/metrics` (`:324`, response `QueryResultsEnvelop` `{results:{exactMatch, metrics:[{<name>:[{model,val}]}]}}` at `:1179-1200`)
  - `POST /system/metrics/enum` (`:454`)
  - `GET /system/metrics/telemetry` (`:386`)
- **Auth note (INFERRED)**: every operation carries the aside "This operation does not require authentication" (for example `:605`). This contradicts the page's own header, "# Authentication / - HTTP Authentication, scheme: bearer" (`api/cribl-core/diagnostics-and-monitoring.md:21-23`; the same pattern is at `api/cribl-insights/data-insights.md:21-23`). I read it as generator boilerplate, not a real auth exemption.

### What the docs leave out, from the reference apps

- **Retention is about 2 days**: "that store only retains ~2 days; the dataset holds ~30" (`cc-cribl-executive-dashboard/src/api/metrics.ts:12-14`; also `src/api/search.ts:4-6`). That app switched to Cribl Search over the `cribl_metrics` dataset for long ranges.
- **Row timestamps**: "Bucketed (non-cumulative) queries — confirmed live — have **no `_time` field at all**; each bucket instead carries `starttime`/`endtime` (both in seconds)." (`cc-di-data-flow-monitor/src/api/metrics.ts:23-26`)
- **Group scope**: the endpoint is Leader-level. "confirmed live that /m/:gid/system/metrics/* 404s, group scoping happens via a __worker_group dimension in the query itself" (`cc-di-data-flow-monitor/config/policies.yml:5-6`).
- **Exact policy spelling** (`cc-di-data-flow-monitor/config/policies.yml:7-8`; also `cc-visicore-criblvision/config/policies.yml:20`):
  ```yaml
  - object: '/system/metrics/query'
    actions: ['POST']
  ```
- **Read-only despite the POST verb**: "`POST /system/metrics/query` and `/system/metrics/enum` are read-only queries despite the verb." (`cc-cribl-executive-dashboard/README.md:113`)

### Insights metrics API (Cribl.Cloud only, better-typed)

**INFERRED:** retention here follows the Workspace's Insights tier: 48 hours free (`insights/about.md:20`), or paid 7 days to 1 year (`insights/enable.md:23`). That is not obviously longer than the ~2-day `/system/metrics/query` store. Detect it live with `GET /system-insights/ttl`.

- `POST /insights/metrics/query`, "Query Data Insights metrics (Cribl.Cloud only)" (`api/cribl-insights/data-insights.md:27-35`).
  - Body `InsightsQueryRequest` (`:47-66`): `metricExpressions[]` (required), `startTime` / `endTime` (Unix ms), `bucketSize` (ms), `dimensionSplits[]`, and `dimensionFilters[]` of `{name, operator: eq|ne|exists, value}`.
  - Response `InsightsQueryResponse` (`:130-148`):
    ```json
    { "timeSeries": [ { "dimensions": {"k":"v"}, "name": "string",
                        "points": [ { "endTime": 0, "startTime": 0, "value": 0 } ] } ] }
    ```
  - `503` is "System Insights database unavailable" (`:115`).
- `GET /system-insights/metrics` (metric names, paginated `{items,count,offset,limit,totalCount}`) (`api/cribl-insights/system-insights.md:86-110`)
- `GET /system-insights/metrics/{id}` (labels) (`:140`)
- `GET /system-insights/ttl`, "Get the data retention period for System Insights" (`:189-195`). An app can call this to detect the Insights retention tier.
- **None of the reference apps call any `/insights/...` or `/system-insights/...` endpoint** (grep of `ref/`, excluding the SDK, returns nothing). It is untested in practice.
- **INFERRED:** app access would need these paths in `policies.yml`, and Insights must be enabled on the Workspace.

### Stream Monitoring page (UI)

- Submenus: Overview, Data, System (incl. Licensing), Reports (Top Talkers), Flows, Logs, Notifications (`stream/monitoring.md:14-24`).
- "The `1 day` setting covers the preceding 24 hours, and this maximum window is not configurable." (`:39`)
- Licensing "compare your daily Cribl Stream and Cribl Edge data throughput against your license quota - and against granular and average throughput over the last 30 to 365 days." (`:219`) This view shows GB against quota, not dollars.

---

## 8. Apps docs: limits and the facts asked for

| Item | Documented value | Source |
|---|---|---|
| **Leader requests limit (per App backend)** | "Maximum Leader API requests each App backend can make per minute. The default is `50`, and the allowed range is `1` through `1,000`." Set by an org admin under **Settings > Global Settings > App Settings**; "Changes take effect after the Leader restarts." | `apps/admin-guide.md:150,144,156` |
| Max concurrent backend executions (Leader-wide) | "The default is `100`. Additional requests receive an HTTP 429" | `admin-guide.md:149` |
| Scheduled jobs per App | "The default is `25`, and the allowed range is `1` through `100`." | `admin-guide.md:151`; `builder-guide.md:279` |
| Schedule `bodyExpression` max | "default is `4,096`, … range is `1` through `16,384`" | `admin-guide.md:152`; `builder-guide.md:282` |
| Schedule job concurrency (Leader-wide) | "default is `50`, … range is `1` through `100`" | `admin-guide.md:153` |
| Cron | "A five-field UTC cron expression. There is no seconds field and no timezone." There is no enable/disable field. | `builder-guide.md:281,284` |
| Dynamic schedules | Policies `/backend-schedules` (GET, POST) and `/backend-schedules/*` (GET, PATCH, DELETE). An upgrade "can overwrite dynamically changed package schedules or remove dynamic schedules that are absent from the package." | `builder-guide.md:286`; API `GET/POST /a/{appId}/backend-schedules`, `GET/PATCH/DELETE /a/{appId}/backend-schedules/{id}` (`api/cribl-core/apps.md:1298-1549`) |
| Backend `timeout` | "The default is `30`, and the allowed range is `1` through `900`." | `builder-guide.md:193` (**conflicts with AGENTS.md; see section 9**) |
| Backend `memory` | "default is `256`, … `1` through `1024`" | `builder-guide.md:194` |
| Backend request/response body | "Request bodies can contain up to 4 MB, and response bodies can contain up to 6 MB." | `builder-guide.md:256` |
| Backend bundle | Build "Rejects a bundle larger than 5 MB." | `builder-guide.md:233`; `admin-guide.md:97` |
| Backend `context` | `appId`, `installationId`, `invocationId`, `caller.userId` ("for attribution, not authorization") | `builder-guide.md:216-221` |
| Package archive | "Compressed archive must not exceed 100 MB." | `admin-guide.md:85` |
| **KV key limit** | "Each App can store up to 1,000 keys by default. To raise the limit, contact [Cribl Support]." | `builder-guide.md:310`; `admin-guide.md:184,393` |
| KV value size | "A value can be any string you can send in the request body … including multi-megabyte artifacts." No hard cap is documented. | `builder-guide.md:308` |
| KV admin API | `PATCH /apps/{id}/kvstore-settings` body `{ maxKeys: number }` | `api/cribl-core/apps.md:914-930` |
| KV bulk / scan | `POST /kvstore/bulk`. `POST /kvstore/scan` body `{cursor, limit, prefix}`: "limit … Defaults to 1000; a larger value is clamped to 10000"; a page closes at "4 MiB of accumulated value bytes"; "Encrypted values are omitted from the page" | `apps.md:980,1031-1048` |
| **Encrypted KV** | "Store API keys, tokens, passwords, and other secrets in the Apps KV store with the query parameter `encrypted=true` on writes. Encrypted values are write-only from the browser: reads return a redacted placeholder" | `apps/runtime-and-security.md:50`; `builder-guide.md:312-315` |
| KV isolation | "Plain (unencrypted) KV values are visible to anyone in your Organization who can use the KV APIs for that App context" | `builder-guide.md:312` |
| KV lifecycle | Upgrade: "KV store data and settings are preserved." Delete: "KV data and settings are removed with the App." Per-Workspace: "Do not assume KV or secrets copied automatically from staging to production." | `admin-guide.md:112,140,350` |
| Proxy timeout (API schema) | "Minimum `1000`, maximum `120000`, default `30000`" (ms) | `api/cribl-core/apps.md:804` |
| Availability | "Apps is available only on Cribl.Cloud." | `https://docs.cribl.io/apps/` overview page (HTML; its `.md` twin returned 403) |

**Encrypted KV write, as used in shipped code:**

- `fetch(api() + '/kvstore/splunk_token?encrypted=true', { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: token })` (`cc-visicore-spl-to-kql/src/api.ts:416`)
- `` `${getKvBase()}/${key}${encrypted ? '?encrypted=true' : ''}` `` (`cc-sample-sanitizer/src/settings-store.ts:425`)

**External API Access: the JSON format** (`apps/admin-guide.md:212-222`, verbatim):

> "To add a host, open **External API Access**, add an object to the array the editor already shows, and select **Save**. Do not replace the array with only the new host:"
```json
{
  "id": "login.okta.com",
  "timeout": 15000,
  "paths": {
    "allowlist": ["/"]
  }
}
```

- "Each entry's `id` is the hostname. The remaining fields are the same declarations App builders use in `proxies.yml`" (`:224`).
- "Hosts that shipped in the App package stay in effect even if you omit them. If you delete a packaged host, it returns after you save." (`:229`)
- "Editing requires the same permission as **Create App**." (`:228`)
- **API**: "use `GET` and `PUT /api/v1/apps/{id}/proxies`. `GET` returns every host currently in effect. `PUT` replaces only the administrator-managed hosts with the `items` array you send." (`:231`)
  - The API reference adds: "Writes only the local overlay (`local/proxies.yml`); pack-shipped `default/proxies.yml` is never modified." (`api/cribl-core/apps.md:780`)
  - Body `AppProxiesReplaceRequest` is `{ items: [ { id, timeout, paths{allowlist,blocklist}, headers{allowlist,blocklist,inject}, rejectUnauthorized } ] }` (`apps.md:793-807`).
- Hostnames are exact: "Wildcards are not supported for hostnames." (`builder-guide.md:372`). Otherwise the request fails with 403 (`admin-guide.md:239,392`).
- "An App can never widen its own external access." (`admin-guide.md:210`)

**Deploy from Live Preview** (`apps/admin-guide.md:73-77`; `apps/quickstart.md:104-111`; `apps/builder-guide.md:133`):

- **What it does**: "When a builder selects **Deploy** in **Live Preview**, Cribl packages the local development App. It then installs that package into the Workspace where **Live Preview** is running."
- **No file review**: it "does **not** run the same pre-install file review as **Add App** > **Import**."
- **Sharing can change**: "Treat **Deploy** like shipping a new install for the same App ID, not like the **Upgrade** action … Members who could open the App only because it was easy for everyone in the Organization to discover might **no longer** see it under **Apps** > **Installed** until sharing is set again."
- **Confirmation**: "Each time you deploy, the UI shows a **Confirm deploy** modal with fixed (static) copy."
- **Backends deploy after the call returns**: "If the App declares backend functions, Cribl starts deploying them after **Deploy** returns." Status shows as **Deploying...** or **Error**, with a **Redeploy** option (`admin-guide.md:116-130`).
- **Who can do it**: "Only Workspace Administrators can use **Create App**, **Live Preview**, and **Deploy** from **Live Preview**." (`admin-guide.md:250`)

**Import from File** (`apps/admin-guide.md:59-69`):

- "Use **Add App** > **Import from File** when you have a `.tgz` from an App builder." Steps: choose the `.tgz` → "Cribl runs a **pre-install check**" → **Review App** modal if the check finds `proxies.yml` hosts, `policies.yml` permissions, backend functions or flagged executables → review the install summary ("Display Name, ID, Version, Author, declared external endpoints, and any declared in-product API permissions") → confirm.
- Validation (`:83-97`):
  - Blocks symlinks, hard links and path traversal; files are forced to `0644`.
  - `package.json` needs `name`, `version` and `"cribl": { "type": "app" }`.
  - "App ID must not conflict with any existing Pack or App name" (409 otherwise, `:57,389`).
- "**Schedule information** is not available during the pre-install check. As a result, **Review App** does not identify scheduled functions." (`:43`)
- **Upgrade** (same App ID) "preserves **Share** settings" (`builder-guide.md:131`; `admin-guide.md:113`).
- There is also a Terraform `criblio_app` resource (`admin-guide.md:26`) and `POST /apps/preinstall-check` (`api/cribl-core/apps.md:1624`).

**Observability of app traffic** (`admin-guide.md:372-380`):

- Backend `console.*` output goes to `app-backend.log`.
- Access-log filters: `http_user_agent == "product-ui-app"` and `cribl_app == "<installed-app-token>"`.
- App requests carry the header `Cribl-App: <app-id>`.

---

## 9. Where AGENTS.md (authoritative) and the docs disagree

AGENTS.md wins for this build. Each item gives AGENTS.md, then the docs, then what the reference apps do.

1. **Backend `timeout` range**: AGENTS.md says "(1–120, default 30)" (`AGENTS.md:264`). Docs say "range is `1` through `900`" (`builder-guide.md:193`). **INFERRED:** stay at 120 or below to satisfy both.
2. **Schedules per App**: AGENTS.md says "Up to 10 schedules per app." (`AGENTS.md:311`). Docs say default `25`, admin-raisable to `100` (`admin-guide.md:151`; `builder-guide.md:279`). **INFERRED:** 10 or fewer is safe under both.
3. **`proxies.yml` location**: AGENTS.md says `config/proxies.yml` (`AGENTS.md:120,124`). Docs say "in a `proxies.yml` file at your project root" (`builder-guide.md:355`; the overview also says "at the project root"). Every reference app uses `config/proxies.yml`.
4. **Header-inject expression syntax**: three spellings are documented.
   - AGENTS.md: `Authorization: "'Bearer ' + kv.openaiApiKey"`, described as "String literals … KV store lookups: `kv.mySecretKey` … Concatenation" (`AGENTS.md:150,160-163`)
   - Builder Guide: ``Authorization: '`Bearer ${kv.api_key}`'`` (`builder-guide.md:366`)
   - API schema: "Values can include `C.kv.<key>` and `C.env.<name>` expressions." (`api/cribl-core/apps.md:798`)
   - The one shipped app with an active inject uses the AGENTS.md concat form (`cc-cribl-executive-dashboard/config/proxies.yml:28,39`; `cc-cribl-power-tools/config/proxies.yml:40`). All other refs only have the template-literal form commented out (for example `cc-di-data-flow-monitor/config/proxies.yml:13-14`).
5. **KV REST base**: AGENTS.md uses `CRIBL_API_URL + '/kvstore/…'`, rewritten to `/api/v1/a/{appId}/kvstore/…` (`AGENTS.md:67,103-108`). Docs use relative `/api/v1/kvstore/<key>` (`builder-guide.md:306,326`). **INFERRED:** these are equivalent after the proxy rewrite. Follow AGENTS.md.
6. **These are different limits, not a conflict**:
   - AGENTS.md: "Requests are rate-limited per app (100 requests/minute)". This is the **external proxy** (`AGENTS.md:168`).
   - Admin Guide: "Leader requests limit … `50`" per minute. This covers **backend → Leader API** calls (`admin-guide.md:150`).
   - AGENTS.md's "Proxied requests time out after **30 seconds**" (`AGENTS.md:76`) is also separate from the backend `timeout`.
7. **Browser storage wording**: AGENTS.md says it is "unreliable" (`AGENTS.md:99`). Docs say `localStorage`/`IndexedDB` are "❌ Not available in the sandbox" (`builder-guide.md:35-36`). Both forbid it.

---

## 10. Other decision-relevant facts found along the way

- **Do not build on the TypeScript SDK.** "Cribl is stopping active development of the Cribl as Code Go and TypeScript SDKs … On October 1, 2026, the SDK repositories will be archived and marked read-only." (`insights-rn/release-v4200.md:72-82`). That is 6 days after this research date. The `cribl-control-plane-sdk-typescript` clone in `ref/` is affected.
- **4.20 moved API rate-limit settings**: login rate limits now live in `api-limits.yml`, set with `PATCH /system/api-limits` (`release-v4200.md:68`).
- **Insights' own alert primitives, if Meter Reader wants to route through Insights** (**INFERRED** option):
  - A custom Monitor can threshold `total_in_bytes` etc. with `sum|avg|max|min|count|absent_over_time` (`insights/monitors.md:51`).
  - Label filters support only `=`/`!=` (`:50`); there are no calculations: "Calculation/binary operations are not available." (`:46`).
  - A Monitor therefore **cannot express bytes × $/GB**, so dollar thresholds cannot be built inside Insights.
