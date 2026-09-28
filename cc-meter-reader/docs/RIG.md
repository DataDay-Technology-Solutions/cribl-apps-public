# The Meter Reader demo rig

The live rig in the dedicated Cribl.Cloud build org (workspace `main`, Worker Group `default`, Cribl 4.20.1): six Datagen Sources, their routes, the demo pipelines and three simulated destinations. It is the traffic Meter Reader prices on stage (PRD 9 and 9.1, SPEC 2 and 14).

First written 2026-09-26 about 04:45 UTC; rewritten 07:00 UTC with the live measurements (sections 5–7 and 9). **The machine-readable numbers are in `demo/rig/measured.json`; the raw measurement windows are in `demo/rig/measurements/`.**

## 1. Status

**Running at the full PRD 9.1 design rate, 450 GB/day in (rateFactor 1.0), since 2026-09-26 06:19 UTC, in the design state** (windows_dc, payments_api and k8s_prod reduced; windows_workstations, pan_firewall and vpc_flow raw; the payments trim intact). Deployed head: `603840d`.

| Part | State | Where |
|---|---|---|
| Destinations `mrd_siem_prod`, `mrd_analytics`, `mrd_archive_s3` (DevNull) | committed and deployed | `9a1d943…` |
| Pipelines (8, all `mrd_*`) | committed and deployed | `9a1d943…`; `mrd_win_docs_reduce` retuned in `9f8871f…` |
| Samples (5 Datagen files: sample library, `isTemplate: true`, name = id) | committed and deployed | `9a1d943…`, `3d2a5d6…`, `329776f…` |
| Routes (6 `mrd_*` routes at the top of `default`) | committed and deployed | `9a1d943…`; design state re-deployed in `603840d` |
| Datagen Sources (6 `mrd_*` inputs) | **committed and deployed with the group key (D19); running at rateFactor 1.0** | `01710cb` (sources + `auth/cribl.secret`), rate steps `152e8c5` → `e454b62` → `5ea3df4` |
| Worker secret decryption | **DECRYPTS** (`probe-secrets.mjs`, 05:52 UTC) | probe `753380f` / removed `323bb96` |
| Traffic, measured ratios, measured GB/day, economics | **measured** (sections 5, 6, 9) | `demo/rig/measured.json` |

The rig's commits on `default`, oldest first:

| Commit | Message |
|---|---|
| `9a1d943` | demo: apply the Meter Reader rig (outputs, pipelines, samples, routes) |
| `861b265` / `66d67ab` | demo: temporary probe mrd_probe_secret / remove it (result then: DOES NOT DECRYPT) |
| `9f8871f` | demo: tune mrd_win_docs_reduce (Go aggressive keeps System metadata) |
| `3d2a5d6` | demo: flag the rig samples as Datagen files (isTemplate) |
| `329776f` | demo: rig sample names equal their ids (Datagen file lookup) |
| `01710cb` | demo: apply the Meter Reader rig (sources) — `inputs.yml` + `auth/cribl.secret` (D19) |
| `c7098ca` / `e72069c`, `113b9cd` / `ade20c5` | probe runs during the Worker reload: NO REQUEST RECEIVED (the probe did not wait for the reload; fixed) |
| `753380f` / `323bb96` | probe run: **DECRYPTS** |
| `152e8c5` | demo: rig rate factor 0.5 (capacity step) |
| `e454b62` | demo: rig rate factor 0.75 (capacity step) |
| `5ea3df4` | demo: rig rate factor 1.0 (PRD 9.1 design rate, 450 GB/day) |
| `48d2609` | demo: measurement run - packs on the raw routes (workstations Go aggressive, Palo Alto, VPC) and the payments trim broken; reverted next |
| `603840d` | demo: restore the rig design state after the measurement run (raw routes raw, payments trim restored) |

