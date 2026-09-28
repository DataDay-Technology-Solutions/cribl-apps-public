# Stream config object shapes: routes, pipelines, inputs, outputs, samples, packs

Research notes for Meter Reader. They cover the JSON shapes and write semantics of the Cribl Stream config APIs, taken from the SDK's bundled OpenAPI spec and from Cribl-Community apps that are installed and working.

## How to read this

- **Authority order.** `AGENTS.md` comes first, then the bundled OpenAPI spec, then working app code. Where an app contradicts itself or only guesses, this doc says so.
- **Citation roots.** Every citation is `repo/path:line`, relative to the reference-clone root `scratchpad/ref/`.
  - `SPEC` means `cribl-control-plane-sdk-typescript/.speakeasy/out.openapi.yaml`. It is OpenAPI 3.1.0, `info.version: 4.19.0-0fbd6d34`, 82,035 lines (`SPEC:1-22`).
  - `SDK` means `cribl-control-plane-sdk-typescript/`.
  - `AGENTS.md:n` means line n of this repository's `AGENTS.md`.
- **Labels.** Anything not read directly from code or spec is marked **INFERRED**. Anything searched for without success is marked **NOT FOUND**.

---

## 0. Ledger

| Fact | Status | Where |
|---|---|---|
| The SDK bundles a full OpenAPI spec at `.speakeasy/out.openapi.yaml`. Its upstream is `criblio/cribl-openapi-spec` `specs/control-plane.yml`. | VERIFIED | `SDK/.speakeasy/workflow.yaml` (sources.inputs.location); `SPEC:1-22` |
| Group context is set by the URL prefix `/m/<groupId>`. The SDK does this by passing `{ serverURL: \`${base}/m/${gid}\` }` per call. | VERIFIED | `AGENTS.md:110-114`; `SDK/README.md:92`; `SDK/examples/example-stream.ts:97` |
| Every GET, POST, PATCH and DELETE on a config object returns a `{ count, items: [ ... ] }` envelope, and single-object calls return a single-item list. | VERIFIED | `SPEC:57109-57121` (CountedPipeline), `SPEC:57216` (CountedRoutes), `SPEC:32983` (CountedInputResponse) |
| PATCH on routes, pipelines, inputs and outputs **replaces the whole object**. Omitted fields are deleted. | VERIFIED | `SPEC:79141-79149` (routes), `SPEC:77636-77642` (pipelines), `SPEC:79668-79677` (inputs), `SPEC:80496-80501` (outputs) |
| A group has one route table, `id: default`. Adding a route means reading the table, splicing the route in, and PATCHing the whole table. There is also `POST /routes/default/append`. | VERIFIED | `SPEC:79128-79132`, `SPEC:79208-79276`; `cc-edge-tag-monitoring/src/api/cribl.ts:255-274` |
| Eval remove-fields key is `conf.remove: string[]` (wildcards allowed). `conf.keep` takes precedence over it. | VERIFIED | `SPEC:2481-2494`; `SDK/src/models/functionconfschemaeval.ts:26-42` |
| Sampling conf is `conf.rules: [{ filter: string, rate: integer }]` (1-in-N). | VERIFIED | `SPEC:6543-6563` |
| Drop conf is `{}`. The drop condition is the function's own `filter`. | VERIFIED | `SPEC:2195-2196`, `SPEC:8974-9012`; example at `SPEC:69513` |
| A datagen input requires `type: 'datagen'` and `samples: [{ sample, eventsPerSec }]` (at least one entry). | VERIFIED | `SPEC:24464-24545`; `cc-gigamon-ami/packs/cc-network-gigamon-ami/default/inputs.yml:52-74` |
| A devnull output requires only `type: 'devnull'`. | VERIFIED | `SPEC:34160-34197` |
| Samples API: `POST /m/:gid/system/samples` with body `{ sampleName, description?, context: { events: [{ _raw, _time }] } }`. | VERIFIED (working app) / **not in spec** | `cc-sample-sanitizer/src/sample-io.ts:403-415`, `:692-705` |
| Pack install: `POST /m/:gid/packs` with body `{ source, id?, allowCustomFunctions?, force? }`. | VERIFIED | `SPEC:77002-77063`, `SPEC:59892-59978`; `cc-gigamon-ami/src/cribl/packClient.ts:614` |
| The string that points a Route, Source or QuickConnect at a **Pack** (for example `pack:<packId>`) | **NOT FOUND** | See section 5. Nothing in 16 repos, the spec, or docs.cribl.io shows the literal. |
| `/system/samples`, `/m/:gid/preview`, `/packs/:id/export` and `/system/metrics/query` | **Not in the bundled spec** | See section 11 |
| `policies.yml` in every app uses `policies: [{ object, actions }]`, with no `/api/v1` prefix and no partial-id wildcards. | VERIFIED | Section 10 |

---

## 1. Envelopes, pagination, errors

- **Counted envelope** (`CountedX`), used for single-object GET/POST/PATCH/DELETE: `{ count: integer, items: X[] }`. Both fields are required (`SPEC:57109-57121`).
- **Paginated envelope** (`PaginatedX`), used for collection GETs of pipelines, inputs, outputs and packs: `{ items, count, offset?, limit?, totalCount? }`. `totalCount` is present only when `limit` is set (`SPEC:57193-57214` for PaginatedPipeline, `SPEC:33176` for PaginatedInputResponse). The query parameters are `offset` and `limit` (`SPEC:77388-77395`).
  - Apps page with `?offset&limit=200` until a short page comes back (`cc-cribl-power-tools/src/api/stream.ts:16-32`).
  - `GET /system/inputs` also accepts `?type=<SourceType>` (`SPEC:79379-79381`).
- **Errors** come back as `{ status: 'error', message }`, schema `Error`, for example at `SPEC:79360-79374`. Apps read `body.message || body.error` (`cc-gigamon-ami/src/cribl/capi.ts:108-114`).
- **Unwrapping a single object.** Apps read one object as `items[0]`, falling back to the raw body (`cc-pipeline-investigator/src/api.ts:192-195`; `cc-gigamon-ami/src/cribl/provision.ts:736-740`).

---

## 2. Routes: `GET /m/:gid/routes`

### Operations

