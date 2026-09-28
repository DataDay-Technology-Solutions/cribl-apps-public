# Throughput metrics: what the shipped Cribl apps actually do

Research for Meter Reader. Scope: every use of `/system/metrics/query`, `/system/metrics`,
`/w/:wid/system/metrics`, `metrics/query` across the reference clones, plus the OpenAPI specs.

- **Reference root:** `scratchpad/ref/` (16 repos). Citations are `repo/path:line`, relative to that root.
- **Our scaffold's guide:** `AGENTS.md` in this project (it outranks everything here).
- **Evidence rule:** anything not read directly from code, docs or captured data is marked **INFERRED**.
  "Confirmed live" means the *comment in the reference code* says so. I did not run anything against an org.
- **Method:** `grep -rn` over all repos (excluding `node_modules`, `dist`, `.git`), then full reads of every
  file that builds or parses a metrics request. The only places `/system/metrics*` is called from code are
  `cc-visicore-criblvision` and `cc-di-data-flow-monitor`. `cc-cribl-executive-dashboard` used it once and
  then moved to Cribl Search (it still carries the types and a mock of it). No other repo calls it.
  None of the 16 repos calls it from a **backend** function: every call is from the browser iframe through the fetch proxy.

---

## 0. The ten facts that matter most for Meter Reader

1. **`POST /system/metrics/query` is in the full product OpenAPI that ships with the app scaffold, and it's marked public.**
   `operationId: createSystemMetricsQuery`, `x-cribl-internal: false`, `x-cribl-availability: both`, in every bundled
   spec (4.18.2, 4.19.0-0fbd6d34 and 4.19.0-prod-hourly; see section 3). It is **not** in the Control Plane SDK's spec
   (`cribl-control-plane-sdk-typescript/.speakeasy/out.openapi.yaml`, 77 paths, no `metrics` path), even though that spec
   is the *same build* (4.19.0-0fbd6d34) as the data-flow-monitor bundle that does contain it. The SPEC's "undocumented"
   premise (SPEC line 106, PRD 2.6b) only holds for the SDK.
2. **Two shipped apps grant it with the exact object `'/system/metrics/query'` and `actions: ['POST']`**
   (`cc-visicore-criblvision/config/policies.yml:20-21`, `cc-di-data-flow-monitor/config/policies.yml:31-32`).
   Neither object carries an `/api/v1` prefix. SPEC line 106 writes `path: /api/v1/system/metrics/query`, which is not the policies.yml format.
3. **The endpoint is Leader-level and unprefixed.** `/m/:gid/system/metrics/*` returns 404 (confirmed live per
   `cc-di-data-flow-monitor/config/policies.yml:29-30`; the exec-dashboard mock reproduces the 404 body at
   `cc-cribl-executive-dashboard/dev/mock-api.js:299-306`). You scope to a group with a `where` on `__worker_group`.
4. **Response: `{ results: Row[] }`.** A bucketed row has `starttime` and `endtime` (epoch **seconds**), with **no `_time`**
   (`cc-di-data-flow-monitor/src/api/metrics.ts:22-27`). Split-by dimensions and `.as()` aliases come back as sibling keys.
   An aggregation with no data is **omitted** from the row, not returned as 0
   (`cc-di-data-flow-monitor/src/api/metrics.ts:148-153`, and visible in the captured fixture).
5. **Split queries also return rollup rows.** A row that lacks one of the split dimensions is a rollup, and its value
   **duplicates the sum of the fully split rows**. Two sources show this:
   - two-dimension splits, confirmed live (`cc-di-data-flow-monitor/src/api/workerMetrics.ts:39-51`, `.../api/licenses.ts:183-187`);
   - a single-dimension `input` or `output` split, verifiable in criblvision's captured fixture (section 5.3).

   **Keep only rows where every split key is a string.** Summing all rows double-counts.
6. **Metric names in use.** For bytes: `total.in_bytes`, split by `input`; `total.out_bytes`, split by `output`; and
   `route.in_bytes` / `route.out_bytes`, split by `route` (the route rule id) and `name`.
   **Pipelines have no byte counters.** `pipe.in_events`, `pipe.out_events`, `pipe.dropped_events` and `pipe.err_events`
   exist, split by `id`
   (`cc-di-data-flow-monitor/src/lib/topology.ts:1227-1235`, `cc-visicore-criblvision/src/api/client.ts:1040-1045`).
   The SPEC's "pipeline bytes" fallback branch (SPEC lines 269, 537) has no series to read.
7. **`route.*` is counted per rule, before FINAL cascading, and disabled rules report too** (confirmed live:
   `cc-di-data-flow-monitor/src/lib/topology.ts:876-889`, `:960-962`). Summing `route.in_bytes` across rules
   over-counts whenever filters overlap. data-flow-monitor applies its own final-rule cascade to fix this.
8. **Aggregation across worker processes and nodes happens server-side.** Both apps use `sum("metric")` with no
   process or node split. `cribl_wp` is **not** a usable dimension on the aggregate endpoint (confirmed live:
   `cc-visicore-criblvision/src/api/client.ts:412-419`). For a per-node breakdown, split by
   `__worker_node_hostname`. That works for Stream Worker Groups but not for Edge Fleets
   (`cc-di-data-flow-monitor/src/api/workerMetrics.ts:13-19`).
9. **Retention is short, and resolution drops with age.**
   - The exec dashboard abandoned the endpoint because of a "~2-day horizon"
     (`cc-cribl-executive-dashboard/src/api/metrics.ts:12-14`, `.../src/api/search.ts:4-7`).
   - criblvision's live-captured fixture shows 300 s buckets for data under about 2.6 h old, and one row per **600 s**
     for older data. Those older rows still claim `endtime - starttime = 300` (section 9, **INFERRED** from the fixture).
   - So **don't derive rates from `endtime - starttime`**. Sums stay correct.
10. **The Search fallback exists and ships.**
   - `dataset="cribl_metrics" metric in ("total.in_bytes") | summarize bytes=sum(value) by _time=bin(_time, Ns), input, worker_group`
     (`cc-cribl-executive-dashboard/src/api/metrics.ts:67-75`).
   - In that dataset the group field is **`worker_group`**, not `__worker_group` (`.../metrics.ts:40-42`).
   - The dataset keeps about 30 days (`.../src/domain/time.ts:7-10`).
   - Search `earliest` and `latest` are **Unix seconds** (`.../src/api/metrics.ts:181-189`).

---

## 1. Inventory: every call site