Each commit passed an explicit file list. After `01710cb`, none includes `auth/users.json`, `secrets.yml` or `package.json` (the org's own pending files, still pending).

## 2. The group key (resolved, D19)

**Before D19.** Creating any Source made the Leader re-serialize `inputs.yml` and re-encrypt the default HEC Source's token (`#42:…`). The group key `auth/cribl.secret` had never been committed on this fresh org, and a probe proved the Worker could not decrypt (`Authorization: Bearer #42:…` arrived at webhook.site). Committing `inputs.yml` alone would have broken that HEC token, so the rig refused.

**D19.** `inputs.yml` and `auth/cribl.secret` were committed together (`01710cb`, 05:45 UTC), the standard Commit & Deploy on a new org. `node scripts/rig/probe-secrets.mjs` then printed **`Worker secret decryption: DECRYPTS`** (05:52 UTC): the dummy Bearer token arrived in plaintext. No rollback was needed.

- **Why the first probe runs printed NO REQUEST RECEIVED.** They ran seconds after the key commit, while the Worker was reloading (`info.cribl.startTime` 05:45:32): the probe found its Destination in the Leader's view, sent the test event into a reloading Worker, and read webhook.site 4 s later. The probe now waits until the Worker's `info.cribl.config.version` equals the probe's commit and the Worker serves the Destination, settles 15 s, sends the test event up to 3 times and polls webhook.site for 60 s each.
- **After D19, rate changes no longer re-encrypt anything.** The `inputs.yml` diff of each rate step contained only the six `eventsPerSec` lines. `--accept-reserialization inputs.yml` is still harmless to pass.
- **Rollback (kept for reference).** If `probe-secrets.mjs` ever prints anything but DECRYPTS: `POST /m/default/version/revert {"commit": "<hash>"}`, then deploy the revert commit (`PATCH /products/stream/groups/default/deploy {"version": "<revert hash>"}`).

**Tell the demo-function builder:** `demoSetRate` commits `inputs.yml`; its hunks start inside the Source (git's 3 context lines do not reach `  mrd_<id>:`), so an owner check must resolve them the way `planCommit` now does (section 8).

## 3. Objects

Every object id starts with `mrd_`, and every description (for pipelines, `conf.description`) contains `[meter-reader-demo]`. Nothing else in the group was created, changed or deleted.

### Destinations (`demo/rig/destinations.json`)

| id | type | Meter Reader price preset | receives |
|---|---|---|---|
| `mrd_siem_prod` | devnull | `splunk_cloud` | windows_dc, windows_workstations, pan_firewall, payments_api |
| `mrd_analytics` | devnull | `datadog` | k8s_prod |
| `mrd_archive_s3` | devnull | `s3` | vpc_flow |

The Leader adds `systemFields: [cribl_pipe]` to each destination. Nothing leaves the org.

### Sources and routes (`demo/rig/sources.json`)

| Source / route id | sample | design GB/day | route pipeline (default) | "Apply the pack" | output |
|---|---|---|---|---|---|
| `mrd_windows_dc` | `mrd_windows_security_xml` | 150 | `mrd_win_xml_pack` | — (reduced all week) | `mrd_siem_prod` |
| `mrd_windows_workstations` | `mrd_windows_security_xml` | 80 | `mrd_passthrough` | `mrd_win_xml_pack`; Go aggressive: `mrd_win_docs_reduce` | `mrd_siem_prod` |
| `mrd_pan_firewall` | `mrd_pan_traffic` | 60 | `mrd_passthrough` | `mrd_pan_pack` (includes syslog pre-processing) | `mrd_siem_prod` |
| `mrd_vpc_flow` | `mrd_vpc_flow_v2` | 60 | `mrd_passthrough` | `mrd_vpc_pack` | `mrd_archive_s3` |
| `mrd_payments_api` | `mrd_api_access` | 40 | `mrd_pay_sample` (break-the-trim target) | — | `mrd_siem_prod` |
| `mrd_k8s_prod` | `mrd_k8s_container` | 60 | `mrd_k8s_noise` | — | `mrd_analytics` |

- **Sources.** Each is `type: datagen`, `sendToRoutes: true`, `pqEnabled: false`, with `samples: [{ sample: <sample id>, eventsPerSec }]`.
- **Routes.** Each has `final: true`, `filter: __inputId=='datagen:<id>'` and an explicit `output`, and the six sit at the **top** of route table `default`. The existing `default` route (`main` → `default`) was sent back exactly as it was read. The Leader wrote it into `local/cribl/pipelines/route.yml`, unchanged, because the table is saved whole.
- **Metrics keys.** Inputs are `datagen:mrd_<source>`, routes are `mrd_<source>`, and outputs are `devnull:mrd_<dest>`.

### Pipelines (`demo/rig/pipelines.json`)

| id | role | functions | provenance |
|---|---|---|---|
| `mrd_passthrough` | raw | none | hand-built |
| `mrd_pay_sample` | reduced, trim target | sampling 1:2 → serde JSON → **eval `[mr-trim]` remove `headers,user_agent,request_body`** (index 2) → serialize JSON → keep `_raw,_time` | hand-built (SPEC 14.2) |
| `mrd_k8s_noise` | reduced, trim | drop `"level":"debug"` (matched on `_raw` before parsing) → serde JSON → **eval `[mr-trim]` remove `labels`** (index 2) → serialize → keep `_raw,_time` | hand-built (SPEC 14.2) |
| `mrd_win_xml_pack` | pack | the pack's 13 functions: whitespace cleanup, `C.Text.parseWinEvent`, flatten, rename, auto-timestamp, mask, regex, serialize, keep-list, dedupe code | **imported from the Dispensary pack** `cribl_splunk_forwarder_windows_xml_events_to_json` **1.2.0** (David Maislin, Cribl; published 2025-12-04; README "30–35%"), pipeline `Splunk_UF_Windows_XML_WEC_WEF_Sysmon`. Comment functions omitted and `disabled: null` normalized to false; nothing else changed. |
| `mrd_win_docs_reduce` | aggressive | parseWinEvent with empty values dropped → remove `RenderingInfo`, provider GUID, correlation, security, version, opcode → flatten → rename → serialize → keep `_raw,_time` | hand-built after Cribl Docs "Reducing Windows XML Events" (documented 34–70%) |
| `mrd_syslog_pre` | pre | one eval: when an RFC 3164 header is present, `host` = sender and `_raw` = body | hand-built. The Dispensary pack `cribl-syslog-input` 1.3.1 requires a Syslog Source (`__inputId` `syslog:*`, `__syslogFail`) and cannot run on Datagen events. |
| `mrd_pan_pack` | pack | **chain → `mrd_syslog_pre`**, then the pack's `pan_traffic` steps: Splunk metadata + cut to the CSV body → CSV extract (130 PAN-OS 11 fields) → auto-timestamp → remove `future_use*` and fields the TA does not use → reserialize CSV → keep `_raw,_time,index,host,source,sourcetype` | **imported from the Dispensary pack** `cribl-palo-alto-networks` **1.1.8** (Josh Rice, Cribl; published 2026-09-22), pipeline `pan_traffic`. Pack variables inlined (`pan_default_source`, `pan_default_index`, `out_format=csv`); the disabled optional sampling and drop groups omitted; the `device_info.csv` time-zone lookup omitted (times are UTC). |
| `mrd_vpc_pack` | pack | serde delim (space) with the 14 v2 fields → drop NODATA/SKIPDATA → **aggregation 60s**: `sum(bytes)`, `sum(packets)`, `count()` by `srcaddr, dstaddr, dstport, action` → serialize → keep `_raw,_time` | SPEC 14.1 documented fallback. The Dispensary pack `cribl-vpc-flow-for-security-teams` 1.0.3 aggregates through **Redis**, which is not available here; its field extraction and NODATA filter are followed. |

### Why the packs are imported rather than installed (SPEC 14.1)

- **The Dispensary works.** Its listing is `https://packs.cribl.io/api/v1/packs/dispensary` and its downloads are `https://packs.cribl.io/dl/<name>/latest/<name>-latest.crbl`. All four packs downloaded (200). The Windows pack's real name uses underscores, `cribl_splunk_forwarder_windows_xml_events_to_json`; the hyphenated name in SPEC 14.1 returns 403.
- **The packs were not installed with `POST /m/default/packs`.**
  - A pack's id is not `mrd_`, and installing one rewrites the group's `package.json`, which was already pending with the org's own changes before the rig ran. That is not the rig's file to change or commit.
  - The route-to-pack reference syntax is undocumented (config-apis.md §5).
  - Two of the four packs cannot run on this data anyway: Syslog needs a Syslog Source, and VPC needs Redis.
- **The imports are the same functions the packs run**, so the ratio Meter Reader measures is the pack's ratio on this data. Each pipeline's `provenance` field in `pipelines.json` records exactly what changed.
- **License (resolved, D59).** The pack archives carry no LICENSE file, so the rig ships no pack pipeline to install: `demo/rig/pipelines.json` keeps `mrd_win_xml_pack` and `mrd_pan_pack` as shells naming their pack, version and pipeline (`fromPack`) with their `provenance`, and `scripts/rig/apply.mjs` leaves those two pipelines to the organization (it prints what to install when one is missing). The recorded replay (`demo/sample/replay.json`) and the mock emulator (`testdata/gen.ts`) still quote pack functions as the organization returned them; see D59 (amended) and the README's Pack attribution. The demo organization still runs its imported copies, and since 9/27 also has both packs installed from the Dispensary for the stage demo.

### Notes for the demo-function builder (SPEC 11)

- **Apply the pack.** Swap the route's `pipeline` to `sources.json` `packPipeline`, or `aggressivePipeline` for "Go aggressive". For `mrd_pan_firewall`, `preProcessingOnApply` is `null`. **Do not set the Source's pre-processing pipeline.** `mrd_pan_pack` already chains `mrd_syslog_pre` inside the route. Meter Reader measures flows at `route.in_bytes → route.out_bytes`, so pre-processing on the Source would shrink "in" and hide the savings.
- **Break the trim.** The `[mr-trim]` function is at **index 2** in both `mrd_pay_sample` and `mrd_k8s_noise`, and it is the only function in each pipeline whose description contains `[mr-trim]`.
- **Throttles.** `demo/rig/throttles.json` holds `baselineEventsPerSec` per Source (1 Worker Node, **rateFactor 1.0**, regenerated 2026-09-26 06:39Z). `demoSetRate` sets `samples[0].eventsPerSec = round(baseline × multiplier)`, and `eventsPerSec` is **per Worker Node** (measured: the Node's two Worker Processes share it; every full minute carries exactly eventsPerSec × 60 events). **Every rate change commits `inputs.yml`.** Since D19 that commit touches only the `eventsPerSec` lines (measured at 06:06Z: no HEC re-encryption), and `planCommit` attributes those lines to the rig even when git's context does not reach the Source's id line (section 8). Spacing: keep commits ≥ 2 minutes apart; each deploy reloads the Worker for ~20–40 s (the minute of a deploy reads short). **Capacity caveat:** the 10× maximum was not load-tested at rateFactor 1.0 (section 6).
- **Datagen `samples[].sample`.** A Datagen Source can use only sample-library records flagged `isTemplate: true`. Those are "Datagen files" (Cribl Docs, Datagens: "Create a Datagen File"), and every built-in Datagen file (weblog, syslog, palo_alto_traffic, …) carries the flag. The rig's samples are flagged, and each has **sampleName equal to its id**, so `sample: <id>` resolves whichever field the Leader matches (`sources.json` `datagenSampleField: "id"`). This is confirmed live once the Sources run: `verify.mjs` must show in-bytes for all six.

## 4. Samples (`testdata/samples.ts` → `demo/rig/samples/`)

`npx tsx testdata/samples.ts` generates the files, and `--check` fails if the files on disk are stale.

- **Determinism.** The generator is seeded (seed 20260926) and fully synthetic. Hosts are `*.example.com`, addresses come only from 10/8 and the three documentation ranges, the account is AWS's documentation placeholder, and users are role accounts.
- **Format.** Each file is **one JSON array of `{_raw,_time}`**, the sample-library format; an NDJSON sample breaks Datagen.
- **Upload.** Each file is uploaded with `POST /m/default/system/samples {id, sampleName (= id), description, isTemplate: true, context:{events}}`. The body stays under 90 KB, and the description carries a content hash so a re-apply detects regenerated samples. Updates carry `created` forward, because PATCH replaces the record.

| file → sample id | events | avg B/event (min–max) | upload | composition |
|---|---|---|---|---|
| `windows-security-xml.log` → `mrd_windows_security_xml` | 33 | 2,529 (1,984–3,047) | 88.9 KB | 4624 ×15, 4688 ×9, 4663 ×9; Splunk forwarder XML with RenderingInfo |
| `pan-traffic.log` → `mrd_pan_traffic` | 64 | 826 (725–912) | 55.2 KB | `<14>` RFC 3164 header + PAN-OS 11 TRAFFIC CSV (130 fields) |
| `vpc-flow-v2.log` → `mrd_vpc_flow_v2` | 420 | 112 (106–116) | 60.4 KB | 28 repeating (src, dst, dstport, action) conversations |
| `api-access.json` → `mrd_api_access` | 56 | 1,138 (924–1,293) | 73.7 KB | `headers`+`user_agent`+`request_body` = **55.6%** of bytes |
| `k8s-container.log` → `mrd_k8s_container` | 84 | 782 (747–810) | 76.2 KB | debug = **40.9%** of bytes (40.5% of events); `labels` = **53.3%** of what remains |

`main()` asserts these composition bounds and exits non-zero if a generator change breaks one. `manifest.json` records every number above.

## 5. Ratios (measured)

**Windows.** Design state: 2026-09-26 06:41–06:51 UTC (10 minutes at rateFactor 1.0). Levers: 06:28–06:38 UTC (10 minutes at rateFactor 1.0, commit `48d2609`: workstations on Go aggressive, Palo Alto on `mrd_pan_pack`, VPC on `mrd_vpc_pack`, payments trim disabled). Every minute of both windows ran at 100.0% of the applied rate.

Two ratios are measured per route, because **Cribl's `route.out_bytes` is an estimate that is not byte-accurate for reshaped events** (measured, see below):

- **true** = 1 − (bytes the Destination receives) / `route.in_bytes`. For a Destination fed by one route (analytics ← k8s, archive-s3 ← vpc) it is that Destination's own `total.out_bytes`; for `mrd_siem_prod` (four routes) it is `route.out_events` × the mean `_raw` bytes of 400 live events per route captured just before the Destination (`POST /m/default/system/capture`, level 3). The capture sums reconcile with every Destination's `total.out_bytes` to within **0.16%**.
- **route** = 1 − `route.out_bytes` / `route.in_bytes`, which is what Meter Reader's route attribution (`core/flows.ts` `attributeWindow`, SPEC 7) prices today.

| route / pipeline | target | predicted (preview, `_raw`) | **true (measured)** | route estimate (what the app reads) |
|---|---|---|---|---|
| windows_dc / `mrd_win_xml_pack` | 0.30–0.35 | 0.342 | **0.342** ✓ | 0.501 ✗ (out of ±10) |
| windows_workstations / `mrd_passthrough` | 0.00 | 0.000 | **0.000** ✓ | −0.013 |
| ↳ Apply the pack (`mrd_win_xml_pack`) | 0.30–0.35 | 0.342 | **0.342** (= windows_dc: same sample, same pipeline) | 0.501 |
| ↳ Go aggressive (`mrd_win_docs_reduce`) | 0.60–0.75 | 0.702 | **0.701** ✓ | 0.905 |
| pan_firewall / `mrd_passthrough` | 0.00 | 0.000 | **0.000** ✓ | −0.035 ✗ (raw band ±0.03) |
| ↳ Apply the pack (`mrd_pan_pack`) | 0.35–0.50 | 0.371 | **0.371** ✓ | 0.519 |
| vpc_flow / `mrd_passthrough` | 0.00 | 0.000 | **0.000** ✓ | −0.183 ✗ |
| ↳ Apply the pack (`mrd_vpc_pack`) | large | ≈ 0.999 | **0.9998** ✓ (560 aggregate rows in 10 min = 28 conversations × 2 Worker Processes × 10) | 0.99977 |
| payments_api / `mrd_pay_sample` | 0.75 (0.70–0.80) | 0.781 | **0.773** ✓ | 0.829 (varied 0.77–0.89 between windows) |
| ↳ trim broken | 0.45–0.55 | 0.509 | **0.494**: the trim is worth **27.9 points** (≥ 25 ✓) | 0.495 (33.4 points) |
| k8s_prod / `mrd_k8s_noise` | 0.70 (0.65–0.75) | 0.724 | **0.724** ✓ | 0.861 ✗ (just outside ±10) |

**No pipeline was retuned.** Every true ratio is inside its band, and equals the `POST /preview` prediction to within 0.02. The route-estimate misses are a property of the counter, not of the pipelines: tuning the pipelines to move the estimate into band would move the real bytes out of it (and make the imported pack functions no longer the packs').

### `route.out_bytes` is an estimate (measured 2026-09-26)

- **Raw routes read slightly negative.** On `mrd_passthrough`, the route estimate is `_raw` + 21–29 bytes per event: 112 → 133 (vpc), 826 → 855 (pan), 2,529 → 2,561 (workstations). The pipeline adds the `cribl_pipe` field; the Destination still receives exactly the `_raw` bytes that came in. So route attribution prices a raw flow's **paid above its would-have-paid** (+18% for vpc_flow).
- **Reshaped events read far smaller than they are.** Per event, route estimate vs captured `_raw`: windows_dc 1,262 vs 1,664; payments 388 vs 517; k8s 182 vs 362; with the levers, Go aggressive 240 vs 755 and the PAN pack 397 vs 519.
- **The estimate is exact when a pipeline removes nothing.** Payments with the trim broken (sample, parse, re-serialize, no field removed): 1,150 vs 1,150 bytes per event. The estimate appears to subtract each removed field at more than its size in `_raw` (1.2–1.5× here), not to measure the re-serialized `_raw`. INFERRED from the numbers above; the Cribl docs say only "Bytes Out estimates the event size after the Route's Pipeline has processed the event".
- **Per Destination** (design state): `mrd_siem_prod` −9.3%, `mrd_analytics` −49.8%, `mrd_archive_s3` +18.3% against the Destination's `total.out_bytes`. With the three packs applied, `mrd_siem_prod` reads −27.1%.
- **What the app would show at 1.0** (design state, route attribution): saved **$348/day** instead of the true **$271/day** (+29%); windows_dc saving 0.50 instead of 0.34; three raw flows paying more than they would have paid. Break-the-trim still reads as a clean regression (0.83 → 0.50, 33 points; the detector's threshold is 15).

**This is for the core owner (open issue 1, section 10).** Destination `total.out_bytes` is exact (it equals the sum of `_raw` bytes delivered, measured to 0.02%) but a Destination mixes flows; route bytes split flows but are estimates. Options: (a) scale each route's out-bytes so the flows into a Destination sum to its `total.out_bytes`, which fixes the sole-feeder Destinations exactly but still misallocates inside `mrd_siem_prod` (at 1.0 the raw workstations and Palo Alto flows would then read −12% and −14%); (b) treat a route whose `out_events == in_events` and whose pipeline is function-free as out = in; (c) give the rig one Destination per flow (changes the demo's "siem-prod" story); (d) label the ratio "Cribl's estimate" in the UI. The numbers the pitch may say (section 9) are the true ones.

## 6. The Worker and its capacity

- **Size.** One Worker Node in `default`: arm64, 2 vCPUs, 1.9 GB RAM, 2 Worker Processes (`GET /master/workers`). Datagen's `eventsPerSec` is per node; both Worker Processes generate and process events.
- **Where the health numbers come from.** `system.cpu_perc` and the memory gauges are not in the aggregate metrics store; `scripts/rig/watch.mjs` samples the node's own buffer (`GET /w/<wid>/system/metrics`, ~10 s buckets) once a minute. CPU is per Worker Process, where 100 = one full vCPU (node total 200). Blocked outputs, backpressure and dropped events are read for the `mrd_*` outputs; the `null` output's drops are the pipelines' intentional drops (sampling, debug filter).
- **Licensing.** Datagen is license-exempt.

| rateFactor | state | window (UTC) | GB/day in | Destinations GB/day | rate achieved | CPU node avg (of 200) | CPU per process, max | free mem, min | blocked / dropped | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.25 | design | 05:54–06:04 | 112.7 | 81.3 | 100.0% | 21.9 | 54 / 98 (Worker reload after the probe deploy at 05:53; 7–10 afterwards) | 151 MB | 0 / 0 | stable |
| 0.5 | design | 06:08–06:12 | 224.5 | 161.9 | 99.8% | 23.0 | 12 / 14 | 171 MB | 0 / 0 | stable |
| 0.75 | design | 06:15–06:18 | 338.1 | 243.8 | 100.1% | 32.6 | 19 / 19 | 220 MB | 0 / 0 | stable |
| **1.0** | design | 06:21–06:25 | 450.7 | 325.0 | 100.2% | 42.6 | 23 / 25 | 283 MB | 0 / 0 | stable |
| **1.0** | **worst case**: all three packs (Go aggressive) + trim broken | 06:28–06:38 | 450.0 | 197.1 | 100.0% | **95.1** | 49 / 49 | 244 MB | 0 / 0 | stable |
| **1.0** | design (left running) | 06:41–06:51 | 450.1 | 324.6 | 100.0% | 46.5 | 25 / 24 | 271 MB | 0 / 0 | stable |

- **Chosen level: rateFactor 1.0 = the PRD 9.1 design rate.** It is the target, so the rig did not step past it. No step showed a short minute, a blocked output, a dropped event at a rig output, or a lagging Worker Process once the post-deploy reload had passed (each deploy reloads the Worker for ~20–40 s and spikes CPU briefly).
- **Headroom.** With every pack applied on stage, each Worker Process runs at about half a vCPU. The XML and CSV parsing of the packs roughly doubles the design-state CPU.
- **Not load-tested:** the Throttle panel's 10× maximum at this baseline. 5× (Spike) on `payments_api` adds 160 GB/day of a light pipeline and should fit; 10× on a Windows source (1.5 TB/day of XML parsing) would not. The demo-function builder may want a per-source cap (open issue 3).
- **Volume against the free tier.** At 1.0 the design state is 450 GB/day in and 325 GB/day into Destinations (≈ 775 GB/day, ≈ 78% of 1 TB/day); with the three packs applied, 197 GB/day out. Datagen is license-exempt and DevNull sends nothing, so whether either counts against the Cloud tier was not observed to matter: nothing throttled during these runs.

## 7. Rates

**The first minute's "≈ 2.1 MB/min for windows_dc" was a partial minute**, not a Datagen shortfall: the key commit landed at 05:45:21 and the Worker restarted at 05:45:32 to load it, so the 05:45 bucket held about 5 seconds of data (842 events = 4.9 s × 172 eps) and 05:46 about 48 seconds. Every full minute since then carries exactly eventsPerSec × 60 events at the sample's mean size (at 0.25: 10,320 events and 26.1 MB per minute for windows_dc = 172 eps × 60 × 2,529 B). No rate correction was needed. The formula `eventsPerSec = design GB/day × rateFactor × 1e9 / 86,400 / mean bytes per event / Worker Nodes` holds as written.

Applied now (rateFactor 1.0, 1 Worker Node; `demo/rig/sources.json`, `demo/rig/throttles.json`):

| Source | design GB/day | eventsPerSec | mean bytes/event | measured GB/day in |
|---|---|---|---|---|
| `mrd_windows_dc` | 150 | 686 | 2,529 | 149.9 |
| `mrd_windows_workstations` | 80 | 366 | 2,529 | 80.0 |
| `mrd_pan_firewall` | 60 | 841 | 826 | 60.0 |
| `mrd_vpc_flow` | 60 | 6,200 | 112 | 60.2 |
| `mrd_payments_api` | 40 | 407 | 1,138 | 40.0 |
| `mrd_k8s_prod` | 60 | 888 | 782 | 60.0 |
| **Total** | **450** | | | **450.1** |

To change the level: `node scripts/rig/apply.mjs --factor <f> --write-throttles --commit --deploy --accept-reserialization inputs.yml`, set `rateFactor` in `sources.json` to match, wait ≥ 2 minutes, then `node scripts/rig/verify.mjs --since <deploy time + 1 min>`.

## 8. Scripts

| script | what it does |
|---|---|
| `scripts/rig/apply.mjs` | Idempotent full apply: destinations → pipelines → samples → Sources → routes (GET, then POST or a full-object PATCH). Flags: `--factor`, `--dry-run`, `--plan-commit`, `--commit [--deploy]`, `--commit-only`, `--accept-reserialization <file>`, `--exclude-blocked`, `--include-group-key` (owner's OK only), `--write-throttles`, `--message`. **Measurement-only:** `--route <route>=<pipeline>,…` (one of that source's own pipelines) and `--break-trim <pipeline>,…` (disables its single `[mr-trim]` function). The next plain apply restores the design state. |
| `scripts/rig/verify.mjs` | Read-only. Whole minutes from `POST /system/metrics/query` (absolute epoch ms, `__worker_group=='default'`, rollup rows dropped): GB/day per Source, the rate achieved against the applied `eventsPerSec` and the short minutes, route in/out, the route ratio against the target band, Destination GB/day and drops, and the node health from `watch.mjs`'s log. `--capture` adds the true ratio (section 5) with its reconciliation per Destination. Flags: `--minutes`, `--since <ISO or ms>`, `--capture`, `--strict`, `--json`. Reads are retried on network errors; writes never are. |
| `scripts/rig/watch.mjs` | Read-only health sampler (section 6): one line per minute and one JSON line in `node_modules/.cache/mr-rig-health.jsonl`. `--once`, `--every <s>`. **It is not left running** (it was a local process of the measuring session): start it before a `verify.mjs` window whose CPU and memory you need, or `health.node` is `null`. |
| `scripts/rig/economics.mjs` | Section 9 from two `verify --capture --json` windows (design state and levers) plus the capacity steps: writes `demo/rig/measured.json` (`--write`) and prints the Markdown table. |
| `scripts/rig/remove.mjs` | Removes only objects that are **both** `mrd_*` **and** tagged. Dry-run by default; `--yes` to act; `--commit --deploy` with the same guarded file list. **Never run as part of the build.** |
| `scripts/rig/probe-secrets.mjs` | The section 2 Worker-decryption probe. Self-cleaning, demo objects only; waits for the Worker to run the probe's commit before testing. |
| `scripts/rig/lib.mjs` | Shared code: the demo-tag guard (`assertOurs`), upsert, metrics, and commit planning (`planCommit`: explicit files, a baseline of pending files, indentation-aware attribution of every changed YAML line to its owner). |
| `demo/rig/apply.sh` | A wrapper for `apply.mjs` (SPEC 1). |

**Commit safety.**
- The rig's own paths (`pipelines/mrd_*/conf.yml`, `data/samples/mrd_*.json`) are always included.
- A shared file (`inputs.yml`, `outputs.yml`, `samples.yml`, `pipelines/route.yml`) is included only when **every** changed line belongs to an `mrd_` object.
- **A hunk that starts inside an object** (git's 3 context lines do not reach its `  <id>:` or `- id:` line, and the hunk header names only `inputs:` / `routes:`) is resolved by content, never by position: in `inputs.yml`, every changed key must exist only in `mrd_` Sources and every inserted `eventsPerSec` must equal a rate an `mrd_` Source has now; in `route.yml`, only `pipeline:` lines qualify, both values must be `mrd_` pipelines, and every route that uses an `mrd_` pipeline must be an `mrd_` route. Anything else stays unattributed and blocks the commit. (Found at the first rate step: the old planner blocked a pure `eventsPerSec` change.)
- If a shared file also shows the Leader re-serializing an untouched object, it is included only when it was clean before the rig ran **and** the operator names it with `--accept-reserialization`.
- Everything else is refused and listed.
- The working-tree diff also contains the org's secret files. The scripts never print or save it; they print only which objects each changed line belongs to.
- The baseline of files pending before the rig's first write is kept in `node_modules/.cache/mr-rig-baseline.json`: `auth/cribl.secret` (committed since D19), `auth/users.json`, `secrets.yml`, `package.json`.

## 9. Rig economics (measured; PRD 9.1 template)

Measured volumes at rateFactor 1.0 (06:41–06:51 UTC) and the PRD 9.1 illustrative presets: `mrd_siem_prod` $2.50/GB (splunk_cloud), `mrd_analytics` $1.50/GB (datadog), `mrd_archive_s3` $0.03/GB (s3). GB = 1e9 bytes. Ratios are the **true** ratios (section 5); the "app" ratio is the route estimate Meter Reader reads today. Pack gains use the lever window (06:28–06:38 UTC); the workstations pack uses windows_dc's ratio (same sample, same pipeline). `demo/rig/measured.json` holds every number, including the route-estimate money under `appRouteEstimate`.

| Source | GB/day in | Destination · $/GB | Would-have-paid / day | Ratio (true · app) | Saved / day | After the pack |
|---|---|---|---|---|---|---|
| `windows_dc` | 149.9 | SIEM (prod) · 2.50 | $375 | 0.342 · 0.501 | $128 | — |
| `windows_workstations` | 80.0 | SIEM (prod) · 2.50 | $200 | 0.000 · -0.013 | $0.00 | +$68/day (0.34) · +$140/day (0.70, Go aggressive) |
| `pan_firewall` | 60.0 | SIEM (prod) · 2.50 | $150 | 0.000 · -0.035 | $0.00 | +$56/day (0.37) |
| `vpc_flow` | 60.2 | Archive (S3) · 0.03 | $1.80 | 0.000 · -0.183 | $0.00 | +$1.81/day (0.9998) |
| `payments_api` | 40.0 | SIEM (prod) · 2.50 | $100 | 0.773 · 0.829 | $77 | break the trim: 0.77 → 0.49 = $28/day lost ($10,166/yr) |
| `k8s_prod` | 60.0 | Analytics · 1.50 | $90 | 0.724 · 0.861 | $65 | — |
| **Total** | **450.1** | | **$917** | 0.295 | **$271** ($98,798/yr) | **$397–$468/day** ($144,737–$170,970/yr) with all three packs |

- **Would have paid:** $917/day. **Saved in the design state:** $270.68/day, **$98,798/yr** annualized (29.5% of spend). PRD 9.1 said ≈ $917, ≈ $262/day, ≈ $96k/yr.
- **With the three packs:** +$68.40 (Windows workstations, 0.342) + $55.65 (Palo Alto, 0.371) + $1.81 (VPC Flow, 0.9998) = **$396.54/day, $144,737/yr**; with **Go aggressive** instead (+$140.27, 0.701) **$468.41/day, $170,970/yr**. PRD 9.1 said $381–457/day, $139k–167k/yr.
- **Break the trim:** payments 0.773 → 0.494 = **27.9 points**, **$27.85/day lost, $10,166/yr**. PRD 9.1 said 0.75 → 0.50, $25/day, $9,125/yr.
- **VPC Flow:** $1.80/day would-have-paid at S3 prices and the pack saves almost all of it: "cents a day at an S3 price, and that is the point; the same 60 GB/day into the SIEM is $150/day."
- **Accrual on stage:** the rig has run at 450 GB/day since Saturday 2026-09-26 06:19 UTC. By Wednesday about 4 days × $271 ≈ **$1,080** accumulated; the headline is the annualized run rate. Before 06:19 it ran at 25–75% (05:45–06:19), which adds about $3.
- **Reading these on stage:** the pitch, story captions and video may say the numbers in this section. What Meter Reader displays will match them only once flow attribution reconciles with Destination bytes (section 5, open issue 1). Until then the app shows $348/day saved, windows_dc at 0.50 and Go aggressive at 0.90.

## 10. Open issues

1. **Route-estimate bias (core owner).** `route.out_bytes` understates reshaped events by 24–68% per event (windows pack, PAN pack, payments −24 to −25%; k8s −50%; Go aggressive −68%) and overstates passthrough events by 1–18% (section 5). The rig's pipelines are on target; the app's numbers are not, until `core/flows.ts` attribution reconciles with Destination `total.out_bytes` or the UI labels the ratio as Cribl's estimate.
2. **Deploy blanks.** Each commit + deploy reloads the Worker (~20–40 s). The minute of a deploy reads short, and the next minute can read slightly high. This matters to the lever timing in PRD 9 ("a deploy can blank a minute of metrics").
3. **Throttle ceiling.** `throttles.json` still allows 10× per source. At rateFactor 1.0, 10× on a Windows source would far exceed this Worker (section 6); consider a per-source cap in `demoSetRate` (e.g. 5× for payments and k8s, 2× for the Windows sources) or measure it.
4. **Long-run check.** The rig was measured for ~40 minutes at 1.0 (last check: 06:50–07:00 UTC, `verify.mjs --minutes 10 --capture --strict` exit 0, 99.9% of the applied rate, CPU node 46.8/200, no blocked or dropped). A Cloud-tier cap, if one applies to Datagen, could trip only after hours. Re-run `node scripts/rig/watch.mjs &` then `node scripts/rig/verify.mjs --minutes 60 --capture --strict` a few hours later and again tomorrow; if in-bytes fall below the applied rate with no rig change, the org is throttling: step every rate down by one factor (PRD 9.1) and regenerate section 9 with `economics.mjs`.
5. **Pack licensing** (resolved, D59): the Windows XML and PAN function lists are no longer in the repository; the rig definition names the packs instead.