| Op | Method and path | Body | Response | Spec |
|---|---|---|---|---|
| List tables | `GET /m/:gid/routes` | none | `CountedRoutes` | `SPEC:79044-79081` |
| Get table | `GET /m/:gid/routes/:id` (id is always `default`) | none | `CountedRoutes` | `SPEC:79083-79124` |
| Replace table | `PATCH /m/:gid/routes/:id` | `RoutesInput` (the **whole table**) | `CountedRoutes` | `SPEC:79133-79207` |
| Append route(s) | `POST /m/:gid/routes/:id/append` | `RouteConfInput[]` (a bare array) | `CountedRoutes` | `SPEC:79208-79276` |
| Pack-scoped | `/m/:gid/p/:pack/routes`, `/p/:pack/routes/:id` (GET, PATCH), `/p/:pack/routes/:id/append` | same shapes | same | `SPEC:74673`, `SPEC:74719-74775`, `SPEC:74857` |

The PATCH description, quoted from `SPEC:79141-79149`: "This endpoint does not support partial updates. Cribl removes any omitted fields when updating the Routing table. ... Cribl also removes any omitted Routes when updating the Routing table."

### Response shape (`CountedRoutes` → `Routes` → `RouteConf`)

```jsonc
{
  "count": 1,
  "items": [{
    "id": "default",                       // required; only supported value is "default"
    "routes": [ /* RouteConf[] */ ],        // required
    "groups":   { "<groupId>": { "name": "...", "index": 0, "description": "..." } },  // Route Groups
    "comments": [ { "id": "...", "comment": "...", "index": 0, "groupId": "..." } ]
  }]
}
```

- `Routes` is at `SPEC:57330-57355` (`SDK/src/models/routes.ts:17`).
- The groups value schema is `AdditionalPropertiesTypeRoutesGroups`, with `name` and `index` required.
- `RouteComment` requires `comment`, `id` and `index`.

`RouteConf` is at `SPEC:57261-57329` (`SDK/src/models/routeconf.ts:12-65`). Its **required** fields are `final`, `id`, `name` and `pipeline` (`SPEC:57325-57329`). `output` is **not** required.

**INFERRED:** when a route has no `output`, events go to the pipeline's `conf.output`, described as "The output destination for events processed by this Pipeline" (`SPEC:57148`), or to the `default` output. Meter Reader must resolve the destination this way when it reads routes.

| field | type | note |
|---|---|---|
| `id` | string | required |
| `name` | string | required |
| `filter` | string | JS expression |
| `pipeline` | string | required. The Pipeline (or Pack, see section 5) that matched events go to. |
| `output` | string | Destination id, applied after the pipeline |
| `final` | boolean | required. `true`: matched events stop here. `false`: all events continue, and this must be `false` to clone. |
| `disabled` | boolean | |
| `description` | string | |
| `clones` | `Array<Record<string,string>>` | `RouteCloneConf`, `SPEC:57250-57254` |
| `enableOutputExpression` | boolean | |
| `outputExpression` | string | evaluated when the route is constructed, not per event |
| `groupId` | string | the Route Group this route belongs to |
| `context` | string | `group` or `pack` |
| `targetContext` | enum `group` or `pack` | `TargetContext`, `SPEC:57255-57260` (`SDK/src/models/targetcontext.ts:9`) |

`RouteConfInput` (`SPEC:63227-63294`, `SDK/src/models/routeconfinput.ts:11`) is the write shape used by PATCH and append.

- It requires only **`name` and `pipeline`** (`SPEC:63292-63294`).
- `final` defaults to **true** ("If `true` (default)", `SPEC:63279-63287`).
- If `id` is omitted, "the server generates a deterministic identifier" (`SPEC:63288-63291`).

### Spec example response

`SPEC` example `RoutesResponseExamplesMultiRouteTable`:

```yaml
count: 1
items:
- id: default
  routes:
  - {id: route-security, name: Security events, final: false, disabled: false,
     pipeline: security-pipeline, filter: "sourcetype=='syslog'", output: splunk-hec}
  - {id: default, name: default, final: true, disabled: false,
     pipeline: main, filter: 'true', output: default}
```

### How apps write routes

- **cc-edge-tag-monitoring** (`src/api/cribl.ts:229-274`) does a GET → splice → PATCH.
  - It reads `/m/:gid/routes/:tableId`, removes any route with the same `name`, and inserts the new route **before the first catch-all**. A catch-all is a route whose `filter` is `''` or `'true'` (`:243-249`, `:264-266`).
  - It then PATCHes `{ id, routes, comments?, groups? }` (`:270-273`).
  - It does not use `append`. The code comment at `:251-258` explains why: appending puts the route after the final `true` catch-all, where it never matches.
- **SDK examples** do the same thing: `routes.routes = [route, ...routes.routes]` followed by `routes.update({ id, routesInput })` (`SDK/examples/example-stream.ts:130-139`; `SDK/examples/example-packs.ts:130-139`).
- **cc-gigamon-ami** policies note that PATCH replaces the table wholesale, so the app edits the array it read and keeps every other route's index (`cc-gigamon-ami/config/policies.yml:505-514`).

### Filtering on `__inputId`

- For a global input the value is `<type>:<inputId>`, confirmed live as `datagen:apache_error` (`cc-di-data-flow-monitor/src/lib/topology.ts:375-383`). The SDK example filter uses the same form: `__inputId=='tcpjson:my-tcp-json'` (`SDK/examples/example-packs.ts:100`).
- **Inside a pack** the value is `<type>:<packId>.<inputId>`, measured on 2026-09-25 as `datagen:cc-network-gigamon-ami-dgtest.dg_asis` (`cc-gigamon-ami/packs/cc-network-gigamon-ami/default/pipelines/route.yml:35-42`; `cc-gigamon-ami/scripts/pack.mjs:129-138`).
- A pack's own route table lives on disk at `default/pipelines/route.yml`, not `routes.yml` (`route.yml:3-6`).

---

## 3. Pipelines: `GET /m/:gid/pipelines`

### Operations