| Endpoint | Repo | Where | Caller | Purpose |
|---|---|---|---|---|
| `POST /system/metrics/query` | cc-visicore-criblvision | `src/api/client.ts:167-180` (`runQuery`) | UI (browser, fetch proxy) | throughput, dropped, per-group, per-input, per-output, per-route, per-pipeline, PQ and backpressure |
| `POST /system/metrics/query` | cc-di-data-flow-monitor | `src/api/metrics.ts:29-31` (`queryMetrics`) | UI | per-input, per-output, per-route and per-pipeline totals; route×input attribution; trends; last-ingest times; per-worker volume, blocked and heartbeat; license per-source breakdown |
| `GET /w/:wid/system/metrics` | cc-visicore-criblvision | `src/api/client.ts:422-442`, `:712-732`, `:762-780` | UI | per-node CPU and memory, node throughput, per-worker-process rows (`?wp=N`) |
| `GET /w/:wid/system/metrics` | cc-di-data-flow-monitor | `src/api/workerInfo.ts:224-253` | UI (lazy, drawer only) | per-node trend: CPU, memory, disk, in/out events, `blocked.outputs` |
| `POST /system/metrics/query` | cc-cribl-executive-dashboard | **no longer called.** Types remain at `src/api/types.ts:98-125`; the mock is `dev/mock-api.js:308-323` | n/a | replaced by Cribl Search over `cribl_metrics` |
| `POST /system/metrics/enum` | cc-cribl-executive-dashboard | types `src/api/types.ts:127-134`; mock `dev/mock-api.js:325-339` | not called from `src/` | catalog of metric names and dimensions. The mock says `metricNameFilter` is treated as a regex (`mock-api.js:334`) |
| `POST /system/metrics/enum` | cc-di-data-flow-monitor | mentioned only: `src/api/metrics.ts:4`, `:147` ("this app's own `/system/metrics/enum` catalog scan") | not called from `src/` | n/a |

Search-based metric reads (the fallback, section 12): `cc-cribl-executive-dashboard/src/api/metrics.ts`,
`cc-visicore-lake-credit-usage/src/api.ts:235-236`, `cc-edge-tag-monitoring/src/lib/query.ts:39-53`.

---

## 2. policies.yml: exact spellings from shipped apps

```yaml
# cc-visicore-criblvision/config/policies.yml:19-39
  - object: '/system/metrics/query'
    actions: ['POST']
  ...
  - object: '/w/:wid/system/metrics'
    actions: ['GET']
  - object: '/m/:gid/system/metrics'
    actions: ['GET']
```

```yaml
# cc-di-data-flow-monitor/config/policies.yml:29-32, 65-71
  # api/metrics.ts — queryMetrics() (Leader-level; confirmed live that /m/:gid/system/metrics/*
  # 404s, group scoping happens via a __worker_group dimension in the query itself instead)
  - object: '/system/metrics/query'
    actions: ['POST']
  ...
  - object: '/w/:wid/system/metrics'
    actions: ['GET']
```

- For `/w/:wid/...` paths, `AGENTS.md:231` says to declare the matching `/m/:gid/...` path as well. criblvision does;
  data-flow-monitor does **not** (it declares only `/w/:wid/system/metrics`). Both apps shipped.
  data-flow-monitor wraps that call in try/catch and treats failure as "omit the chart" (`src/api/workerInfo.ts:126-131`, `:250-252`),
  so a silent authorization failure there would not show. **INFERRED.**
- `cc-cribl-executive-dashboard/config/policies.yml:38-45` declares **no** metrics path. It uses only
  `'/m/:gid/search/jobs'` `['POST']` and `'/m/:gid/search/jobs/*'` `['GET','POST']`.
- The exec dashboard README says the POST is a read: "`POST /system/metrics/query` and `/system/metrics/enum` are
  read-only queries despite the verb." (`cc-cribl-executive-dashboard/README.md:113`)
- The exec dashboard README also lists "a 404 on `system/metrics/query`" among bugs that "only appeared against a live Leader"
  (`cc-cribl-executive-dashboard/README.md:61-62`). Read together with the mock, that 404 was the group-prefixed path
  (`dev/mock-api.js:299-306`). **INFERRED.**

---

## 3. OpenAPI status

Parsed from the bundled `openapi.json` files: 8 repos across four build versions. All of them have `/system/metrics/query` with `x-cribl-internal: false`.

| Spec | Version | `/system/metrics/query` | `/system/metrics` (GET) | `/system/metrics/enum` | Other |
|---|---|---|---|---|---|
| `cc-cribl-executive-dashboard/openapi.json:199304` (same version in cc-cribl-power-tools) | `4.19.0-prod-hourly.20260724T1703-35af40fd` | `createSystemMetricsQuery`, internal **false**, availability **both** | `getSystemMetrics`, internal **true**, availability both | `createSystemMetricsEnum`, internal false | `/system/metrics/telemetry` (internal true); `/edge/metrics/query` (internal false, "Query and aggregate system metrics collected on the Edge host"); `/search/metrics/query` (internal true, cloud); `/insights/metrics/query` (internal false, cloud) |
| `cc-di-data-flow-monitor/openapi.json:199304` and `cc-gigamon-ami/openapi.json:199304` | `4.19.0-0fbd6d34`: **the same build id as the SDK spec below** | internal **false**, availability both | internal true | internal false | same set as above |
| `cc-visicore-criblvision/openapi.json:151676` (same version in lake-credit-usage and config-inspector; cc-synth `:142965` is `4.18.2-alpha.1779991482659-256b58c6`) | `4.18.2-fd1f0d2f` | same, internal false | internal true | internal false | `/insights/metrics/query` internal **true** in this version |
| Control Plane SDK `cribl-control-plane-sdk-typescript/.speakeasy/out.openapi.yaml` | `4.19.0-0fbd6d34` (line 20) | **absent** | absent | absent | 77 paths total; the only status paths are `/system/status/inputs|outputs` (`:81114`, `:81259`). Same build as the data-flow-monitor spec, which *does* contain the metrics paths, so the SDK spec is a **filtered subset** of the product spec. **INFERRED.** |

### 3.1 Request schema: `SystemMetricsQueryRequest` (4.19 spec)

```
aggs (required): allOf[
  { aggregations: string[] (required), splitBys?: string[] },
  oneOf[ { timeWindowSeconds: integer (required), cumulative?: boolean },
         { cumulative: boolean (required), timeWindowSeconds?: integer } ]
]
earliest?: string | integer   "relative time string (for example, -1h) or a timestamp in Unix time (milliseconds)"
latest?:   string | integer   "relative time string (for example, now) or a timestamp in Unix time (milliseconds)"
where?: string                "Filter expression applied to retrieved metrics."
namespace?: string            "The metrics store namespace. If omitted, uses the default metrics store."
alwaysBounds?: boolean        "response includes earliest and latest bounds in the results even when no data matched"
source?: 'linux' | 'windows'
```

The spec's own request example (`SystemMetricsQueryExamplescumulativeByInput`):

