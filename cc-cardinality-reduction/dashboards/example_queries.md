# Cardinality Reduction Pack — Example Queries (v4.0.0)

Copy-paste queries for inspecting the pack's `cr_*` audit fields at your
destination, plus how to see them inside Cribl itself.

> **Why this file replaced the Grafana dashboard JSON:** the previous
> `grafana_dashboard.json` had no datasources, targets, or grid layout — it was
> not actually importable. Rather than ship a fake dashboard, this is an honest
> query collection you can paste into whatever tool you use.

## What is visible where (read this first)

The `cr_*` audit fields are **event fields**, written into the events that
arrive at your destination. They are **not metrics** — there is no
`cr_events_processed` metric, no `mstats`, no Prometheus counter emitted by
this pack. Query them like any other event field.

| Fields | Visible at the destination when |
|---|---|
| `cr_risk`, `cr_route_tier` | **Always** (unless `OMIT_NONE_TAGS` suppresses none-risk tags) |
| `cr_would_modify`, `cr_would_drop`, `cr_would_normalize_metric` | `DRY_RUN=true` only |
| `cr_match_count`, `cr_categories`, `cr_fields_modified`, `cr_whitelisted` | `DRY_RUN=true` **or** `VERBOSE_AUDIT_METADATA=true` |
| `cr_pack_version`, `cr_dest_type`, `cr_raw_bytes_saved`, `cr_otel_family`, `cr_otel_type`, `cr_metric_group` | `VERBOSE_AUDIT_METADATA=true` only |
| `cr_orig_metric_name`, `cr_metric_entity`, `cr_orig_<label>`, `<field>_cr_group`, `labels.cr_server` | Live normalization (`DRY_RUN=false`), when the relevant rewrite happens |
| `cr_config_invalid`, `cr_dest_type_unknown`, `cr_mode_unknown`, `cr_thresholds_inverted`, `cr_walk_truncated` | Whenever the config problem occurs |
| `cr_error`, `cr_error_stage`, `cr_error_type`, `cr_error_version`, `cr_error_stack` | Whenever the engine catches an exception |

**If a query returns nothing**, check `DRY_RUN` / `VERBOSE_AUDIT_METADATA`
before debugging anything else — most audit fields are intentionally absent in
quiet production mode.

**`cr_risk` semantics:** risk tiers come from heuristic category weights
(session/email/jwt/ip-class patterns weigh heaviest; uuid/mac/hex/timestamps
next; container/url lower). They are *not* measured series counts — treat all
"savings" numbers below as directional estimates.

---

## Splunk (SPL)

These mirror `dashboards/splunk_savedsearches.conf` — see that file for the
install-ready saved-search versions. Adjust `index=*` to your environment.

**Risk distribution (always available):**

```spl
index=* cr_risk=* earliest=-24h
| stats count by cr_risk
| sort -count
```

**Route-tier distribution (always available):**

```spl
index=* cr_route_tier=* earliest=-24h
| stats count by cr_route_tier
```

**Top fields the pack would normalize (requires DRY_RUN):**

```spl
index=* cr_would_modify=* cr_would_modify!="none" earliest=-24h
| makemv delim="," cr_would_modify
| mvexpand cr_would_modify
| stats count by cr_would_modify
| sort -count | head 20
```

**Category breakdown (requires DRY_RUN or VERBOSE_AUDIT_METADATA):**

```spl
index=* cr_categories=* cr_categories!="none" earliest=-24h
| makemv delim="," cr_categories
| mvexpand cr_categories
| stats count by cr_categories
| sort -count
```

**Engine errors:**

```spl
index=* cr_error=* earliest=-24h
| stats count by cr_error_stage, cr_error_type, cr_error
```

**Config warnings:**

```spl
index=* (cr_config_invalid=* OR cr_dest_type_unknown=* OR cr_mode_unknown=* OR cr_thresholds_inverted=*) earliest=-24h
| stats count by cr_config_invalid, cr_dest_type_unknown, cr_mode_unknown, cr_thresholds_inverted
```

**Bytes saved by raw rewriting (requires VERBOSE_AUDIT_METADATA):**

```spl
index=* cr_raw_bytes_saved=* earliest=-24h
| stats sum(cr_raw_bytes_saved) as total_bytes_saved, avg(cr_raw_bytes_saved) as avg_per_event
```

---

## Elasticsearch / Kibana

### KQL (Discover / dashboard filters)

```text
cr_risk : *                                   # any audited event
cr_risk : "critical"                          # critical tier only
cr_would_modify : * and not cr_would_modify : "none"   # DRY_RUN flagged events
cr_error : *                                  # engine errors
cr_config_invalid : * or cr_dest_type_unknown : * or cr_mode_unknown : *
cr_whitelisted : *                            # whitelist hits
```

### ES|QL (Kibana ≥ 8.11, Discover → "Try ES|QL")

