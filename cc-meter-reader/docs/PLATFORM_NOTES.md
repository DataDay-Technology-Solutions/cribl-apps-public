# PLATFORM_NOTES — the engineering reference for the Meter Reader build

Consolidates `docs/platform/*.md` (metrics, version, kv-backend, config-apis, capra, guidance, insights-and-apps-docs), re-checked on 2026-09-26 against the code they cite, this project's `openapi.json` (Cribl `4.20.1-590ec085`), `node_modules/@cribl/apps@1.1.0`, `DECISIONS.md` and `SPIKE.md`. For depth, follow the pointer at the end of each section.

**Precedence:** `AGENTS.md` → measured facts on this org (`SPIKE.md`, `DECISIONS.md`) → this project's `openapi.json` → shipped reference apps → docs.cribl.io → SPEC v1.2 → PRD v4.16. The measured facts sit above the docs because they are this org. For example, the KV store answers 413 above ~100 KB even though the Builder Guide says values can be "multi-megabyte".

**Citation roots**
- `repo/path:line`: a reference clone under `scratchpad/ref/`.
- Bare paths (`AGENTS.md:76`, `openapi.json:240514`, `node_modules/...`, `DECISIONS.md` D-ids, `SPIKE.md` line n): this project.
- `SPEC:n` / `PRD:n`: `meter-reader-v4.16/METER_READER_SPEC.md` and `METER_READER_PRD.md`.
- docs.cribl.io citations (for example `apps/admin-guide.md:150`) are taken as recorded in `docs/platform/insights-and-apps-docs.md` (fetched 2026-09-25). I did not re-fetch them.

**Evidence labels:** unlabeled means seen in code, docs or spec. **MEASURED** means a live measurement recorded by this project or a reference repo. **INFERRED** means my conclusion. **UNVERIFIED** means only a live org can answer (see §8).

> ### Runtime frame (read first)
> **The primary v1.0.0 release has no backend.** `settings.runtime = 'ui'`, and the package contains no `backend.yml` or `schedules.yml` (DECISIONS D12b, which supersedes D12).
> - This org cannot install App backends. `POST /apps` returned 403 "App backend compute requires an enterprise license/plan" (SPIKE.md line 3; D11).
> - Instead, the open tab runs `runSweep()` every 30 s as the signed-in member, holds the KV lock, and backfills missed minutes from metrics history (D11).
> - **What binds under the UI runtime:**
>   - Each proxied request times out after **30 s** (`AGENTS.md:74-76`).
>   - Member-context authorization applies. Admins bypass the policy matcher (`cc-gigamon-ami/README.md:163-166`).
>   - The member-context Leader rate limit, if any, is UNVERIFIED (§8 Q6).
> - Everything about the 50/min backend budget, `context`, schedules and endpoint timeouts applies only to the optional backend variant (§4.3).

---

## 1. Metrics query

### 1.1 Endpoint and status
- **Call:** `POST /system/metrics/query`. It is Leader-level and never group-prefixed: `/m/:gid/system/metrics/*` returns 404, confirmed live (`cc-di-data-flow-monitor/config/policies.yml:29-32`). Scope to a group inside the query with `__worker_group`.
  - UI: `fetch(CRIBL_API_URL + '/system/metrics/query')`.
  - Backend: `fetch('/api/v1/system/metrics/query')`.
- **Spec status: documented.** It is in this project's spec as `operationId createSystemMetricsQuery`, `x-cribl-internal: false`, `x-cribl-availability: both` (`openapi.json:240514`; D7). It is also in the public Cribl Core API reference (insights-and-apps-docs.md §7). It is absent only from the Control Plane SDK's filtered spec (metrics.md §3).
- **Live on this org (MEASURED):**
  - It answered the App UI as a member, through the proxy, with HTTP 200 (9/26 03:57Z).
  - The install validator accepted the `policies.yml` entry (SPIKE.md line 1).
  - The backend path was not exercised, because this org has no backend compute.
- **Policy:** `object: '/system/metrics/query'`, `actions: ['POST']`. That spelling ships in `cc-visicore-criblvision/config/policies.yml:19-20` and `cc-di-data-flow-monitor/config/policies.yml:31-32`.
- **It is a read despite the POST verb:** "`POST /system/metrics/query` and `/system/metrics/enum` are read-only queries despite the verb" (`cc-cribl-executive-dashboard/README.md:113`).

### 1.2 Request schema (`SystemMetricsQueryRequest`, `openapi.json:100593`)
```
aggs (required): allOf[ { aggregations: string[] (required), splitBys?: string[] },
                        oneOf[ { timeWindowSeconds: integer (required), cumulative?: boolean },
                               { cumulative: boolean (required), timeWindowSeconds?: integer } ] ]
earliest?, latest?: string | integer   // relative string ("-1h") or Unix MILLISECONDS
where?: string       namespace?: string       alwaysBounds?: boolean       source?: 'linux'|'windows'
```

### 1.3 Recommended sweep queries (INFERRED composition; every element is a shipped pattern)
Use one POST per split set. Both bounds are **absolute epoch ms**: the exec-dashboard found that relative strings "return empty — the real bug that produced 0 B" (`cc-cribl-executive-dashboard/README.md:55`). Use `cumulative: true` over exactly the window being metered. That returns one row per split value, which is the di pattern (`cc-di-data-flow-monitor/src/api/metrics.ts:77-108`), and avoids the bucket-edge problem.
```json
{ "where": "__worker_group == 'default'",
  "earliest": 1790380800000, "latest": 1790380860000,
  "aggs": { "aggregations": ["sum(\"total.in_bytes\").as(\"inB\")", "sum(\"total.in_events\").as(\"inE\")"],
            "splitBys": ["input"], "cumulative": true } }
```
| Query | `aggregations` | `splitBys` | Source pattern |
|---|---|---|---|
| Inputs | `sum("total.in_bytes").as("inB")`, `sum("total.in_events").as("inE")` | `['input']` | di `metrics.ts:77-108` |
| Outputs | `sum("total.out_bytes").as("outB")`, `sum("total.out_events").as("outE")`, `sum("total.dropped_events").as("dropE")` | `['output']` | same |
| Routes | `sum("route.in_bytes").as("inB")`, `sum("route.out_bytes").as("outB")`, `sum("route.in_events").as("inE")`, `sum("route.out_events").as("outE")` | `['route']` | di `fetchRouteVolumeTotals` `metrics.ts:111-139` |
| Route × input (attribution and FINAL cascade) | `sum("route.in_bytes").as("v")` | `['route','input']` | di `fetchRouteSourceBreakdown` `metrics.ts:190-217` |
| Pipelines (events only) | `sum("pipe.in_events")`, `sum("pipe.out_events")`, `sum("pipe.dropped_events")` | `['id']` | di `metrics.ts:155-183` |
| Group control total | same as Inputs, with `where: "(has_no_dimensions) && (__worker_group==\"default\")"` and no split | none | criblvision `client.ts:264-276` |

- **Several groups in one call:** drop the `where` and add `'__worker_group'` to `splitBys`, as in `['input','__worker_group']` (`cc-di-data-flow-monitor/src/api/licenses.ts:210-249`). Key org-wide data by `(__worker_group, input)`, because the same `type:id` occurs in several groups (`licenses.ts:118-125`).
- **Escaping:** escape literals inside `where` (`cc-di-data-flow-monitor/src/api/metrics.ts:45-55`). Both `==` with `'…'` and `==` with `"…"` ship.

### 1.4 Response and parsing rules
- **Envelope:** `{ results: Row[] }` (`CriblEventEnvelop`). Default a missing `results` to `[]` (`cc-visicore-criblvision/src/api/client.ts:178-179`).
- **Cumulative row:** `{ _time, <splitKey>: string, <alias>: number }`.
- **Bucketed row:** `{ starttime, endtime (epoch SECONDS), ... }` with **no `_time`**, confirmed live (`cc-di-data-flow-monitor/src/api/metrics.ts:22-27`).
- **Rollup rows: drop them.** A split query also returns rows that lack a split key, and their values duplicate the sum of the fully split rows. The same holds for two-key splits, confirmed live (`cc-di-data-flow-monitor/src/api/workerMetrics.ts:39-51`). Filter:
  ```ts
  const keep = (row, keys) => keys.every(k => typeof row[k] === 'string');   // workerMetrics.ts:49-51
  ```