```json
{ "where": "input == 'syslog:in_syslog:udp'",
  "aggs": { "aggregations": ["min(_time).as(starttime)", "max(_time).as(endtime)", "max(\"health.inputs\").as(\"health\")"],
            "cumulative": true, "splitBys": ["input"] } }
```

A second example uses `"namespace": "full-fidelity"` with `splitBys: ["__dist_mode"]`.

### 3.2 Response schema

`CriblEventEnvelop { results: CriblEvent[] (required) }`. `CriblEvent` is `{ _raw: string (required), ...additionalProperties }`.
The spec's example:

```json
{ "results": [ { "_raw": "", "_time": 1714992000, "input": "syslog:in_syslog:udp",
                 "starttime": 1714988400, "endtime": 1714992000, "health": 1 } ] }
```

**INFERRED:** in that example, `starttime` and `endtime` are aliases the request computed itself (`min(_time).as(starttime)`),
not fields the engine always adds to cumulative rows.

### 3.3 `GET /system/metrics` (x-cribl-internal: true)

- **Query params:** `wp` (integer, "Worker Process index to query. Supported only on Worker Nodes."), `numBuckets`,
  `earliest`, `latest` (relative or Unix **ms**), `metricNameFilter` (regex or array), `filterExpr`, `namespace`.
- **Response:** `{ results: { exactMatch: boolean, metrics: MetricTimeBucket[] } }`, where
  `MetricTimeBucket = { [metricName]: Array<{ model: object, val: number }> }`.

### 3.4 `POST /system/metrics/enum` request

`SystemMetricsEnum { dimKeyFilter?, dimValueFilter?, earliest?: number (ms), filterExpr?, maxValues?, metricNameFilter?, namespace? }`.
Response: `{ count, items: [{ name, dims: [{ name, count, values: string[] }] }] }`.

---

## 4. Request bodies, call by call

### 4.1 criblvision: one transport, many queries

```ts
// cc-visicore-criblvision/src/api/client.ts:167-180
const body = {
  where: q.where,
  aggs: { aggregations: q.aggregations, timeWindowSeconds: q.timeWindowSeconds, ...(q.splitBys ? { splitBys: q.splitBys } : {}) },
  earliest: `${q.earliestSeconds}s`,   // e.g. "21600s" — a positive seconds string, no minus sign
  latest: Date.now(),                   // epoch MILLISECONDS
};
const res = await apiPost<{ results?: MetricRow[] }>('/system/metrics/query', body);
return res.results ?? [];
```

`timeWindowSeconds: -1` is used for "natural buckets" (`client.ts:158`). `cumulative` is never sent.

Scoping helpers:
- `whereForGroup('all')` and `whereForTop('all')` → `'((__dist_mode=="worker") || (__dist_mode=="managed-edge"))'` (`:163`, `:890`)
- one group → `` `(__worker_group=="${group}")` `` (`:164`, `:891`). **Not escaped**, unlike data-flow-monitor.

| Function | `where` | `aggregations` | `splitBys` | `timeWindowSeconds` |
|---|---|---|---|---|
| `getThroughputSeries` `:264-276` | `(has_no_dimensions) && <group>` | `IN_OUT_AGGS` = `sum("total.in_events").as("eventsIn")`, `sum("total.out_events").as("eventsOut")`, `sum("total.in_bytes").as("bytesIn")`, `sum("total.out_bytes").as("bytesOut")` (`:77-82`) | — | bucket |
| `getDroppedSeries` `:279-295` | `(has_no_dimensions) && (__dist_mode=="worker")`, or `... && (__worker_group=="g")` | `sum("total.dropped_events").as("dropped")` | — | bucket |
| `getGroupTotals` `:298-307` | `(has_no_dimensions)` | `IN_OUT_AGGS` | `['__worker_group']` | `-1` |
| `getOutEventsByOutput` `:347-360` | `whereForTop` | `sum("total.out_events").as("events")` | `['output']` | bucket |
| `getOutBytesByOutput` `:363-376` | `whereForTop` | `sum("total.out_bytes").as("bytes")` | `['output']` | bucket |
| `getInEventsByInput` `:381-394` | `whereForTop` | `sum("total.in_events").as("events")` | `['input']` | bucket |
| `getInBytesByInput` `:397-410` | `whereForTop` | `sum("total.in_bytes").as("bytes")` | `['input']` | bucket |
| `getPQStatsByDim` `:544-603` | `whereForTop` | `max("pq.queue_size").as("pqBytes")`, `` max("backpressure.${dim}s").as("bp") `` | `[dim, '__worker_group']` | bucket |
| `getPQSeriesByDim` `:650-664` | `whereForTop` | `max("pq.queue_size").as("pqBytes")` | `[dim, '__worker_group']` | bucket |
| `getRouteSeries` `:862-880` | `whereForTop` | `sum("route.in_events").as("eventsIn")`, `sum("route.in_bytes").as("bytesIn")`, `sum("route.out_events").as("eventsOut")`, `sum("route.out_bytes").as("bytesOut")` | `['route', 'name', '__worker_group']` | bucket |
| `getTopInputs` `:895-906` | `whereForTop` | `sum("total.in_bytes").as("bytes")`, `sum("total.in_events").as("events")` | `['input']` | `-1` |
| `getTopOutputs` `:909-920` | `whereForTop` | `sum("total.out_bytes").as("bytes")`, `sum("total.out_events").as("events")` | `['output']` | `-1` |
| `getTopRoutes` `:923-934` | `whereForTop` | `sum("route.in_bytes").as("bytes")`, `sum("route.in_events").as("events")` | `['name']` | `-1` |
| `getPipelineStats` `:986-1017` | `whereForTop` | `sum("pipe.in_events").as("evIn")`, `sum("pipe.out_events").as("evOut")`, `sum("pipe.dropped_events").as("evDrop")`, `sum("pipe.err_events").as("evErr")` | `['id', '__worker_group']` | `-1` |
| `getPipelineSeries` `:1046-1059` | `whereForTop` | `sum("pipe.in_events").as("eventsIn")`, `sum("pipe.out_events").as("eventsOut")` | `['id', '__worker_group']` | bucket |

Ranges and buckets come from `cc-visicore-criblvision/src/state/AppContext.tsx:21-24`:

| Range | `rangeSeconds` | `bucketSeconds` |
|---|---|---|
| 1h | 3600 | 60 |
| 6h | 21600 | 300 |
| 24h | 86400 | 900 |
| 7d | 604800 | 3600 |

### 4.2 data-flow-monitor: typed transport, cumulative totals and bucketed trends

```ts
// cc-di-data-flow-monitor/src/api/metrics.ts:8-20
interface MetricsQueryRequest {
  where?: string; earliest: string | number; latest: string | number;
  aggs: { aggregations: string[]; splitBys?: string[]; cumulative?: boolean; timeWindowSeconds?: number };
  namespace?: string; alwaysBounds?: boolean;
}
```

