# Cardinality benchmark: `cc-cardinality-reduction`

`measure.js` reproduces the Prometheus before/after numbers in the [top-level README](../../README.md). It needs Node 14 or later and has no npm dependencies.

```bash
node cc-cardinality-reduction/benchmarks/measure.js            # 100,000 samples, seed 42
node cc-cardinality-reduction/benchmarks/measure.js --events 20000 --seed 7 --json
```

## Method

1. **Synthetic data only.** The script generates Prometheus exposition lines with a seeded port of the generator behind DataTap's `datatap-prometheus` source ([cribl-apps](https://github.com/DataDay-Technology-Solutions/cribl-apps)). Each sample gets a new pod name (`<service>-<8 hex>-<5 hex>`) and a new `instance` IP:port, and the metric name rotates every 15 seconds across 9 common metric families.
2. **The pack's real pipeline.** Every line runs through all functions in `cc-cardinality-reduction/default/pipelines/cardinality_reduction/conf.yml`, in order, with each function's filter honored, the same way the pack's CI end-to-end harness runs them. The two aggregation functions are stateful and off by default (`ENABLE_AGGREGATION=false`), so they are skipped.
3. **Before** is the audit-mode output (`DRY_RUN=true`), where values are never changed. **After** is the live-mode output (`DRY_RUN=false`). Both use `DESTINATION_TYPE=prometheus`. A series is the metric name plus its full label set, and samples the pipeline drops (non-SLO histogram buckets) are not counted after.

## Results (pack v4.0.0, 100,000 samples, seed 42)

| MODE | Unique series before | Unique series after | Reduction | Samples kept | Engine errors |
|---|---:|---:|---:|---:|---:|
| safe | 100,000 | 99,004 | 1.0% | 99,004 | 0 |
| aggressive | 100,000 | 29,226 | 70.8% | 99,004 | 0 |

Distinct label values (before → after):

| Label | Before | After, safe | After, aggressive |
|---|---:|---:|---:|
| `pod` | 100,000 | 12,300 | 12,300 |
| `instance` | 99,896 | 98,901 | 1 |
| `handler` | 6,340 | 6,097 | 6,097 |
| `le` | 10 | 9 | 9 |
| `code`, `container`, `device`, `image`, `job`, `method`, `mode`, `namespace` | unchanged | unchanged | unchanged |

## Reading the numbers

- **Safe mode keeps IP addresses by design**, so `instance` stays unique per sample and series barely move. `MODE=aggressive` collapses `instance` to `__IP__`, which is where the 70.8% comes from.
- **`pod` drops from 100,000 to 12,300, not to 7.** The pod rule strips `-<hash>-<suffix>` from names like `api-server-7f8d9b4c6-xk2pq`, but it skips suffixes made only of digits (for example `order-service-5d6f7a8b-12345`) to avoid false positives. DataTap draws its suffixes from hex, so about 12% of its pod names end in all digits. Real Kubernetes suffixes are drawn from a letter-heavy alphabet, so this case is rare in practice.
- **`handler` is not a URL field the pack recognizes by name** (it templates `url`, `path`, `uri`, `request_uri`, `endpoint`, `route`), so IDs inside `handler` values stay. Adding a custom rule or renaming the label would collapse them.
- **Histogram:** the `0.025` bucket is outside the pack's SLO-aligned keep-set, so it is dropped in live mode (996 of 100,000 samples). `+Inf` is always kept.
- These are the default settings. Real-world results depend on your label mix, whitelist, and mode.

## Bundled-sample numbers

The first table in the top-level README comes from the pack's own advisor, run against the 10 sample files that ship inside the pack:

```bash
cd cc-cardinality-reduction && node tools/recommend.js
```