| Op | Method and path | Body | Response | Spec |
|---|---|---|---|---|
| List | `GET /m/:gid/pipelines?offset&limit` | none | `PaginatedPipeline` | `SPEC:77342-77406` |
| Create | `POST /m/:gid/pipelines` | `Pipeline` | `CountedPipeline` (400 on validation) | `SPEC:77407-77535` |
| Get | `GET /m/:gid/pipelines/:id` | none | `CountedPipeline` | `SPEC:77582-77626` |
| Replace | `PATCH /m/:gid/pipelines/:id` | full `Pipeline` | `CountedPipeline` | `SPEC:77627-77768` |
| Delete | `DELETE /m/:gid/pipelines/:id` | none | `CountedPipeline` | `SPEC:77537-77581` |
| Pack-scoped | `/m/:gid/p/:pack/pipelines[/:id]` | same | same | `SPEC:74214`, `SPEC:74421` |

- The PATCH description at `SPEC:77636-77642` reads: "does not support partial updates. Cribl removes any omitted fields."
- **INFERRED.** The group-level list does **not** include pack pipelines. cc-pipeline-investigator lists `/m/:gid/packs` and then `/m/:gid/p/<pack>/pipelines` for each pack (`cc-pipeline-investigator/src/api.ts:147-177`).
- **Caution about pack pipelines.** cc-gigamon-ami's policy comment says "No pipeline is deleted: inside a pack that DELETE answers and removes nothing" (`cc-gigamon-ami/config/policies.yml:441-443`).

### Pipeline shape

The shape below is `SPEC:57123-57192` (`SDK/src/models/pipeline.ts:20-77`). Note that `conf` has `additionalProperties: false`.

```jsonc
{
  "id": "my-pipeline",                    // required
  "conf": {                               // required
    "asyncFuncTimeout": 1000,             // 0..10000 ms
    "output": "default",                  // output for events this pipeline processes
    "description": "…",
    "streamtags": [],
    "functions": [ /* PipelineFunctionConf[] */ ],
    "groups": { "<gid>": { "name": "…", "description": "…", "disabled": false } },
    "__template_streamtags": "…"
  }
}
```

### Function entry shape

`PipelineFunctionConf` is a `oneOf` of 70 function schemas, with discriminator `propertyName: id` (`SPEC:11505-11577` and after). Every `PipelineFunction<X>` wrapper has `additionalProperties: false`, requires `id` and `conf`, and allows exactly these keys:

```jsonc
{ "id": "<function id>", "filter": "true", "disabled": false, "final": false,
  "description": "…", "groupId": "<pipeline group id>", "conf": { /* per-function */ } }
```

Source: `SPEC:9102-9141` (eval wrapper); `SDK/src/models/pipelinefunctioneval.ts:17`.

The discriminator ids, from `SPEC:11577-11650`, are:

> aggregate_metrics, aggregation, auto_timestamp, cef, chain, clone, code, comment, distinct, dns_lookup, drop, drop_dimensions, dynamic_sampling, eval, event_breaker, eventstats, externaldata, flatten, foldkeys, gen_stats, geoip, grok, handlebars, join, json_unroll, lake_export, limit, local_search_datatype_parser, local_search_ruleset_runner, local_search_schema_mapper, local_search_time_range_normalizer, local_search_transformer, lookup, mask, metrics_export, mv_expand, mv_pull, notification_policies, notifications, notify, numerify, otlp_logs, otlp_metrics, otlp_traces, pack, pivot, publish_metrics, redis, regex_extract, regex_filter, rename, rollup_metrics, sampling, search_engine_export, send, sensitive_data_scanner, serde, serialize, sidlookup, signal_filter, snmp_trap_serialize, sort, store, suppress, tee, trim_timestamp, union, unroll, window, xml_unroll

**Watch the `pack` id.** Function id `pack` is the *Pack function*: its conf is `{ unpackedFields: string[], target: string }` and it packs fields into one field (`SPEC:5607-5618`). It does **not** route events to a Cribl Pack.

### `eval` (`FunctionConfSchemaEval`)

`SPEC:2457-2499`, `SDK/src/models/functionconfschemaeval.ts:26-60`, with `additionalProperties: false`:

```jsonc
"conf": {
  "add":    [ { "name": "env", "value": "'production'", "disabled": false } ],  // value (a JS expression) is required; name is optional
  "keep":   [ "host", "source" ],        // wildcards allowed; takes precedence over remove
  "remove": [ "identification", "*" ],   // wildcards allowed; quote names containing special chars
  "printUndefineds": false
}
```

- Line anchors: `add` at `SPEC:2461`, `keep` at `SPEC:2481`, `remove` at `SPEC:2488`.
- The description of `remove` reads: "List of fields to remove. Supports * wildcards. Fields that match 'Keep fields' will not be removed" (`SPEC:2488-2494`).
- The SDK example that keeps only one field is `conf: { remove: ["*"], keep: ["name"] }` with `id: "eval"` and `final: true` (`SDK/examples/example-packs.ts:79-89`).
- Spec example `PipelineExamplesEval` is at `SPEC:69581`:

```yaml
functions:
- id: eval
  filter: 'true'
  conf:
    add: [{name: action, value: "login == 'error' ? 'blocked' : action"}]
    keep: [host, source, action, myTags]
    remove: [identification]
```

### `sampling` (`FunctionConfSchemaSampling`)

`SPEC:6543-6563`, `SDK/src/models/functionconfschemasampling.ts:11-26`:

```jsonc
"conf": { "rules": [ { "filter": "__status == 200", "rate": 5 } ] }   // rate is an integer; keeps 1 of N matching events
```

- Each rule requires `filter` and `rate` and has `additionalProperties: false`.
- The spec example `PipelineExamplesSampling` is at `SPEC:70117`.
- The related `dynamic_sampling` function takes `conf: { mode: 'log'|'sqrt', keyExpr, samplePeriod, minEvents, maxSampleRate }` (`SPEC:2352-2390`).

### `drop` (`FunctionConfSchemaDrop`)

- The conf is `{}` (type object with no properties) (`SPEC:2195-2196`; `SDK/src/models/functionconfschemadrop.ts:10`).
- Events are dropped when the function's `filter` matches.
- Spec example at `SPEC:69513`: `{ id: drop, filter: "_raw.search(/success/i)>=0", conf: {} }`.

### `aggregation` (`FunctionConfSchemaAggregation`)