- **Time:** `earliest` and `latest` are **epoch ms** numbers, from `Date.now() - option.ms` and `Date.now()`
  (`src/hooks/useFlowGraph.ts:47-51`). Ranges are 15m, 1h, 4h, 12h and 24h only (`src/lib/types.ts:292-298`).
- **Scoping:** `` groupWhere(groupId, extra?) = `__worker_group == '${escapeFilterLiteral(groupId)}'` `` plus
  `` ` && (${extra})` `` (`src/api/metrics.ts:52-55`). Literals are escaped (`:45-47`).
- **Headers:** `Content-Type: application/json` (`src/api/client.ts:37-43`).

| Function (`src/api/metrics.ts` unless noted) | `where` | `aggregations` | `splitBys` | mode |
|---|---|---|---|---|
| `fetchEndpointVolumeTotals` `:77-108` | groupWhere | `` sum("total.in_${unit}").as("in") ``, `` sum("total.out_${unit}").as("out") ``, plus for outputs `sum("total.dropped_events").as("dropped")` | `['input']` or `['output']` | `cumulative: true` |
| `fetchRouteVolumeTotals` `:111-139` | groupWhere | `` sum("route.in_${unit}").as("in") ``, `` sum("route.out_${unit}").as("out") ``, `sum("route.dropped_events").as("dropped")` | `['route']` | cumulative |
| `fetchPipelineVolumeTotals` `:155-183` | groupWhere | `sum("pipe.in_events").as("in")`, `sum("pipe.out_events").as("out")`, `sum("pipe.dropped_events").as("dropped")`, `sum("pipe.err_events").as("err")` | `['id']` | cumulative |
| `fetchRouteSourceBreakdown` `:190-217` | groupWhere | `` sum("route.in_${unit}").as("v") `` | `['route', 'input']` | cumulative |
| `fetchTrend` `:242-267` | `groupWhere(g, dimFilter)` | `` sum("${metric}").as("v") `` | — | `cumulative: false`, `timeWindowSeconds = max(1, floor((latest-earliest)/1000/buckets))`, where buckets is 30 by default, 40 or 60 at call sites |
| `fetchLastIngestTimes` `:282-305` | groupWhere | `sum("total.in_events").as("v")` | `['input']` | `cumulative: false`, 48 buckets |
| `fetchWorkerHeartbeatLag` (`src/api/workerMetrics.ts:54-68`) | groupWhere | `avg("system.max_worker_process_heartbeat_lag").as("lag")` | `['__worker_node_hostname']` | cumulative |
| `fetchWorkerBlockedTotals` (`src/api/workerMetrics.ts:95-126`) | groupWhere | `sum("blocked.outputs").as("v")`; `sum("total.blocked_eps").as("v")` | `['output','__worker_node_hostname']`; `['input','__worker_node_hostname']` | cumulative |
| `fetchWorkerVolumeTotals` (`src/api/workerMetrics.ts:138-181`) | groupWhere | `` sum("total.in_${unit}").as("v") ``; `` sum("total.out_${unit}").as("v") `` | `['input','__worker_node_hostname']`; `['output','__worker_node_hostname']` | cumulative |
| `fetchSourceBreakdown` (`src/api/licenses.ts:210-249`) | **no `where`** (org-wide) | `sum("total.in_bytes").as("v")` | `['input', '__worker_group']` | `cumulative: false`, `timeWindowSeconds: 86400` (daily) or `3600` (hourly) |

`dimFilter` examples used with `fetchTrend`:
- `` route=='${ruleId}' `` (`src/components/NodeDetailPanel.tsx:96-103`)
- `` input=='${type}:${rawId}' `` (`:111-112`)
- `` (route == 'a' || route == 'b') && input == 'type:id' `` (`src/hooks/useFlowSummaryTrends.ts:61-64`)
- the `blocked.outputs` trend (`src/components/NodeDetailPanel.tsx:178`)

### 4.3 Filter-expression syntax seen

- **Equality:** both `==` with double quotes (`__worker_group=="g"`, criblvision) and `==` with single quotes
  (`__worker_group == 'g'`, data-flow-monitor and the OpenAPI example) are used in shipped apps.
- **Combining:** `&&` and `||` with parentheses.
- **Rollup series:** `has_no_dimensions` is a bare predicate that selects them (criblvision `:271`, `:287-288`, `:301`).
  With `has_no_dimensions`, a `splitBys: ['__worker_group']` still returns rows tagged with `__worker_group`
  (every one of the 580 `byGroup` fixture rows has it), so `__worker_group` is **not** counted as a "dimension" by that predicate. **INFERRED** from the fixture.
- **Distribution mode:** `__dist_mode` values seen are `"worker"` and `"managed-edge"` (criblvision `:163`).
- **Aggregation functions seen:** `sum("m")`, `max("m")`, `avg("m")`, `min(_time)`, each with `.as("alias")`.
  Aliases are quoted in app code; the spec example leaves some unquoted (`.as(starttime)`).

---

## 5. Response shape and parsing

### 5.1 Envelope

`{ results: Row[] }`. Both apps default a missing `results` to `[]`
(criblvision `client.ts:178-179`; data-flow-monitor types `results` as required, `metrics.ts:22-27`).
The exec-dashboard type: `MetricsQueryResponse = { results?: MetricsQueryEvent[] }`, where
`MetricsQueryEvent = { _time?: number; _raw?: string; [field: string]: unknown }` with "`_time` is Unix *seconds*"
(`cc-cribl-executive-dashboard/src/api/types.ts:98-111`).

### 5.2 Bucketed vs cumulative rows

- **Bucketed** (`timeWindowSeconds`, `cumulative: false`): `{ starttime, endtime, <splitDims...>, <aliases...> }`.
  "Bucketed (non-cumulative) queries — confirmed live — have **no `_time` field at all** … Using `_time` for a bucketed
  result silently produces NaN timestamps." (`cc-di-data-flow-monitor/src/api/metrics.ts:23-26`).
  criblvision types this as `MetricRow { starttime: number; endtime: number; [alias]: number|string|undefined }`
  (`cc-visicore-criblvision/src/api/types.ts:52-57`).
- **Cumulative** (`cumulative: true`): "Cumulative queries return one row with `_time`" (`metrics.ts:23`), one row per
  split value. data-flow-monitor reads only the aliases and split keys (`metrics.ts:97-107`).
- **Bucket time for charts:** data-flow-monitor uses `row.starttime ?? row._time` × 1000 (`metrics.ts:225-228`).
  criblvision uses `starttime * 1000` (`src/lib/metrics.ts:5-10`).

### 5.3 Sparse rows and rollup rows: captured-live evidence

