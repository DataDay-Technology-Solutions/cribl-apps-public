# cribl-apps-public

Public distribution of DataDay Technology Solutions Cribl packs and Apps — early-access releases for the Cribl community before they are live on the Cribl Packs Dispensary or the Cribl Marketplace.

## Apps in this repo

### Meter Reader (`cc-meter-reader`)

A free, open-source Cribl App built by Steve Koelpin. It turns Cribl's throughput into a receipt: it prices every flow at what its destination charges, works out what Cribl cut, sampled or diverted before the meter ran, and shows one number, **Saved by Cribl**, by source, route, pipeline and destination, drawn against the commit timeline. When a change erodes the savings, the alert names the commit and the person and arrives through Cribl's own notification bell and the notification targets an administrator already set up (Slack, PagerDuty, email, webhook). A Report Card for leadership downloads as PDF, HTML or CSV. It never changes pipeline, route, source or destination configuration.

**What one Cribl pack saves: $1.6M\* a year, projected**, for the Palo Alto Networks pack at 10 TB/day of firewall logs: 10,000 GB/day × $1.50/GB\* × 30% × 365 = $1,642,500\*. 30% is the top of the 15–30% Cribl publishes for this pack and the default in Cribl's ROI calculator; $1.50/GB\* ≈ Splunk Cloud's 5–10 TB/day list ($2.10\*) after an assumed volume discount. When a pipeline change broke a trim, the alert arrived in 1:27 to 2:13 across nine live runs, and the incident closed itself after the fix deployed ([`docs/LIVE_VALIDATION.md`](cc-meter-reader/docs/LIVE_VALIDATION.md)).

\* For demonstration purposes only. Does not reflect actual prices.

**Status:** v1.1.4, the judge-path release: it replaces 1.1.0 and fixes a plain Datagen Source that metered nothing, and other first-run issues. It is the same tree as the hackathon submission, [Cribl-Community/cc-meter-reader](https://github.com/Cribl-Community/cc-meter-reader). **Latest release:** [meter-reader-v1.1.4](../../releases/tag/meter-reader-v1.1.4)

**Install:** download `meter-reader-1.1.4.tgz` from the [meter-reader-v1.1.4 release](../../releases/tag/meter-reader-v1.1.4), then in Cribl open **Apps** → **Import from File** (under **Build my own App ▾** on a workspace with no Apps yet, under **Add App** once one is installed) → **Import** → **Install**. The release declares no external host and no backend, so it installs on every Cribl.Cloud plan, Standard included. This is an App, not a pack: it is not imported under Processing → Packs.

**Watch:** the [6-minute walkthrough](https://youtu.be/_4KhXD4fvTk).

Full documentation: [`cc-meter-reader/README.md`](cc-meter-reader/README.md). Questions and ideas: an issue on this repo.

## Packs in this repo

### Cardinality Reduction Pack (`cc-cardinality-reduction`)

Finds the fields that blow up your index and metrics bill — UUIDs, session and trace IDs, Kubernetes pod hashes and ephemeral labels, container hashes, vendor tokens, timestamps, IDs inside URL paths, Prometheus histogram buckets — and audits or normalizes them in the Cribl pipeline, before the data reaches Splunk, Prometheus, Datadog, Chronicle, Elastic, Loki, or object storage.

It ships in audit mode (`DRY_RUN=true`). Events pass through unchanged and pick up `cr_*` tags that show what the pack would change. Review the audit at your destination, whitelist the fields you query, then flip one variable to go live.

**Status:** Cribl Packs Dispensary listing pending. Install from this repo for early access.

**Latest release:** [v4.0.0](../../releases/tag/cc-cardinality-reduction-v4.0.0)

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

1. Download `cc-cardinality-reduction-4.0.0.crbl` from the [cc-cardinality-reduction-v4.0.0 release](../../releases/tag/cc-cardinality-reduction-v4.0.0)
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

## Compatibility (Cardinality Reduction Pack)

- Self-managed Cribl Stream or Cribl Edge 4.0+, or hybrid worker groups where Code functions are allowed
- Not for Cribl.Cloud-managed worker groups: the engine runs in Cribl Code functions, which are restricted there

## License

Apache License 2.0. See each folder's own license: [`cc-cardinality-reduction/LICENSE`](cc-cardinality-reduction/LICENSE), [`cribl-datatap/LICENSE`](cribl-datatap/LICENSE), [`cc-meter-reader/LICENSE`](cc-meter-reader/LICENSE).

## Author

Steve Koelpin — DataDay Technology Solutions
[linkedin.com/in/skoelpin](https://www.linkedin.com/in/skoelpin/)

## Feedback

Found a bug or want a new detection pattern? Open an issue on this repo. Include your pack version, your Cribl version, and the output of `tools/doctor.sh`. For a new pattern, include a sample event that shows the match.

---

Join the [Cribl Innovators Network](https://www.linkedin.com/groups/13052739/) on LinkedIn · [datadaytech.com](https://datadaytech.com)