- The wrapper requires `conf.timeWindow` and `conf.aggregations` (`SPEC:8604-8645`).
- The conf fields are at `SPEC:1161-1270`:
  - `timeWindow` (pattern `\d+[sm]$`, `SPEC:1188`)
  - `aggregations: string[]`, minItems 1 (`SPEC:1194`)
  - `groupbys: string[]` (`SPEC:1202`)
  - `passthrough`, `preserveGroupBys`, `sufficientStatsOnly`, `metricsMode`
  - `prefix`, `flushEventLimit`, `flushMemLimit`, `cumulative`, `searchAggMode`
  - `add[]` (`SPEC:1237`)
  - `shouldTreatDotsAsLiterals`, `flushOnInputClose`, `printUndefineds`, `lagTolerance`, `idleTimeLimit`
- Spec example `PipelineExamplesAggregations` is at `SPEC:69288`:

```yaml
- id: aggregation
  filter: 'true'
  conf: {passthrough: false, preserveGroupBys: false, sufficientStatsOnly: false, metricsMode: false,
         timeWindow: 10s, aggregations: ['sum(bytes).where(action=="REJECT").as(TotalBytes)'],
         groupbys: [srcaddr], cumulative: false, shouldTreatDotsAsLiterals: false, flushOnInputClose: true}
```

### `chain`

- The conf is `{ processor: string }`, described as "The data processor (Pack/Pipeline) to send events through" (`SPEC:1592-1598`).
- Example `PipelineExamplesChain` at `SPEC:69424` is `conf: { processor: prometheus_metrics }`.
- cc-di-data-flow-monitor reads `conf.processor` as the target pipeline id (`cc-di-data-flow-monitor/src/api/topology.ts:23-34`).

### Pipeline preview (not in spec)

cc-pipeline-investigator runs events through a saved pipeline with `POST /m/:gid/preview`. The body is (`cc-pipeline-investigator/src/api.ts:397-409`, `:462-473`):

```jsonc
{ "cpuProfile": false, "dropped": false, "mode": "pipe", "pipelineId": "<id>",
  "level": 3, "timeout": 10000, "memory": 2048, "events": [ { /* event */ } ] }
```

- The code comment says "Cribl's preview ignores an inline `pipelineConf` when a `pipelineId` is set", so the app previews a **saved** throwaway clone with prefix `pi_tmp_` (`api.ts:437-445`, `:45`). The clone is created with POST, then PATCHed, then DELETEd (`api.ts:77-115`).
- **The app contradicts itself on pack pipelines.** `previewPipelineBatch` posts to `/m/:gid/p/:pack/preview` (`api.ts:366-370`). `previewOriginalAndOptimized` says "Preview is always group-level — no `/p/:pack` segment" and sends `pipelineId: '<packId>:<pipelineId>'` to `/m/:gid/preview` (`api.ts:457-459`, `:487`, `:494`). Neither form is documented in the spec, and this doc does not resolve the conflict.

---

## 4. Inputs (Sources) and outputs (Destinations)

### Operations

| Op | Method and path | Body | Response / notes | Spec |
|---|---|---|---|---|
| List inputs | `GET /m/:gid/system/inputs?type&offset&limit` | none | `PaginatedInputResponse` | `SPEC:79332-79408` |
| Create input | `POST /m/:gid/system/inputs` | `Input` with `id` required; **omit `criblSourceProvenance`** | `CountedInputResponse`; 409 if the id exists | `SPEC:79409-79607` |
| Get input | `GET /m/:gid/system/inputs/:id` | none | `CountedInputResponse`; 404 if missing | `SPEC:79608-79659` |
| Replace input | `PATCH /m/:gid/system/inputs/:id` | full `Input` | Full replacement. `criblSourceProvenance` is preserved if omitted and cannot be overwritten. | `SPEC:79660-79868` |
| Delete input | `DELETE /m/:gid/system/inputs/:id` | none | `CountedInputResponse` | `SPEC:79869-79917` |
| List outputs | `GET /m/:gid/system/outputs` | none | Paginated | `SPEC:80135-80212` |
| Create output | `POST /m/:gid/system/outputs` | `Output` with `id` required | 409 if the id exists | `SPEC:80213-80434` |
| Replace output | `PATCH /m/:gid/system/outputs/:id` | full `Output` | Full replacement ("Cribl removes any omitted fields") | `SPEC:80488-80719` |
| Delete output | `DELETE /m/:gid/system/outputs/:id` | none | 409 if the output is referenced by another entity | `SPEC:80720-80774` |
| Pack-scoped | `/m/:gid/p/:pack/system/inputs[/:id]`, `/m/:gid/p/:pack/system/outputs[/:id]` | same | same | `SPEC:74933`, `SPEC:75222`, `SPEC:75794`, `SPEC:76107` |

The quoted input PATCH text (`SPEC:79669-79677`) reads: "Provide a complete representation of the Source ... does not support partial updates. Cribl removes any omitted fields ... Cribl preserves `criblSourceProvenance` when you omit it from the request body, and you cannot overwrite it through this endpoint."

**How working apps PATCH inputs and outputs**

- **cc-gigamon-ami** reads the live object whole, deletes only `criblSourceProvenance`, overlays the changed keys, and PATCHes the full body (`cc-gigamon-ami/src/cribl/packClient.ts:843-879`; `cc-gigamon-ami/src/cribl/provision.ts:706-732`).
  - The rationale is in `provision.ts:709-712`: "UNDER FULL-REPLACEMENT SEMANTICS A STRIPPED KEY IS A DELETED KEY".
  - `pq`, `connections`, `metadata`, `tls` and `__template_*` must be carried forward (`provision.ts:724-731`).
- **cc-cribl-power-tools** sends `{ ...original, pipeline }` to set the pre-processing pipeline, and deletes `pipeline` to clear it (`cc-cribl-power-tools/src/api/stream.ts:49-90`).

### Input fields relevant to Meter Reader

These fields are common to all input types. Taken from `InputDatagen`, `SPEC:24464-24562`:

| field | meaning | spec |
|---|---|---|
| `pipeline` | "Pipeline to process data from this Source before sending it through the Routes". This is the **pre-processing pipeline**. | `SPEC:24483-24487` |
| `sendToRoutes` | "Select whether to send data to Routes, or directly to Destinations" | `SPEC:24488-24490` |
| `connections` | QuickConnect: `[{ pipeline?: string, output: string }]`. `pipeline` is titled "Pipeline or Pack". | `SPEC:24513-24519`; `ConnectionConfInputCollection` `SPEC:61698-61708`; `SDK/src/models/connectionconfinputcollection.ts:11` |
| `disabled`, `streamtags`, `metadata[{name,value}]`, `pqEnabled`, `pq`, `environment`, `description`, `criblSourceProvenance` | standard fields | `SPEC:24464-24562` |