criblvision's `public/fixtures.json` was captured from a live org. The file header says "falls back to captured fixtures"
(`src/api/client.ts:1-2`); `capturedAt` = 1783368904222. Here is one 600 s bucket (starttime 1783347000) from
`topSourcesDefault`, a split by `input`:

```
{eventsIn: 6644,   input: 'cribl:CriblLogs'}                          <- no bytesIn key at all
{eventsIn: 6644,   input: 'subscription:network_data'}                <- no bytesIn
{eventsIn: 6644,   input: 'subscription:network_data:Network-Team'}   <- 3-part key, no bytesIn
{bytesIn: 307458,  eventsIn: 1798,  input: 'datagen:infoblox-audit-log'}
{bytesIn: 24335212, eventsIn: 26438}                                  <- NO input key: rollup row
{bytesIn: 24027754, eventsIn: 17996, input: 'datagen:win-data-gen'}
{eventsIn: 121694, input: 'cribl:CriblMetrics'}                       <- no bytesIn
{bytesIn: 0, eventsIn: 0, input: 'syslog:in_syslog_tls'}             <- explicit zeros
{bytesIn: 0, eventsIn: 0, input: 'syslog:in_syslog_tls:tcp'}         <- 3-part protocol variant
... tcpjson:in_tcp_json, tcp:in_tcp, cribl_http:home-assistant-in_cribl_http (all 0)
```

What this shows. Items marked **INFERRED** come from arithmetic on the fixture.
- **The row without `input` is the group rollup.**
  - Its `bytesIn` (24,335,212) equals 307,458 + 24,027,754, the sum of the per-input byte rows. That holds for every bucket checked.
  - For outputs, the rollup `bytesOut` (28,978,848) equals 3,265,505 + 413,316 + 25,300,027 exactly.
  - Summing every row would **double the bytes**. criblvision drops the rollup by mapping a missing key to `'(none)'`
    and filtering it out (`client.ts:942`, `:949`). `splitToSeries` skips rows with an empty key (`src/lib/metrics.ts:57-58`).
- **For events, the rollup is not the sum of the per-input rows.** The rollup's `eventsIn` is 26,438; the per-input rows
  sum to 161,420. It matches only 1,798 + 17,996 + 6,644, so internal inputs (`cribl:CriblMetrics`, and two of the three
  6,644 rows) are excluded or deduplicated in the rollup. **INFERRED.**
- **Zeros are reported for configured but idle inputs**: explicit `0` values. That contradicts PRD line 211, "zero is never reported",
  at least for aggregated rows.
- **Inputs can have events and no bytes series.** Internal and subscription inputs show this, matching data-flow-monitor's
  live note (`src/lib/topology.ts:578-588`).
- **Dimension values can have three parts:**
  - `subscription:network_data:Network-Team`
  - `syslog:in_syslog_tls:tcp`
  - the spec example `syslog:in_syslog:udp`

  So "type is everything before the first colon, real ids never contain one" (`cc-di-data-flow-monitor/src/api/licenses.ts:229-233`)
  holds for the type prefix. The **rest** is not always the bare id.

Two-dimension rollup, confirmed live (`cc-di-data-flow-monitor/src/api/workerMetrics.ts:39-48`):
> a two-dimension `splitBys` query … (e.g. `['input', '__worker_node_hostname']`) can return an extra rollup row per hostname
> that omits the *other* split field entirely — its own value is exactly the sum of that hostname's other, fully-split rows

Their defence is `hasDim(row, key) = typeof row[key] === 'string'`, required for every split key (`workerMetrics.ts:49-51`, `:115`, `:122`, `:170`, `:175`).
The same guard appears in `fetchRouteSourceBreakdown` (`metrics.ts:209-211`) and `fetchSourceBreakdown` (`licenses.ts:228`).

### 5.4 Missing aggregations

"Cribl's query engine doesn't error on an aggregation with no matching data, it just silently omits that field from the row"
(`cc-di-data-flow-monitor/src/api/metrics.ts:148-150`). Everyone reads aliases as `Number(row.alias ?? 0)`.
data-flow-monitor also keeps "key absent" distinct from "0" to show "no bytes metric" (`src/lib/topology.ts:578-588`, `:751-755`).

---

## 6. Metric names observed (aggregate store)

| Metric | Split dims used | Used by | Notes |
|---|---|---|---|
| `total.in_bytes` / `total.in_events` | `input`, `__worker_group`, `__worker_node_hostname`, or none (`has_no_dimensions`) | both | Source-side boundary counter. data-flow-monitor treats it as ground truth for "how much came in" (`topology.ts:394-396`) |
| `total.out_bytes` / `total.out_events` | `output`, `__worker_group`, `__worker_node_hostname` | both | "reflects what was *handed to* this Destination's output stage, not what actually left it" (`topology.ts:756-759`) |
| `total.dropped_events` | none, or `output` | both | |
| `total.blocked_eps` | `input` + `__worker_node_hostname` | data-flow-monitor | Stream only |
| `route.in_bytes` / `route.out_bytes` / `route.in_events` / `route.out_events` / `route.dropped_events` | `route` (rule id), `name`, `input`, `__worker_group` | both | per-rule, pre-cascade (section 11) |
| `pipe.in_events` / `pipe.out_events` / `pipe.dropped_events` / `pipe.err_events` | `id`, `__worker_group` | both | **events only.** `pipe.err_events` was absent from their enum scan but real (`metrics.ts:145-153`) |
| `pq.queue_size` | `input` or `output`, `__worker_group` | criblvision | gauge, read with `max` (`client.ts:540-543`) |
| `backpressure.outputs` / `backpressure.inputs` | `input` or `output`, `__worker_group` | criblvision | non-zero while engaged |
| `blocked.outputs` | `output` + `__worker_node_hostname` | data-flow-monitor | never in the aggregate store for Edge (`workerInfo.ts:158-163`) |
| `system.max_worker_process_heartbeat_lag` | `__worker_node_hostname` | data-flow-monitor | |
| `health.inputs` | `input` | OpenAPI example only | |

**Not seen anywhere:** `source.in_bytes` (named in SPEC line 552), `pipe.*_bytes`, or a `#input=`/`#output=`-style
dimension syntax (PRD line 272, SPEC line 266 write `total.in_bytes|#input`). The shipped apps always pass the
dimension as a **`splitBys` entry** (`'input'`, `'output'`, `'route'`, `'id'`) and filter with `where`.

### 6.1 Dimension values and how each app maps them back to config

