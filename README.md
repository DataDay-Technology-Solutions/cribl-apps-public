# cribl-apps-public

Public distribution of DataDay Technology Solutions Cribl packs — early-access releases for the Cribl community before packs are live on the Cribl Packs Dispensary.

## Packs in this repo

### Cardinality Reduction Pack (`cc-cardinality-reduction`)

Finds the fields that blow up your index and metrics bill — UUIDs, session and trace IDs, Kubernetes pod hashes and ephemeral labels, container hashes, vendor tokens, timestamps, IDs inside URL paths, Prometheus histogram buckets — and audits or normalizes them in the Cribl pipeline, before the data reaches Splunk, Prometheus, Datadog, Chronicle, Elastic, Loki, or object storage.

It ships in audit mode (`DRY_RUN=true`). Events pass through unchanged and pick up `cr_*` tags that show what the pack would change. Review the audit at your destination, whitelist the fields you query, then flip one variable to go live.

**Status:** Cribl Packs Dispensary listing pending. Install from this repo for early access.

**Latest release:** [v4.0.0](../../releases/latest)

Full documentation: [`cc-cardinality-reduction/README.md`](cc-cardinality-reduction/README.md)

#### Before / after (test environment, synthetic data only)

All numbers come from running the pack's real pipeline code (v4.0.0) against synthetic test data. No customer or production data was used.

**The pack's bundled test data**: 10 sample files, 1,420 synthetic events, default settings, analyzed with the pack's own `tools/recommend.js`.

| | Before | After |
|---|---:|---:|
| Distinct values across the 55 high-cardinality fields the pack flags | 5,251 | ~55 |
| Share of all distinct field values eliminated | — | **73.8%** |

**Prometheus stress test**: 100,000 samples (16.7 minutes at 100 events/sec) from the generator behind DataTap's `datatap-prometheus` source. Every sample carries a new pod hash and a new `instance` IP:port, which is the worst case for a TSDB. Settings: `DESTINATION_TYPE=prometheus`, live mode (`DRY_RUN=false`).

| | Before | After, `MODE=safe` (default) | After, `MODE=aggressive` |
|---|---:|---:|---:|
| Unique series (metric name + label set) | 100,000 | 99,004 | **29,226 (−70.8%)** |
| Distinct `pod` values | 100,000 | 12,300 | 12,300 |
| Distinct `instance` values | 99,896 | 98,901 | **1** |

Safe mode never rewrites IP addresses. Because this generator gives every sample its own `instance`, unique series only drop once `MODE=aggressive` collapses it. On real scrape targets `instance` is stable, and pod churn is the main driver. Method, per-label results, and caveats: [`cc-cardinality-reduction/benchmarks`](cc-cardinality-reduction/benchmarks). Reproduce with `node cc-cardinality-reduction/benchmarks/measure.js`.

### DataTap — On-Demand Streaming Data (`cribl-datatap`)

Production-realistic streaming sample data for Cribl Stream: 110+ sourcetypes across 15 category sources — security, network, endpoint, identity, metrics and more. Install the pack and data flows instantly, for demos, pipeline development, and load testing. Synthetic data only.

**Status:** early access. **Latest release:** [cribl-datatap-v3.0.0](../../releases/tag/cribl-datatap-v3.0.0)

Install and the full source list are in [`cribl-datatap/README.md`](cribl-datatap/README.md): import the `.crbl` from the release in Cribl (**Processing → Packs → Add Pack → Import from file**), or use the copy-paste / `install.sh` flow.

## Installing the Cardinality Reduction Pack

### Cribl Stream UI (recommended)

1. Download the latest `.crbl` from the [Releases](../../releases/latest) page
2. In Cribl Stream, go to **Processing → Packs**. On a distributed deployment, select the Worker Group first.
3. Click **Add Pack → Import from file** and select the downloaded `.crbl`
4. Attach the pack's `cardinality_reduction` pipeline to a route and keep `DRY_RUN=true` (the default) while you review the audit tags
5. On a distributed deployment, **Commit & Deploy**

### Cribl CLI

```bash
$CRIBL_HOME/bin/cribl pack install -g <worker-group> /path/to/cc-cardinality-reduction-4.0.0.crbl
```

On a single-instance deployment, omit `-g <worker-group>`.

Next steps (the audit → evaluate → activate workflow, pack variables, and the whitelist advisor) are in the [pack README](cc-cardinality-reduction/README.md).

## Compatibility

- Self-managed Cribl Stream or Cribl Edge 4.0+, or hybrid worker groups where Code functions are allowed
- Not for Cribl.Cloud-managed worker groups: the engine runs in Cribl Code functions, which are restricted there

## License

Apache License 2.0. See [`cc-cardinality-reduction/LICENSE`](cc-cardinality-reduction/LICENSE).

## Author

Steve Koelpin — DataDay Technology Solutions
[linkedin.com/in/skoelpin](https://www.linkedin.com/in/skoelpin/)

## Feedback

Found a bug or want a new detection pattern? Open an issue on this repo. Include your pack version, your Cribl version, and the output of `tools/doctor.sh`. For a new pattern, include a sample event that shows the match.

---

Join the [Cribl Innovators Network](https://www.linkedin.com/groups/13052739/) on LinkedIn · [datadaytech.com](https://datadaytech.com)