Replace `logs-*` with your index pattern.

**Risk distribution:**

```esql
FROM logs-*
| WHERE cr_risk IS NOT NULL
| STATS events = COUNT() BY cr_risk
| SORT events DESC
```

**Category breakdown (splits the comma-joined `cr_categories`):**

```esql
FROM logs-*
| WHERE cr_categories IS NOT NULL AND cr_categories != "none"
| EVAL category = SPLIT(cr_categories, ",")
| MV_EXPAND category
| STATS events = COUNT() BY category
| SORT events DESC
```

**Top would-modify field paths (requires DRY_RUN):**

```esql
FROM logs-*
| WHERE cr_would_modify IS NOT NULL AND cr_would_modify != "none"
| EVAL field_path = SPLIT(cr_would_modify, ",")
| MV_EXPAND field_path
| STATS events = COUNT() BY field_path
| SORT events DESC
| LIMIT 20
```

**Engine errors:**

```esql
FROM logs-*
| WHERE cr_error IS NOT NULL
| STATS events = COUNT() BY cr_error_stage, cr_error_type
| SORT events DESC
```

> Note: if your index template maps `cr_*` as `text`, aggregations need the
> `.keyword` subfield (e.g. `cr_risk.keyword`) in classic aggs/Lens; ES|QL
> handles keyword resolution automatically in recent versions.

---

## Grafana Loki (LogQL)

These assume your events land in Loki as JSON lines so `| json` can extract
`cr_*` fields. Adjust the stream selector (`{job="cribl"}`) to your labels.

**Risk distribution over the last 24h:**

```logql
sum by (cr_risk) (
  count_over_time({job="cribl"} | json | cr_risk != `` [24h])
)
```

**Critical-risk event rate (panel-friendly):**

```logql
sum (rate({job="cribl"} | json | cr_risk = `critical` [5m]))
```

**DRY_RUN flagged events (would be modified in live mode):**

```logql
{job="cribl"} | json | cr_would_modify != `` | cr_would_modify != `none`
```

**Engine errors, grouped by stage:**

```logql
sum by (cr_error_stage) (
  count_over_time({job="cribl"} | json | cr_error != `` [24h])
)
```

**Config warnings:**

```logql
{job="cribl"} | json
  | cr_config_invalid != `` or cr_dest_type_unknown != `` or cr_mode_unknown != ``
```

> LogQL has no comma-split/mv_expand equivalent, so per-category breakdowns of
> `cr_categories` are approximate at best — use a regexp line filter per
> category instead, e.g. `| cr_categories =~ `.*uuid.*``.

---

## Inside Cribl (Data Preview / sample capture)

You don't need a destination to verify the pack — the fields are visible in
Cribl itself, *including* the `__`-prefixed internal plumbing fields that get
stripped before reaching destinations (this is exactly why v4.0.0 renamed the
operator-facing fields from `__cr_*` to `cr_*`).

**Data Preview (the fastest check):**

1. Cribl UI → **Processing → Packs → cc-cardinality-reduction → Pipelines →
   `cardinality_reduction`**.
2. In the right-hand preview pane, choose a **Sample Data** file (the pack
   bundles samples under `data/samples/`, e.g. `log_events_mixed.json`) and
   click **Run**.
3. Switch to the **OUT** tab. Every event should show `cr_risk` and
   `cr_route_tier`; with the pack's default `DRY_RUN=true` you'll also see
   `cr_would_modify`, `cr_match_count`, `cr_categories`, etc.
4. Internal `__`-prefixed fields are also visible here (toggle **Show
   Internal Fields** in the preview settings). Remember: anything starting
   with `__` is preview-only plumbing — it will NOT reach your destination.

**Live capture (verifying real traffic):**

1. Worker Group → **Data → Sources** (or use **Sample/Capture** from the
   pipeline view) → **Capture**.
2. Set the capture point to *after* the pipeline/route that runs the pack
   ("Before the Destination" works well).
3. Filter expression to grab only audited events, e.g.:

   ```js
   cr_risk !== undefined
   ```

   or to catch problems specifically:

   ```js
   cr_error !== undefined || cr_config_invalid !== undefined
   ```

4. Captured events show the full field set; save interesting captures as
   sample files for regression-testing pack settings.

**Quick functional checklist in preview:**

| Expectation | Field to look at |
|---|---|
| Every event tagged | `cr_risk`, `cr_route_tier` present on OUT |
| DRY_RUN audit working | `cr_would_modify` lists field paths (or `none`) |
| Metric renames planned | `cr_would_normalize_metric` shows `old → new` |
| Whitelist respected | `cr_whitelisted` lists your protected fields |
| No engine faults | `cr_error` absent everywhere |
| Variables sane | `cr_config_invalid` / `cr_dest_type_unknown` / `cr_mode_unknown` absent |