- **`input` / `output`:** `` `${type}:${id}` `` ("confirmed live — e.g. … `datagen:apache_error`",
  `cc-di-data-flow-monitor/src/lib/topology.ts:375-383`), sometimes with a third part (section 5.3).
  - data-flow-monitor looks up `metricsKey(input.type, input.id)` exactly, so 3-part keys go unmatched (`topology.ts:574`, `:745`).
  - criblvision strips the first `type:` prefix only: `raw.slice(raw.indexOf(':') + 1)` (`client.ts:943`,
    `src/lib/metrics.ts:59`). `in_syslog_tls` and `in_syslog_tls:tcp` become separate ids.
  - The exec dashboard resolves the whole value, then each colon-part longest-first, against configured ids
    (`cc-cribl-executive-dashboard/src/domain/volume.ts:22-34`). Both syslog keys fold into one entity and are **summed**
    (`volume.ts:97-110`). If both keys carry the same bytes, that double-counts. **INFERRED:** they were 0 in the fixture, so it's unverified.
- **The same `type:id` can appear in several groups.** "the metrics store's own `input` dimension alone doesn't disambiguate them",
  confirmed live (`cc-di-data-flow-monitor/src/api/licenses.ts:118-125`). Key org-wide data by `(__worker_group, input)`.
- **The `default` output has no dimension.** "the 'default' output's own `total.out_events`/`total.out_bytes` row carries no
  `output` dimension tag at all" (`topology.ts:458-461`). Those bytes appear only in the rollup. **INFERRED.**
- **`route`:** data-flow-monitor keys its totals by the route rule's `rule.id` (`topology.ts:914`, `:994`; `metrics.ts:110`
  "per Route rule id"). criblvision splits by both `route` and `name` and tops by `name` (`client.ts:876`, `:929`).
- **`id`:** the pipeline id for `pipe.*` (both apps).
- **`__worker_group`:** the group id. Search's `cribl_metrics` calls it `worker_group`
  (`cc-cribl-executive-dashboard/src/api/metrics.ts:40-42`).
- **`__worker_node_hostname`:** usable on Stream, never tagged for Edge (`workerMetrics.ts:13-19`).
- **`cribl_wp`:** not a dimension on the aggregate endpoint. "a splitBys:['cribl_wp'] query silently returns unsplit rows
  with no `cribl_wp` key at all" (`cc-visicore-criblvision/src/api/client.ts:412-415`).
- **`host`:** criblvision says `host`/`cribl_wp` "aren't usable dimensions on the aggregate metrics query"
  (`src/pages/SizingCalculator.tsx:36-38`) and "the aggregated metrics query has no per-node dimension" (`client.ts:708-711`).
  data-flow-monitor's `__worker_node_hostname` contradicts the per-node part of that for Stream.

---

## 7. Aggregation across workers and processes

- Both apps rely on the server to sum across worker processes and nodes. They issue `sum("metric")` with no process split and
  no client-side per-process fan-out on the aggregate endpoint. The PRD's "values are per Worker Process … sum across workers
  and processes" (PRD lines 211, 274) describes the raw series. On the aggregate query, that summing is done for you by `sum()`.
  **INFERRED:** both apps use this as a group total, and criblvision's Overview and Throughput tiles present
  `sumAlias(rows, 'bytesIn')` as total volume (`src/pages/Overview.tsx:38-42`, `src/pages/Throughput.tsx:49-53`).
- **Per node:** add `'__worker_node_hostname'` to `splitBys` (Stream only).
- **Per process:** only through the raw per-node endpoint with `?wp=N`, one call per process index, capped at 24
  (`cc-visicore-criblvision/src/api/client.ts:420-442`, `:476-488`).
- **In the raw per-node buffer:**
  - `system.cpu_perc` has one entry per `__worker_process`, and data-flow-monitor sums them (`workerInfo.ts:189-198`).
  - `total.in_events` and `total.out_events` have a node-level rollup entry whose `model` is exactly `{ __internal: "1" }`.
    Per-source and per-destination entries carry `ci`/`input`/`co`/`output` (`workerInfo.ts:200-207`).
- **Across groups:** criblvision uses `has_no_dimensions` with `splitBys: ['__worker_group']`, then sums by group client-side
  (`src/pages/Throughput.tsx:19-31`). data-flow-monitor runs one query per group and merges the results
  (`src/hooks/useFlowGraph.ts:53-57`).
  The fixture checks out: for three 600 s buckets, the per-group `bytesIn` sums (4 groups) equal the
  `throughputAll` (has_no_dimensions, worker + managed-edge) value exactly (e.g. 120,821,782). **INFERRED** from `public/fixtures.json`.

---

## 8. Time handling, bucketing and limits

### `earliest` / `latest` formats

- **criblvision:** `earliest: "21600s"` (a positive seconds string) and `latest: Date.now()` (ms). It shipped and works
  (`client.ts:175-176`).
- **data-flow-monitor:** both are epoch-ms numbers (`useFlowGraph.ts:47-51`).
- **OpenAPI:** relative string (`-1h`, `now`) or Unix **ms**.
- **Exec dashboard:** in live use, relative strings returned an **empty 200**. Its README hash table lists
  "`#norelative` | Only *relative* time ranges (`-1h`) return empty — the real bug that produced 0 B" (`README.md:55`),
  and the mock does the same (`dev/mock-api.js:315-319`).

  **Use absolute epoch ms for both bounds.**

### Bucket sizes in use

- **criblvision:** 60, 300, 900 and 3600 s, or `-1` (`AppContext.tsx:21-24`). With `-1`, the fixture shows 600 s buckets
  for both a 6 h and a 24 h window. **INFERRED.**
- **data-flow-monitor:** `floor(range/buckets)`, 86400 and 3600 (sections 4.2 and 12).
- **Buckets are epoch-aligned.** Every fixture `starttime` is divisible by its width. **INFERRED.**

### Partial edge buckets

data-flow-monitor drops the first and last buckets when there are more than 4 points:
"partial buckets under-report" (`cc-di-data-flow-monitor/src/api/metrics.ts:230-239`).
The fixture's newest 300 s bucket (59.5 MB) is about 5% below its neighbours (about 62.5 MB), which is consistent with late
data. **INFERRED.**

### Resolution degrades with age (INFERRED from the fixture, `throughputAll`, requested at `timeWindowSeconds: 300`)

- Rows newer than about 2.58 h are spaced **300 s** apart, at about 60 MB each.
- Rows older than that are spaced **600 s** apart, at about 120 MB each (10 minutes of data).
- **Every row still reports `endtime - starttime = 300`.**
- Sums over the window are right. **Rate = value / (endtime - starttime) is wrong by ×2 on older rows.**
  Compute rates from the spacing between buckets, or only from recent data.

### Retention

- **Exec dashboard:** "that store only retains ~2 days" (`cc-cribl-executive-dashboard/src/api/metrics.ts:12-14`).
- **data-flow-monitor, license page:** the `input`+`__worker_group` split's retention is "much shorter than the 90-day history
  `/system/licenses/usage` itself carries" (`licenses.ts:189-194`).
