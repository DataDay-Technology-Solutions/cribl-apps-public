# Cardinality Reduction Pack (cc-cardinality-reduction)

Detect high-cardinality fields (UUIDs, session/trace IDs, K8s ephemeral labels, container hashes, vendor tokens, histogram buckets) and either **audit** them or **normalize** them before they reach your destination — Splunk, Prometheus, Datadog, Chronicle, Loki, Elastic, or object storage.

The pack ships in **audit mode (`DRY_RUN=true`)**: events flow through unchanged but get tagged with destination-visible `cr_*` fields describing what *would* change. You review the audit at your destination, whitelist what you query, then flip one variable to activate.

> **What is "cardinality"?** The number of distinct values a field takes. A `pod` label with 50,000 ephemeral hash suffixes is high-cardinality and expensive to index or store as time series; the same data with `pod` collapsed to its deployment name might be 50 values. This pack detects and collapses those fields without losing the queryable signal.

> **Compatibility — read first:** the pack's engine runs in Cribl **Code functions**, which are restricted on Cribl.Cloud-managed workers. This pack is for **self-managed Cribl Stream/Edge (4.0+) and hybrid worker groups** where custom code functions are permitted.

## Contents

- [Before / after — what reduction looks like](#before--after--what-reduction-looks-like)
- [5-minute quickstart](#5-minute-quickstart)
- [The audit → evaluate → activate workflow](#the-audit--evaluate--activate-workflow)
- [Pack variables (the 12 shipped settings)](#pack-variables-the-12-shipped-settings)
- [tools/recommend.js — whitelist advisor](#toolsrecommendjs--whitelist-advisor)
- [What gets detected](#what-gets-detected)
- [Emitted fields — the cr_* contract](#emitted-fields--the-cr_-contract)
- [Risk and routing semantics](#risk-and-routing-semantics)
- [Per-destination notes](#per-destination-notes)
- [Advanced variables appendix](#advanced-variables-appendix)
- [Limitations & compatibility](#limitations--compatibility)
- [Distributed deployment](#distributed-deployment)
- [Performance](#performance)
- [Troubleshooting](#troubleshooting)
- [License & support](#license--support)

---

## Before / after — what reduction looks like

**Input event** (typical K8s metric arriving at Cribl):
```json
{
  "_metric": "http_requests_total",
  "_value": 1523,
  "_time": 1711555200,
  "labels": {
    "job": "api-gateway",
    "instance": "10.0.1.45:8080",
    "pod": "api-deployment-7d8f9c6b5d-x4z2k",
    "container_id": "docker://3a8b2c4d1e5f6789abcdef0123456789",
    "trace_id": "550e8400-e29b-41d4-a716-446655440000",
    "method": "GET",
    "endpoint": "/api/v1/users/12345/orders/67890",
    "status": "200"
  }
}
```

**After pipeline (DRY_RUN — no shape change, just audit tags)**:
```json
{
  "_metric": "http_requests_total",
  "_value": 1523,
  "labels": { "job": "api-gateway", "instance": "10.0.1.45:8080",
              "pod": "api-deployment-7d8f9c6b5d-x4z2k", … },
  "cr_risk": "critical",
  "cr_route_tier": "cold",
  "cr_would_modify": "labels.pod,labels.container_id,labels.trace_id,labels.endpoint",
  "cr_categories": "container_hash,uuid,session_id"
}
```

**After pipeline (live mode — `DRY_RUN=false`)**:
```json
{
  "_metric": "http_requests_total",
  "_value": 1523,
  "labels": {
    "job": "api-gateway",
    "instance": "10.0.1.45:8080",
    "pod": "api-deployment",
    "container_id": "__CONTAINER_HASH__",
    "trace_id": "request_trace",
    "method": "GET",
    "endpoint": "/api/v1/users/{id}/orders/{id}",
    "status": "200"
  },
  "cr_risk": "medium",
  "cr_route_tier": "hot"
}
```

Four high-cardinality labels collapsed: `pod` lost its hash suffix, `container_id` became a placeholder, `trace_id` became its semantic group name, `endpoint` got its numeric segments templated. In a Prometheus TSDB that's the difference between ~50,000 active series and ~50.

---

## 5-minute quickstart

1. **Install** — Cribl UI → Processing → Packs → **Add Pack → Import from file** → upload the `.crbl` tarball. On a distributed deployment, do this on the **leader**.
2. **Attach** — open your route (Routing → Data Routes), and set the route's pipeline to the pack's `cardinality_reduction` pipeline (it appears under the pack's namespace), or reference it from a chain. Keep `DRY_RUN=true` — the default.
3. **Preview** — open the pipeline and capture a sample from live traffic, or use the bundled samples: the pack ships 10 sample files under `data/samples/` (1,420 events) that appear directly in the pipeline's Sample Data picker. Start with `log_events_mixed`.
4. **Look at the output** — every previewed event carries `cr_risk` / `cr_route_tier`, and events the pack would change carry `cr_would_modify`. Nothing in the event itself changes while `DRY_RUN=true`.
5. **Commit & Deploy** (distributed deployments) so worker groups pick it up.

Bundled samples:

| Sample | Events | What it exercises |
|---|---|---|
| `log_events_mixed` | 20 | **start here** — UUIDs, session/trace IDs, MAC addresses |
| `cardinality_test_data` | 20 | all risk tiers in one file |
| `histogram_samples` | 20 | Prometheus histogram bucket optimization |
| `k8s_prometheus_100` | 100 | raw Prometheus exposition lines (stage-0 parser) |
| `k8s_structured_100` | 100 | K8s events with pod hashes & container IDs |
| `kubernetes_events` | 20 | K8s audit/event objects (nested `metadata.uid` etc.) |
| `metric_name_samples` | 20 | StatsD/Datadog per-entity metric-name reduction |
| `mixed_enterprise_100` | 100 | mixed Splunk/CloudTrail/CEF/OTel shapes |
| `otel_metrics` | 20 | OTel metric family classification |
| `enterprise_1000` | 1000 | volume sample for representative audits |

---

## The audit → evaluate → activate workflow

The pack is built around one loop. Do not skip the audit.

**1. Audit (DRY_RUN=true, the default) — run for 1–7 days.**
Attach the pipeline and let real traffic flow. Events are tagged, never modified.

**2. Evaluate at your destination.** Search for the audit fields, e.g. in Splunk:
```
cr_risk!="none" | stats count by cr_categories
cr_would_modify!="none" | stats count by cr_would_modify
```
This tells you exactly which fields the pack would touch on *your* data.

**3. Run the whitelist advisor.** Export a representative sample of events (JSON array or NDJSON) and run:
```bash
node tools/recommend.js my_events.json
```
It runs your events through the real engine and proposes a `FIELD_WHITELIST=` line for business-entity fields (customer_id, order_id, email, …) that you must decide on. See [tools/recommend.js](#toolsrecommendjs--whitelist-advisor).

**4. Set the whitelist.** Cribl UI → Processing → Packs → cc-cardinality-reduction → **Variables** (under the pack's Settings/Knowledge). Edit `FIELD_WHITELIST` with every field you actively query or group by. Whitelisting matches leaf names and full dotted paths, case-insensitively.

**5. Activate.** Flip `DRY_RUN` to `false`, Save, Commit & Deploy.

**6. Verify.** Search the destination again: whitelisted fields appear in `cr_whitelisted` (with `VERBOSE_AUDIT_METADATA=true`), modified values now show placeholders/group names, and `cr_risk` distribution shifts down as high-cardinality fields collapse. If anything you need got collapsed, add it to `FIELD_WHITELIST` — originals are not recoverable from already-shipped events (see [Limitations](#limitations--compatibility)), so widen the whitelist before relying on a field.

---

## Pack variables (the 12 shipped settings)

These ship as real Cribl pack variables (`default/vars.yml`). Edit them in the Cribl UI: **Processing → Packs → cc-cardinality-reduction → Variables**. The engine reads them on every event — changes take effect on Save (+ Commit & Deploy in distributed mode).

| Variable | Type | Default | What it does |
|---|---|---|---|
| `DRY_RUN` | boolean | `true` | Audit mode — detect and tag without changing any event. Flip to `false` to activate live normalization. |
| `DESTINATION_TYPE` | string | `'splunk'` | `splunk` / `prometheus` / `datadog` / `chronicle` / `elastic` / `loki` / `object_storage` / `custom`. Aliases (mimir, cortex, dd, secops, elasticsearch, gcs, …) auto-map. Controls replace-vs-enrich behavior. |
| `MODE` | string | `'safe'` | Detection aggressiveness. `safe` = high-confidence patterns only. `aggressive` adds 8–15 char hex, bare IPv4/IPv6, IP:port instances. |
| `FIELD_WHITELIST` | string | `''` | Comma-separated field names the pack must NEVER touch. Leaf names or full dotted paths, case-insensitive. |
| `FIELDS_TO_DROP` | string | `''` | Comma-separated field names to drop entirely in live mode (e.g. `user_agent,referer,punct`). |
| `VERBOSE_AUDIT_METADATA` | boolean | `false` | Adds `cr_categories`, `cr_match_count`, `cr_fields_modified`, `cr_pack_version`, … to every event. Useful while evaluating; keep off in production. |
| `ENABLE_RAW_MODIFICATION` | boolean | `true` | Replace high-cardinality values inside `_raw` too (live mode). Without this, Splunk still indexes the originals from `_raw`. |
| `ENABLE_HISTOGRAM_OPTIMIZATION` | boolean | `true` | Drop non-SLO Prometheus histogram buckets in live mode. Keeps 11 SLO-aligned buckets (5/10/50/100/250/500 ms, 1/2.5/5/10 s, `+Inf`); `le` is matched numerically so OpenMetrics float forms (`1.0`, `5.0`) are kept. |
| `ENABLE_PII_DETECTION` | boolean | `false` | SSN, credit card, phone, IBAN, UK NI, DE national ID → `__SSN__`/`__CC__`/etc. Off by default — patterns can hit non-PII numerics. Audit first. |
| `DROP_SPLUNK_NOISE_FIELDS` | boolean | `false` | Drop `punct`, `linecount`, `eventtype` in live mode. |
| `ENABLE_AGGREGATION` | boolean | `false` | EXPERIMENTAL — aggregate high/critical-risk counters and gauges over `AGGREGATION_WINDOW`. Assumes Prometheus naming conventions. Test on a lower environment first. |
| `AGGREGATION_WINDOW` | string | `'60s'` | Tumbling window for experimental aggregation (`30s`, `60s`, `5m`). |

Boolean variables accept `true/1/yes/on` and `false/0/no/off` (case-insensitive, whitespace-tolerant). Unrecognized values fall back to the documented default — a typo can never silently enable a destructive flag.

The engine reads ~25 more variables that are not pre-registered — see the [Advanced variables appendix](#advanced-variables-appendix).

---

## tools/recommend.js — whitelist advisor

The hardest part of activation is deciding what to whitelist. `tools/recommend.js` automates the analysis: it extracts the pack's **real stage-1 engine** from the pipeline YAML, runs your sample events through it in audit mode, and reports per leaf field — occurrences, distinct-value count, detected category, and an example before → after.

```bash
# Against the bundled samples (default):
node tools/recommend.js

# Against your own exported events (.json array or NDJSON, files or directories):
node tools/recommend.js /path/to/exported_events.ndjson /path/to/more/

# Flags:
node tools/recommend.js --json events.json          # machine-readable output
node tools/recommend.js --whitelist a,b,c ...       # simulate a FIELD_WHITELIST
node tools/recommend.js --mode aggressive ...       # simulate MODE=aggressive
```

No npm dependencies — plain `node recommend.js` works anywhere Node ≥ 14 is installed. It never contacts Cribl; everything runs offline.

The report has three buckets:

- **NORMALIZE (safe)** — shape-detected machine noise (UUIDs, hashes, pod names, timestamps, tokens). Let the pack collapse these.
- **REVIEW** — business entity IDs (`customer_id`, `user_id`, `account_id`, `order_id`, `tenant_id`, `org_id`, `email`, `invoice_id`, `subscription_id`, and similar). The pack would collapse them, but only you know whether you query them. The report ends with a ready-to-paste `FIELD_WHITELIST=` line covering exactly these fields, plus an estimated reduction summary (distinct values collapsed / total distinct).
- **KEPT** — fields the engine would not touch.

The tool is stateless, like the pack itself — it sees value *shapes*, not your query workload. Before whitelisting (or deciding not to), review your destination's query/search logs (Splunk audit index, Grafana query history, etc.) to confirm which REVIEW fields are actually used.

---

## What gets detected

**By field name** (always treated as a high-cardinality identifier):

| Category | Field names |
|---|---|
| Tracing / correlation | `trace_id`, `span_id`, `request_id`, `req_id`, `session_id`, `correlation_id`, `transaction_id`, `txn_id`, `message_id`, `event_id`, `x_request_id`, `x_trace_id`, `job_id`, `task_id`, `run_id` |
| User / customer / account | `user_id`, `customer_id`, `account_id`, `tenant_id`, `org_id`, `organization_id`, `member_id`, `subscriber_id` |
| Order / payment / billing | `order_id`, `order_number`, `payment_id`, `charge_id`, `invoice_id`, `subscription_id`, `cart_id`, `checkout_id` |
| Device / auth / token | `device_id`, `auth_token`, `access_token`, `refresh_token`, `api_key`, `csrf_token`, `nonce`, `jti`, `guid` |
| Documents / messaging | `document_id`, `doc_id`, `thread_id`, `channel_id` |
| Container / image | `container_id`, `image_id`, `image_digest` |
| K8s ephemeral (dropped) | `pod_template_hash`, `controller_revision_hash`, `pod_ip`, `host_ip`, `uid` (metrics), `metrics_path` |
| K8s normalized | `pod`, `pod_name`, `replicaset`, `created_by_name` (hash suffix stripped) |
| URL paths | `url`, `path`, `uri`, `request_uri`, `endpoint`, `route` (numeric/UUID/hex segments → `{id}`/`{uuid}`/`{hex}`; query string dropped) |
| Sensitive (redacted live) | `password`, `secret`, `api_key`, `authorization`, `bearer_token`, `cookie`, `aws_secret_access_key`, … plus any name ending in `password`/`secret`/`_key`/`_token`/`_auth`/`credential(s)`. Legitimate `*_key` names (`sort_key`, `partition_key`, `routing_key`, `cache_key`, `foreign_key`, `primary_key`, `hash_key`, `range_key`, `shard_key`, `row_key`, `composite_key`, `idempotency_key`) are exempt. Extend via `EXTRA_SENSITIVE_FIELDS`. |

**By value pattern** (regardless of field name):

| Pattern | Example | Replaced with | Mode |
|---|---|---|---|
| UUID (canonical / bare 32-hex / embedded) | `550e8400-e29b-…` | `__UUID__` | safe |
| Email | `alice@example.com` | `__EMAIL__` | safe |
| JWT | `eyJhbGc…eyJzdWI…sig` | `__JWT__` | safe |
| MAC address | `00:1B:44:11:3A:B7` | `__MAC__` | safe |
| MongoDB ObjectId | `507f1f77bcf86cd799439011` | `__OID__` | safe |
| Stripe-style typed ID | `cus_NffrFeUfNV2Hib…` | `__STRIPE_ID__` | safe |
| AWS ARN | `arn:aws:iam::…` | `__ARN__` | safe |
| Vendor tokens (GitHub, GitLab, Slack, AWS keys, npm, GCP, Twilio, OpenAI, Anthropic, SendGrid, Okta, …) | `ghp_…`, `AKIA…`, `xoxb-…` | `__TOKEN__` | safe |
| Authorization header values | `Bearer eyJ…` | `__AUTH_HEADER__` | safe |
| URL with embedded credentials | `https://u:p@host/` | `https://__AUTH__@host/` | safe |
| ISO-8601 timestamp | `2026-04-25T14:00:00Z` | `2026-04-25` (date only) | safe |
| Unix epoch (in `*_time`/`*_at`/`*_ts` fields) | `1745596800` | `__TS__` | safe |
| Docker/SHA256 hash (64-hex), cgroup paths | `sha256:abc…` | `__CONTAINER_HASH__` | safe |
| Session-ID prefix | `sess_…`, `req_…`, `trace_…` | `__SESSION_ID__` | safe |
| Hex string ≥ 16 chars | `a3f5e8d9c1b2…` | `__HEX__` | safe |
| Hex string 8–15 chars | `abcd1234` | `__HEX__` | aggressive |
| IPv4 / IPv6 / IP:port instance | `10.0.1.45` | `__IP__` | aggressive |
| PII: SSN / CC / phone / IBAN / UK NI / DE NID | `123-45-6789` | `__SSN__` etc. | opt-in (`ENABLE_PII_DETECTION`) |
| Base64 blobs ≥ 64 chars | `QWxhZGRpbjpv…` | `__BASE64__` | opt-in (`ENABLE_BASE64_DETECTION`) |
| File paths with date/ID segments | `/logs/2026/04/25/x.log` | `/logs/{date}/x.log` | opt-in (`ENABLE_FILE_PATH_TEMPLATING`) |
| Stack-trace frame truncation | Java/Python/Node frames | top N frames kept | opt-in (`ENABLE_STACK_TRACE_TRUNCATION`) |

Fields named in `FIELD_GROUPS` (inline in the pipeline YAML) get **semantic** replacements instead of placeholders: `customer_id → customer_entity`, `trace_id → request_trace`, `order_id → order_ref`, etc. Custom patterns go in the inline `CUSTOM` array (`ENABLE_CUSTOM_RULES=true`) — Cribl's code-function sandbox forbids file reads, so both are edited directly in `default/pipelines/cardinality_reduction/conf.yml`.

**Matching is first-match-wins**: pass 1 (field names) runs before pass 2 (value patterns), and within pass 2 patterns are ordered most-specific-first. A field matched by one rule is not re-examined by later rules.

**Other layers:** stage-0 auto-parser (JSON or Prometheus exposition `_raw` → structured fields; strict line-shape gate, never overwrites an existing `_time`, preserves `+Inf`/`NaN`), histogram bucket dropping, null/sentinel field removal, JSON compaction, Splunk noise-field dropping, and experimental counter/gauge aggregation.

---

## Emitted fields — the cr_* contract

All operator-facing fields use the `cr_` prefix (no leading underscores) so they survive to your destination — Cribl strips `__`-prefixed internal fields before delivery. Internal plumbing (`__cr_requires_aggregation`, `__cr_metric_type`, `__keep_bucket`) keeps the `__` prefix and never leaves Cribl.

| Field | When | Meaning |
|---|---|---|
| `cr_risk` | always* | `none` / `medium` / `high` / `critical` |
| `cr_route_tier` | always* | `hot` / `warm` / `cold` |
| `cr_would_modify` | DRY_RUN | comma list of fields the pack would normalize (or `none`) |
| `cr_would_drop` | DRY_RUN | fields the pack would drop |
| `cr_would_normalize_metric` | DRY_RUN | metric-name rewrite preview (`old → new`) |
| `cr_match_count` | DRY_RUN or verbose | matched-pattern count on the event |
| `cr_categories` | DRY_RUN or verbose | comma list of matched categories |
| `cr_fields_modified` | DRY_RUN or verbose | modified-field list (live equivalent of `cr_would_modify`) |
| `cr_whitelisted` | DRY_RUN or verbose | fields skipped because of `FIELD_WHITELIST` |
| `cr_pack_version`, `cr_dest_type`, `cr_raw_bytes_saved`, `cr_otel_family`, `cr_otel_type`, `cr_metric_group` | verbose only | version stamp, destination tag, `_raw` byte savings, OTel classification |
| `cr_orig_metric_name`, `cr_metric_entity` | live | original metric name + extracted entity after metric-name normalization — the only recovery path for the original name |
| `cr_orig_<label>`, `<field>_cr_group` | live, enrich mode | preserved original / added group value alongside the original |
| `cr_dest_type_unknown`, `cr_mode_unknown`, `cr_thresholds_inverted`, `cr_config_invalid`, `cr_walk_truncated` | config warnings | typo'd `DESTINATION_TYPE`/`MODE`, inverted thresholds, event exceeded walk caps (6 levels / 1000 leaves) |
| `cr_error`, `cr_error_stage`, `cr_error_type`, `cr_error_version`, `cr_error_stack` | on engine error | caught exception details (`cr_error_stack` requires `DEBUG_MODE=true`) |

\* `OMIT_NONE_TAGS=true` suppresses `cr_risk`/`cr_route_tier` on `none`/`medium` events to save bytes — only set it if no downstream query expects the field to always exist.

---

## Risk and routing semantics

**Be clear about what risk is:** `cr_risk` is a **heuristic**, not a measurement. The engine does not count actual distinct series at your destination (it's stateless — see [Limitations](#limitations--compatibility)). Each detection category carries a hardcoded indicative weight (e.g. session IDs weigh more than K8s pod hashes), and the event's risk is the **largest weight among matched categories** compared against `HIGH_CARDINALITY_THRESHOLD` / `CRITICAL_CARDINALITY_THRESHOLD`. Those two advanced variables only shift where the boundary falls between category weights (in practice: which categories — e.g. plain hex vs. metric-name matches — land in `high` vs `critical`); they do not make the engine measure anything.

Use risk as a *routing signal*, not a series-count fact:

| Risk | `cr_route_tier` |
|---|---|
| `none`, `medium` | `hot` |
| `high` | `warm` |
| `critical` | `cold` |

```
Route 1 (Hot):  cr_route_tier=='hot'   → primary destination (full fidelity)
Route 2 (Warm): cr_route_tier=='warm'  → reduced-retention destination
Route 3 (Cold): cr_route_tier=='cold'  → archive (S3/GCS/Azure Blob)
```

---

## Per-destination notes

| Destination | Recognized aliases | Default normalization | Notes |
|---|---|---|---|
| `splunk` | splunk_hec, splunk_indexer | `replace` | Keep `ENABLE_RAW_MODIFICATION=true` so `_raw` indexing reflects normalized values — otherwise Splunk indexes the originals out of `_raw` anyway |
| `prometheus` | mimir, cortex, thanos | always `replace` | Label cardinality is the cost driver; consider `ENABLE_AGGREGATION` (experimental) for high-cardinality counters |
| `datadog` | dd | always `replace` | Datadog tags cap at 200 chars per key:value |
| `chronicle` | google_chronicle, secops | enrich UUIDs/sessions | Preserves trace fields alongside group values so analysts can still pivot |
| `elastic` | elasticsearch, opensearch | enrich UUIDs/sessions | Elastic <8.0 rejects dots in field names; the pack does not rewrite them |
| `loki` | grafana_loki | enrich UUIDs/sessions | Loki rejects empty label values; `ENABLE_NULL_FIELD_REMOVAL` (default on) helps |
| `object_storage` | s3, gcs, azure_blob | aggressive `replace` | Archival — no need to preserve originals |
| `custom` | (anything unrecognized) | `enrich` | Conservative default |

Unrecognized values are tagged on every event as `cr_dest_type_unknown` so typos are visible in your destination searches. Changing `DESTINATION_TYPE` takes effect on Save (+ Commit & Deploy) — the engine reads it per event.

---

## Advanced variables appendix

Beyond the 12 shipped variables, the engine reads the following from `C.vars`. They are **not pre-registered** in `default/vars.yml` — to set one, add it yourself as a pack variable (Cribl UI → Packs → cc-cardinality-reduction → Variables → Add Variable, same place as the shipped ones). Unset means the default below.

| Variable | Default | Effect |
|---|---|---|
| `ENABLE_UUID_DETECTION` | `true` | UUID patterns (canonical, bare 32-hex, embedded) |
| `ENABLE_SESSION_ID_DETECTION` | `true` | known-ID field names, session prefixes, email/JWT/MAC/Mongo/Stripe/vendor tokens |
| `ENABLE_HEX_DETECTION` | `true` | 16+ char hex (8–15 in aggressive mode) |
| `ENABLE_CONTAINER_HASH_REDUCTION` | `true` | container/image hashes, K8s pod/RS names, K8s ephemeral drops |
| `ENABLE_OTEL_NORMALIZATION` | `true` | OTel family/type classification (emitted under verbose only) |
| `ENABLE_METRIC_NAME_NORMALIZATION` | `true` | per-entity metric-name reduction (`api.customer_abc123.requests` → `api.requests`) |
| `ENABLE_NULL_FIELD_REMOVAL` | `true` | live: remove `null`/`''`/`'N/A'`/`'-'`/`'undefined'` fields |
| `ENABLE_JSON_COMPACTION` | `false` | live: strip whitespace from pretty-printed JSON `_raw` |
| `ENABLE_STACK_TRACE_TRUNCATION` | `false` | live: keep top N stack frames in `_raw` |
| `STACK_TRACE_KEEP_FRAMES` | `5` | frames kept when truncation is on (0–100) |
| `ENABLE_BASE64_DETECTION` | `false` | base64 blobs ≥ 64 chars → `__BASE64__` |
| `ENABLE_FILE_PATH_TEMPLATING` | `false` | date/ID segments in `*_path`/`*_file` fields → `{date}`/`{id}` |
| `ENABLE_CUSTOM_RULES` | `false` | activate the inline `CUSTOM` rules array |
| `EXTRA_SENSITIVE_FIELDS` | `''` | comma-separated extra field names to redact |
| `NORMALIZATION_DEFAULT` | `'replace'` | `replace` or `enrich` for destinations that don't force a mode |
| `METRIC_NAMING_STYLE` | `'auto'` | `prometheus` / `statsd` / `datadog` / `otel` / `auto` / `none` — counter/gauge classification for aggregation |
| `HIGH_CARDINALITY_THRESHOLD` | `10000` | heuristic boundary for `high` risk (see [Risk semantics](#risk-and-routing-semantics)) |
| `CRITICAL_CARDINALITY_THRESHOLD` | `100000` | heuristic boundary for `critical` risk; must be > HIGH or every event is tagged `cr_config_invalid` |
| `UUID_REPLACEMENT` | `'__UUID__'` | placeholder override |
| `SESSION_ID_REPLACEMENT` | `'__SESSION_ID__'` | placeholder override |
| `HEX_REPLACEMENT` | `'__HEX__'` | placeholder override |
| `CONTAINER_HASH_REPLACEMENT` | `'__CONTAINER_HASH__'` | placeholder override |
| `OMIT_NONE_TAGS` | `false` | suppress `cr_risk`/`cr_route_tier` on none/medium events |
| `DEBUG_MODE` | `false` | include `cr_error_stack` (first 4 frames) on engine errors |
| `METRICS_SAMPLE_RATE` | `0.1` | **no effect in current Cribl** — gates calls to a `C.Metric` hook that Cribl Stream does not provide. The calls are guarded no-ops; the variable is kept for forward compatibility. |

---

## Limitations & compatibility

- **Self-managed / hybrid only.** The engine is implemented as Cribl Code functions, which are restricted on Cribl.Cloud-managed worker groups. Use Cribl Stream or Edge 4.0+ self-managed, or hybrid worker groups where Code functions are allowed.
- **Heuristic risk, not measurement.** `cr_risk` reflects category weights, not observed series counts (see [Risk semantics](#risk-and-routing-semantics)).
- **Stateless — no true usage-awareness.** The pack processes one event at a time. It cannot know which fields your team actually queries, and it keeps no cross-event state (no real distinct-value counting at runtime). **Review your destination's query/search logs before whitelisting decisions** — `tools/recommend.js` proposes candidates, your query logs confirm them.
- **First-match-wins ordering.** A value matched by an earlier pattern is not examined by later ones; in rare overlap cases the category attribution follows pattern order, not your intuition.
- **`replace` is irreversible.** Once live with `NORMALIZATION_DEFAULT=replace`, original values are gone from shipped events. Use `enrich` (or the enrich-by-default search-tier destinations) where you need recoverability, and audit before activating.
- **PII detection is pattern-based, off by default.** No Luhn validation; can hit non-PII numerics. Audit before enabling, and use a dedicated PCI-grade redactor if compliance requires one.
- **Walk caps**: 6 nesting levels, 1,000 leaf fields, 8 KB per value. Deeper/wider events are partially scanned and tagged `cr_walk_truncated`.
- **Aggregation is experimental** and assumes Prometheus naming conventions; StatsD/Datadog counters without recognizable suffixes get gauge math (avg/min/max), which is wrong for counters. Set `METRIC_NAMING_STYLE` or leave aggregation off.

---

## Distributed deployment

1. Install / upgrade the pack tarball on the **leader** (Packs → Add/Update).
2. Set pack variables on the leader (Variables UI).
3. **Commit & Deploy** — worker groups receive the pack and config.
4. Verify on a worker group: capture live data into the pipeline preview and check for `cr_risk` tags, or search the destination for events with `cr_*` fields.

Pack upgrades preserve operator-set variables; pack-shipped defaults update automatically. After upgrading across a major version, run `tools/upgrade_check.sh` to flag deprecated variables, and re-check dashboards/saved searches against the [emitted-field contract](#emitted-fields--the-cr_-contract) — v4.0.0 renamed all operator-facing fields from `__cr_*` to `cr_*`.

---

## Performance

Engine microbenchmarks (single Node V8 thread, Apple M-series, audit mode, no Cribl runtime overhead) measure **~3–17 µs per event** for typical shapes — structured log events around 3 µs, metric events with ~6 labels around 14 µs, 3-level nested JSON around 17 µs — rising to ~90 µs for pathological 50-label events. Design choices behind that: O(1) field-name hash lookups, length gates before every regex, anchored patterns (no catastrophic backtracking), capped recursion.

Treat these strictly as Node-bench numbers for the engine code in isolation. **Real Cribl throughput depends on your worker CPU, event mix, and everything else in the pipeline** — benchmark in your own environment before capacity planning.

---

## Troubleshooting

**First stop:** two diagnostic scripts ship in `tools/`:

```bash
# Health check after install — pack present, pipeline loads, smoke test:
$CRIBL_HOME/default/cc-cardinality-reduction/tools/post_install_check.sh

# Bundle pack/Cribl/pipeline/error info into a support-ticket report:
$CRIBL_HOME/default/cc-cardinality-reduction/tools/doctor.sh
```

`doctor.sh` prints a clear `AUTH FAIL` and exits non-zero when Cribl is unreachable. `tools/wizard.sh` interactively suggests variable values based on destination and rollout stage, and `tools/upgrade_check.sh` flags deprecated variables after upgrades.

**Common issues:**

- **A field I query got collapsed.** Add it to `FIELD_WHITELIST` (leaf name or dotted path, case-insensitive). It will show up in `cr_whitelisted` and pass through untouched. Already-shipped events are not recoverable under `replace`.
- **My ingest bytes went up after install.** `VERBOSE_AUDIT_METADATA=true` adds several `cr_*` fields per event — useful while evaluating, expensive at volume. Set it back to `false`. `DRY_RUN=true` also adds `cr_would_modify` to every event by design.
- **No `cr_*` fields on real traffic but preview works.** You are probably looking at destination events that arrived before the pipeline was attached to the route. Confirm with `cribl_pipe="cardinality_reduction"` on recent events, and on distributed deployments confirm you ran Commit & Deploy.
- **Every event carries `cr_config_invalid` / `cr_dest_type_unknown` / `cr_mode_unknown`.** A pack variable has a typo or inverted thresholds. The engine deliberately does not auto-correct — fix the variable.
- **Counter metrics look wrong after enabling aggregation.** Classification is suffix-based; counters that don't end in `_total` (Prometheus) or a recognized StatsD/Datadog suffix get gauge math. Set `METRIC_NAMING_STYLE` or disable aggregation.
- **I see `cr_error` on events.** The engine caught an exception and let the event pass through. Set `DEBUG_MODE=true` to also get `cr_error_stack`, fix/report, then turn it back off.
- **Histogram buckets disappearing that I expected to keep.** Only the 11 SLO-aligned `le` values (plus `+Inf`) survive when `ENABLE_HISTOGRAM_OPTIMIZATION=true` and `DRY_RUN=false`. The keep-set is inline in the pipeline YAML (stage-2 eval); `data/lookups/histogram_buckets.csv` is a human-readable reference, not runtime config.

---

## License & support

- License: [Apache License 2.0](LICENSE)
- Issues / PRs: https://github.com/DataDay-Technology-Solutions/cribl-apps-public/issues — attach `tools/doctor.sh` output, your pack version, and Cribl version. For new detection patterns, include a sample event proving the match.
- Author: DataDay Technology Solutions
- Version history: [CHANGELOG.md](CHANGELOG.md) · upgrade notes: [UPGRADING.md](UPGRADING.md)