- cc-di-data-flow-monitor reads the same trimmed shape: `RawInput { id, type, disabled?, pipeline?, sendToRoutes?, connections?: [{pipeline?, output}] }` (`cc-di-data-flow-monitor/src/api/topology.ts:44-62`).
- Outputs carry a `pipeline` field for post-processing (`topology.ts:71-86`).

### `datagen` input

`InputDatagen` is at `SPEC:24464-24562` (`SDK/src/models/inputdatageninput.ts:18-41`). It **requires** `type` and `samples`.

```jsonc
{
  "id": "mrd_datagen",
  "type": "datagen",
  "disabled": false,
  "sendToRoutes": true,
  "pipeline": "<optional pre-processing pipeline>",
  "samples": [ { "sample": "<sample id/file name>", "eventsPerSec": 10 } ],  // at least 1; both keys required; eventsPerSec >= 1 (default 10), per Worker Node
  "metadata": [ { "name": "origin", "value": "'sample'" } ],
  "streamtags": [], "pqEnabled": false, "description": "…"
}
```

- `samples` is at `SPEC:24522-24542`: "Maximum number of events to generate per second per Worker Node. Defaults to 10." `minimum: 1`.
- The spec create example `InputCreateExamplesDatagen` (`SPEC:65646`) is `{ id: datagen-source, type: datagen, samples: [{sample: sample.json, eventsPerSec: 10}], sendToRoutes: true, pqEnabled: false }`.
- **Working pack config.** `cc-gigamon-ami/packs/cc-network-gigamon-ami/default/inputs.yml:52-74` has `type: datagen`, `disabled: true`, `sendToRoutes: true`, and `samples: [{ sample: gigamon_ami_services, eventsPerSec: 1 }, …]`.
  - There, `sample` is the **key/id** in `default/samples.yml`. The `sampleName` recorded for that key is `gigamon_ami_services.json` (`cc-gigamon-ami/packs/cc-network-gigamon-ami/default/samples.yml:4-10`).
  - `scripts/pack.mjs:464-466` enforces that every `sample` a DataGen names exists as a key in `samples.yml`.
- **UNDETERMINED: which sample field `samples[].sample` must hold.** The evidence points two ways:
  - The gigamon pack uses the samples.yml **key** (`gigamon_ami_services`), while that record's `sampleName` is `gigamon_ami_services.json`.
  - The spec example uses `sample.json` (`SPEC:65652`), which could be either an id or a `sampleName`.

  So the value is either the sample record's `id` or its `sampleName`. **Verify before the demo lever creates a datagen.** Call `GET /m/:gid/system/inputs/<an existing datagen>` on a live group, then compare its `samples[].sample` with both `id` and `sampleName` of the matching `GET /m/:gid/system/samples` item. For a sample uploaded via POST, the returned `items[0].id` is the id (section 6). A wrong key risks a 400 or a source that silently emits nothing (**INFERRED**).
- A DataGen sample file must be **one JSON array document, not NDJSON**. An NDJSON sample "installed, and then every read of its content failed with a 500" (`cc-gigamon-ami/scripts/pack.mjs:13-14`). This was observed for pack-shipped sample files.
- `datagen` sources are licence-exempt (`cc-di-data-flow-monitor/src/lib/licenseExempt.ts:29`).

### `devnull` output

`OutputDevnull` is at `SPEC:34160-34197` (`SDK/src/models/outputdevnull.ts:7-35`). Only `type` is required:

```jsonc
{ "id": "devnull", "type": "devnull", "pipeline": "<optional post-processing>",
  "systemFields": [], "environment": "…", "streamtags": [] }
```

The built-in `default` output (`type: 'default'`) forwards to `defaultId`, which out of the box points at `devnull`. This was confirmed live, and the metrics for `default` carry no `output` dimension (`cc-di-data-flow-monitor/src/lib/topology.ts:455-468`; field in `topology.ts:79-82`).

### Output types (84)

These are the `Output` discriminator values on `type` (`SPEC:56722`, mapping at `SPEC:56808-56895`):

> default, webhook, sentinel, devnull, syslog, splunk, splunk_lb, splunk_hec, wiz_hec, tcpjson, wavefront, signalfx, filesystem, s3, azure_blob, azure_data_explorer, azure_logs, kinesis, honeycomb, azure_eventhub, google_bigquery, google_chronicle, google_cloud_storage, google_cloud_logging, google_cloud_observability, google_pubsub, exabeam, kafka, confluent_cloud, msk, elastic, elastic_cloud, newrelic, newrelic_events, influxdb, cloudwatch, minio, statsd, statsd_ext, graphite, router, sns, sqs, snmp, sumo_logic, datadog, grafana_cloud, loki, amazon_managed_prometheus, prometheus, ring, open_telemetry, service_now, dataset, cribl_tcp, cribl_http, cribl_search_engine, humio_hec, crowdstrike_next_gen_siem, dl_s3, security_lake, cribl_lake, disk_spool, click_house, customer_metrics_storage, local_search_storage, xsiam, netflow, dynatrace_http, dynatrace_otlp, sentinel_one_ai_siem, chronicle, databricks, snowflake_streaming, microsoft_fabric, cloudflare_r2, nutanix_objects, storj_s3, alphasoc_s3, dell_s3, cloudian_s3, scality_s3, alibaba_cloud_s3, ibm_cloud_s3

### Input types (71)

These are the `Input` discriminator values (`SPEC:32301`, mapping at `SPEC:32374` and after):