- **criblvision:** offers 7 d at 3600 s buckets (`AppContext.tsx:24`). Nothing in the repo confirms whether a full 7 d comes back.
  Its `byGroup` fixture covers 24.2 h.
- **Raw per-node buffer:** about 27 h for a Stream Worker and about 302 buckets for an Edge node (`workerInfo.ts:133-136`).

### Timeouts and limits

- The fetch proxy times out at 30 s (`AGENTS.md:76`). The exec dashboard budgets 28 s (`README.md:114`).
- No shipped app documents a result-row cap for `/system/metrics/query`.
- data-flow-monitor issues 9 metrics queries in parallel per group refresh, plus one worker-status fan-out
  (`useFlowGraph.ts:70-92`), and one such set per group for "All Worker Groups".
- The raw `/w/:wid/system/metrics` payload is "multi-megabyte per node" (`workerInfo.ts:127-128`).

---

## 9. `GET /w/:wid/system/metrics` (per-node raw buffer)

- **Path:** `` `/w/${encodeURIComponent(nodeId)}/system/metrics` ``, where `wid` is the worker id from `/master/workers`
  (criblvision `client.ts:425`, `:716`, `:766`; data-flow-monitor `workerScoped(workerId, '/system/metrics')`,
  `workerInfo.ts:226`, helper `client.ts:118-120`).
- **Query params sent:**
  - criblvision sends `?earliest=${nowSec - range}&latest=${nowSec}` (epoch **seconds**; the spec says ms) and `&wp=N`.
  - data-flow-monitor sends none: "`et`/`lt` query params were tried live and had no effect on the returned window"
    (`workerInfo.ts:133-136`).
  - Whether `earliest`/`latest` in seconds does anything is unverified. **INFERRED:** likely ignored or misread.
    `metricNameFilter`, `filterExpr` and `numBuckets` exist in the spec (section 3.3). No app uses them, and they could cut the multi-MB payload. **INFERRED.**
- **Shape:** `{ results: { metrics: Array<{ [metricName]: Array<{ model?: Record<string,string>, val?: number }> }> } }`.
  Each array element is one time bucket; `_time` is itself an entry: `bucket['_time'][0].val` in epoch **seconds**
  (`workerInfo.ts:167-178`, `:232`; criblvision `client.ts:680-686`, `:721`).
- **How each app parses it:**
  - criblvision's `entryVal` takes `arr[0].val` whatever its `model` (`client.ts:682-686`).
  - data-flow-monitor is model-aware:
    - `wholeNodeValue`: the entry with an empty `model`, for `system.*` (`workerInfo.ts:180-187`);
    - `internalRollupValue`: `model` is exactly `{__internal:'1'}`, for `total.*` (`:200-207`);
    - `summedProcessValue`: summed across `__worker_process` (`:189-198`);
    - `perOutputValues`: one value per `model.output`, for `blocked.outputs` (`:209-222`).
  - **INFERRED risk:** criblvision's `arr[0]` on `total.in_bytes` may read a per-input entry rather than the node rollup.
- **Metrics read from it:** `system.cpu_perc`, `system.free_mem`, `system.total_mem`, `system.disk_used`, `system.total_disk`,
  `total.in_events`, `total.out_events`, `total.in_bytes`, `total.out_bytes`, `blocked.outputs`.
- **Status:** `x-cribl-internal: true` in both specs. data-flow-monitor's policy comment says so and calls it best-effort
  (`config/policies.yml:65-71`).

---

## 10. How criblvision computes bytes per source, destination and route

- **Per source:** `total.in_bytes` split by `['input']` (group-scoped or dist-mode-scoped where), `timeWindowSeconds: -1`.
  The rows go through `aggregateSplit`: drop rows with no `input` (the rollup), strip the first `type:` prefix, sum across
  buckets per id, and sort by bytes descending (`client.ts:895-906`, `:939-950`).
- **Per destination:** the same with `total.out_bytes` split by `['output']` (`:909-920`).
- **Per route:** `route.in_bytes` split by `['name']`, summed per name (`:923-934`).
  The series view splits by `['route','name','__worker_group']` with all four `route.*` metrics (`:862-880`).
  Route reduction = in against out per route; pipeline mode uses events only (`:1040-1045`).
- **Totals:** `has_no_dimensions` rows summed across buckets. Rate = total / `rangeSeconds`
  (`src/pages/Overview.tsx:57`, `:66`). Reduction = `reductionPct(bytesIn, bytesOut)` (`src/lib/format.ts:43`).
- **Charts:** `splitToSeries` aligns every id to the union of bucket `starttime`s, fills gaps with 0, and keeps the top N by total
  with no "Other" bucket (`src/lib/metrics.ts:32-80`).

## 11. How data-flow-monitor computes bytes per source, destination, route and pipeline

- **Both units, every time.** Each refresh fetches events *and* bytes for sources, destinations and routes
  (`src/hooks/useFlowGraph.ts:62-92`).
- **Source:** `sourceTotals[metricsKey(type,id)].in` from the cumulative `total.in_*` split by `input`. "No bytes key" is kept
  distinct from zero (`topology.ts:572-602`).
- **Destination:** `destTotals[metricsKey(type,id)].out` from the cumulative `total.out_*` split by `output`.
  It is forced to 0 when per-worker status shows the destination stuck (`topology.ts:744-767`, `src/lib/blockedOutput.ts`).
  The `default` output resolves to its `defaultId` target (`topology.ts:455-480`).
- **Route:** `routeTotals[rule.id]`, cumulative `route.*_bytes` split by `route` (`topology.ts:994`).
  **Per-rule values are raw filter matches.** The source attribution (`route` × `input`, `metrics.ts:190-217`) is
  post-processed with a FINAL cascade:
  - keys already claimed by an earlier enabled `final` rule are subtracted;
  - disabled rules get nothing;
  - rules after an unconditional `final` catch-all are dead (`topology.ts:876-892`, `:918-972`).

  Quote (`:876-883`): "`route.in_events` … reports, independently for *every* rule (including disabled ones), 'how many of this
  Source's events match this rule's own filter,' NOT 'how many events this rule actually dispatched after real FINAL cascading
  was applied.'"
- **Pipeline bytes:** derived, not measured. It is the sum of `route.in_bytes`/`route.out_bytes` over the rules whose
  `rule.pipeline` is that pipeline (`topology.ts:914-916`, `:1227-1242`), and applies only to the main pipeline role, not
  pre- or post-processing pipelines.
- **Aggregating IN:** count each Source once (`sumUniqueSourceIn`); summing IN across flow rows double-counts fan-out
  (`topology.ts:385-414`). Summing OUT across flows is fine (`:398-401`).