- **Absent aggregation ≠ error.** A metric with no data is **omitted** from the row (`cc-di-data-flow-monitor/src/api/metrics.ts:148-153`). Read `Number(row.alias ?? 0)`. Explicit `0` rows also occur for configured but idle inputs (metrics.md §5.3, from criblvision's live fixture). Keep "no bytes series" (key absent across the whole query) distinct from 0 for display (`cc-di-data-flow-monitor/src/lib/topology.ts:578-588`).
- **Dimension values:**
  - `input` and `output` are `` `${type}:${id}` ``, confirmed live (`cc-di-data-flow-monitor/src/lib/topology.ts:375-383`), but can have 3 parts (`syslog:in_syslog_tls:tcp`, `subscription:network_data:Network-Team`; metrics.md §5.3). Match the config id longest-first. Never assume `split(':')[1]`.
  - The built-in `default` output's rows carry **no `output` dimension** (`cc-di-data-flow-monitor/src/lib/topology.ts:458-461`). The demo rig routes to named `mrd_*` DevNulls, so this only matters for customer flows through `default`.
  - `route` = the route rule `id` (`cc-di-data-flow-monitor/src/lib/topology.ts:914`, `:994`).
  - `id` = the pipeline id for `pipe.*`.

### 1.5 Metric names (aggregate store)
| Metric | Split | Notes |
|---|---|---|
| `total.in_bytes` / `total.in_events` | `input` | Bytes are "counted after deserializing and event breaking" (`stream/monitoring.md:59-87` via insights-and-apps-docs.md §6) |
| `total.out_bytes` / `total.out_events` / `total.dropped_events` | `output` | Destinations count "the outgoing payload (typically a JSON string) prior to compression" (same source). This is what was handed to the output stage (`cc-di-data-flow-monitor/src/lib/topology.ts:756-759`) |
| `route.in_bytes` / `route.out_bytes` / `route.in_events` / `route.out_events` / `route.dropped_events` | `route` (rule id), `name`, `input` | Route "Bytes Out estimates the event size after the Route's Pipeline has processed the event" (same source). Counted **per rule, before FINAL cascading; disabled rules report too**, confirmed live (`cc-di-data-flow-monitor/src/lib/topology.ts:876-889`) |
| `pipe.in_events` / `pipe.out_events` / `pipe.dropped_events` / `pipe.err_events` | `id` | **Events only.** No `pipe.*_bytes` exists in any repo (metrics.md §6) |
| **Do not exist** | — | `source.in_bytes` (named in SPEC:552), `pipe.in_bytes`, `pipe.out_bytes` (SPEC:269), and any `#input=` / `#output=` syntax |

- **Pipeline bytes are derived:** the sum of `route.*_bytes` over the rules whose `pipeline` is that pipeline, after the FINAL cascade (`cc-di-data-flow-monitor/src/lib/topology.ts:914-916`, `:1227-1242`).
- **FINAL cascade:** subtract keys already claimed by an earlier enabled `final` rule, give disabled rules nothing, and treat rules after an unconditional `final` catch-all as dead (`topology.ts:876-892`, `:918-972`).
- **Worker and process aggregation:** `sum()` aggregates across worker processes and nodes on the server. Do not fan out per process (metrics.md §7). `cribl_wp` is not a dimension (`cc-visicore-criblvision/src/api/client.ts:412-419`).

### 1.6 Time, resolution, retention
- **Retention:** the store "only retains ~2 days" (`cc-cribl-executive-dashboard/src/api/metrics.ts:12-14`).
- **Resolution degrades with age (INFERRED from criblvision's live fixture, metrics.md §8):**
  - Rows younger than ~2.6 h are 300 s apart.
  - Older rows are **600 s apart but still report `endtime - starttime = 300`**.
  - Sums stay correct. **Never derive rates from `endtime - starttime`.**
- **Partial edge buckets under-report.** di drops the first and last bucket (`cc-di-data-flow-monitor/src/api/metrics.ts:230-239`).
- **Buckets are epoch-aligned** (INFERRED, fixture).
- **Timeouts:** the fetch proxy times out at 30 s (`AGENTS.md:76`). The exec-dashboard budgets 28 s (`cc-cribl-executive-dashboard/src/api/criblFetch.ts:28-29`).
- **Row cap:** no shipped app documents one.

### 1.7 Fallback (not needed: SPIKE.md line 1 = metrics-query branch ships)
If it is ever needed, the fallback is Cribl Search over the built-in `cribl_metrics` dataset. The shipped query (`cc-cribl-executive-dashboard/src/api/metrics.ts:67-75`):
```
dataset="cribl_metrics" metric in ("total.in_bytes") | summarize bytes=sum(value) by _time=bin(_time, 60s), input, worker_group
```
- **Field names:** the group field is `worker_group`, not `__worker_group` (`metrics.ts:40-42`).
- **Time:** `earliest` and `latest` are Unix **seconds**. Sending ms returns zero rows (`metrics.ts:181-189`).
- **Retention:** ~30 days (`src/domain/time.ts:7-10`).
- **Job flow:** `POST /m/default_search/search/jobs`, then poll every 700 ms with a 90 s cap, and read results in pages of 1000 (`src/api/search.ts:16,30-39`).
- **Cost:** one job is about a minute of Search compute (`cc-visicore-lake-credit-usage/src/api.ts:243-247`), so this is useful for a 30-day history seed, not a per-minute sweep.
- **Policies:** as in `cc-gigamon-ami/config/policies.yml:135-171`, `'/m/default_search/search/jobs'` with GET and POST, plus `/:jobId`, `/:jobId/status` and `/:jobId/results`, each declared separately.

**Cross-check (optional):**
- `GET /system/licenses/usage` returns daily `{ startTime, endTime, inBytes, outBytes, …, exemptedLicenseInBytes }`.
  - It is marked `x-cribl-availability: onprem` (`openapi.json:235418`), yet a Cloud org answers 200, confirmed live (`cc-di-data-flow-monitor/src/api/licenses.ts:8-15`).
- Datagen is license-exempt (`cc-di-data-flow-monitor/src/lib/licenseExempt.ts:29`).

→ Depth: `docs/platform/metrics.md`.

---

## 2. Config APIs and exact object shapes

**Common rules**
- All paths take the group prefix `/m/:gid` (`AGENTS.md:112`).
- **Envelopes:**
  - Single-object calls return `{ count, items: [X] }`; read `items[0]`.
  - Collections return `{ items, count, offset?, limit?, totalCount? }` and page with `?offset&limit`.
  - Errors are `{ status: 'error', message }`.
  - Source: config-apis.md §1.
- **PATCH replaces the whole object; omitted fields are deleted.** This applies to routes, pipelines, inputs and outputs (`openapi.json:170617` for the pipelines operation). There is no PUT on any config object.

| Object | Read | Write (demo only) | Shape essentials |
|---|---|---|---|
| Routes | `GET /m/:gid/routes` → `items[0] = { id: 'default', routes: RouteConf[], groups?, comments? }` | `PATCH /m/:gid/routes/default` with the **whole table**. `POST …/routes/default/append` adds at the end, **after** the catch-all, where a new route never matches (`cc-edge-tag-monitoring/src/api/cribl.ts:251-258`) | `RouteConf` requires `id, name, pipeline, final`. Also `filter, output?, disabled, description, clones, enableOutputExpression, outputExpression, groupId, context, targetContext` |
| Pipelines | `GET /m/:gid/pipelines`, `/m/:gid/pipelines/:id` → `{ id, conf }` | `POST /m/:gid/pipelines` `{id, conf}`; `PATCH /m/:gid/pipelines/:id` with the full object | `conf` (`additionalProperties:false`): `asyncFuncTimeout, output, description, streamtags, functions[], groups`. A function is `{ id, filter, disabled, final, description, groupId, conf }` |
| Inputs | `GET /m/:gid/system/inputs[/:id]` | `POST` (409 on duplicate id); `PATCH …/:id` with the full object, **omitting `criblSourceProvenance`** | `type`, `disabled`, `pipeline` (the **pre-processing** pipeline), `sendToRoutes`, `connections: [{ pipeline?, output }]` (QuickConnect), `metadata[]`, `description` |
| Outputs | `GET /m/:gid/system/outputs[/:id]` | `POST`; `PATCH` with the full object; `DELETE` answers 409 if referenced | `type`, `pipeline` (post-processing), `description`. The built-in `default` output forwards to `defaultId` (devnull out of the box) |
| Samples | `GET /m/:gid/system/samples` → `{ id, sampleName, size, numEvents, isTemplate? }`; `GET …/:id/content` | `POST /m/:gid/system/samples`; `PATCH …/:id` | See the note on samples below |
| Packs | `GET /m/:gid/packs` | `PUT /m/:gid/packs?filename=` (binary) → `{source}`; `POST /m/:gid/packs` `{ source, id?, allowCustomFunctions?, force? }` | `PackInfo { id, source, version, displayName, … }` |

**Samples.** They are in the 4.20.1 spec (`openapi.json:185998`, `:186178`), so config-apis.md §6's "not in spec" is out of date. `DataSample` **requires `id` and `sampleName`**. The working app's body omits `id`: `{ sampleName, context: { events: [{ _raw, _time }] } }` (`cc-sample-sanitizer/src/sample-io.ts:403-415`).

**Function confs Meter Reader uses**
```jsonc
{ "id": "eval", "filter": "true", "description": "[mr-trim] …",
  "conf": { "remove": ["headers","user_agent","request_body"] } }   // keep[] wins over remove[]; wildcards allowed
{ "id": "sampling", "filter": "true", "conf": { "rules": [ { "filter": "true", "rate": 2 } ] } }   // keep 1 in N
{ "id": "drop", "filter": "level=='debug'", "conf": {} }            // the drop condition is the function's filter
```
- **Datagen input:**
  ```jsonc
  { id, type: 'datagen', sendToRoutes: true, samples: [{ sample, eventsPerSec }], description }
  ```
  - `samples` needs at least one entry. `eventsPerSec` is a minimum of 1, **per Worker Node**. `sample` is titled "Data Generator File Name" (`openapi.json:30945`).
  - Whether `sample` holds the sample record's `id` or its `sampleName` is UNVERIFIED (§8 Q9).
  - The sample file must be one JSON array, not NDJSON: an NDJSON sample installed, then every read of its content failed with a 500 (`cc-gigamon-ami/scripts/pack.mjs:13-14`).
- **DevNull output:** `{ id, type: 'devnull', description }`.

**Flow-walk facts**
- **Route filters on inputs:** the `__inputId` value is `<type>:<inputId>` for a global input and `<type>:<packId>.<inputId>` inside a pack (config-apis.md §2).
- **Route with no `output`:** events go to the pipeline's `conf.output`, then to `default` (INFERRED, config-apis.md §2).
- **Three pipeline positions:** a source's `pipeline` is pre-processing, the route's `pipeline` is processing, and an output's `pipeline` is post-processing. QuickConnect `connections[]` bypass routes when `sendToRoutes: false`.
- **Pipelines inside packs** are not in the group-level list. Read them from `/m/:gid/p/<pack>/pipelines` (`cc-pipeline-investigator/src/api.ts:147-177`).
- **Pack references:** the string a route uses to point at a Pack is **not found** anywhere. Display whatever the API returns, and never construct one (config-apis.md §5).

→ Depth: `docs/platform/config-apis.md` (the 84 output types and 71 input types, all shapes and spec anchors).

---

## 3. Commit, deploy, history

### 3.1 Making a demo change live (group `default`; every step is volatile → confirmation per `AGENTS.md:78-91`)
| # | Call | Body | Read back |
|---|---|---|---|
| 1 | `GET /m/default/pipelines/<id>` | none | `items[0] = { id, conf }` |
| 2 | `PATCH /m/default/pipelines/<id>` | the **complete** `{ id, conf }` | `CountedPipeline` |
| 3 | `GET /m/default/version/status` | none | `items[0].files[].path`, e.g. `groups/default/local/cribl/pipelines/<id>/conf.yml` (repo-root relative, group-scoped; MEASURED, version.md §1) |
| 4 | `POST /m/default/version/commit` | `{ "message": "demo: break the trim on <id>", "files": ["groups/default/local/cribl/pipelines/<id>/conf.yml"], "effective": true }` | `items[0].commit`, the full 40-char SHA |
| 5 | `PATCH /products/stream/groups/default/deploy` | `{ "version": "<items[0].commit>" }` | `CountedConfigGroup` |
| 5b | `PATCH /master/groups/default/deploy` (deprecated, `openapi.json:200834`) | same | Use **only on a 404** from step 5. Never on a 403 or a 5xx (`cc-gigamon-ami/src/cribl/provision.ts:907-930`) |

**Commit body.** `GitCommitBody` is `{ message (required), files?, effective? }` (`openapi.json:113434`; path `openapi.json:242039`). The deploy body is `DeployRequest { version (required), lookups? }` (`openapi.json:85393`).
- There is **no `group` body field**; the group comes from the `/m/<gid>` prefix.
- `effective: true` without a group context returns 400. Cribl's own UI sends it on every group commit (UI-BUNDLE, version.md §3). Its exact semantics are UNVERIFIED.

**Always pass `files`.** This org has 399 pending files at the Leader level and 386 in `default_search` (MEASURED, version.md §5.3 / §8). An omitted `files` "commits all pending changes".

**Response `items[0]`:** `{ author{name,email}, branch, commit, files{created,modified,deleted,renamed}, summary }`.
- "Nothing to commit" arrives as `items:[{}]`. Skip the deploy in that case (`cc-cribl-power-tools/src/workflows/PipelineAssign.tsx:278-286`).
- The branch on this Leader is `master`, not the spec's `main` (MEASURED).

**Deploy.** It moves the group to that commit, so every commit in between goes live too. It **restarts the group's Worker Processes** (`cc-gigamon-ami/config/policies.yml:263-266`).
- **INFERRED:** expect a dip in the metrics minute after each lever. The detector must not read it as a regression (§8 Q12).

**There is no deploy-history API** (`cc-visicore-criblvision/src/pages/CommitAuditLog.tsx:61-63`, and MEASURED). Record `deployedAt` yourself when step 5 returns.

**A demo lever costs 5 Leader calls** (GET, PATCH, status, commit, deploy) before any KV writes.

### 3.2 History per group (read-only, release)
| Purpose | Call | Notes |
|---|---|---|
| Group history | `GET /m/<gid>/version?offset=0&limit=50` | MEASURED: returns only the commits that touch the group. `?limit` without `offset` → **400** "missing 'offset' parameter". `?count=N` also works (`items, count`) |
| Changed files of one commit | `GET /m/<gid>/version/files?commit=<hash>` | `items[0] = { count, items: GitFile-tree[], commitMessage }`. The tree has one node per path segment (`{name, state:'M'|'A'|'D', children[]}`); flatten it (`cc-gigamon-ami/src/cribl/provision.ts:1018-1057`). It returns **commit X alone**, not "since" X. The **root commit returns 500** `fatal: bad revision 'X~..X'` (MEASURED) |
| Diff and full message | `GET /m/<gid>/version/show?commit=&diffLineLimit=` | `commitMessage` is **URL-encoded** and holds the whole `git show` header (MEASURED) |
| Pending files | `GET /m/<gid>/version/status` | `items[0].files[] = { path, index, working_dir }` |
| Latest commit on the group record | `GET /products/stream/groups/<gid>?fields=git.commit,git.log` | `git.commit` is a 7-char hash. The `git.log` row cap is UNVERIFIED |

- **Row shape** (`GitLogResult`, `openapi.json:113551`): `{ hash (40), date, message (subject), body, author_name, author_email, refs }`. It has no `short` field (MEASURED).
- **Ordering:** newest first. HEAD is the row whose `refs` contains `HEAD -> master`.
- **`date` is `"2026-09-24 00:09:51 +0000"`**, which is not ISO 8601 despite the spec. Normalize it: first space → `T`, `+0000` → `+00:00` (MEASURED, version.md §5.2).
- **Authors:** system commits read "Cribl System / cribl@<leader-host>". The author of a commit made through the App proxy is UNVERIFIED (§8 Q13).
- **`configVersion`** is abbreviated. Compare hashes by a ≥7-char prefix, never `===` (`cc-gigamon-ami/src/cribl/provision.ts:932-946`). No group on this fresh org has a deployed `configVersion` yet (MEASURED); treat a missing one as "unknown".
- **File-path match keys:**
  - a pipeline: `groups/<gid>/local/cribl/pipelines/<id>/` (`cc-gigamon-ami/src/cribl/provision.ts:532-541`)
  - a route: `groups/<gid>/local/cribl/routes.yml`, from the spec example (INFERRED for this org)

→ Depth: `docs/platform/version.md`.

---

## 4. KV, backend, schedules

### 4.1 KV (both runtimes)
| Item | Fact | Source |
|---|---|---|
| UI URL | `CRIBL_API_URL + '/kvstore/<key>'`, rewritten to `/api/v1/a/{appId}/kvstore/<key>` | `AGENTS.md:67,101-108`; D15 |
| Backend URL | `fetch('/api/v1/kvstore/<key>')` (relative, already app-scoped) | `cc-visicore-spl-to-kql/backend/lib/kv.ts:27-62`; D15 |
| Admin script URL | `/api/v1/a/meter-reader/kvstore/<key>` | D15 |
| **Write** | `PUT` with `Content-Type: text/plain` and body `JSON.stringify(v)`. With `application/json` the store answers 200 and saves the literal `[object Object]` | MEASURED in 4 repos (kv-backend.md §1.2); `cc-visicore-spl-to-kql/backend/lib/kv.ts:38-45` |
| PUT response | **201 with an empty body.** Check `res.ok`; never parse it | `cc-di-data-flow-monitor/src/api/client.ts:58-69` (MEASURED) |
| Read | `res.text()` → `JSON.parse`. Treat `'[object Object]'` as absent | `cc-gigamon-ami/src/cribl/kv.ts:66-68,132-152` |
| Missing key | 404, **or** the UI proxy rejects with a `ReadableStreamDefaultController … is not valid JSON` error. Handle both | `cc-cribl-executive-dashboard/src/api/criblFetch.ts:180-197` |
| Delete absent key | 404, or 400. Accept both | `cc-cribl-power-tools/src/api/kv.ts:67-77` |
| List keys | `POST /kvstore/keys` with `{prefix}` (sent as `application/json`) → **bare JSON array** of names | `AGENTS.md:108`; `cc-gigamon-ami/AGENTS.md:142-162` (MEASURED 2026-09-15) |
| **Batch read** (4.20.1 spec) | `POST /kvstore/scan` `{ prefix?, limit? (default 1000, clamped at 10000), cursor? }` → `{ count, items: [{key, value}], nextCursor? }`. A page closes at 4 MiB of values. Encrypted values are omitted | `openapi.json:235004` |
| **Batch write** (4.20.1 spec) | `POST /kvstore/bulk` → `{ count }`. The request schema is not in the spec | `openapi.json:234934`; §8 Q7 |
| **Value cap** | **~100 KB.** 100,000 bytes round-trips; 1, 2 and 4 MB → **413 `PayloadTooLargeError`** (MEASURED on this org). The docs' "multi-megabyte" is wrong here | SPIKE.md line 2; D13; `cc-visicore-spl-to-kql/AGENTS.md:564` |
| Chunking | `core/kv.ts`: over 90 KB → gzip + base64 → ≤ 90 KB chunks at `<key>/c/<n>`, with a manifest at `<key>` | D13; pattern at `cc-visicore-spl-to-kql/src/knowledge/kvpack.ts` |
| Key count | 1,000 per App by default (raised through Support or `PATCH /apps/{id}/kvstore-settings {maxKeys}`) | `apps/builder-guide.md:310`; `api/cribl-core/apps.md:914-930` |
| **Key characters** | `/`-separated segments; `encodeURIComponent` each segment. **`\|` 404s even percent-encoded** (2 live measurements). `:` is untested in any shipped key. Sanitize user ids (`auth0\|…`) to `[A-Za-z0-9_-]` | `cc-di-data-flow-monitor/src/state/AppState.tsx:41-54`; `cc-gigamon-ami/src/cribl/user.ts:53-73` |
| Encrypted | `PUT …/<key>?encrypted=true` with a text/plain raw body. **Unreadable afterwards**: a read returns 403 (spl-to-kql) or "a redacted placeholder" (docs). Usable only as `kv.<key>` in `proxies.yml` `headers.inject` | `cc-visicore-spl-to-kql/AGENTS.md:562-563`; `apps/runtime-and-security.md:50` |
| Concurrency | **No compare-and-set.** Read-modify-write retry at most 8 times with a 250 ms settle (`cc-visicore-spl-to-kql/backend/lib/merge.ts:5-30`). Append-only logs use one key per entry (`cc-gigamon-ami/src/cribl/kv.ts:277-303`) | kv-backend.md §1.6 |
| Visibility | Plain values are readable by anyone in the org who can use this App's KV API | `apps/builder-guide.md:312` |
| Lifecycle | Upgrade preserves KV. Delete removes it | `apps/admin-guide.md:112,140` |
| Local dev | KV does **not** work on bare `localhost:5173`. It works only in Live Preview or an installed app | `cc-gigamon-ami/CLAUDE.md:132-137` |

**Keys rule for Meter Reader.** FlowKey (`g|in|route|pipe|out`) and ObjectKey live **inside values**, never in a key path. Key names use `/` only: `settings`, `snapshot`, `roll/min/2026-09-26T03`, `lock/meter`, `demo/state` (D13).

### 4.2 Rate limits and timeouts (as known)
| Limit | Applies to | Value | Source |
|---|---|---|---|
| Fetch-proxy request timeout | UI → any Cribl API | 30 s | `AGENTS.md:76` |
| External proxy rate | App → external hosts (`/a/{appId}/proxy/…`) | 100 req/min/app | `AGENTS.md:168` |
| Proxy host timeout | per host in `proxies.yml` | 1000–120000 ms, default 30000 | `AGENTS.md:133` |
| Leader requests limit | **App backend** → Leader API | 50/min by default (1–1,000, org setting, Leader restart) | `apps/admin-guide.md:150` |
| Concurrent backend executions | Leader-wide | 100, then 429 | `apps/admin-guide.md:149` |
| Member-context UI → Leader rate | UI runtime | **Unknown**: not documented, not yet measured (open 2026-09-26) | §8 Q6 |

**What the open tab asks of that unknown limit** (the code after the 2026-09-26 budget fixes; README "Engineering notes"). A sweep: about 23 calls, planned under 35 in steady state (a catch-up after downtime may use more; the runner's largest was 47, catching up two hours). A tab does not sweep at all while a runner swept in the last 90 s. Between sweeps, one `meta` read per poll (10 s; 5 s on the presenter view; settings allow 5–60 and 3–30), the snapshot only after a `meta` that changed, `prices` every 20 s until a price exists and then every 60 s, `demo/state` in the demo build (every poll during a lever or scene, else every 30 s), the inventory on the Prices and Budgets sections, and a custom range's rollup documents once (≤ 4 with the sweep's cursor). Before those fixes, the in-browser emulator measured one metering tab at 35–38 calls a minute, the presenter view at 47–59, and the fastest legal presenter setting with a 30-day range at 68–75 steady and 107 in its first minute (api-budget audit, `tests/report/audit/api-budget/`, git-ignored); the fixes removed the tab's duplicate sweep beside the runner, the extra refresh after a skipped sweep and most range reads, and were not re-measured. A tab that meets a 429 backs polling off to 60 s for 5 minutes. A sweep retries a 429 once after the Leader's `Retry-After` (at most 60 s; 5 s without one); a second 429 stops it, and the next 2, 4, 8, then 16 minutes are skipped with no Leader call (runner and tab alike, recorded in `meta.rateLimitedSince` / `meta.rateLimitedUntil`); the first sweep after the back-off catches up (RUNBOOK §6, EPIC_AUDIT P1-E01).

No shipped app handles 429 on KV or Leader calls. gigamon's Search client retries 429 and 5xx with `300·2^n + jitter` ms, four tries (`cc-gigamon-ami/src/cribl/search.ts:61-81`).

### 4.3 Backend variant only (`npm run package:backend`; not the v1.0.0 primary; D12b)
- **`backend.yml` schema** (`node_modules/@cribl/apps/lib/build/backendManifestSchema.js:18-81`):
  - `runtime: js`.
  - Endpoint `name` must match `^[a-zA-Z0-9][a-zA-Z0-9_-]*$`.
  - **`timeout` is 1–120 s** (default 30; `:58-63`). **`memory` is 1–1024 MB** (default 256).
  - Each bundle must stay under 5 MB (`:81`).
  - The docs say the timeout can reach 900 s (`apps/builder-guide.md:193`). The build schema and `AGENTS.md:264` say 120, and they win (D3).
- **Handler:** `export async function onRequest(request: Request, context): Promise<Response>`.
  - **`context` shape:** the scaffold types it `{ appId }` (`AGENTS.md:274`). The docs list `appId, installationId, invocationId, caller.userId` (`apps/builder-guide.md:216-221`). No shipped app reads anything but `appId`.
  - **Module top-level code runs at build time** (`AGENTS.md:288`).
- **Invoking from the UI:** `POST ${CRIBL_API_URL}/endpoints/<name>` works in spl-to-kql (`cc-visicore-spl-to-kql/src/api.ts:426-427`) without declaring anything in `policies.yml`.
  - The platform answers **502, 503 or 504** when the backend is not running. Use 422 for app-level errors (`cc-visicore-spl-to-kql/AGENTS.md:513-514`).
  - A UI-invoked endpoint that runs past 30 s hits the proxy timeout. Return early and let the UI poll KV (kv-backend.md Finding C).
- **Grants:** backends run with the App-wide grants in `policies.yml`, not the caller's roles (PRD:205; `AGENTS.md:292`).
- **Logs:** `console.*` goes to `app-backend.log` (`apps/admin-guide.md:372-380`).
- **Limits:** request body ≤ 4 MB, response ≤ 6 MB (`apps/builder-guide.md:256`).
- **Build flags:** there is no `define` or `process.env` in the backend bundle (`node_modules/@cribl/apps/lib/build/backendBuild.js:135-145`). A demo/release switch must come from KV or from a generated constant file.
- **Schedules** (`config/schedules.yml`):
  ```yaml
  meter-every-minute:            # top-level key = schedule id; no nested id:
    endpoint: meter
    cronSchedule: '* * * * *'    # five-field UTC; minute granularity is untested in any repo
    bodyExpression: '{ scheduleId, scheduledFor }'
  ```
  - `AGENTS.md:311` allows **≤ 10 per App**; the docs say 25 by default (D4).
  - The only real example is `cc-visicore-spl-to-kql/config/schedules.yml:1-6` (daily).
  - `scheduledFor` is typed `string`, but its format is unseen (`cc-visicore-spl-to-kql/backend/splunk-sync.ts:53`).
  - A scheduled no-op returns `200 {ok:true, skipped}`.
  - Review App does **not** show schedules (`apps/admin-guide.md:43`).
  - Upgrades can overwrite dynamic schedules (`apps/builder-guide.md:286`).
- **Status APIs:** `GET /apps/{id}/backend/status`, `GET /a/{appId}/backend-schedules` (`openapi.json:197712`).

→ Depth: `docs/platform/kv-backend.md`, `docs/platform/insights-and-apps-docs.md` §8.

---

## 5. `policies.yml`: exact spellings

**Format** (`AGENTS.md:215-222`):
```yaml
policies:
  - object: '<path>'
    actions: ['GET']
```

**Rules**
- **Path form:** no `/api/v1` prefix, and placeholders such as `:gid` and `:id`.
- **Collections and children:** a collection path does **not** cover its children (`AGENTS.md:248`).
- **Worker paths:** a `/w/:wid/...` path needs its `/m/:gid/...` twin (`AGENTS.md:228-231`).
- **Wildcards:** partial-id wildcards (`mrd_*`) appear in no reference app. gigamon avoids `*` entirely because its segment semantics are undocumented (`cc-gigamon-ami/config/policies.yml:19-24`). Use `:id`.
- **Never declare** `/kvstore/*` or `/proxy/*` (`AGENTS.md:226`). `/endpoints/*` is not declared by spl-to-kql either.
- **Testing:** admins never hit the matcher (`cc-gigamon-ami/README.md:163-166`), so every grant must be tested as a **shared non-admin**.
- **Query strings** are not part of the object (INFERRED, `cc-gigamon-ami/src/cribl/provision.ts:961-963`).

### 5.1 Release (read-only; UI runtime): recommended `config/policies.yml`
```yaml
policies:
  # Worker Groups (list + one record, incl. ?fields=git.commit,git.log). /master/groups is deprecated in 4.20.1.
  - object: '/products/stream/groups'          # precedent: cc-cribl-executive-dashboard/config/policies.yml:15; cc-gigamon-ami:357
    actions: ['GET']
  - object: '/products/stream/groups/:gid'     # precedent: cc-gigamon-ami/config/policies.yml:259
    actions: ['GET']
  # Inventory the sweep walks
  - object: '/m/:gid/system/inputs'            # precedent: cc-di-data-flow-monitor/config/policies.yml:20
    actions: ['GET']
  - object: '/m/:gid/system/outputs'           # precedent: cc-di-data-flow-monitor/config/policies.yml:22
    actions: ['GET']
  - object: '/m/:gid/pipelines'                # precedent: cc-di-data-flow-monitor/config/policies.yml:18
    actions: ['GET']
  - object: '/m/:gid/routes'                   # precedent: cc-di-data-flow-monitor/config/policies.yml:16
    actions: ['GET']
  # Throughput (a read despite the verb; the single non-GET in the release file)
  - object: '/system/metrics/query'            # precedent: cc-visicore-criblvision/config/policies.yml:19-20; cc-di-data-flow-monitor:31-32
    actions: ['POST']
  # Change timeline (group-scoped history + changed files per commit)
  - object: '/m/:gid/version'                  # NOVEL: no reference app declares it; preinstall-check accepted it (SPIKE.md line 1)
    actions: ['GET']
  - object: '/m/:gid/version/files'            # NOVEL (Leader-level twin '/version/files' ships in cc-gigamon-ami/config/policies.yml:536)
    actions: ['GET']
  # Workspace/version for the footer and payload `workspace`
  - object: '/system/info'                     # precedent: cc-visicore-criblvision/config/policies.yml:24
    actions: ['GET']
```

**Differences from the current `config/policies.yml` (the spike set):**
- **Drop** `/system/metrics/enum` POST. It is a second non-GET, and SPEC:483 allows only one.
- **Drop** `GET /system/metrics`, `/m/:gid/packs`, `/m/:gid/system/samples`, `/version` and `/m/:gid/system/status/*`, unless code calls them.
- **Replace** `/master/groups` and `/master/groups/*` with the `/products/stream/groups` pair.
- **Replace** `/m/:gid/version/*` with the exact `/m/:gid/version/files`.
- **Optional, only if the code calls it:** `/m/:gid/packs` GET (precedent: `cc-gigamon-ami/config/policies.yml:391`), for pack pipelines.

### 5.2 Demo build: the release set plus exactly these
```yaml
  # Levers: create/patch demo-tagged objects (the [meter-reader-demo] tag is enforced in code; no partial-id grants exist)
  - object: '/m/:gid/pipelines'                # POST creates rig pipelines — precedent: cc-edge-tag-monitoring/config/policies.yml:58-59
    actions: ['GET', 'POST']
  - object: '/m/:gid/pipelines/:id'            # precedent (as '/*'): cc-edge-tag-monitoring/config/policies.yml:60-61
    actions: ['GET', 'PATCH']
  - object: '/m/:gid/system/inputs'            # precedent: cc-edge-tag-monitoring/config/policies.yml:26
    actions: ['GET', 'POST']
  - object: '/m/:gid/system/inputs/:id'        # precedent (as '/*'): cc-edge-tag-monitoring/config/policies.yml:30
    actions: ['GET', 'PATCH']
  - object: '/m/:gid/system/outputs'           # precedent: cc-edge-tag-monitoring/config/policies.yml:36
    actions: ['GET', 'POST']
  - object: '/m/:gid/system/outputs/:id'       # precedent (PATCH only, as '/*'): cc-cribl-power-tools/config/policies.yml:80
    actions: ['GET', 'PATCH']
  - object: '/m/:gid/routes/:id'               # PATCH is on the TABLE id ('default') — precedent: cc-gigamon-ami/config/policies.yml:513 (':tableId')
    actions: ['GET', 'PATCH']
  # Commit + deploy
  - object: '/m/:gid/version/status'           # precedent: cc-visicore-lookup-sync/config/policies.yml:24
    actions: ['GET']
  - object: '/m/:gid/version/commit'           # precedent: cc-visicore-lookup-sync/config/policies.yml:27; cc-cribl-power-tools:51
    actions: ['POST']
  - object: '/products/stream/groups/:gid/deploy'   # precedent: cc-gigamon-ami/config/policies.yml:271
    actions: ['PATCH']
  - object: '/master/groups/:gid/deploy'       # 404-fallback only — precedent: cc-gigamon-ami/config/policies.yml:273
    actions: ['PATCH']
  # Rig samples (only if demoApplyRig uploads them; else Steve uploads once in the UI)
  - object: '/m/:gid/system/samples'           # precedent (as '/m/*/…'): cc-sample-sanitizer/config/policies.yml:20
    actions: ['GET', 'POST']
  - object: '/m/:gid/system/samples/:id'       # precedent (as '/m/*/…/*'): cc-sample-sanitizer/config/policies.yml:23
    actions: ['GET', 'PATCH']
  # Pack presence check (install via API only if needed: add POST, and PUT for upload)
  - object: '/m/:gid/packs'                    # precedent: cc-gigamon-ami/config/policies.yml:391
    actions: ['GET']
```

### 5.3 `proxies.yml` (historical: no package declares one since D23 for the release and D57 for the Enterprise variant)
Kept as the platform reference. No build stores a webhook URL (hackathon rule 4.5), so no build posts to a webhook host; alerts go through Cribl's bell and notification targets, and the self-hosted runner posts direct webhooks from its `.env`. Use the `AGENTS.md:150,160-163` concat syntax for any injection, not the SPEC's template literal.
```yaml
hooks.slack.com:
  timeout: 10000
  paths:
    allowlist:
      - /services/
```
- Every other host (webhook.site, a ServiceNow instance) is added by an admin under **App Settings → External API Access**. The JSON form is `{ "id": "<host>", "timeout": 15000, "paths": { "allowlist": ["/"] } }`, added to the existing array, never replacing it (`apps/admin-guide.md:212-231`).
- Hostnames match exactly, with no wildcards (`cc-cribl-power-tools/config/proxies.yml:14-18`).
- An undeclared host returns 403, and redirects are not followed across hosts (`cc-visicore-spl-to-kql/AGENTS.md:567-570`).

---

## 6. UI / Capra essentials (full cheat-sheet: `docs/platform/capra.md`)
- **Theme:**
  - Install `installThemeBridge()` from `AGENTS.md:369-387` before render. It toggles `.dark` on `<body>` from the `CRIBL_APP_LAYOUT` postMessage.
  - Pass `onTheme` into React state for charts and `EmptyState theme`.
  - Add `:root { color-scheme: light dark; }`.
  - Never build a theme switcher (`AGENTS.md:354-404`).
- **Styling:**
  - Use CSS `token('…')` only; a bad key fails the build (capra.md §1.4).
  - Capra components reject `className`/`style`, except the Card parts. Space things with wrapper `<div>`s (`AGENTS.md:416-420`).
  - Typography tokens are the `font` shorthand, for example `font: token('typography.metric.xl')`.
- **Not exported in 1.16.0:** `Heading, Tabs, Stack/Flex/Grid, Dialog, Banner, Chip, SegmentedControl, Select, useToast, Progress, Slider, Stepper, PageHeader, MetricCard, TimeScope, TextInput`. Use `Text as="h1"`, `TabNav`, plain divs, `Modal`, `Alert`, `Tag`/`Pill`, `ToggleButtonGroup`, `SelectField`, `Toast.*` + `<Toast.Provider/>`, `Card` + `Text variant="metric-*"`, `DateRangePickerField`, `TextField` (capra.md §2).
- **Confirmation:** only `Modal.confirm(...)` renders a Cancel button. Use it, or a controlled `<Modal>`, for every volatile call. Name the object and say whether the action can be undone (`AGENTS.md:78-91`; capra.md §3.7).
- **Callbacks differ by component:**
  - `TextField.onChange(string)`, `NumberField.onChange(number)`, `SelectField.onChange(Key|null)`.
  - `Checkbox`/`Switch` take a native event.
  - `Modal.onIsOpenChange`.
  - `Button` children must be a plain string.
  - Details: capra.md §4-5.
- **Table:** requires `defineColumns<T>()`, `visibleColumns` and `items[].id`. Show `EMPTY_CELL_PLACEHOLDER` in empty cells (capra.md §3.9).
- **Money display:**
  - There is **no `$` icon** in `@capra/icons`.
  - Currency shows the symbol, commas and 2 decimals, with no space (`$10.20`).
  - Units take a space (`2.7 GB`), and one column uses one unit (capra.md §7.4).
- **Charts:**
  - No chart library is installed. Use SVG with `visualization.*` tokens or `getChartTheme()` (capra.md §7.3).
  - Canvas with same-origin images fails in the sandbox (PRD:203).
- **Routing:**
  - `<BrowserRouter basename={window.CRIBL_BASE_PATH}>` plus Capra `RouterProvider navigate/useHref` (capra.md §8.1).
  - `VerticalNavigation.Item` is not router-aware; intercept `onClick` (§8.2).
  - Links out of the app need `target="_top"` or `_blank` (`AGENTS.md:340-352`).
- **Identity:** `await window.getCriblUser()` → `{ id, username, email?, firstName?, lastName?, initials? }` (`AGENTS.md:24-44`). There are no roles.
- **Storage:** no browser storage for app data (`AGENTS.md:99`). UI state goes in the URL (SPEC:432).
- **Live Preview is blocked in Chrome 151** by Local Network Access. Install through the Apps API or Import from File instead (D8).

---

## 7. Insights facts for the README "What exists / what Meter Reader adds" row
All from docs.cribl.io 4.20, as recorded in `docs/platform/insights-and-apps-docs.md` §1-6. Absence in the docs is not proof of absence in the product (§8 Q16).

| Question | Answer | Source |
|---|---|---|
| Price or $ per flow? | **No.** The only $ figures are the price of Insights itself and FinOps credits. FinOps' finest grain is product, Workspace, or "the 10 Worker Groups with the most data usage". There is no source, route, pipeline or destination grain | `insights/enable.md:23`; `billing-licensing/finops-center.md:94-96,209,217-220` |
| Counterfactual? | **No.** Compare mode sets actual against an earlier actual window. FinOps' 3-month forecast is org- and product-level | `insights/data.md:118`; `finops-center.md:91-92` |
| Commit or author on an alert? | **No.** The template variables are `monitor_id, monitor_name, description, status, value, labels, fired_at, workspace_name, __policyId, metadata.*`. Stream Monitoring's config-change markers show "configuration versions"; the docs do not mention an author | `insights/templates.md:166-188`; `stream/monitoring.md:41,226` |
| Scheduled $ receipt? | **No.** Notifications fire on state change only. Monitoring Reports is a pull-only Top Talkers view in bytes and events | `insights/notifications.md:24`; `stream/monitoring.md:240` |
| Targets | Email (custom SMTP, or `system_email` on Enterprise), Amazon SNS, PagerDuty, Slack, Webhook. **No Teams, Opsgenie or ServiceNow** target | `insights/targets.md:16-20` |
| Map | Stream only: Source → Pre-Processing Pipeline → Routes/QuickConnect → Post-Processing Pipeline → Destination, with Volume, Freshness and Shape metrics and no cost metric | `insights/data.md:10,58-62,134-138` |
| Availability | Workspace Admins in **Enterprise** Cribl.Cloud orgs; 48 h free retention; paid tiers of 7 d to 1 y | `insights/about.md:18-20`; `insights/enable.md:23` |
| Can a Monitor express $? | No: "Calculation/binary operations are not available", so bytes × $/GB cannot be thresholded | `insights/monitors.md:46` |
| Bytes-in vs bytes-out caveat | "Data Insights accounts for compression, formatting, and protocol overhead at the Destination" | `insights/data.md:102-104` |

**Draft row (paste-ready):**
> **Cribl Insights** (Enterprise Cribl.Cloud): draws the Source → Pipeline → Route → Destination map in bytes and events, compares time windows, and sends Monitor alerts to Email, SNS, PagerDuty, Slack and webhooks. No price on any flow, no counterfactual, no commit or author on an alert, and alerts rather than a scheduled dollar receipt. **Meter Reader adds:** a $/GB price at every destination, a chosen counterfactual, a savings regression tied to the commit and the user who shipped it, and a dollar receipt delivered to Slack.

The PRD's wording (PRD:162, PRD:476) lists "Slack/PagerDuty/email/webhook". **Add SNS.**

---

## 8. OPEN QUESTIONS — only a live org can answer

Each item gives the question, then how to test it, then what it gates. "Read-only" means GET, or the metrics POST, with no confirmation needed.

1. **Leader acceptance of `1.0.0-demo`.**
   - Test: install a `createAppPack`-built `.tgz` with `version: "1.0.0-demo"`, then Upgrade over `1.0.0`.
   - Gates: the D5 fallback (distinct patch + displayName).
2. **Non-admin grants for the novel objects `/m/:gid/version` and `/m/:gid/version/files`** (no shipped precedent), and for `/products/stream/groups/:gid` in place of `/master/groups/*`.
   - Also confirm that `?fields=git.commit,git.log` works on `/products/stream/groups/:gid`. version.md measured it only on `/master/groups`.
   - Test: share the app with a non-admin and read the timeline. Admins bypass the matcher.
   - Gates: the release policies (§5.1).
3. **Does the Review App modal show `POST /system/metrics/query` as a write?**
   - Test: `POST /apps/preinstall-check` with the release package, then a screenshot.
   - Gates: README and PITCH wording ("the install screen shows only reads").
4. **Minute-grain metrics. The whole per-minute design rests on this one.**
   - **The evidence is thin.** No fixture in any repo shows a 60 s row; criblvision's captured fixture is 300 s and 600 s. The only evidence that 60 s grain exists is that criblvision *requests* `bucketSeconds: 60` for its 1 h range and shipped (`cc-visicore-criblvision/src/state/AppContext.tsx:21`).
   - **The questions:**
     - Does a `cumulative: true` query over the last completed minute return stable values?
     - How late does a minute settle (late-data rewrite of minute N−1)?
     - How far back do 60 s-grain answers stay exact before the ~2.6 h downsampling?
   - **If the native grain is coarser than 60 s,** the sweep window becomes the native grain, and the meaning of `regressionMinutes`/`spikeMinutes` shifts. Rescale them to windows, or require N consecutive native buckets.
   - Test: read-only. Query the same minute at +10 s, +40 s, +70 s and +130 s. Query `timeWindowSeconds: 60` over the last 6 h and read the row spacing.
   - Gates: the sweep window, the D11 backfill, detector timing, and `measuredLagSec`.
5. **Retention on this org** (~2 days in the refs). Is there a `namespace` with longer history?
   - Test: read-only. `timeWindowSeconds: 3600` from −7 d, plus `POST /system/metrics/enum`.
   - Gates: the history seed and the "collecting since" copy.
6. **Is there a Leader rate limit on member-context UI calls?** What does a 429 look like through the proxy (status, body, `Retry-After`)?
   - Test: read-only. Burst the sweep's calls and log statuses.
   - Gates: the 30 s cadence, with two tabs plus the lock.
   - **Status 2026-09-26: still open.** Ten live runs never met a 429 (the runner logged none in 754 sweeps, with the admin credential), which says nothing about a member's tab. The procedure is in `docs/LIVE_VALIDATION.md` ("Still to run"): as a **non-admin** member (an administrator bypasses the policy matcher: "Runtime frame" at the top), about 150 reads of the App's `meta` KV document inside one minute from the developer console of the App's frame (`${window.CRIBL_API_URL}/kvstore/meta`, the way the App reads it; the `?diag=1` panel calls nothing), logging each status and any `Retry-After`. The first 429, if any, is the ceiling; record it here in §4.2 and in the README's "Leader rate limits" with the date.
7. **`/kvstore/scan` and `/kvstore/bulk` through the UI proxy.** Are they reachable, and what is bulk's request body? Does scan return plain values verbatim (text/plain-written JSON)? Do scan and bulk count as one request each?
   - Test: KV only (app-scoped).
   - Gates: collapsing 7+ KV reads per sweep into one.
8. **KV key forms.** Do `:` keys work (the SPEC uses them; core/types.ts:205-207 comments still do)? Does `/kvstore/keys` return full names with or without a leading `/`? Is a missing key through the UI proxy a 404 or the stream error?
   - Gates: key naming (§4.1) and the hydrate path.
9. **Datagen.** Must `samples[].sample` hold the sample `id` or its `sampleName`? Does `POST /system/samples` require `id` (the spec says yes; the sanitizer omits it)?
   - Test: read-only. `GET /m/default/system/inputs/<existing datagen>` against `GET /m/default/system/samples`.
   - Gates: `demoApplyRig`.
10. **Route and pack reference strings.** When a route's Pipeline is a Pack, what do `routes[i].pipeline`, `context` and `targetContext` hold? What are the `route` and `id` metric dimension values for pack pipelines?
    - Test: read-only after a UI edit.
    - Gates: the flow walk for the pack levers.
11. **Metric dimensions for the rig.**
    - Does `route` carry the rule `id` for every rule?
    - Do QuickConnect flows emit any `route.*` series?
    - Do the demo DevNull outputs appear as `devnull:mrd_…`?
    - Test: read-only.
    - Gates: FlowKey attribution.
12. **Deploy side effects.** Does a deploy (which restarts Worker Processes) leave a zero or partial minute in `total.*`/`route.*`? Does a PATCH to one route rewrite `routes.yml` in full?
    - Gates: detector false positives after each lever, and the commit `files` list.
13. **Commit identity and scope.**
    - Who is `author_name` on a commit made through the App proxy by a member?
    - Does `/m/:gid/version/commit` without `files` stay group-scoped?
    - What does `effective: true` change?
    - Does `files` in the commit response use the same repo-relative paths as `/version/status`?
    - Gates: the "named the person" claim (the fallback is `getCriblUser().username` recorded by the app).
14. **Proxy egress from the UI runtime.**
    - `fetch('https://hooks.slack.com/services/…')` from the iframe: status and body (Slack returns `ok` text).
    - An admin-authorized `webhook.site` works, and an unlisted host gets a 403. What is the 403 body shape?
    - Gates: the notification path and the "host not authorized" UI (PRD item n).
15. **Backend variant, if Enterprise compute appears:**
    - minute cron firing with the tab closed;
    - the `scheduledFor` format;
    - `context` keys (`caller.userId`?);
    - whether KV calls count toward the 50/min budget;
    - whether an endpoint survives past 30 s when UI-invoked;
    - where `app-backend.log` surfaces.
    - Gates: switching `settings.runtime` to `backend`.
16. **Insights on the judges' orgs.** Is it enabled (Enterprise only)? Does the live UI show anything $-shaped that the docs omit?
    - Gates: the wording of the README Insights row.
17. **`getCriblUser().id` format on this org** (`auth0|…`?).
    - Gates: per-user key sanitization and payload `author`.
18. **Leader UI deep-link paths** for a pipeline, route or destination page (SPEC:434), opened with `target="_top"` in installed mode.

---

## 9. CONFLICTS with PRD / SPEC assumptions, with recommended decisions

### 9.1 Already decided (recorded in `DECISIONS.md`; listed so no agent re-litigates them)
| # | PRD / SPEC says | Platform says | Decision |
|---|---|---|---|
| C1 | Backend `timeout` 300, "up to 900 s" (SPEC:71,84; PRD:36,207) | `@cribl/apps` schema `maximum: 120` (`node_modules/@cribl/apps/lib/build/backendManifestSchema.js:58-63`); `AGENTS.md:264` | **D3:** ≤ 120 s (backend variant only) |
| C2 | ≤ 25 schedules (PRD:209) | "Up to 10 schedules per app" (`AGENTS.md:311`) | **D4:** ≤ 10; 2 used |
| C3 | Demo version `<release>-demo` (SPEC:53,483) | Only the CLI bump path validates strict `X.Y.Z` (`parseVersion` at `node_modules/@cribl/apps/lib/package/pkgutil.js:20-27`, called from `nextVersion` `:31-46`). `createAppPack` copies `version` verbatim (`:184-190`), and the install schema types it as a bare `string` (`appPackageJsonSchema.js:24`) | **D5:** build the demo with `createAppPack`. Leader acceptance is still open (§8 Q1) |
| C4 | `paths: - path: /api/v1/…; methods:` with `*` and `mrd_*` (SPEC:97-121) | `policies: - object: '/…' actions: [...]`, no prefix, `:gid` (`AGENTS.md:215-246`) | **D6.** Exact spellings in §5 |
| C5 | Metrics query "undocumented" (PRD:8,211; SPEC:106) | In the 4.20.1 spec with `x-cribl-internal: false` (`openapi.json:240514`) and the public API reference | **D7:** the README may say documented |
| C6 | Always-on scheduled `meter` (PRD §1, §5) | 403 on install of a backend, "enterprise license/plan" (SPIKE.md line 3) | **D11/D12b:** UI runtime is primary. Copy never claims "while closed" |
| C7 | KV 2 MB values; snapshot ≤ 2 MB (SPEC:147,165,482; PRD:210) | 413 above ~100 KB, MEASURED (SPIKE.md line 2) | **D13:** gzip + base64 chunks ≤ 90 KB. Change the SPEC:482 perf gate from "snapshot ≤ 2 MB" to "each KV value ≤ 90 KB" |
| C8 | UI calls endpoints at `/endpoints/<n>` vs `AGENTS.md:290`'s `/a/{appId}/endpoints/{name}` | spl-to-kql uses `${CRIBL_API_URL}/endpoints/<name>` successfully | **D15** |

### 9.2 New: each needs a decision (recommendation last)
| # | PRD / SPEC says | Evidence | Recommendation |
|---|---|---|---|
| N1 | D11 backfill: "one query per gap, 1-minute windows" | Resolution degrades after ~2.6 h (600 s rows that still report `endtime-starttime=300`) and retention is ~2 days (§1.6; INFERRED from fixture) | Backfill each gap with **one** `timeWindowSeconds` query at the native grain. Sum each returned row into the minute rollups by `starttime`. Flag the rows `backfilled: true` and have the detector skip them. Never derive rates from bucket width. Cap backfill at ~48 h |
| N2 | Dimension syntax `total.in_bytes\|#input` (PRD:272; SPEC:266) | Shipped apps pass `splitBys: ['input']` and filter with `where` (metrics.md §6) | Use `splitBys`. Delete the `#` syntax from SPEC |
| N3 | Pipeline-bytes branch `pipe.in_bytes/out_bytes` (SPEC:269); Search fallback on `source.in_bytes` (SPEC:552) | Neither series exists; pipelines report events only (metrics.md §6) | Delete the `pipeline` attribution branch. Derive pipeline bytes from post-cascade `route.*_bytes`. Use `total.in_bytes` in any Search fallback |
| N4 | `flow.inB = route.in_bytes` (SPEC:268) | `route.*` is per rule, pre-FINAL-cascade, and disabled rules report (`cc-di-data-flow-monitor/src/lib/topology.ts:876-889`, confirmed live) | Apply the FINAL cascade using the `['route','input']` split (§1.3). Skip disabled rules. Never sum `route.in_bytes` across overlapping rules |
| N5 | "Zero is never reported … missing series means zero" (PRD:211,273) | Explicit `0` rows **and** omitted aggregations both occur (metrics.md §5.3–5.4) | Read `Number(row.alias ?? 0)`. Keep "series absent all window" as a separate `noBytes` flag for display, not as 0 |
| N6 | "Values are per Worker Process; sum across workers and processes" (PRD:274; SPEC:266) | `sum()` in the aggregate query already sums across processes and nodes (metrics.md §7) | One `sum()` query. No client-side process fan-out |
| N7 | `paid` from destination out-bytes "includes compression" (PRD:276; SPEC:270) | Stream docs: destination bytes are "the outgoing payload … **prior to compression**"; Data Insights docs say it includes compression and protocol overhead (§1.5, §7) | Keep the route-out → destination-out preference. Word the Show-the-math note as "includes serialization/format overhead; measured before compression (Stream Monitoring docs)", not "includes compression" |
| N8 | Release policies `/api/v1/version/*` (SPEC:107) | That covers neither the bare `/version` collection nor `/m/:gid/version` (`AGENTS.md:228,248`); group history is `/m/:gid/version` (MEASURED group-scoped) | Use `/m/:gid/version` and `/m/:gid/version/files` GET (§5.1). Test as a non-admin (§8 Q2) |
| N9 | Demo `/api/v1/m/*/routes [GET, PATCH]` (SPEC:118) | PATCH exists only on `/routes/{id}` (`openapi.json:173160`); the table id is `default` | `'/m/:gid/routes/:id'` `['GET','PATCH']` plus `'/m/:gid/routes'` `['GET']` |
| N10 | Demo `/api/v1/version/commit` (SPEC:119) | Leader-level commit with 399 pending files on this org; group context is `/m/:gid/version/commit` (version.md §1, §8) | `'/m/:gid/version/commit'` POST, always with explicit `files` from `/m/:gid/version/status`. Deploy `items[0].commit` |
| N11 | Deploy `/api/v1/products/stream/groups/*/deploy` (SPEC:120) | Shipped spelling is `'/products/stream/groups/:gid/deploy'` (`cc-gigamon-ami/config/policies.yml:271`) | Use it. Add `'/master/groups/:gid/deploy'` for the 404 fallback only |
| N12 | Partial-id grants `mrd_*` (SPEC:116-117) | No precedent in any of the 16 repos | Grant `/:id`. Enforce `[meter-reader-demo]` in code (SPEC 19.5). Say so in the README |
| N13 | Current `config/policies.yml` has `/system/metrics/enum` POST | SPEC:483: the release has no non-GET except the metrics query | Drop enum from the release file (keep it for spike runs only) |
| N14 | `/api/v1/master/groups` (SPEC:101) | `GET /master/groups` is `deprecated: true` in 4.20.1 (`openapi.json:199928`); `GET /products/stream/groups` returns only Stream groups (MEASURED) | Use `/products/stream/groups` and `/products/stream/groups/:gid`. Keep `/master/groups` out of the release file unless a test shows otherwise |
| N15 | KV keys `roll:min:…`, `lock:meter`, `demo:state`, `secret:notify:<id>:url` (SPEC:149-160; `core/types.ts:205-207` comments); FlowKey uses `\|` (SPEC:169) | `\|` in a key 404s even encoded (MEASURED ×2); `:` untested; D13 already uses `/` | Keys use `/` only (`roll/min/<hour>`, `lock/meter`, `demo/state`). FlowKey stays inside values. Fix the `core/types.ts` comments |
| N16 | SPEC 10: commits via the SDK `Versions.Commits.*`; "files per commit" is "since" (spec text) | The SDK repos are archived read-only on **Oct 1, 2026** (`release-v4200.md:72-82`). `/version/files?commit=X` = X alone; the root commit returns 500 (MEASURED) | Plain `fetch` adapters only. Guard the root commit. Treat `files` as that commit's own files |
| N17 | Commit `date` is ISO 8601 (spec `GitLogResult`) | `"YYYY-MM-DD HH:MM:SS +0000"` (MEASURED) | Normalize before `Date.parse` in `core/time.ts` |
| N18 | `deployedAt` "from the deploy record if the API exposes it" (SPEC:345) | No deploy-history API exists (§3.1) | Levers record `deployedAt` when step 5 returns. Non-app commits show "committed" |
| N19 | Proxy inject `'`${kv.anthropic_api_key}`'` (SPEC:134) | `AGENTS.md:150,160-163` documents `"'…' + kv.key"`; the one shipped active inject uses concat (`cc-cribl-executive-dashboard/config/proxies.yml:28,39`) | Use the AGENTS concat form: `x-api-key: kv.anthropic_api_key` |
| N20 | Budget "50 per minute per App backend", ≤ 35 calls/sweep, 429 handling (SPEC:259-261,278; PRD:208) | The 50/min limit is documented for **backends** only (`apps/admin-guide.md:150`). Under the UI runtime the member-context limit is unknown (§8 Q6); the 100/min limit is external egress only (`AGENTS.md:168`) | Keep the ≤ 35 counter and the one-retry-on-429 logic (they are cheap). Evaluate them against the measured UI limit. Use `/kvstore/scan` to batch reads if §8 Q7 passes |
| N21 | Relative time windows implied (SPEC 7 step 2 is fine), and the spec allows `-1h` | Relative strings returned empty live (`cc-cribl-executive-dashboard/README.md:55`) | Absolute epoch **ms** for both bounds, always |
| N22 | Internal types excluded: `cribl`, `cribl_metrics`, `cribl_internal` (SPEC:265) | Input discriminators are `cribl` and `criblmetrics` (config-apis.md §4); the license-exempt set is `datagen, cribl, criblmetrics` (`cc-di-data-flow-monitor/src/lib/licenseExempt.ts:29`) | Exclude by `type in ['cribl','criblmetrics']` |
| N23 | SPEC 14.2: `demoApplyRig` uploads samples; "not in spec" (config-apis.md §6) | `/system/samples` is in the 4.20.1 spec; `DataSample` requires `id` + `sampleName` (`openapi.json:185998`) | POST `{ id, sampleName, context: { events } }` with `id` = `sampleName` minus its extension. Verify with §8 Q9 before relying on it |
| N24 | Search fallback `/api/v1/m/default_search/search/jobs` with policies `[GET, POST]` + `/*` (SPEC:111-112) | Not needed (SPIKE.md line 1). If revived: `worker_group` field, seconds, ~30 d retention, ~1 min of compute per job | Keep it as a **history-seed** option only, never per minute |
| N25 | Backend `context.caller.userId` for attribution (SPEC:343; PRD:205) | The scaffold types `context` as `{appId}`; no shipped backend reads `caller` | Moot under the UI runtime: the UI passes `getCriblUser().username` itself. Backend variant: read `context.caller?.userId` defensively |
| N26 | "Meter Reader uses all four … the scheduled `meter` function" (PRD:80); the Sweep DoD "Runs every minute with the tab closed" (SPEC:516); the compliance test checks "no `demo*` endpoint in `backend.yml`" (SPEC:483) | Under D12b the release `.tgz` has **no** `backend.yml` or `schedules.yml` | README: claim **three** (documented Cribl API, KV store, declared proxy host `hooks.slack.com`). Reword the Sweep DoD to "every 30 s while a tab is open, KV lock, backfill on reopen". The compliance test asserts `default/backend.yml` and `default/schedules.yml` are **absent** from the release `.tgz` |
