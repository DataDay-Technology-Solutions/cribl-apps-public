# Splunk Cloud workload pricing (SVC) and Meter Reader

**Status:** research, synthesized 2026-09-26 from three verified research passes (Splunk documents, public price points, Cribl and practitioner material). Decision D46 (9/26 2:40 PM ET): SVC is acknowledged, not priced, in 1.0; this document is the sourced basis for a later version. No code, README or preset changes accompany it.

**The question (Steve):** Splunk Cloud also sells workload pricing in Splunk Virtual Compute (SVC) units. Should Meter Reader account for how applying a Cribl pack (trim, shape, sample, route) reduces SVC consumption, or stick to straight GB saved?

**The answer in one paragraph.** Keep $/GB as the measured default. Bytes are the only quantity Splunk documents as directly metered and the only one Cribl can measure exactly. Under workload pricing ingestion is not metered at all: the customer buys a fixed block of SVCs sized for peak demand, plus searchable storage in 500 GB blocks, and the bill moves only at renewal, true-up or when they buy more SVCs. A GB removed before the indexer still has value on that plan, but it is realized as capacity freed and as fewer SVCs and less storage bought next time, not as an invoice line this month. So a "workload (SVC)" price basis belongs in Meter Reader as a labelled **estimate**: a derived $/GB = (annual $ per SVC ÷ 365) ÷ (GB/day per SVC at the customer's workload class), with storage added as a separate, well-sourced per-GB line, and search-side savings explicitly not counted (which makes the figure conservative). Every input the estimate needs (the $/SVC, the GB/day-per-SVC ratio) lives in the customer's contract, not on a public page; Splunk publishes no $/SVC and labels its own sizing ratios "not guaranteed".

## How to read this document

- Every number carries a source tag `[S#]` that resolves in the [source table](#sources) to a URL and the date shown on that page (or the fetch date when the page carries no stamp). A figure marked **inferred** is our arithmetic on sourced numbers, with the arithmetic shown.
- Confidence uses the repository's `PresetConfidence` scale so the words match `core/presets.ts` and the Prices page: **published** = Splunk's own page or legal document says it; **reported** = a reseller filing, partner or third party says it; **estimate** = our arithmetic on those, with stated assumptions. The research passes' high/medium/low map onto these as: high on a Splunk page → published; high or medium on a reseller or third-party page → reported; low, or anything derived → estimate.
- Reseller prices are Splunk "End Customer Pricelist - EMEA" rate cards in USD, filed on UK G-Cloud. They are list, pre-discount, ex-VAT. "Annual" is inferred: the per-SVC rows print no period, but the same lists carry "Note: List prices based on annual term" (printed on the Capacity-on-Demand row, not the SVC rows), price their ingest rows "per GB for 1 year", and the magnitude agrees (a $10,205.10 platform figure could not be monthly) [S12][S13].
- Verbatim Splunk text is quoted; paraphrase is not put in quotation marks.

## Executive summary

1. Keep straight GB saved at $/GB as the measured default; it is the only Splunk Cloud meter a Cribl App can observe, and it is exact.
2. An SVC is "a unit of capabilities in Splunk Cloud Platform that includes compute, memory, and I/O resources" [S1]; a workload subscription "does not meter ingestion" and is a fixed entitlement bought for peak, raised by buying more SVCs [S1][S3].
3. SVC usage in the Cloud Monitoring Console is CPU across three consumers, indexing, search and shared services; Splunk says the search profile "will likely be the biggest driver" [S5][S7].
4. Only Splunk's own experiment quantifies the split: at 20k events/s ingest was ~10.0 SVC of 19.42 total, and pre-index CIM extraction cut total SVC 42% by removing search work, with the ingest share flat because the same events reached the indexers [S9].
5. Splunk's architects also report that after a 52% CPU-seconds cut on a 100-SVC stack, "SVC usage did not change meaningfully" [S8]: SVC usage is entitlement usage, not consumption, and freed capacity shows as headroom, not a lower reading.
6. Splunk publishes no $/SVC. The only public list price is $10,205.10 per SVC per year (0-49 SVCs) and $9,354.10 (50+), Standard Success Plan, unchanged from April 2024 through the January 2026 reseller list [S12][S13][S16]; Enterprise Security adds $2,550.70 (Essentials) or $8,723.90 (Premier) per SVC [S12][S16].
7. Splunk's only GB-to-SVC bridges are the ingest-plan allocation ceiling of 1 SVC per 10 GB/day [S1] and a "not guaranteed" sizing table of 5 to 45+ GB/day per SVC by workload class [S3][S7]; the customer's actual ratio is in their order.
8. Storage is the one workload-plan line sized directly in ingested GB: DDAS = uncompressed GB/day × retention days, bought in 500 GB blocks at list $690 per block per year ($1.38 per GB-year, inferred), so a GB never ingested avoids about $0.34 at 90-day retention and $1.38 at 365 [S1][S12].
9. Recommended later-version design: a "workload (SVC)" price basis per Splunk Cloud destination with two customer inputs ($/SVC/year, GB/day per SVC) and an optional DDAS line, producing a derived $/GB labelled estimate and shown in Show the math with its formula, sources and the words "realized at renewal; search-side savings not counted". At Splunk's 1:10 ratio and the 50+ list price the derived figure is $2.56/GB platform only, or $2.90 with the 90 days of storage the ingest plan bundles; both sit inside the existing $2.25 ingest preset's $1.47-$4.85 range.
10. A pack demo can truthfully claim GB/day removed, DDAS never provisioned, and SVC-equivalents of indexing capacity freed at the customer's ratio, worth $N a year at their next sizing; it cannot claim a lower SVC reading or a lower bill this month.

## 1. What workload pricing is and what drives SVC consumption

### 1.1 The unit and the subscription

| Fact | Splunk's words | Source |
|---|---|---|
| Definition (service documentation) | "A Splunk Virtual Compute (SVC) is a unit of capabilities in Splunk Cloud Platform that includes compute, memory, and I/O resources." | [S1] 2026-06-26 |
| Definition (contract) | Splunk Cloud Platform capacity is "Daily Indexing Volume or number of Splunk Virtual Compute ("SVC")"; "'Splunk Virtual Compute (SVC)' means a unit of capabilities in Splunk Cloud Platform that includes the following resources: compute, memory and I/O as further explained in the service documentation." Only these two capacity units are defined for Splunk Cloud Platform. | [S2] live page "Last updated on Sept 2026"; Aug 2026 PDF identical |
| Benchmarked, measured, fixed | "An SVC is a unit of compute and related resources that provides a consistent level of search and ingest equal to the SVC benchmark. ... Splunk Cloud Platform captures SVC utilization measurements for each machine every few seconds. ... The total number of SVCs you need is the maximum compute resources anticipated for your peak demands. Thus, this model involves the purchase of a fixed capacity of SVCs." | [S3] modified 2026-02-12 |
| The subscription | "This subscription is based on the resource capacity consumed rather than the data volume ingested. Your subscription entitles you to the purchased workload resources and this subscription does not meter ingestion. ... As necessary, you can purchase additional resource capacity to increase ingest and search load or to improve performance. You purchase units of storage blocks based on your data retention requirements for your workload-based subscription." | [S1] |
| The entitlement | "Splunk Cloud Platform workload-based subscription provisions the Splunk Virtual Compute (SVC) entitlement up to your subscription level. Workload-based subscriptions do not meter ingestion. You can increase ingest and/or search load and operate the service to your desired performance objective until the SVC entitlement of your subscription reaches full utilization. As necessary, you can purchase additional SVC to increase ingest and search load or to improve performance." | [S1] |
| Which plan is the default | "Your subscription to the Splunk Cloud Platform service is workload-based and is sized for resource capacity. By exception, you may be on an ingest-based subscription that is sized for data volume ingested." | [S1] |
| Marketing definition | "Workload pricing is based on the amount of compute and storage resources required to run search and analytics workloads, so you can cost-effectively ingest volumes of large data into Splunk." "Splunk Virtual Compute (SVC) is a unit of cloud compute, memory and I/O resources. These, in turn, are primarily driven by search quantity and complexity as well as daily indexing volume." | [S4] fetched 2026-09-26 |
| Launch framing | "you're NOT metered on data you ingest into the Splunk platform, but instead on when you engage in tasks." | [S29] 2021-10-19 |

Splunk's pricing pages also list **activity-based pricing**, "a dual-meter pricing model based on both ingest and search activity", available for Splunk Cloud Platform [S4]. It is absent from the Service Description [S1] and from the capacity document [S2], which define only workload and ingest subscriptions; no public Splunk document defines its units, meters or overage rules. It may be contract-only. Do not state that it does not exist; see the open questions, because a dual meter would make GB directly metered again.

### 1.2 What consumes SVC

| Fact | Splunk's words | Source |
|---|---|---|
| Workloads include indexing | "Workloads are activities in Splunk Cloud Platform such as searching, investigating, monitoring, machine learning, data streaming, data indexing, and data processing that require compute resources." | [S3] |
| What the CMC measures | "SVC is a unit of capabilities that includes CPU, memory, and I/O. Overall SVC usage primarily considers CPU across search and indexing workloads. Splunk deploys infrastructure based on your entitled SVCs. Provisioned SVCs are allocated to the search head and indexer tiers after initial sizing conversations about intended workloads and requirements, with intention to minimize the footprint for both tiers." | [S5] 2026-06-28 (10.5.2605; identical in 10.2.2510, 2026-03-19) |
| The three consumers | "Overall peak SVC usage refers to the highest amount of resources used in a given time interval to perform system processes such as indexing, any running search processes, and shared services. It primarily measures the CPU usage across search and indexing workloads." Search peak SVC "can occur on both the search and indexing tiers"; indexing peak SVC "occurs on the indexing tiers". | [S5] |
| Ingest rate moves it | "When data ingestion rates are high, the indexer consumes more resources to process and ingest data. High ingestion rates can increase SVC usage." | [S5] |
| Accelerations consume it | "The internal splunk-system-user virtual administrator runs jobs and processes like summary refreshes, report accelerations, and data model accelerations on behalf of a Splunk Cloud Platform customer. Running these processes consumes SVCs." | [S5] |
| How it is reported | Views: Overall, "By process: Overall peak SVC usage split by search processes, indexing processes, and shared services", "By tier". Lantern lists "Peak SVC usage within selected time granularity (1-hour, 15-min, 5-min)", "Peak SVC usage per hour split by consumer (ingestion, search, and shared services)", "Peak SVC usage per hour by ingestion source (index, sourcetype)", "Hourly rate of ingestion". | [S5][S3] |
| Thresholds | "Generally, you should ensure that SVC usage is less than 80% to maintain performance. Usage greater than or equal to 80% is considered elevated, and greater than or equal to 90% might cause degraded performance." | [S5]; same 80% in [S6] 2023-05-26 |
| Not a health measure | "SVCs are used [three ways]: A purchasing SKU. A number that Splunk uses to determine how much infrastructure to provision ... And in the case of SVC usage, a measure of entitlement usage. However, SVC usage is not a measure of health, capacity, or performance." | [S8] modified 2026-03-24 |
| Optimisation may not move it | "Improving a search or indexing process might not decrease your SVC usage but could improve your system performance." | [S26] 2026-03-16 |
| Splunk's own caveat on the metric | "The SVC usage metric on its own cannot efficiently explain why SVC consumption might increase without a corresponding rise in search or ingest activities, or why it might remain constant despite an increase in searches." | [S25] 2025-10-14 |

A wording note the verifiers flagged: the CMC page says the Overall panel shows "average hourly SVC usage" while every view definition and every Lantern bullet says "peak" [S5][S3]. That is Splunk's own inconsistency. Neither page states what Splunk bills against, because nothing is billed against usage: the entitlement is what is bought.

### 1.3 Indexing versus search: what Splunk says about the split

- 2021 brochure: "Search and analysis workloads are the primary determinants of your investment in Splunk and are directly tied to the value you generate. Indexing data will also drive some workload consumption but at a much lower rate than search and analysis." [S10] PDF created 2021-09-16. The superlative "much lower" appears only there; Splunk's 2026 pricing page keeps search first but drops it ("primarily driven by search quantity and complexity as well as daily indexing volume") [S4].
- 2023 blog: "Remember, each profile is based on two primary factors: search and ingest. The combination of those factors is what drives your SVC usage. Based on historical patterns of existing SVC customers, your search profile will likely be the biggest driver of SVC usage." [S7] 2023-05-26.
- Splunk has never published a numeric indexing:search weighting. The only measured split is Splunk's Edge Processor experiment (section 3.1), where ingest was 51% of total SVC with heavy data-model-acceleration search load and 90% without it [S9] (percentages inferred from the published table).
- The closest thing to a practitioner split is Cribl's own 2019 post on Splunk's per-core model, and it is an assumption: "1 to 2 cores per machine are handling ingestion and the remaining are processing search/query workloads", with cost driven by "daily ingestion volume and expected query volume" [S41] 2019-09-19 (pre-dates SVC; discusses vCPU on Splunk Enterprise).
- On-prem capacity guidance, usable only as an order-of-magnitude anchor: "If an indexer ingests 150GB/day of data, then it uses up to ~4 of the available CPU cores for indexing processes" and "A user (or app) that submits a search request uses one CPU core on each indexer until the search is complete" [S27] undated. Inferred: about 37 GB/day of indexing per core, so one concurrent search costs as much indexer CPU as about 37 GB/day of ingest. Splunk publishes no core-to-SVC mapping.

### 1.4 The two published GB-to-SVC relationships (do not merge them)

**(a) The allocation ceiling for ingest-based plans** (Service Details, "Performance considerations"; current wording since edition 10.0.2503, where the ES increment changed from 1:20 to 1:10):

> "SVCs are allocated to your subscription plan based on your ingest-based subscription (GB/day), up to the maximum of 1 SVC for every 10 GB/day. Purchase of Splunk Enterprise Security (ES) Premium Solution provides incremental SVC allocation of 1 SVC for every 10 GB of licensed peak daily ingest. Purchase of Splunk IT Service Intelligence (ITSI) Premium Solution provides incremental SVC allocation of 1 SVC for every 20 GB of licensed peak daily ingest. The ratio of allocated SVC to licensed peak daily ingest level is subject to change with the evolving infrastructure and architecture of the service." [S1]

This is how much compute Splunk provisions per licensed GB/day for ingest customers: a cap, not a price and not a consumption rate. The same page's service-limits table separately pairs entitlement tiers as "less than 166 SVC or 1 TB", "more than 166 SVC or 1 TB" and "more than 900 SVC or 7 TB" [S1]; those are tier-gating thresholds (about 6.0 and 7.8 GB/day per SVC, inferred), not allocation ratios.

**(b) The sizing table by workload class** (Lantern, modified 2026-02-12; same table in the 2023 blog), introduced with "The following table provides some common estimates. The stated volume is not guaranteed. Talk to your sales representative for assistance with your unique environment." [S3], and "We included ranges because they are based on usage statistics of a cohort of customers, rather than a single data point. SVC usage may vary based on the complexity of the data ingested and searches executed." [S7]:

| Workload type | GB/day per SVC | Implied SVC per 1 TB/day (inferred) |
|---|---|---|
| Compliance Storage | 35-45+ | 22-29 |
| Data Lake (Exploration / Use Case Development) | 25-35+ | 29-40 |
| Basic Reporting | 20-30 | 33-50 |
| Ad-hoc Investigation | 15-25 | 40-67 |
| Continuous Monitoring | 10-20 | 50-100 |
| Premium Solution - ES or ITSI (Low workload) | 10-15 | 67-100 |
| Premium Solution - ES or ITSI (High workload) | 5-10 | 100-200 |

Splunk's public calculator [S11] takes "Select a Workload Type" and "GB Ingested Per Day" and returns "Estimated SVCs", so Splunk's own selling model is SVCs = GB/day ÷ (GB/day per SVC for the workload class). Its page JavaScript (stamped "PRICING CALCULATOR 2023") uses hard-coded divisors of 80 / 37.5 / 23 / 22 / 20 for its five workload options plus a fixed +60 SVC offset; those constants sit at or above the top of every Lantern range and are uncorroborated by any Splunk text, so the Lantern table is the one to use (see "What we could not confirm"). The calculator's disclaimer: "Please note that this value is simply an estimate. There are a variety of factors that could influence the actual amount of SVCs that you would be provisioned with Splunk. A few examples of such factors include changing or unknown use cases, and the proportion of Indexers to Search Heads allotted for your entitlement." [S11]

### 1.5 Storage: the workload-plan line that is sized in ingested GB

- Workload subscriptions: "DDAS in your Splunk Cloud Platform environment should be sized based on the volume of uncompressed data that you want to index on a daily basis. For workload-based subscriptions, you purchase DDAS based on your data retention requirements ... For example, if your forecasted daily volume of uncompressed data is 1 TB and your searchable retention need is 365 days, your Splunk Cloud Platform environment should be sized to have 365 TB of DDAS." [S1]
- Ingest subscriptions: "Ingest-based subscriptions include sufficient DDAS to allow you to store up to 90 days of your uncompressed data. For example, if your daily volume of uncompressed data is 100 GB, your Splunk Cloud Platform environment will have 9000 GB (9 TB) of DDAS." [S1] This confirms the existing preset note's assumption that the ingest subscription includes about 90 days of searchable storage.
- Increments and overrun: "You can optionally purchase additional DDAS in 500 GB increments." "If you ingested far more data than your initial estimate and thus exceeded your entitled DDAS capacity, the Splunk Cloud Platform service elastically expands the amount of DDAS to retain your data per your retention settings. ... Refer to the Splunk General Terms for Splunk's policy for Overages." [S1] Lantern: "You can subscribe to storage upfront based on estimates, then true-up annually to account for the variability of ingest." [S3]
- Measured on uncompressed bytes: the CMC DDAS dashboard "provides insights into your data retention based on the uncompressed data you have indexed"; Yellow at 80%, Red at 90% of entitlement [S22] 2026-03-19.
- Archive (DDAA) is "an optional subscription" at "a lower cost option for long term storage"; restores are searchable for up to 30 days; the restore allowance is 10% of DDAS entitlement (20% enhanced) [S1][S22]. Self-storage (DDSS) goes to the customer's own S3/GCS bucket [S63] 2022-11-11.

Storage is therefore sized on exactly what Cribl reduces (uncompressed GB/day reaching the indexer), and it is the one component of a workload contract with a public per-GB list price (section 2).

### 1.6 Exceeding the entitlement: what is and is not documented

The research pass originally claimed "no overage or burst charge is documented"; verification refuted the headline while confirming every quote. The precise statement:

- No SVC-specific overage rate, burst allowance, grace policy or SVC metering is documented anywhere in the Service Details [S1], General Terms [S20], capacity document [S2] or pricing FAQ [S21]. The SVC entitlement is provisioned "up to your subscription level"; the documented remedy is "optimizing your existing search workload or by contacting your Splunk sales representative to increase your SVC entitlement" [S1].
- A contractual overage right does exist: General Terms §11.2 "If a verification or usage report reveals that you have exceeded the Capacity or Use Rights, then we will have the right to invoice you using the applicable Fees at list price then in effect", and §26 defines Capacity to include "number of search and compute units" [S20] Last Updated May 2026. Splunk does not document the compute-unit/SVC equivalence, so this facially covers SVC.
- On a workload plan the explicitly documented overage vector is storage (the elastic-expansion sentence above). The FAQ line "We only charge for overages when you consistently exceed your purchased data ingestion or storage capacity" [S21] is scoped to ingestion and storage; it is not an SVC statement.
- Ingest plans have an explicit grace rule: "You can exceed your ingest-based subscription daily index volume a maximum of five times in a calendar month." Measured per day in UTC [S1][S62].
- Federated Search is metered separately in Data Scan Units of 10 TB, with overage "at one-tenth of the list price of a 10 TB - Data Scan Unit" [S24][S2]; it is not SVC.

Implication for the App: on a workload plan, reduced ingest never avoids a metered SVC overage. Savings are realized as avoided storage true-up and as fewer SVCs bought at expansion or renewal.

### 1.7 Splunk's own guidance on reducing ingest as an SVC lever

Under "Ingest optimizations" Splunk lists: "Reduce ingested data amounts by using technologies like Edge Processor, Ingest Processor, and ingest actions. These allow you to optimize or reduce the amount of data being ingested into the Splunk platform to include only necessary data." and "Offload ingest actions and/or props/transforms work to Edge Processor or Ingest Processor: Because ingest actions rulesets run on Splunk indexers hosted in Splunk Cloud Platform, moving the work being done by ingest actions to an external data processor ... is an effective way to reduce the amount of work being done by the indexers." [S8] So Splunk treats pre-index reduction, the Cribl pack pattern, as an SVC lever, but gives no ratio, and the same article reports the .conf25 result that the SVC usage reading did not move (section 3.4). Splunk's own pre-index service, Ingest Processor, is metered in GB/day processed: an Essential tier free up to 500 GB/day and a paid Premier tier above it [S23] 2026-05-14. Splunk prices the Cribl-like function on bytes, not SVC.

## 2. Public price points

Splunk publishes no $/SVC and no $/GB anywhere on splunk.com or help.splunk.com; the AWS Marketplace listing says "Pricing is based on your specific requirements and eligibility. Request a private offer to receive a custom quote." [S19] fetched 2026-09-26. The prices below are the Splunk EMEA end-customer rate card as filed by resellers. Four independent G-Cloud 14 filings agree to the cent (Somerford [S12], Networkology [S13], Bytes [S14], and Softcat [S15], 2024-05-01, G-Cloud document 92354, whose URL the research pass did not capture). The underlying channel list is dated 12 April 2024 (PDF created 2024-05-03); Somerford's 2025-01-22 date is its G-Cloud upload date. Somerford's G-Cloud 15 filing of 2026-01-30 [S16] (read from the PDF with `pdftotext -layout`) carries the platform, ES Essentials, ITSI, storage (DDAS and DDAA, pre-purchase and true-up) and SE-S-VC rows at the same prices, so January 2026 is the currency anchor for every figure in sections 2.1 and 2.2 that cites it; it also adds the ES Premier per-SVC SKU. The encryption, compliance, federal and PCI variants were not re-checked against it.

### 2.1 Per-SVC prices (USD, per SVC per year inferred, list, ex-VAT)

| Item | SKU | Price | Tier | List or negotiated | Sources and dates | Confidence |
|---|---|---|---|---|---|---|
| Splunk Cloud Platform, Standard Success Plan | SE-S-CLD-SVC-ST | $10,205.10 / $9,354.10 | 0-49 / 50+ SVCs | List | [S12] 2025-01-22 (data Apr 2024); [S13] 2024-05-03; [S14] 2024-04-23; unchanged in [S16] 2026-01-30 | reported |
| Platform, Premium Success Plan | SE-S-CLD-SVC-PR | $11,224.92 / $10,289.51 | 50-99 / 100+ | List | [S12][S13][S14] | reported |
| Platform, Encryption at Rest, Standard / Premium | SE-S-CLD-SVC-ENC-ST / -PR | $11,735.87 / $10,757.22; $12,908.66 / $11,832.94 | 0-49 / 50+; 50-99 / 100+ | List | [S12][S14] | reported |
| Platform, Compliance + Encryption, Standard / Premium | SE-S-CLD-SVC-CP-ST / -PR | $12,246.12 / $11,224.92; $13,469.90 / $12,347.41 | as above | List | [S12][S14] | reported |
| Platform, Federal (IL controls), Standard / Premium | SE-S-CLD-SVC-FED-ST / -PR | $15,307.65 / $14,031.15; $16,837.38 / $15,434.27 | as above | List | [S12][S14] | reported |
| Enterprise Security Essentials add-on, Standard | ES-S-CLD-SVC-ST | $2,550.70 / $2,337.95 | 10-49 / 50+ | List; "Platform Cloud SVC & Storage Required" | [S12] (labelled "Enterprise Security"); relabelled "Essentials" and unchanged in [S16] | reported |
| Enterprise Security Essentials add-on, Premium | ES-S-CLD-SVC-PR | $2,806.00 / $2,572.17 | 10-99 / 100+ | List | [S12] | reported |
| Enterprise Security Premier add-on, Standard | ES-S-CLD-SVC-PRE-ST | $8,723.90 / $7,995.95 | 10-49 / 50+ | List | [S16] 2026-01-30 (new SKU; 3.4x Essentials, inferred) | reported |
| ITSI add-on, Standard / Premium | IT-S-CLD-SVC-ST / -PR | $3,188.95 / $2,922.15; $3,507.50 / $3,215.21 | 10-49 / 50+; 10-99 / 100+ | List | [S12]; ST unchanged in [S16] | reported |
| App for PCI Compliance add-on | PC-S-CLD-SVC-ST / -PR | $1,534.53 / $1,811.25 | per SVC | List | [S12] | reported |
| Extra SVC for an ingest-plan customer | SE-S-VC "Ingest Model Compute Customization - SVC" | $13,800.00 (ENC: $15,870.00) | per SVC | List | [S12][S13]; $13,800.00 unchanged in [S16] 2026-01-30 (ENC variant not re-checked) | reported |
| US MSRP for ES per SVC | ES-S-CLD-SVC-ST | $2,484.16 | per SVC | "MSRP", quote required | [S17] undated, fetched 2026-09-26 | reported (page internally inconsistent: title says Premium, SKU is Standard) |
| Implied US MSRP per platform SVC | — | about $8,874 / $8,134 | 0-49 / 50+ | **Inferred**: EMEA ÷ 1.15, the ratio five of seven matching hssl.us SKUs show | [S17][S12] | estimate |
| Third-party "$55-75K per SVC per year" | — | contradicted | — | Unsourced | [S52] 2026-09-24, repeated by [S54] | not usable |
| Third-party "~$2K-$5K per SVC" | — | contradicted | — | Self-described "implied ... not a Splunk-quoted rate" | [S51] 2026-07-13 | not usable |

Minimums implied by the tiers: platform Standard starts at 0-49 SVCs, Premium Success at 50, ES/ITSI add-ons at 10 [S12]. Splunk's legacy success-plan page states a 50 SVC minimum for Premium Success Plans bought before 2022-02-01 [S58]; no current published minimum SVC commit was found.

### 2.2 Storage prices (USD, per 500 GB block, per year inferred, list)

| Item | SKU | Price | Per GB-year (inferred) | Sources | Confidence |
|---|---|---|---|---|---|
| Additional searchable storage (DDAS) | SE-S-STOR | $690.00 | $1.38 | [S12][S13]; unchanged in [S16] 2026-01-30 | reported |
| DDAS true-up (SVC plan) | SE-S-SVC-STOR-TU | $690.00 | $1.38 | [S12]; unchanged in [S16] | reported |
| DDAS true-up charge (SVC plan) | SE-S-SVC-STOR-TUC | $828.00 | $1.656 (1.2x pre-purchase, inferred) | [S12]; unchanged in [S16]; US MSRP $720.00 [S17] | reported |
| Archive (DDAA) | SE-S-ARC / SE-S-SVC-ARC-TU | $276.00 | $0.552 | [S12]; unchanged in [S16] | reported |
| DDAA true-up charge | SE-S-SVC-ARC-TUC | $331.20 | $0.662 | [S12]; unchanged in [S16]; US MSRP $288.00 [S17] | reported |
| Encryption-at-rest variants | SE-S-STOR-ENC / SE-S-ARC-ENC / -TUC | $793.50 / $316.25; charges $952.20 / $379.50 | $1.587 / $0.633 | [S12] | reported |
| Federal storage true-up charges | SE-S-SVC-FED-STOR-TUC / -ARC-TUC | $1,131.60 / $400.20 | $2.263 / $0.800 | [S12] | reported |
| GSA Schedule 70 additional storage (federal, 2018) | — | $586.40 per 500 GB | $1.173 | [S18] 2018-04-18 | reported (negotiated federal, pre-SVC) |

Per ingested GB, DDAS at list costs $1.38 × retention days ÷ 365 (inferred): $0.34 at 90 days, $0.68 at 180, $1.38 at 365. Encryption at rest is "for an additional charge" [S1]; the SVC uplift is about 15% (inferred from $11,735.87 vs $10,205.10).

### 2.3 Ingest prices, for the cross-check (USD per GB/day per year, Standard Success Plan, list)

| Tier (GB/day) | SE-S-CLD-ST platform | ÷ 365 (inferred $/GB) | ES-S-CLD-ST add-on | Source |
|---|---|---|---|---|
| 5-9 | $2,049.30 | $5.61 | — | [S12]; "per GB for 1 year (min 5GB per day)" per Softcat's summary |
| 10-19 | $1,745.70 | $4.78 | — | [S12] |
| 20-49 | $1,518.00 | $4.16 | — | [S12] |
| 50-99 | $1,265.00 | $3.47 | $1,214.40 | [S12] |
| 100-199 | $1,012.00 | $2.77 | $759.00 | [S12] |
| 200-499 | $974.05 | $2.67 | $588.23 | [S12] |
| 500-999 | $851.00 | $2.33 | $483.00 | [S12] |
| 1,000-1,999 | $822.25 | $2.25 (the current preset) | $465.75 | [S12][S13] |
| 2,000-4,999 | $793.50 | $2.17 | $448.50 | [S12] |
| 5,000-9,999 | $764.75 | $2.10 | $431.25 | [S12] |

Other ingest price points: US MSRP (hssl.us, undated) $800 / $690 / $665 per GB/day per year at 100-199 / 2,000-4,999 / 5,000-9,999, i.e. $2.19 / $1.89 / $1.82 per GB (inferred) [S17]; GSA Schedule 70 (Epic Machines, dated 2018-04-18, includes 0.75% IFF) $781.86 (100-199) and $698.79 (1,000-1,999), i.e. $2.14 / $1.91 per GB (inferred) [S18]; costbench $8,100/yr for 5 GB/day and $24,000/yr for 20 GB/day (2026-07-11), consistent with US MSRP within 10-20% [S56]. The $2.25 preset sits at EMEA list for 1-2 TB/day and about 15% above US MSRP at the same tier.

### 2.4 Cross-checks between the two models (all inferred)

- At Splunk's allocation ceiling, 1 SVC is worth 10 GB/day. Platform SVC at 50+ = $9,354.10 ÷ 10 = $935.41 per GB/day per year vs. $822.25 ingest list at 1-2 TB/day: workload costs 13.8% more per GB/day at that ratio. At 0-49, $10,205.10 ÷ 10 = $1,020.51 vs. $1,012 at 100-199 GB/day: 0.8% more. So at list, workload pricing undercuts ingest only when the customer runs lighter than about 11-12 GB/day per SVC, i.e. less search per GB than Splunk's "Continuous Monitoring" class.
- A 1,000 GB/day customer: 100 SVCs × $9,354.10 = $935,410/yr on workload vs. 1,000 × $822.25 = $822,250/yr on ingest (both list, platform only, before storage; the ingest plan includes 90 days of DDAS, the workload plan includes none).
- An ingest customer buying extra compute pays $13,800 per SVC, 35% above the workload-plan rate.

### 2.5 Effective $/GB under workload pricing at list, by workload class (inferred)

Formula: (annual $ per SVC ÷ 365) ÷ (GB/day per SVC). Assumes the purchased SVCs are fully used (as the ingest preset assumes the entitlement is used) and that the customer's SVC count tracks GB/day at the class ratio. Dividing by the 80% practical ceiling raises every figure 25%.

| GB/day per SVC | Splunk class at that ratio | 0-49 SVCs ($10,205.10) | 50+ SVCs ($9,354.10) | + ES Essentials, 0-49 ($12,755.80) | + ES Premier, 0-49 ($18,929.00) |
|---|---|---|---|---|---|
| 5 | ES/ITSI high workload | $5.59 | $5.13 | $6.99 | $10.37 |
| 10 | ES/ITSI low; Continuous Monitoring low end; the 1:10 allocation ceiling | $2.80 | $2.56 | $3.49 | $5.19 |
| 15 | Ad-hoc Investigation low end | $1.86 | $1.71 | | |
| 20 | Basic Reporting low end; Continuous Monitoring high end | $1.40 | $1.28 | $1.75 | |
| 25 | Data Lake low end | $1.12 | $1.03 | | |
| 30 | Basic Reporting high end | $0.93 | $0.85 | | |
| 35 | Compliance Storage low end | $0.80 | $0.73 | | |
| 40 | Compliance Storage | $0.70 | $0.64 | | |
| 45 | Compliance Storage high end | $0.62 | $0.57 | $0.78 | |

Add DDAS on top: $0.34/GB at 90-day retention, $1.38 at 365 (section 2.2). The existing $2.25 ingest preset equals a workload customer at 12.4 GB/day per SVC (0-49 price) or 11.4 (50+ price), inside this range. Sources: prices [S12][S16], ratios [S3][S7]. Confidence: estimate.

## 3. How reduced ingest and Cribl packs translate to SVC

### 3.1 The mechanism, component by component

SVC has three documented consumers: indexing, search and shared services [S5]. A Cribl pack that trims, shapes, samples or routes touches them differently.

| Component | What a byte reduction does to it | Evidence | Confidence |
|---|---|---|---|
| **Indexing** (indexer-tier CPU) | Falls roughly with the volume of events reaching the indexer. Splunk's controlled test held throughput at 20k events/s and the ingest share was 10.00 SVC without and 10.07 SVC with upstream CIM field extraction, even though the second arm forwarded raw events plus extracted fields [S9]. So indexing SVC tracks events/bytes processed at the indexer, not the field work done upstream; fewer events is what would move it. Proportionality to bytes is inferred, not documented by Splunk. | [S9] published 2024-07-01, modified 2025-10-22 | published (the numbers); estimate (proportionality) |
| **Search** | Only indirectly: smaller indexes and fewer buckets to scan, and data-model accelerations (scheduled every 5 minutes over "index=* OR index=_*" by default [S61]) scan less. The size of this effect depends on the customer's query and DMA patterns, which are invisible from Cribl. Splunk's test moved search from 8.04 to 1.04 SVC by replacing 19 accelerated data models with pre-extracted CIM fields at constant volume, a 42% total SVC reduction [S9]; that is the search lever a shaping pack pulls, but it is not a function of bytes. | [S9][S61] | published (the test); not measurable by the App |
| **Shared services** (platform overhead) | Untouched. A Splunk support KB snippet (unverified; page unreadable) describes a stack where "The Splunk shared services are utilizing 80% of the SVC, not including search and ingestion" [S34]. | [S34] snippet only | estimate |
| **Storage (DDAS)** | Directly: DDAS is sized as uncompressed GB/day × retention days and bought in 500 GB blocks, so every GB/day removed shrinks the next block purchase or annual true-up [S1][S3]. | [S1][S12] | published (rule); reported (price) |

Two Splunk-published results bound what any claim can say:

- **Splunk's Edge Processor experiment** [S9]: Setup 1 (data straight to indexers, DMA on 19 models every 5 min): total 19.42 SVC = ingest 10.00 + search 8.04 + shared 1.38. Setup 2 (CIM fields extracted upstream, DMA off): 11.18 SVC = ingest 10.07 + search 1.04 + shared 0.07. Both at 20,000 events/s of WinEventLog:Security (34 event types). "In our test, Edge Processor achieved a 42% reduction in SVCs compared to the DMA process. Much of these savings were attributed to the search process". Caveat: "only the Windows TA was installed ... In a typical Splunk deployment, dozens or even hundreds of TAs are often installed, making the search queries run by DMA significantly more complex and resource-intensive", and "not meant to be comprehensive". No event size or GB/day is given, so the 10 SVC of ingest cannot be converted to GB/day per SVC.
- **Splunk's .conf25 experiment (PLA1033)** [S8]: two identical 100-SVC stacks; after ingest optimisations (event breaking, index-time extractions, Edge/Ingest Processor, ingest actions) and search optimisations, total CPU seconds per hour fell "from about 240,000 seconds down to about 115,000", indexer average CPU "from 98% down to 57%", yet "after all these optimizations and results that clearly demonstrate the system is running more efficiently while consuming fewer resources, SVC usage did not change meaningfully. Again, this is because SVC usage is not a measure of health, capacity, or performance." The authors' framing: the environment "can accomplish more with the same SVCs by ingesting additional data or running additional searches." Cite this as Splunk's architects' observation and explanation, not as a documented design property of the metric.

### 3.2 What is measurable from Cribl's side, and what is not

| Measurable by Meter Reader today | Not observable from Cribl |
|---|---|
| Bytes in at a route and bytes out after its pipeline, per source, route, pipeline and destination (reconciled attribution, D20); events likewise | SVC usage, by consumer, tier, index or sourcetype (CMC License Usage > Workload only [S5][S6]; also the Splunk App for Chargeback, method not public [S30]) |
| GB/day that never reaches the indexer, per Splunk Cloud destination | The customer's search workload, concurrency, DMA and summary schedules, which Splunk says usually dominate SVC [S7] |
| The bytes over time, so a peak-hour reduction could be distinguished from an average one | The customer's GB/day-per-SVC ratio (sized from Splunk's proprietary regression on customer telemetry via SCMA, "aggregated across thousands of Splunk Cloud customers" [S28][S33]) |
| — | The customer's $/SVC (in the order; no public Splunk price) |
| — | Whether the customer is on workload, ingest or activity-based pricing (an App cannot tell from the destination) |

Two measurement caveats already in the preset note still apply: Splunk licenses the size of `_raw` while Cribl counts delivered bytes including HEC/S2S metadata, confirmed independently by a Cribl employee: "Splunk ingest takes the size of _raw where Cribl does full event length" [S43] 2025-03-11; and SVC usage is a peak-hour reading, so a reduction that does not lower the peak hour does not change the reported number [S5][S3].

No Cribl-authored source quantifies SVC saved. Across about 35 Cribl pages, docs, case studies, the ROI calculator (whose source code models AWS Elasticsearch infrastructure cost minus Cribl's own price, with no Splunk license or SVC input [S42]) and community threads, every Cribl claim is in GB, license dollars or mechanism only: "With workload-based licensing that focuses on CPU, tuning data and searches is now a direct lever on your bill" [S36] 2026-07-16; "Workload-based licensing means CPU and query patterns matter as much as ingest volume" [S35]; "if you're using workload-based pricing (SVC), much higher costs" [S40] 2022-12-06; the Finality case study, "Reduced SIEM license cost and facilitated switch to SVC/CPU utilization license model" with no SVC number [S39] 2024-04-22. Cribl's one lab measurement is search seconds on 2 GB/day of Tomcat logs in Docker [S37][S38], not SVC. Partners are the same: TekStream lists "Ingest volume (still impacts infrastructure footprint)" among SVC-plan cost drivers and puts "Search optimization (SVC)" at 10-25% without method [S46]; SP6 says "You can ingest as many GB/day as you want*" with the footnote that storage remains a secondary pricing dimension [S47] 2024-02-08; Edge Delta claims "optimize your SVC consumption by 30-60%" with no method [S49]; Realm Security says "the volume of data you ingest into Splunk strongly correlates with SVC utilization" but also "you should not expect a lower Splunk bill when moving to workload-based pricing", and its only dollar case is an ingest-priced customer [S50] 2026-06-25. Cribl Insights itself prices nothing: its docs list rates, drops and top talkers in bytes and events, with no cost, savings or SVC term [S45]. There is no coefficient to borrow.

### 3.3 The honest conversion options

| Option | Formula | Inputs and where they come from | Confidence (repo scale) | Where the money is realized |
|---|---|---|---|---|
| **A. Customer's own effective $/GB** (today's path) | as entered | The customer's internal chargeback or planning figure | as good as their number | Whatever their number means |
| **B. Ingest-equivalent list $/GB** (today's preset) | $822.25 ÷ 365 = $2.25 | Reseller list [S12] | reported | The at-renewal value of the same GB/day on the ingest plan |
| **C. SVC-derived $/GB** | (annual $ per SVC ÷ 365) ÷ (GB/day per SVC) | $/SVC from the customer's order, else list $9,354.10 / $10,205.10 [S12][S16]; ratio from the customer's sizing, else Splunk's class table [S3] or the 1:10 allocation ceiling [S1] | estimate | Fewer SVCs at renewal, right-size or the next expansion; headroom until then |
| **D. Storage per GB** | $1.38 × retention days ÷ 365 (list); in 500 GB blocks | DDAS list [S12]; retention from the customer | reported (price), estimate (per-GB conversion) | Next storage block purchase or annual true-up |
| **E. SVC-equivalents freed** (a unit, no dollars) | GB/day removed ÷ (GB/day per SVC) | Ratio as in C | estimate | Headroom; the number of SVCs not needed at the customer's class |
| **F. Search-side SVC** | not counted | No coefficient exists; the only bound is Splunk's 42% total / search 8.04 → 1.04 at constant volume [S9] | — | Omitting it makes C conservative |
| **G. Measured SVC delta from the CMC** | before/after per index or sourcetype | Only if the customer exports CMC Workload data; per-index SVC is what customers already watch [S31] | published, if supplied | Actual reading; still an entitlement-usage figure, not a bill |

Option C is a **purchase-time sizing equivalence**, and the document should call it that. Splunk sizes SVCs as GB/day ÷ (GB/day per SVC for the workload class) [S11][S3]; so GB/day removed ÷ that ratio is the number of SVCs the customer would not need to buy at the next sizing. It is not an indexing-only consumption coefficient: no source publishes indexing SVC per GB/day, and the README, D46 and PITCH wording "indexing SVC per GB/day" should be read as "GB/day per SVC at your workload class" (open question 1). Using the whole-workload ratio attributes the search share to bytes as well, which is how Splunk itself sells, but it is why the figure must be labelled an estimate and realized at renewal.

### 3.4 Failure modes (each has a source)

1. **The entitlement is a fixed block.** "this model involves the purchase of a fixed capacity of SVCs" [S3]; "Workload-based subscriptions do not meter ingestion" [S1]. A mid-term reduction changes no invoice. Savings appear at renewal, at true-up, or as an SVC purchase avoided.
2. **The reading may not move.** Splunk's architects halved CPU seconds and "SVC usage did not change meaningfully" [S8]; Splunk's docs say improving a process "might not decrease your SVC usage" [S26]. A demo cannot promise a lower CMC number.
3. **Peak, not average.** SVC usage is "the highest amount of resources used in a given time interval" [S5]; a reduction outside the peak hour does not show.
4. **Shared services are untouchable** by any pack and can be the largest consumer [S34] (snippet, unverified).
5. **The ratio varies 9x by workload class** (5 to 45+ GB/day per SVC) and is "not guaranteed" [S3]; the 1:10 allocation is "subject to change" [S1]. Picking the wrong class moves the dollar figure by up to 9x.
6. **The ES edition matters 3.4x**: Essentials $2,550.70 vs Premier $8,723.90 per SVC [S12][S16]. A model that uses "the ES per-SVC price" understates Premier customers.
7. **Ingest-plan customers with SVC allocations are still billed per GB**; for them the ingest preset is right and the SVC basis is wrong. The App cannot tell which plan a destination is on.
8. **Bytes are not `_raw`**: Cribl's GB can run above Splunk's license GB [S43].
9. **Cribl compute is outside SVC but not free.** Stream processing credits (0.32 credits/GB on Cloud workers, per the `cribl_lake` preset note) and the Settings "Cribl cost" field already exist; SVC freed has an offset that the receipt should keep showing.
10. **Practical ceiling.** Usable capacity is about 80% of the entitlement [S5][S6]; a figure computed at 100% understates the value of headroom by 25%, and one computed at 80% overstates a renewal saving. State which.
11. **Minimum tiers.** ES and ITSI add-ons start at 10 SVCs; a small reduction cannot cross a tier [S12].
12. **Activity-based pricing** (dual meter, ingest plus search) is marketed [S4] but undocumented; if a customer is on it, GB is directly metered again and the conversion above is the wrong one.

## 4. Recommendation for Meter Reader

### 4.1 Keep $/GB as the measured default

Bytes are exact, reconciled per flow (D20), and are the only quantity Splunk documents as directly metered (ingest plans) or directly sized (DDAS on both plans). Every other Meter Reader preset is per GB or per GB-month. The existing `splunk_cloud` preset already sits inside the workload-implied range ($0.57-$5.59 platform only, section 2.5), the like-for-like workload figure at Splunk's 1:10 ratio ($2.90 with the 90 days of storage the ingest plan bundles) is within 30% of it, and its note already says "Customers on workload (SVC) pricing do not pay per GB, so ingest cuts save them money only indirectly." Nothing in the research argues for changing the default. This matches D46.

### 4.2 Add a "workload (SVC)" price basis per destination, as a labelled estimate, in a later version

Design (the shape the README and D46 already describe, with the wording corrected):

- **Where:** Settings → Prices, per Splunk Cloud destination, a price basis selector: `Ingest ($/GB)` (default) or `Workload (SVC), estimate`. The basis is stored with the price version, so a switch is versioned with an effective time like any price change and history is never repriced.
- **Inputs when Workload is chosen:**
  1. Annual price per SVC (default: list $9,354.10, confidence reported, with the 0-49 tier $10,205.10 noted; the customer overwrites with their contract figure).
  2. GB/day per SVC (default 10, Splunk's allocation ceiling; a picker offering Splunk's workload classes with their ranges, labelled "Splunk's sizing estimate, not guaranteed").
  3. Optional: count searchable storage, with retention days (default 90) at list $1.38 per GB-year, or the customer's DDAS price per 500 GB block.
- **Output:** a derived $/GB = (input 1 ÷ 365 ÷ input 2) + (input 3's $ per GB-year × retention days ÷ 365), stored in millicents like any price so the meter, ledger, alerts and receipt need no new arithmetic. At the defaults: $9,354.10 ÷ 365 ÷ 10 = $2.56, plus $1.38 × 90 ÷ 365 = $0.34, so $2.90/GB with storage and $2.56 without.
- **Show the math** gains one block for workload-priced destinations: the formula, the three inputs and their sources, the confidence word "estimate", and the sentence "Realized at renewal, true-up or an avoided SVC purchase, not as a metered charge. Search-side SVC savings are not counted." Alongside the dollars, show the unit figure: "N SVC-equivalents at your ratio" and "M GB of searchable storage not provisioned".
- **Receipt and alerts:** the headline stays "Saved by Cribl"; a workload-priced destination's rows carry the marker "estimate, at renewal" the way sampled flows carry their attribution caveat. An alert on a broken trim still fires on bytes; its dollar figure uses the derived price and its text names the basis.
- **Search-side savings: not counted, and say so.** The only measurement, Splunk's own, put the search lever at up to 42% of total SVC at constant volume [S9]; it is real, it is what a shaping pack pulls, and nothing on the Cribl side can size it. Leaving it out keeps the number conservative and defensible in front of a Splunk account team.
- **Not auto-suggested.** `suggestPreset` maps `splunk_hec` and `*.splunkcloud.com` to `splunk_cloud`; it cannot know the subscription type. The workload basis is a deliberate choice by someone who has read their order.

### 4.3 What a pack demo could truthfully claim

Using the live rig's numbers (README: 450 GB/day, alert at $24 a day and $8,708 a year, annualized Saved by Cribl about $99,000, all at $2.25/GB), the byte quantities behind them are inferred here as 10.6 GB/day (the alert) and about 120 GB/day (the annual figure).

Truthful, at the 1:10 ratio and the 50+ list price (inferred, an illustration):

- "This pack keeps about 120 GB/day out of the indexer. At your ratio that is 12 SVC-equivalents of indexing capacity you do not need to buy at your next sizing, about $112,000 a year at list ($9,354.10 per SVC), and about 10.8 TB of searchable storage you never provision at 90-day retention, 22 blocks of 500 GB, about $15,000 a year at list. Search-side savings are not counted. Until renewal this is headroom, not a refund."
- For the broken-trim alert: "10.6 GB/day came back; that is about one SVC-equivalent and two storage blocks at your next true-up, about $11,300 a year at list, on top of the capacity it eats now."

Not truthful, and never to be said:

- "Your SVC usage will drop X%." (Splunk's own experiment says it may not move [S8].)
- "Your Splunk bill drops $N this month." (Nothing is metered [S1].)
- "Cribl saves you $N in SVC" with a figure taken from a third-party $/SVC ($55-75K or $2-5K [S52][S51]) or a third-party ratio (1.5-7 GB/day per SVC [S51]); both contradict the filed list and Splunk's table.
- Any SVC number attributed to Cribl material; there is none.

### 4.4 Storage deserves to be counted even where SVC is not

On a workload plan storage is the only line sized in GB, with a public list price and an annual true-up. A conservative implementation could ship the DDAS line first (option D), because it needs only a retention setting and a block price, both published or reported, and leave SVC-equivalents as a unit figure (option E) until a customer supplies a $/SVC.

## 5. Proposed preset row for `core/presets.ts`

The evidence supports a row with confidence `'estimate'`, provided it ships together with the price-basis UI in 4.2 (or, at minimum, with "workload / SVC, estimate" in the label, because the picker string `'{preset} · typical {typical}/GB (range {low}–{high})'` is all a user sees before opening the ⓘ). It should not be added to 1.0 (D46). Mechanics it needs: a new `PresetId` member, a `PRESETS` entry with `matchTypes: []` so it is never auto-suggested, and a README table row.

Tier choice: the ingest preset uses the 1,000-1,999 GB/day tier; at Splunk's 1:10 allocation that customer holds 100-200 SVCs, the 50+ tier, so the preset uses $9,354.10 and 10 GB/day per SVC, which gives $2.56. Storage is excluded from the typical figure so the row is platform-only like every other reseller row, and the basis says what to add. The two Splunk Cloud figures are therefore not like for like: the $2.25 ingest figure includes the 90 days of DDAS that plan bundles, the workload plan includes none, so the comparable workload figure is $2.56 + $0.34 = $2.90; the basis says so.

```ts
// PRESETS entry (matchTypes empty on purpose: an App cannot tell which subscription a destination is on)
{ id: 'splunk_cloud_svc', label: 'Splunk Cloud (workload / SVC, estimate)', matchTypes: [], milliCentsPerGb: 256_000 },
```

```ts
  splunk_cloud_svc: {
    rangeUsd: [0.57, 5.59],
    confidence: 'estimate',
    basis:
      "Workload (SVC) pricing: an annual subscription per Splunk Virtual Compute unit, a fixed block of compute bought for peak demand. Ingestion is not metered and there is no per-GB price, so this figure is an at-renewal equivalence, not a meter: it converts a GB/day kept out of the indexer into the SVCs you would not need to buy at your next sizing, using Splunk's own sizing rule (SVCs = GB/day / GB/day per SVC for your workload class). Per-GB figure = (annual $ per SVC / 365) / (GB/day per SVC). Preset = $9,354.10 per SVC per year (Standard Success Plan, 50+ SVCs, platform only: the tier a 1-2 TB/day customer lands in at Splunk's allocation of 1 SVC per 10 GB/day) / 365 / 10 = about $2.56. At the 0-49 SVC price ($10,205.10) it is about $2.80. The 10 GB/day per SVC ratio is the ceiling Splunk allocates to ingest subscriptions and the search-heavy end of the non-premium classes in its published sizing table (continuous monitoring 10-20, ad-hoc investigation 15-25, basic reporting 20-30, data lake 25-35+, compliance storage 35-45+, ES or ITSI 5-15 GB/day per SVC), which Splunk says is not guaranteed; use your own ratio. The $2.25 Splunk Cloud ingest preset includes the 90 days of searchable storage that plan bundles; the like-for-like figure here is about $2.90 (see storage below). Range low = 50+ price at 45 GB/day per SVC (compliance storage) = about $0.57. High = 0-49 price at 5 GB/day per SVC (ES or ITSI, high workload, platform only) = about $5.59; with the Enterprise Security Essentials add-on ($2,550.70 per SVC) the high is about $6.99, and with ES Premier ($8,723.90) about $10.37. Assumes the purchased SVCs are fully used, like the ingest preset; Splunk calls usage above 80% elevated, so dividing by 0.8 raises every figure 25%. Storage is not included: workload subscriptions buy searchable storage (DDAS) separately, sized as uncompressed GB/day x retention days in 500 GB blocks at list $690 per block per year ($1.38 per GB-year), so a GB never ingested also avoids about $0.34 at 90-day retention and $1.38 at 365 days; add that if you want it counted. Search-side SVC, usually the larger share per Splunk, is not counted: a pack that shapes data also makes searches cheaper, but nothing on the Cribl side can measure it, so this figure is conservative. Under a fixed entitlement a mid-term reduction changes no invoice: it frees capacity and lowers the next renewal, true-up or SVC purchase; Splunk's own architects report that halving CPU left the Cloud Monitoring Console's SVC usage reading unchanged. Prices are from Splunk EMEA end-customer price lists in USD that resellers filed on UK G-Cloud (Somerford, Jan 2026 and Jan 2025; Networkology, Apr 2024), which agree to the cent; Splunk publishes no price per SVC. Not auto-suggested: pick this only if your contract is in SVCs.",
    sources: [
      {
        url: 'https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/584424/410732020769866-pricing-document-2025-01-22-0621.pdf',
        quote: "SE-S-CLD-SVC-ST Splunk Cloud Platform - Subscription with Standard Success Plan - per SVC 0 - 49 SVC's $10,205.10 50+ SVC's $9,354.10 ... SE-S-SVC-STOR-TU Splunk Cloud Subscription - Data Storage True-up - 500GB Increments $690.00 ... ES-S-CLD-SVC-ST Splunk Enteprise Security - Subscription with Standard Success Plan - per SVC 10 - 49 SVC's $2,550.70",
      },
      {
        url: 'https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-15/documents/584424/793652572707052-pricing-document-2026-01-30-1331.pdf',
        quote: "SE-S-CLD-SVC-ST Splunk Cloud Platform - Subscription with Standard Success Plan - per SVC 0 - 49 SVC's $10,205.10 50+ SVC's $9,354.10 ... SE-S-SVC-STOR-TU Splunk Cloud Subscription - Data Storage True-up - 500GB Increments $690.00 ... ES-S-CLD-SVC-ST Splunk Enteprise Security Essentials with Standard Success Plan - per SVC 10 - 49 SVC's $2,550.70 ... ES-S-CLD-SVC-PRE-ST Splunk Enterprise Security Premier with Standard Success Plan 10 - 49 SVC's $8,723.90 50+ SVC's $7,995.95",
      },
      {
        url: 'https://help.splunk.com/en/splunk-cloud-platform/get-started/service-terms-and-policies/10.5.2605/information-about-the-service/splunk-cloud-platform-service-details',
        quote: 'Workload-based subscriptions do not meter ingestion. ... SVCs are allocated to your subscription plan based on your ingest-based subscription (GB/day), up to the maximum of 1 SVC for every 10 GB/day. ... For workload-based subscriptions, you purchase DDAS based on your data retention requirements ... if your forecasted daily volume of uncompressed data is 1 TB and your searchable retention need is 365 days, your Splunk Cloud Platform environment should be sized to have 365 TB of DDAS.',
      },
      {
        url: 'https://lantern.splunk.com/Manage_Performance_and_Health/Understanding_workload_pricing_in_Splunk_Cloud_Platform',
        quote: 'The following table provides some common estimates. The stated volume is not guaranteed. ... Compliance Storage ... 35-45+ ... Continuous Monitoring ... 10-20 ... Premium Solution - ES or ITSI (High workload) ... 5-10 ... The total number of SVCs you need is the maximum compute resources anticipated for your peak demands. Thus, this model involves the purchase of a fixed capacity of SVCs.',
      },
      {
        url: 'https://lantern.splunk.com/Platform_Data_Management/Transform_Pipelines/Maximizing_SVC_usage_in_Splunk_Cloud_Platform',
        quote: 'after all these optimizations and results that clearly demonstrate the system is running more efficiently while consuming fewer resources, SVC usage did not change meaningfully. Again, this is because SVC usage is not a measure of health, capacity, or performance.',
      },
    ],
  },
```

Every `quote` above is verbatim page text: the G-Cloud 14 and 15 lines were copied from `pdftotext -layout` output of the filed PDFs (the price lists misspell "Enteprise"; the quote keeps it). Before this row ships, run `tests/compliance.test.ts` (this document passed the `forbidden.txt` scan on 2026-09-26). The three-decimal price rule is satisfied ($2.563 rounds to $2.56 for display; store 256_000 millicents).

## 6. Open questions for Steve

1. **Wording.** README (money model and roadmap), D46 and the PITCH Q&A say "indexing SVC per GB/day". No source publishes an indexing-only coefficient; the sourced quantity is "GB/day per SVC at your workload class" (Splunk's sizing ratio), which is a purchase-time equivalence. Change the wording when the roadmap item is next touched?
2. **Which customer is this for?** Is the target buyer on workload pricing (Splunk's default since the Service Description says ingest is "by exception") and do they know their $/SVC, their class ratio, their ES edition and their DDAS retention? Those four numbers decide whether the basis is usable at all.
3. **Storage first?** Ship the DDAS per-GB line (well sourced, block-priced, annually trued-up) before the SVC-derived line, or together?
4. **Unit or dollars on the receipt?** Show "SVC-equivalents freed" as a unit next to dollars, or only in Show the math?
5. **The CMC join.** The Workload dashboard reports peak SVC per hour by index and sourcetype [S3][S5], which is the natural join key to a Cribl destination or route. Is a manual import of a CMC export (option G) worth designing, or is that too far from an App that never touches the Splunk side?
6. **Activity-based pricing.** Splunk markets a dual ingest-plus-search meter for Splunk Cloud Platform [S4] with no public definition. If a prospect is on it, GB is metered again. Ask Splunk-side contacts what its units are?
7. **US versus EMEA list.** The only public per-SVC list is EMEA in USD; the US MSRP hints at 15% lower [S17]. Keep the EMEA figure as "typical" (consistent with the ingest preset) or note the US implication in the basis?
8. **A paid edition?** If a paid edition ever carries the SVC basis, is the two-input basis the paid feature, or the free acknowledgement?
9. **Independent evidence.** The one practitioner quote on SVC in the trade press ("Federated searching can be very slow and will chew through SVC") is attributed by TechTarget to Steve himself [S57] 2024-06-17; it must not be cited as independent support.
10. **Utilisation basis.** Compute the estimate at 100% of entitlement (like the ingest preset) or at the 80% practical ceiling? The basis text currently says 100% and notes the 25% uplift.

## 7. What we could not confirm (so nobody repeats it)

- **"No overage or burst charge is documented for SVC."** Refuted in precision: General Terms §11.2 plus the §26 Capacity definition ("number of search and compute units") give Splunk a contractual overage right that facially covers SVC [S20]. What remains true: no SVC-specific rate, burst, grace or metering is published, and the FAQ's overage sentence names only ingestion and storage [S21].
- **Third-party $/SVC.** "$55-75K per SVC per year" [S52][S54] is 5.4-7.3x the filed list; "~$2K-5K" [S51] is self-described as implied. Neither cites a source. Do not average them with the list.
- **Third-party GB/day-per-SVC ratios.** siemcostcalculator's 1.5-7 GB/day per SVC [S51] is 2-10x tighter than Splunk's own 5-45+ [S3]; provenance "triangulated from partner enablement decks" is unverifiable.
- **Splunk calculator constants.** The page JavaScript's 715 / 8134 / 600 multipliers and 80 / 37.5 / 23 / 22 / 20 divisors [S11] look like 2023 annual list prices and sizing ratios, but they are unlabelled constants in a marketing page, disagree with the Lantern table, and are not published prices. Do not cite 8134 as Splunk's $/SVC.
- **"Total Volume in GB / GB per SVC Ratio = Number of SVCs."** Surfaced as a search snippet attributed to Lantern; the fetched page did not contain the sentence verbatim. The calculator's behaviour [S11] supports the formula; the sentence does not.
- **Splunk support KB, "shared services are utilizing 80% of the SVC"** [S34]: snippet only; the page is JS-rendered and unreadable. If read literally it implies ~1.2 GB/day per SVC on that stack, far outside Splunk's table.
- **Community threads** (548971: workload pricing "starting from 2-3TB/day before it has competitive prices"; 756750: "search factor" heuristic): snippet-only; community.splunk.com returns 403; Wayback copies rendered only the opening posts [S32]. Reddit r/Splunk was unreachable by every route.
- **Kinney Group's "Splunk will bill you for any excess consumption beyond your license limits"** [S48] 2025-09-25 cites no source and conflicts with the Service Details' remedy of buying more SVC [S1].
- **Cribl's LogStream-era whitepaper numbers** differ between the PDF table (up to 9.1x for a metrics index, "nearly 20%" headroom) [S37] and the blog (13x, 16%) [S38]; the table's seconds columns do not reproduce the stated 32x-103x multipliers; and the "traditional" arm searched ~2.5x more records than the optimized arm. Do not quote the multipliers as like-for-like.
- **The Dec 2023 Cribl webinar on Splunk Cloud CPU utilization** [S44] was not transcribed; any SVC figure inside it is unverified. Two Cribl solution briefs are PDF-gated landing pages with no body text.
- **Vendr's "$150-$225 per GB/day"** [S55] is unit-ambiguous (about 5x below the annual list; likely per month or a small-tier rate); no SVC data.
- **monitoringcost.com's "Workload pricing is roughly 30 to 60 percent cheaper than equivalent ingest pricing" and "$3,000 to $400,000/month by pack size"** [S53] 2026-06 cite nothing ("verified against splunk.com pricing and public customer commentary"); the 30-60% line is repeated by Motadata [S54]. The filed list (section 2.4) shows workload at or above ingest per GB/day at Splunk's own allocation ratio, so the claim depends entirely on the customer's ratio.
- **hssl.us** [S17]: the 1.15 EMEA/US ratio fits five of seven SKUs, not the ingest 100-199 tier (1.265) or ES per SVC (1.027); some pages may be a different list version.
- **The 2021 brochure's "at a much lower rate than search"** [S10] is not repeated on any 2026 Splunk page; quote it as dated.
- **Encryption, compliance, federal and PCI SKU variants** were last seen in the April 2024 data [S12][S13][S14] and were not re-checked against the January 2026 list [S16]; the platform, ES, ITSI, storage and SE-S-VC rows were, and are unchanged.
- **Softcat's G-Cloud 14 filing** (2024-05-01, document 92354) agrees with the others per the research pass, but its URL was not captured; it is not cited for any number here.
- **DDAS/DDAA per-GB prices on any Splunk page:** none exist; every storage price here is a reseller filing.

## Sources

| Tag | What it is | Date on the source | URL |
|---|---|---|---|
| S1 | Splunk Cloud Platform Service Details, edition 10.5.2605 (the Service Description; newest edition, per its version selector) | last updated 2026-06-26 | https://help.splunk.com/en/splunk-cloud-platform/get-started/service-terms-and-policies/10.5.2605/information-about-the-service/splunk-cloud-platform-service-details |
| S2 | Splunk Offerings Purchase Capacity and Limitations (live page; the Aug 2026 PDF is filed under "Prior versions" with identical Splunk Cloud wording) | "Last updated on Sept 2026"; PDF "Published: Aug 2026" | https://www.splunk.com/en_us/legal/licensed-capacity.html ; https://www.splunk.com/content/dam/splunk2/en_us/pdfs/legal/licensed-capacity/purchase-capacity-and-limitations-august-2026.pdf |
| S3 | Splunk Lantern, Understanding workload pricing in Splunk Cloud Platform | published 2021-12-14, modified 2026-02-12 | https://lantern.splunk.com/Manage_Performance_and_Health/Understanding_workload_pricing_in_Splunk_Cloud_Platform |
| S4 | splunk.com, Pricing models (workload-pricing.html served identical content) | no stamp; fetched 2026-09-26 | https://www.splunk.com/en_us/products/pricing/pricing-models.html |
| S5 | Splunk Cloud Platform Admin Manual, Monitor current SVC usage of your workload-based subscription, 10.5.2605 (text identical in 10.2.2510, 2026-03-19) | last updated 2026-06-28 | https://help.splunk.com/en/data-management/splunk-cloud-platform-admin-manual/10.5.2605/monitor-your-splunk-cloud-platform-deployment/use-the-license-usage-dashboards/monitor-current-svc-usage-of-your-workload-based-subscription |
| S6 | Splunk blog, Workload Pricing and SVCs: What You Can See and Control (Samir Virani) | 2023-05-26, updated 2023-07-31 | https://www.splunk.com/en_us/blog/platform/workload-pricing-and-svcs-what-you-can-see-and-control.html |
| S7 | Splunk blog, What is Splunk Virtual Compute (SVC)? (Samir Virani) | 2023-05-26 (originally 2021-09-13) | https://www.splunk.com/en_us/blog/platform/what-is-splunk-virtual-compute-svc.html |
| S8 | Splunk Lantern, Maximizing SVC usage in Splunk Cloud Platform (.conf25 PLA1033; Danial Zaki, Paul Reeves) | published 2026-03-03, modified 2026-03-24 | https://lantern.splunk.com/Platform_Data_Management/Transform_Pipelines/Maximizing_SVC_usage_in_Splunk_Cloud_Platform |
| S9 | Splunk Lantern, Using Edge Processor to save Splunk Virtual Compute | published 2024-07-01, modified 2025-10-22 | https://lantern.splunk.com/Platform_Data_Management/Transform_Pipelines/Using_Edge_Processor_to_save_Splunk_Virtual_Compute |
| S10 | Splunk pricing options brochure (PDF) | created 2021-09-16 | https://www.splunk.com/en_us/pdfs/resources/getting-started/splunk-pricing-options.pdf |
| S11 | splunk.com, Pricing calculator (JS stamped "PRICING CALCULATOR 2023") | no stamp; fetched 2026-09-26 | https://www.splunk.com/en_us/products/pricing/pricing-calculator.html |
| S12 | Somerford, G-Cloud 14, "Splunk End Customer Pricelist - EMEA" (USD, ex-VAT) | uploaded 2025-01-22; PDF created 2024-05-03; channel list 2024-04-12 | https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/584424/410732020769866-pricing-document-2025-01-22-0621.pdf |
| S13 | Networkology, G-Cloud 14, "Splunk End Customer Pricelist - EMEA DISTRIBUTOR April'24" | 2024-05-03 | https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/704888/577509071646966-pricing-document-2024-05-03-1004.pdf |
| S14 | Bytes Software Services, G-Cloud 14 price list | 2024-04-23 | https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/92220/511766451042724-pricing-document-2024-04-23-1505.pdf |
| S15 | Softcat, G-Cloud 14 price list (document 92354); agrees with S12-S14 per the research pass, URL not captured, cited for no number here | 2024-05-01 | (not captured) |
| S16 | Somerford, G-Cloud 15 price list | 2026-01-30 | https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-15/documents/584424/793652572707052-pricing-document-2026-01-30-1331.pdf |
| S17 | hssl.us US reseller MSRP pages (SE-S-CLD-ST tiers, ES per SVC, storage true-up charges) | undated; fetched 2026-09-26 | https://hssl.us/splunk-cloud-subscription-with-standard-success-plan-gb-day-se-s-cld-st-5000-9999/ ; https://hssl.us/splunk-cloud-subscription-data-storage-true-up-500gb-increments-se-s-svc-stor-tuc/ |
| S18 | GSA Schedule 70 price list, contract 47QTCA18D00A9 (Epic Machines Inc.) | 2018-04-18 | https://gsaadvantage.gov/ref_text/47QTCA18D00A9/0VP9ZC.3RFMY3_47QTCA18D00A9_IFSS600V2.PDF |
| S19 | AWS Marketplace, Splunk Cloud Platform listing | fetched 2026-09-26 | https://aws.amazon.com/marketplace/pp/prodview-jlaunompo5wbw |
| S20 | Splunk General Terms | "Last Updated: May 2026" | https://www.splunk.com/en_us/legal/splunk-general-terms.html |
| S21 | splunk.com, Pricing FAQ | fetched 2026-09-26 | https://www.splunk.com/en_us/products/pricing/faqs.html |
| S22 | Admin Manual 10.1.2507, Monitor current usage of searchable storage (DDAS) | 2026-03-19 | https://help.splunk.com/en/data-management/splunk-cloud-platform-admin-manual/10.1.2507/monitor-your-splunk-cloud-platform-deployment/use-the-license-usage-dashboards/monitor-current-usage-of-searchable-storage-ddas |
| S23 | Admin Manual 10.4.2604, Use the Ingest Processor dashboard | 2026-05-14 | https://help.splunk.com/en/data-management/splunk-cloud-platform-admin-manual/10.4.2604/monitor-your-splunk-cloud-platform-deployment/use-the-license-usage-dashboards/use-the-ingest-processor-dashboard |
| S24 | Federated Search 10.3.2512, About Federated Search for Amazon S3 (DSU definition; the 10.5.2605 legacy page carries the same text) | 2026-03-06 | https://help.splunk.com/en/splunk-cloud-platform/search/federated-search/10.3.2512/search-data-stored-in-amazon-s3/about-federated-search-for-amazon-s3 |
| S25 | Splunk blog, Introducing resource metrics: the new Workload dashboard | 2025-10-14 | https://www.splunk.com/en_us/blog/platform/introducing-resource-metrics-elevate-your-insights-with-the-new-workload-dashboard.html |
| S26 | Admin Manual 10.3.2512, Optimize indexing and search processes | 2026-03-16 | https://help.splunk.com/en/splunk-cloud-platform/administer/admin-manual/10.3.2512/optimize-indexing-and-search-processes/optimize-indexing-and-search-processes |
| S27 | Splunk Lantern, Platform capacity considerations (Splunk Enterprise guidance) | undated | https://lantern.splunk.com/Splunk_Success_Framework/Platform_Management/Platform_capacity_considerations |
| S28 | Splunk, Gain more value with workload pricing (PDF) | (c) 2021; PDF 2021-02-26 | https://www.splunk.com/en_us/pdfs/getting-started/gain-more-value-workload-pricing.pdf |
| S29 | Splunk blog, Workload pricing: more value from Splunk Cloud | 2021-10-19 | https://www.splunk.com/en_us/blog/conf-splunklive/workload-pricing-more-value-from-splunk-cloud.html |
| S30 | Splunkbase, Splunk App for Chargeback (v2.0.59) | 2026-01-14 | https://splunkbase.splunk.com/app/5688 |
| S31 | Splunk Community thread 751227 (per-index SVC alerting), Wayback copy | archived 2025-08-07 | https://web.archive.org/web/20250807185455/https://community.splunk.com/t5/Splunk-Search/Splunk-alert-when-specific-index-SVC-usage-is-too-high-or-too/m-p/751227 |
| S32 | Splunk Community thread 548971 (Workload-Based Pricing), Wayback copy; numeric replies snippet-only | archived 2025-05-13 | https://web.archive.org/web/20250513112741/https://community.splunk.com/t5/Splunk-Cloud-Platform/Workload-Based-Pricing/td-p/548971 |
| S33 | Splunk Community thread 749833 (calculating SVCs on-prem), snippet only | 2025 | https://community.splunk.com/t5/Splunk-Enterprise/How-do-we-calculate-SVCs-on-prem-to-the-best-of-our-ability/td-p/749833 |
| S34 | Splunk support KB (shared services SVC), search snippet only; page unreadable | undated | https://splunk.my.site.com/customer/s/article/The-splunkd |
| S35 | Cribl, Splunk solutions page | undated | https://cribl.io/solutions/technologies/splunk/ |
| S36 | Cribl whitepaper landing page, Improving Splunk software and lowering CPU usage with Cribl | 2026-07-16 | https://cribl.io/resources/wp/improving-splunk-software-and-lowering-cpu-usage-with-cribl/ |
| S37 | Cribl LogStream-era whitepaper PDF (partner-hosted) | PDF undated; hosted 2024-02 | https://spicosolutions.com/wp-content/uploads/2024/02/Learn-How-to-Improve-Splunk-Performance-and-Lower-CPU-Usage-Cribl-Whitepaper.pdf |
| S38 | Cribl blog, Improving Splunk performance (Ahmed Kira) | 2021-07-08 | https://cribl.io/blog/improving-splunk-performance/ |
| S39 | Cribl case study, Finality | 2024-04-22 | https://cribl.io/resources/cs/finality/ |
| S40 | Cribl blog, Augment an existing data lake with Exabeam and Cribl Stream | 2022-12-06 | https://cribl.io/blog/how-to-augment-an-existing-data-lake-with-exabeam-and-cribl-stream/ |
| S41 | Cribl blog, Understanding Splunk's new license model (Clint Sharp) | 2019-09-19 | https://cribl.io/blog/understanding-splunks-new-license-model-its-not-the-pricing-model-its-the-price-tag-that-matters/ |
| S42 | Cribl ROI calculator (page JS read) | undated; read 2026-09-26 | https://cribl.io/roi-calculator/ |
| S43 | Cribl community, Splunk license utilization and Cribl savings on one chart (Ben Marcus, Employee) | 2025-03-11 | https://knowledge.cribl.io/general-7/curious-if-anyone-has-a-way-to-show-splunk-license-utilization-and-cribl-savings-on-the-same-chart-1375 |
| S44 | Cribl webinar landing, Manage Splunk Cloud CPU utilization and costs with Cribl Stream | 2023-12-06 | https://cribl.io/resources/learn-how-to-manage-splunk-cloud-cpu-utilization-and-costs-with-cribl-logstream/ |
| S45 | Cribl docs, About Insights | undated; checked 2026-09-26 | https://docs.cribl.io/insights/about/ |
| S46 | TekStream, Splunk Cloud cost optimization (Somesh Soni) | undated | https://www.tekstream.com/blog/splunk-cloud-cost-optimization-enterprise-strategies/ |
| S47 | SP6, Choosing the right Splunk license | 2024-02-08 | https://sp6.io/blog/choosing-the-right-splunk-license/ |
| S48 | Kinney Group, What is Splunk's SVC consumption licensing? | 2025-09-25 | https://kinneygroup.com/blog/what-is-splunks-svc-consumption-licensing/ |
| S49 | Edge Delta, Splunk SVC workload pricing | 2022-01-08, updated 2025-03-13 | https://edgedelta.com/company/blog/splunk-svc-workload-pricing |
| S50 | Realm Security, How to reduce Splunk costs | 2026-06-25 | https://realm.security/how-to-reduce-splunk-costs/ |
| S51 | siemcostcalculator.com, Splunk pricing | 2026-07-13 | https://siemcostcalculator.com/splunk-pricing |
| S52 | expanso.io, Splunk pricing guide | modified 2026-09-24 | https://expanso.io/blog/splunk-pricing-guide/ |
| S53 | monitoringcost.com, Splunk pricing | 2026-06 | https://monitoringcost.com/splunk-pricing |
| S54 | Motadata, Splunk pricing | 2026-07-23 | https://www.motadata.com/blog/splunk-pricing |
| S55 | Vendr, Splunk marketplace page | 2026-02 | https://www.vendr.com/marketplace/splunk |
| S56 | costbench.com, Splunk Cloud | 2026-07-11 | https://costbench.com/software/log-management/splunk-cloud/ |
| S57 | TechTarget, Post-lawsuit, Splunk and Cribl meet again in data pipelines (Beth Pariseau) | 2024-06-17 | https://www.techtarget.com/searchitoperations/news/366589134/Post-lawsuit-Splunk-and-Cribl-meet-again-in-data-pipelines |
| S58 | Splunk, Success plans purchased before 2022-02-01 | fetched 2026-09-26 | https://www.splunk.com/en_us/support-and-services/success-plans-purchased.html |
| S61 | Splunk Lantern, Optimizing data model acceleration for better performance | undated | https://lantern.splunk.com/Platform_Data_Management/Optimize_Data/Optimizing_data_model_acceleration_for_better_performance |
| S62 | Admin Manual 10.2.2510, Monitor current usage of your ingestion-based subscription | 2026-02-05 | https://help.splunk.com/en/data-management/splunk-cloud-platform-admin-manual/10.2.2510/monitor-your-splunk-cloud-platform-deployment/use-the-license-usage-dashboards/monitor-current-usage-of-your-ingestion-based-subscription |
| S63 | Splunk blog, Dynamic Data: data retention options in Splunk Cloud | 2022-11-11 | https://www.splunk.com/en_us/blog/platform/dynamic-data-data-retention-options-in-splunk-cloud.html |

Raw page text and the source PDFs from the research passes are in the session scratchpad (`svc-details.txt`, `svc-usage.txt`, `lantern-*.txt`, `pcl-aug2026.txt`, `somerford-2025.txt`, `networkology-2024.txt`, `svc_pricing_findings.json`, `findings_final.json`, `svc_findings.json`); they are not committed.

Coverage bounds: community.splunk.com and Reddit were unreachable except via two Wayback copies; Splunk support KBs are JS-rendered; no .conf slide decks were retrievable (PLA1033 is covered through its Lantern write-up); Cisco/Splunk's direct price book is not public and the newest public list checked is January 2026. Every session's WebSearch budget was exhausted during verification, so currency rests on direct fetches of the primary pages and their version selectors.