- **Per worker:** `total.in_*` split by `['input','__worker_node_hostname']` and `total.out_*` split by
  `['output','__worker_node_hostname']`, both requiring each split key to be present (`workerMetrics.ts:138-181`).

---

## 12. The Search alternative (`cribl_metrics` dataset): shipped queries

- **Exec dashboard** (`cc-cribl-executive-dashboard/src/api/metrics.ts:67-75`):
  `` dataset="cribl_metrics" metric in ("total.in_bytes") | summarize bytes=sum(value) by _time=bin(_time, ${N}s), input, worker_group ``
  - Default names: `total.in_bytes`, `total.out_bytes`, `input`, `output`, `worker_group` (`:35-43`).
  - `_time` can arrive as seconds, ms or ISO, so all three are parsed (`:86-99`).
  - When the `bytes` alias is missing, the first other numeric field is used (`:119-127`).
  - The job goes to `POST /m/default_search/search/jobs`, is polled every 700 ms, and is capped at 90 s. Results come in pages of 1000 (`src/api/search.ts:16`, `:30-39`).
  - `earliest`/`latest` are **Unix seconds**. Sending ms "lands ~50,000 years out and the job completes with zero rows" (`metrics.ts:181-189`).
  - Retention is about 30 days (`src/domain/time.ts:7-10`). The 7-day baseline uses daily buckets (`metrics.ts:391-395`).
  - Bucket choice: `bucketSecondsFor` picks from [60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400], aiming for about 90 points (`src/domain/time.ts:42-49`).
- **Lake credit usage** (`cc-visicore-lake-credit-usage/src/api.ts:235-236`):
  `dataset="cribl_metrics" | where output startswith "cribl_lake:" and metric == "total.out_bytes" | timestats span=1d bytes=sum(value) by output`,
  cached in KV for 30 minutes because "each search job here takes on the order of a minute of Search compute" (`:243-247`).
- **Edge tag monitoring**, in a *user-routed* CriblMetrics dataset rather than `cribl_metrics`:
  - fields are `_metric`, `_value` and `host`;
  - names carry a `cribl.logstream.` prefix, e.g. `cribl.logstream.host.in_bytes` and `cribl.logstream.host.out_bytes`
    (`cc-edge-tag-monitoring/src/lib/config.ts:108-117`);
  - `total.*` "is split by output and double-counts our own relay" (`config.ts:133-141`).

  So a routed dataset does **not** use the built-in dataset's `metric`/`value` schema.
  This matters for SPEC 19.16's "route it to a Lake dataset `mr_metrics`" branch.

---

## 13. License usage as a cross-check (not the metrics store)

- **Endpoint:** `GET /system/licenses/usage` returns daily items `{ startTime, endTime (ms), inBytes, outBytes, inEvents, outEvents, droppedBytes, exemptedLicenseInBytes }`
  (`cc-di-data-flow-monitor/src/api/licenses.ts:68-108`). It is Leader-level and org-wide. It is documented as on-prem with
  a 403 in SaaS, but "confirmed live" to return 200 on Cribl.Cloud (`:8-15`).
- **Billed bytes = `inBytes - exemptedLicenseInBytes`.** "in a Datagen-heavy org `inBytes` alone can overstate the real bill by
  two orders of magnitude" (`src/hooks/useLicenseConsumption.ts:23-31`, `:141`).
- **Per-source split rescaling:** the metrics-store per-source split is rescaled to the license-usage total, because they are
  "two different measurement systems and can disagree slightly" (`:33-40`, `:150-151`).
- **Exempt source types:** `datagen`, `cribl`, `criblmetrics` (`src/lib/licenseExempt.ts:29`). `cribl_http`/`cribl_tcp` are
  deliberately not treated as exempt (`:22-27`). The Meter Reader demo rig is Datagen: its bytes are license-exempt and
  show up in `exemptedLicenseInBytes`. **INFERRED** relevance.

---

## 14. Conflicts to resolve in the spike

| Topic | Source A | Source B | Note |
|---|---|---|---|
| Metrics query "documented"? | SPEC 106, PRD 2.6b: not in SDK, treat as undocumented | Bundled product `openapi.json`: `x-cribl-internal: false` | Both are true. It's public in the product spec and absent from the SDK. |
| policies.yml path | SPEC 106: `/api/v1/system/metrics/query` | Shipped: `'/system/metrics/query'` | Use the shipped spelling. |
| Relative time | OpenAPI: `-1h` accepted | Exec dashboard README:55: relative returned empty live | Use absolute ms. |
| `earliest` format | criblvision `"21600s"` | data-flow-monitor ms numbers | Both shipped. ms matches the spec. |
| Pipeline bytes | SPEC 269: `pipe.in_bytes` fallback | data-flow-monitor and criblvision: none exist | Drop that branch, or derive pipeline bytes from route bytes as data-flow-monitor does. |
| Route bytes sum | SPEC 268: `flow.inB = route.in_bytes` | data-flow-monitor: per-rule, pre-cascade, disabled rules report | Apply the FINAL cascade, or don't sum across overlapping rules. |
| "Zero never reported" | PRD 211 | Fixture shows explicit `0` rows | For the aggregate query, absence and zero both occur. |
| Dimension syntax | PRD/SPEC `total.in_bytes|#input` | Apps use `splitBys: ['input']` | Use `splitBys`. |
| Per-node dimension | criblvision: aggregate has no per-node dim | data-flow-monitor: `__worker_node_hostname` works on Stream | `host` vs `__worker_node_hostname`. |
| `/w/:wid` policy | AGENTS.md:231 requires `/m/:gid` twin | data-flow-monitor omits it | criblvision's both-declared form is the safe one. |
| Backend caller | SPEC: `meter` backend runs the query | No reference app calls metrics from a backend | Spike test #1 is still needed for the **backend** path specifically. |

## 15. Proposed first spike request (INFERRED; untested)

```http
POST /api/v1/system/metrics/query          (backend: fetch('/api/v1/system/metrics/query'))
Content-Type: application/json

{ "where": "__worker_group == 'default'",
  "earliest": <windowStartMs>, "latest": <windowEndMs>,
  "aggs": { "aggregations": ["sum(\"total.in_bytes\").as(\"inB\")", "sum(\"total.in_events\").as(\"inE\")"],
            "splitBys": ["input"], "cumulative": true } }
```

Keep only rows where `typeof row.input === 'string'`. Run parallel queries for:
- `total.out_bytes` / `total.out_events` split by `output`;
- `route.in_bytes` / `route.out_bytes` split by `route`;
- `pipe.in_events` / `pipe.out_events` / `pipe.dropped_events` split by `id`.

Also run a `(has_no_dimensions)` query as the group-total control. Measure whether `timeWindowSeconds: 60` returns 60 s rows for
the last minute, given the age-based downsampling in section 8.