> collection, kafka, msk, http, splunk, splunk_search, splunk_hec, azure_blob, elastic, confluent_cloud, grafana, loki, prometheus_rw, prometheus, edge_prometheus, office365_mgmt, office365_service, office365_msg_trace, microsoft_graph, eventhub, eventhub_amqp, exec, firehose, google_pubsub, cribl, cribl_tcp, cribl_http, cribl_lake_http, tcpjson, system_metrics, system_state, kube_metrics, kube_logs, kube_events, windows_metrics, crowdstrike, datadog_agent, datagen, http_raw, kinesis, criblmetrics, metrics, s3, s3_inventory, snmp, open_telemetry, model_driven_telemetry, sqs, syslog, file, tcp, appscope, wef, win_event_logs, apple_unified_logs, raw_udp, journal_files, wiz, openai, wiz_webhook, netflow, security_lake, bedrock_s3, servicenow_table, zscaler_hec, cloudflare_hec, sysdig_hec, upwind_hec, openai_compliance_logs, anthropic_compliance, okta

- Metric dimensions key inputs and outputs as `${type}:${id}`, not bare id (`cc-di-data-flow-monitor/src/lib/topology.ts:375-383`).
- The built-in internal source cannot be POSTed. It is found by `type` in `['criblmetrics','cribl']` (`cc-edge-tag-monitoring/src/api/cribl.ts:196-210`).

---

## 5. Referencing a Pack from a route, source or connection: NOT FOUND

**Searched, with no result:**

- **Code and config.** `grep` for `'pack:`, `"pack:`, `` `pack: ``, `pack:${` and `startsWith('pack` across all 16 reference repos (`*.ts, *.tsx, *.js, *.mjs, *.md, *.yml, *.json`). The only hits are npm script names such as `pack:check`.
- **The spec.** No `pack:` value literal appears in `SPEC`. `ConnectionConfInputCollection.pipeline` is titled "Pipeline or Pack" and gives no format (`SPEC:61701-61704`). `FunctionConfSchemaChain.processor` says "(Pack/Pipeline)" and gives no format either (`SPEC:1592-1598`).
- **docs.cribl.io/stream/packs/.** Packs appear with a "PACK badge" in the Pipeline column and are selectable "in all places where you can reference a Pipeline". No literal config syntax is given.

**What is known**

- `RouteConf.context` and `RouteConf.targetContext` take `group` or `pack` (`SPEC:57255-57260`, `RouteConf` `SPEC:57261-57324`). **INFERRED:** these fields may be part of how a route hands off to a pack. This has not been measured.
- `cc-pipeline-investigator` uses `<packId>:<pipelineId>` as an **app-internal** id (`src/api.ts:50-55`, `:172`). It also sends that form as `pipelineId` to group-level preview (`:487`, `:494`). That is a pipeline inside a pack, not a route-to-pack reference.
- `PATCH /packs/:id` (upgrade) says "update any Routes, Pipelines, Sources, and Destinations that use the previous Pack version so that they reference the upgraded Pack" (`SPEC:77251-77253`). This confirms that such references exist, but not their spelling.

**How to verify on a live Leader** (read-only, so no confirmation is needed)

1. In the Cribl UI, set one route's Pipeline to a Pack, save, and do not commit.
2. Call `GET /m/:gid/routes` and read `items[0].routes[i].pipeline`, `.context` and `.targetContext` for that route.
3. For a Source, set its pre-processing pipeline or a QuickConnect connection to a Pack, then `GET /m/:gid/system/inputs/:id` and read `pipeline` and `connections[].pipeline`.

Until that is done, Meter Reader must not construct pack references. It should display whatever string the API returns.

---

## 6. Sample files (`/m/:gid/system/samples`): working app code, not in the spec

The SDK has **no** `/system/samples` operation:

- `grep -rn "system/samples" SDK/src` returns nothing.
- `SDK/src/sdk/samples.ts:5-6` wraps `destinationsSamplesCreate` and `destinationsSamplesGet`, which are **Destination** samples (`GET /system/outputs/:id/samples`, `SPEC:80861`).

### Observed calls (cc-sample-sanitizer, a working app)

| Op | Method and path | Body | Response read | Cite |
|---|---|---|---|---|
| List | `GET /m/:gid/system/samples` | none | `{ items: [{ id, sampleName, size, numEvents, description?, isTemplate? }] }` | `cc-sample-sanitizer/src/sample-io.ts:274-280`; `isTemplate` filter at `cc-pipeline-investigator/src/api.ts:198-206` |
| Content | `GET /m/:gid/system/samples/:id/content` | none | An array of events (objects with `_raw`, `_time`, and `__criblEventType`, `__ctrlFields`, `__final`, `__cloneCount` to strip). Some deployments return strings or `{items}`. | `sample-io.ts:294-299`; `cc-pipeline-investigator/src/api.ts:227-252` |
| Create | `POST /m/:gid/system/samples` | `{ sampleName, description?, context: { events: [ { _raw, _time } ] } }` | New id read as `items[0].id`, falling back to `id` | `sample-io.ts:403-415`, `:692-705` |
| Update | `PATCH /m/:gid/system/samples/:id` | `{ id, sampleName, description?, context: { events: [...] } }` | none | `sample-io.ts:407-412`, `:697-702` |
| Delete | `DELETE /m/:gid/system/samples/:id` | none | none | `sample-io.ts:721` |
| Pack samples | `GET /m/:gid/p/:pack/system/samples` and `/p/:pack/system/samples/:id/content` | none | same shapes | `sample-io.ts:321-339` |

The exact create body, from `cc-sample-sanitizer/src/sample-io.ts:403-406`:

```ts
const sampleBody = {
  sampleName,
  context: { events: events.map(raw => ({ _raw: raw, _time: Date.now() / 1000 })) },
};
```

- Upsert is done by name: list, find `sampleName === name`, then PATCH if it exists or POST if not (`sample-io.ts:400-415`).
- `description` is a free string. The sanitizer stores JSON in it as a cross-app metadata carrier (`sample-io.ts:574-591`).
- The policies it declares are:
  - `/m/*/system/samples` with GET and POST
  - `/m/*/system/samples/*` with GET, PATCH and DELETE
  - `/m/*/system/samples/*/content` with GET
  - `/m/*/packs` with GET
  - `/m/*/p/*/system/samples` and `/m/*/p/*/system/samples/*/content` with GET

  Source: `cc-sample-sanitizer/config/policies.yml:17-37`.
- Pack-shipped sample records on disk carry `{ sampleName, isTemplate, tsTemplateField, created, size, numEvents }` (`cc-gigamon-ami/packs/cc-network-gigamon-ami/default/samples.yml:4-10`).

**UNVERIFIED alternative. Do not use.** `cc-pipeline-investigator/src/api.ts:255-279` (`uploadTempSample`) tries **PUT** with `{ id, content: ndjson }` against six guessed URLs, including `/system/datagen/:id` and `/lib/datagen/:id`, and throws if all fail. It is a probe loop, not a confirmed API shape.

---

## 7. Packs (`/m/:gid/packs`)

| Op | Method and path | Body | Response | Spec |
|---|---|---|---|---|
| List | `GET /m/:gid/packs?with=inputs,outputs,collectors&offset&limit` | none | `PaginatedPackInfo` | `SPEC:77066-77136`, `SPEC:60071` |
| Upload `.crbl` | `PUT /m/:gid/packs?filename=<name>`, content-type `application/octet-stream` | binary | `{ source: "<staging id>" }` (`UploadPackResponse`) | `SPEC:77137-77189`, `SPEC:60118` |
| Install | `POST /m/:gid/packs` | `PackRequestBody` | `CountedPackInstallInfo` | `SPEC:77002-77063`, `SPEC:59892-59978`, `SPEC:59778` |
| Get | `GET /m/:gid/packs/:id` | none | `CountedPackInfo` | `SPEC:77190-77236` |
| Upgrade | `PATCH /m/:gid/packs/:id` | `PackUpgradeRequest { source (required), allowCustomFunctions?, minor?, spec? }` | `CountedPackInfo` | `SPEC:77237-77297`, `SPEC:60094` |
| Uninstall | `DELETE /m/:gid/packs/:id` | none | `CountedPackUninstallInfo { id, source }` | `SPEC:77298-77340` |
| Export (not in spec) | `GET /m/:gid/packs/:id/export?mode=merge&filename=<id>.crbl` | none | binary | `cc-cribl-power-tools/src/api/packs.ts:33-48` |

### Install body

`PackRequestBody` is at `SPEC:59892-59978` (`SDK/src/models/packrequestbodyunion.ts:30-146`). It has `anyOf` required `id` **or** `source`:

```jsonc
{
  "source": "https://…/x.crbl" | "git+https://github.com/org/repo" | "<staging id from PUT>",  // omit to create an empty pack
  "id": "my-pack",
  "allowCustomFunctions": false,   // true OR OMITTED means custom JS functions are allowed
  "force": true,                   // overwrite an existing pack with the same id
  "spec": "<semver range>", "version": "1.0.0", "displayName": "…", "author": "…", "description": "…",
  "minLogStreamVersion": "…", "tags": { "dataType": [], "domain": [], "technology": [], "streamtags": [] }
}
```

Spec examples:

- **Dispensary** (`SPEC:72786`): `{ source: "https://packs.cribl.io/dl/cribl-duo-rest-io/latest/cribl-duo-rest-io-latest.crbl", force: true, allowCustomFunctions: true }`
- **URL** (`SPEC:72814`): `{ source: "https://github.com/criblpacks/cribl-palo-alto-networks/releases/download/1.1.4/cribl-palo-alto-networks-a3e5a19d-1.1.4.crbl", allowCustomFunctions: false }`
- **Git** (`SPEC:72821`): `{ source: "git+https://github.com/criblio/cribl_ocsf_postprocessing", allowCustomFunctions: false }`
- **Uploaded** (`SPEC:72805`): `{ source: "cribl-search-missing-logs-1.0.1.Do7DH5I.crbl", id: "cribl-search-missing-logs", allowCustomFunctions: false }`
- **Empty pack** (`SPEC:72794`): `{ id, displayName, version: "0.0.1", tags: { streamtags: [] }, exports: [] }`

Working app calls:

- **cc-gigamon-ami:** `capi('POST', '/m/<g>/packs', { id: PACK_ID, source: PACK_URL, allowCustomFunctions: false })` (`cc-gigamon-ami/src/cribl/packClient.ts:614`). The Leader downloads the URL itself, and there is no digest parameter (`packClient.ts:109-113`).
- **cc-cribl-power-tools:** uploads with PUT, then installs with `POST { id, source: <staging id>, ... }` (`cc-cribl-power-tools/src/api/managementPlane.ts:145-177`; types at `src/api/types.ts:255-268`).
- **SDK:** `cribl.packs.install({ source: PACK_URL, id: PACK_ID }, { serverURL: groupUrl })` (`SDK/examples/example-packs.ts:108`).

**Install response and list item** (`PackInfo`, `SPEC:60008-60093`, `SDK/src/models/packinfo.ts:15`):

- Required: `id` and `source`.
- Also: `author, collectors, dependencies, description, displayName, exports[], inputs, isDisabled, minLogStreamVersion, outputs, settings, spec, tags, version`, and `warnings[]` in the install response.
- Example at `SPEC:72770`: `{ id: cribl-palo-alto-networks, displayName, version: 1.1.4, author: Cribl, source: "<url>", exports: [pipelines, inputs], warnings: [] }`.

After an install, cc-gigamon-ami identifies its own pack by **both** `version` and `source === <release URL>` from the list (`packClient.ts:66-72`, `:205-224`).

---

## 8. Create and update matrix

| Object | Create | Update | Delete | Update semantics |
|---|---|---|---|---|
| Route | `POST /m/:gid/routes/default/append` (body `RouteConfInput[]`, added **at the end**) or GET + splice + `PATCH /m/:gid/routes/default` | `PATCH /m/:gid/routes/default` with the whole table | Omit the route from the PATCH | Whole table replaced. Omitted routes are removed. |
| Pipeline | `POST /m/:gid/pipelines` with `{id, conf}` | `PATCH /m/:gid/pipelines/:id` with the full object | `DELETE /m/:gid/pipelines/:id` | Full replacement |
| Input | `POST /m/:gid/system/inputs` (id required; 409 on duplicate) | `PATCH /m/:gid/system/inputs/:id` with the full object | `DELETE …/:id` | Full replacement; `criblSourceProvenance` preserved |
| Output | `POST /m/:gid/system/outputs` (id required; 409 on duplicate) | `PATCH /m/:gid/system/outputs/:id` with the full object | `DELETE …/:id` (409 if referenced) | Full replacement |
| Sample | `POST /m/:gid/system/samples` | `PATCH /m/:gid/system/samples/:id` | `DELETE …/:id` | App code only; not in spec |
| Pack | `POST /m/:gid/packs` | `PATCH /m/:gid/packs/:id` with `{source}` | `DELETE /m/:gid/packs/:id` | Upgrade from source |

- There is **no PUT** for any of these config objects. The only PUT is pack upload.
- Idempotent upsert pattern: GET by id; on 404 POST, otherwise PATCH (`cc-edge-tag-monitoring/src/api/cribl.ts:321-341`).
- Every write above counts as volatile under `AGENTS.md:78-91`. It needs an explicit button, a confirmation naming the resource and action, and never runs on load or on a timer.

---

## 9. Making changes live: commit, then deploy

Config writes to `/m/:gid/...` are pending until they are committed and deployed. The SDK example commits and then deploys (`SDK/examples/example-stream.ts:141-155`).

- **Commit:** `POST /m/:gid/version/commit` with `GitCommitBody { message (required), files?: string[], effective?: boolean }` (`SPEC:81515-81577`, `SPEC:60858-60876`).
  - "If omitted, all pending changes are committed" (`SPEC:60866-60870`).
  - `effective: true` requires a group context.
  - The response is `{ items: [{ commit: "<hash>", ... }] }` (`cc-edge-tag-monitoring/src/api/cribl.ts:283-294`).
- **Deploy:** `PATCH /products/stream/groups/:gid/deploy` with `DeployRequest { version: "<commit hash>" (required), lookups? }` (`SPEC:78279-78341`).
  - Apps also use the legacy `PATCH /master/groups/:gid/deploy` with body `{ version }` (`cc-edge-tag-monitoring/src/api/cribl.ts:300`; `cc-cribl-power-tools/src/api/managementPlane.ts:197-209`).
- cc-gigamon-ami always passes an explicit `files` list, because an empty list commits everyone's pending changes (`cc-gigamon-ami/config/policies.yml:515-530`).

---

## 10. `policies.yml` object spellings (observed in all apps)

- **Schema.** Every app uses `policies: [ { object: '<path>', actions: [...] } ]`, which matches `AGENTS.md:207-250`.
  - No app prefixes objects with `/api/v1`.
  - No app uses partial-id wildcards such as `mrd_*`.
  - Placeholder segments appear in two forms: `:gid`, `:id`, `:pack` or `:tableId` in most apps, and `*` in cc-sample-sanitizer.
- **Examples:**
  - `'/m/:gid/routes'` GET and `'/m/:gid/routes/:tableId'` PATCH (`cc-gigamon-ami/config/policies.yml:511-514`)
  - `'/m/:gid/pipelines'` GET/POST and `'/m/:gid/pipelines/*'` GET/PATCH (`cc-edge-tag-monitoring/config/policies.yml:58-61`)
  - `'/m/:gid/system/inputs/*'` PATCH (`cc-cribl-power-tools/config/policies.yml:76-77`)
  - `'/m/:gid/packs'` GET/POST (`cc-gigamon-ami/config/policies.yml:391-392`)
  - `'/m/*/system/samples'` GET/POST (`cc-sample-sanitizer/config/policies.yml:20-21`)
  - `'/m/:gid/version/commit'` POST (`cc-visicore-lookup-sync/config/policies.yml:27-28`)
  - `'/master/groups/:id/deploy'` PATCH (`cc-visicore-lookup-sync/config/policies.yml:12-13`)
  - `'/products/stream/groups/:gid/deploy'` PATCH (`cc-gigamon-ami/config/policies.yml:271-272`)
- **Mismatch in Meter Reader's own spec.** `meter-reader-v4.16/METER_READER_SPEC.md:98-118` writes grants as `paths: - path: /api/v1/m/*/pipelines ; methods: [GET]`. It also writes partial-id grants such as `/api/v1/m/*/pipelines/mrd_*`.
  - That is not the `AGENTS.md` schema, which uses `policies:`, `object:` and `actions:` with no `/api/v1` prefix.
  - Partial-id wildcards have no precedent in any reference app. **INFERRED:** they may not match. If they are not supported, grant the collection or `/*` and enforce the `mrd_` prefix in code.
- **Worker paths.** `/w/:wid/...` must also declare the matching `/m/:gid/...` path (`AGENTS.md:228-231`).
- **Outlier. Do not copy.** `cc-config-inspector/config/policies.yml:13-16,27-30` declares input and output grants as `/inputs`, `/outputs`, `/m/:gid/inputs` and `/m/:gid/outputs`, with no `system/` segment. No other app does this, and these match no path in `SPEC`, where inputs and outputs live under `/system/`.

---

## 11. Not in the bundled spec, with who uses each

| Path | Used by | Status |
|---|---|---|
| `/m/:gid/system/samples[/:id[/content]]`, `/m/:gid/p/:pack/system/samples…` | cc-sample-sanitizer, cc-pipeline-investigator | Working apps; the spec has no schema |
| `POST /m/:gid/preview`, `POST /m/:gid/p/:pack/preview` | cc-pipeline-investigator | App code only; the app is internally inconsistent about pack scope |
| `GET /m/:gid/packs/:id/export` | cc-cribl-power-tools | App code only |
| `/system/metrics/query` | named in `METER_READER_SPEC.md:107` | Not in `SPEC` path list (`SPEC:73314-81994`, 77 paths) |

The full path list of the bundled spec is 77 paths, `SPEC:73315-81994`. It includes:

- `/routes`, `/pipelines`, `/packs`, `/system/inputs`, `/system/outputs`, `/system/status/*`, `/system/capture`, `/system/settings/*`
- `/version/*`, `/products/{product}/groups/*`, `/products/lake/*`, `/lib/jobs`, `/lib/database-connections`, `/functions`
- `/p/{pack}/...` mirrors of the config paths

---

## 12. Reproduce

```sh
cd scratchpad/ref/cribl-control-plane-sdk-typescript
grep -nE "^  /" .speakeasy/out.openapi.yaml                       # 77 paths
grep -nE "^    (RouteConf|Pipeline|PipelineFunctionEval|FunctionConfSchemaEval|FunctionConfSchemaSampling|InputDatagen|OutputDevnull|PackRequestBody):" .speakeasy/out.openapi.yaml
grep -rn "system/samples" src                                    # empty: not an SDK operation
```

PyYAML needs a constructor for the `tag:yaml.org,2002:value` tag (`=` at `SPEC:4820`) to load the spec.
