// core/presets.ts — typical $/GB starting points per destination vendor (SPEC 6).
//
// Each preset is TYPICAL LIST PRICING, not a quote: the UI offers it as a starting point, labelled as
// such, until the member enters a contract rate. Stored as integer millicents per GB ($1 = 100,000).
// Values were researched and checked against vendor price lists, public reseller filings and third-party
// reports on 9/26/26; PRESET_NOTES holds, per preset, the typical range, how the per-GB figure is derived,
// how firm it is, and the sources with the words on them that carry the number. The basis and sources are
// data (like the preset labels here) and are shown as-is on the Prices page and in the README; the words
// that frame them ("typical", "range", "Typical list pricing, not a quote…") live in src/copy/en.ts.
//
// Two values are rounded to the price field's three-decimal granularity (SPEC 6: "accepts dollars with up to
// three decimals"), so a picked preset is always a valid entry: Azure Blob $0.0184 → $0.018 and Snowflake
// $0.0341 → $0.034. Both lie inside their ranges; the exact figures are in their notes.

import type { Preset, PresetId, PresetNote } from './types.ts';
import { DEMO_TAG } from './flows.ts';

/**
 * SPEC 6 table, in order. `matchTypes` holds the SPEC's type names plus the exact Cribl 4.20
 * `Output.type` spellings where they differ (`humio_hec`, `crowdstrike_next_gen_siem`,
 * `snowflake_streaming`, `databricks_zerobus`), so auto-suggest works on real inventories.
 */
export const PRESETS: Preset[] = [
  { id: 'splunk_cloud', label: 'Splunk Cloud', matchTypes: ['splunk_hec'], milliCentsPerGb: 225_000, billing: 'entitlement', monogram: 'SC' },
  { id: 'splunk_enterprise', label: 'Splunk Enterprise', matchTypes: ['splunk', 'splunk_lb'], milliCentsPerGb: 200_000, billing: 'entitlement', monogram: 'SE' },
  { id: 'sentinel', label: 'Microsoft Sentinel', matchTypes: ['sentinel', 'azure_logs'], milliCentsPerGb: 250_000, billing: 'entitlement', monogram: 'MS' },
  {
    id: 'crowdstrike_ngsiem',
    label: 'CrowdStrike Falcon Next-Gen SIEM / LogScale',
    matchTypes: ['humio', 'humio_hec', 'crowdstrike_ngsiem', 'crowdstrike_next_gen_siem'],
    milliCentsPerGb: 200_000,
    billing: 'entitlement',
    monogram: 'CS',
  },
  { id: 'datadog', label: 'Datadog Logs', matchTypes: ['datadog'], milliCentsPerGb: 180_000, billing: 'metered', monogram: 'DD' },
  { id: 'elastic', label: 'Elastic Cloud', matchTypes: ['elastic', 'elastic_cloud'], milliCentsPerGb: 35_000, billing: 'metered', monogram: 'EC' },
  { id: 'google_secops', label: 'Google SecOps', matchTypes: ['google_chronicle', 'chronicle'], milliCentsPerGb: 150_000, billing: 'entitlement', monogram: 'GS' },
  { id: 'sumo', label: 'Sumo Logic', matchTypes: ['sumo_logic'], milliCentsPerGb: 250_000, billing: 'entitlement', monogram: 'SL' },
  { id: 'newrelic', label: 'New Relic', matchTypes: ['newrelic', 'newrelic_events'], milliCentsPerGb: 40_000, billing: 'metered', monogram: 'NR' },
  { id: 's3', label: 'Amazon S3', matchTypes: ['s3'], milliCentsPerGb: 2_300, billing: 'storage', monogram: 'S3' },
  { id: 'azure_blob', label: 'Azure Blob', matchTypes: ['azure_blob'], milliCentsPerGb: 1_800, billing: 'storage', monogram: 'AB' },
  { id: 'cribl_lake', label: 'Cribl Lake', matchTypes: ['cribl_lake'], milliCentsPerGb: 5_000, billing: 'storage', monogram: 'CL' },
  { id: 'databricks', label: 'Databricks', matchTypes: ['databricks', 'databricks_zerobus'], milliCentsPerGb: 5_000, billing: 'metered', monogram: 'DB' },
  { id: 'snowflake', label: 'Snowflake', matchTypes: ['snowflake', 'snowflake_streaming'], milliCentsPerGb: 3_400, billing: 'metered', monogram: 'SF' },
  { id: 'internal', label: 'Internal / free', matchTypes: ['devnull', 'cribl_tcp', 'cribl_http', 'router'], milliCentsPerGb: 0, billing: 'metered', monogram: 'IF' },
];

/**
 * What each preset's typical price rests on (verified 9/26/26). `rangeUsd` is what customers typically pay
 * per GB, low to high; `confidence` is 'published' (the vendor's own price list or price API), 'reported'
 * (a reseller filing or third-party report) or 'estimate' (our arithmetic on those, with stated assumptions).
 */
export const PRESET_NOTES: Readonly<Record<PresetId, PresetNote>> = {
  splunk_cloud: {
    rangeUsd: [1.47, 4.85],
    confidence: 'reported',
    basis:
      "Ingest pricing: annual subscription per GB/day of entitlement. Per-GB figure = (annual $ per GB/day) / 365, assuming the full daily entitlement is used (unused entitlement raises the effective rate). Preset = $822.25/GB/day/yr at the 1,000-1,999 GB/day tier, Standard Success Plan, platform only, which is about $2.25/GB. That also roughly equals platform plus Enterprise Security after a ~35% discount ((822.25 + 465.75) x 0.65 / 365 = about $2.29). Enterprise Security adds about $1.28/GB at list ($465.75/GB/day/yr at 1-2 TB/day). Range low = $764.75 (5-10 TB/day tier) less an assumed ~30% discount = about $1.47. High = platform + ES at list, 100-199 GB/day tier ($1,012 + $759 = about $4.85). Splunk publishes no rates of its own. These figures are from EMEA end-customer price lists in USD that Splunk resellers filed on UK G-Cloud 14 (Somerford, Jan 2025; Networkology, Apr 2024), and the two lists agree. The ingest subscription typically includes 90 days of searchable storage. Caveats: Splunk licenses the size of _raw, while Cribl counts delivered bytes including HEC/S2S metadata, so Cribl's GB can run a little higher than Splunk's license GB. Customers on workload (SVC) pricing do not pay per GB, so ingest cuts save them money only indirectly.",
    sources: [
      {
        url: 'https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/584424/410732020769866-pricing-document-2025-01-22-0621.pdf',
        publisher: 'UK G-Cloud 14 price list (Somerford, Jan 2025)',
        quote: 'SE-S-CLD-ST ... 100 - 199 GB/day $1,012.00 ... 500 - 999 GB/day $851.00 ... 1000 - 1999 GB/day $822.25 ... 2000 - 4999 GB/day $793.50 ... 5000 - 9999 GB/day $764.75',
      },
      {
        url: 'https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/704888/577509071646966-pricing-document-2024-05-03-1004.pdf',
        publisher: 'UK G-Cloud 14 price list (Networkology, Apr 2024)',
        quote: 'ES-S-CLD-ST Splunk Enterprise Security - Subscription with Standard Success Plan - GB/day ... 100 - 199 GB/day $759.00 ... 1000 - 1999 GB/day $465.75',
      },
      {
        url: 'https://siemcostcalculator.com/splunk-pricing',
        publisher: 'SIEM Cost Calculator: Splunk pricing',
        quote: 'roughly $1,000 per GB/day/yr at a typical 50 GB/day deployment, rising toward $1,620 at single-digit volumes and falling below $750 at very high volume',
      },
    ],
  },
  splunk_enterprise: {
    rangeUsd: [1.4, 3.0],
    confidence: 'estimate',
    basis:
      'Self-managed. Annual term license per GB/day plus infrastructure you run yourself, converted with /365 assuming full use of the entitlement. The license at list is $621/GB/day/yr at 1,000-1,999 GB/day (about $1.70/GB). After an assumed ~30% negotiated discount it is about $1.19/GB. Add roughly $0.50-1.00/GB for your own indexers and storage. Splunk sizes a reference-hardware indexer at up to 300 GB/day with a search load, and far less with Enterprise Security. The infrastructure estimate assumes replication factor 2 and about 90 days of searchable storage. Staff costs are excluded. The preset of about $2.00 is an estimate. Low = $575 list at 5-10 TB/day less 30% (about $1.10) plus lean infrastructure (about $0.30). High = list license at 1-2 TB/day ($1.70) plus ES-sized infrastructure (about $1.30). The Enterprise Security term license is extra.',
    sources: [
      {
        url: 'https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/704888/577509071646966-pricing-document-2024-05-03-1004.pdf',
        publisher: 'UK G-Cloud 14 price list (Networkology, Apr 2024)',
        quote: 'SE-T-LIC-ST Splunk Enterprise - Term License with Standard Success Plan - GB/day ... 500 - 999 GB/day $644.00 ... 1000 - 1999 GB/day $621.00 ... 5000 - 9999 GB/day $575.00',
      },
      {
        url: 'https://help.splunk.com/en/splunk-enterprise/get-started/deployment-capacity-manual/10.2/performance-reference/summary-of-performance-recommendations',
        publisher: 'Splunk capacity planning manual',
        quote: 'An indexer that meets the minimum reference hardware requirements can ingest up to 300 GB/day while supporting a search load.',
      },
    ],
  },
  sentinel: {
    rangeUsd: [2.05, 5.59],
    confidence: 'published',
    basis:
      "Analytics tier with simplified pricing (Sentinel and Log Analytics ingestion on one meter), per GB ingested (10^9 bytes). Pay-as-you-go is $4.30/GB in East US, West US 2 and West US 3, $4.76 in East US 2, and $5.59 in West US and West Europe (Azure Retail Prices API, Sep 2026). Commitment tiers in East US, as the per-day price and the resulting $/GB: 50 GB/d $161.25 = $3.23; 100 GB/d $296 = $2.96; 500 GB/d $1,265 = $2.53; 1,000 GB/d $2,480 = $2.48; 5,000 GB/d $11,550 = $2.31; 50,000 GB/d $102,600 = $2.05. The 50 GB tier appears in the API from Oct 2025, although the Learn page still says tiers start at 100 GB. Usage above the commitment is billed at the tier's effective rate. The preset is the 500-1,000 GB/day commitment tier. The first 90 days of retention are included. Free data sources (for example Azure Activity, Office 365 audit and Defender alerts) and the M365 E5 data grant lower the effective rate. Most data sent through Cribl (firewall, syslog, CEF) is billable. The data lake tier is much cheaper for secondary logs: $0.05/GB ingest + $0.10/GB processing + $0.026/GB-month storage.",
    sources: [
      {
        url: "https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Sentinel' and armRegionName eq 'eastus'",
        publisher: 'Azure Retail Prices API: Sentinel, East US',
        quote: 'Pay-as-you-go Analysis | 1 GB | 4.3; 50 GB Commitment Tier Capacity Reservation | 1/Day | 161.25; 500 GB Commitment Tier Capacity Reservation | 1/Day | 1265.0; 1000 GB Commitment Tier Capacity Reservation | 1/Day | 2480.0; 50000 GB Commitment Tier Capacity Reservation | 1/Day | 102600.0; Data lake ingestion Data Processed | 1 GB | 0.05; Data processing Data Processed | 1 GB | 0.1; Data lake storage Data Stored | 1 GB/Month | 0.026',
      },
      {
        url: 'https://learn.microsoft.com/en-us/azure/sentinel/billing',
        publisher: 'Microsoft Learn: Sentinel billing',
        quote: 'Commitment tier pricing starts at 100 GB per day. Any usage above the commitment level is billed at the Commitment tier rate you selected. ... The Effective Per GB Price is simply the Microsoft Sentinel Price divided by the Tier GB per day quantity. ... Retain all data ingested into the workspace at no charge for the first 90 days.',
      },
    ],
  },
  crowdstrike_ngsiem: {
    rangeUsd: [0.73, 5.95],
    confidence: 'reported',
    basis:
      "Third-party (non-Falcon) data only: Falcon telemetry is not charged, and Falcon Insight customers get 10 GB/day of third-party data free. BT's G-Cloud 14 filing (2-year term, prices exclude VAT) lists two annual recurring lines per GB/day: NG-SIEM at £200 and NG-SIEM retention at £615. Converted with /365 and an assumed 1.33 USD/GBP, the two together are about $2.97/GB. The filing says these figures are for the lowest commit and the highest retention, but it does not name the retention period. Some third-party write-ups give this line as £2,000; the filed PDF says £200. The preset takes the retention-inclusive rate less the 25-30% EA discount a third party reports for multi-year commits above $250K a year ($2.08-2.23), rounded down to $2.00. Range low of $0.73 is the NG-SIEM ingest line alone at the default 7-day retention (£200), which is not a realistic SIEM setup. Range high of $5.95 is the AWS Marketplace pay-as-you-go rate ($0.00595/MB, 13-month retention included). LogScale Cloud on the same filing is £1,370 + £205 retention, about $5.74/GB. Support adds 12-25%.",
    sources: [
      {
        url: 'https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/92553/402045104585581-pricing-document-2024-05-02-1114.pdf',
        publisher: 'UK G-Cloud 14 price list (BT, May 2024)',
        quote: 'Falcon Next Gen-SIEM £200 Per GB/Day for 3rd Party Data ... Falcon NG-SIEM Retention £615 GB/Day desired retention ... Falcon Logscale Cloud £1,370 Per GB/Day for 3rd Party Data ... Falcon Logscale Retention £205 Per GB/Day desired retention ... Pricing is based on a 7-day data retention with extended retention durations available. Commercials Provided for NG SIEM and Logscale Cloud represent lowest commit GB/Day & Highest Retention.',
      },
      {
        url: 'https://aws.amazon.com/marketplace/pp/prodview-vubjuepxztndi',
        publisher: 'AWS Marketplace: Falcon Next-Gen SIEM',
        quote: 'Falcon Next-Gen SIEM (13-month retention) | Per MB of non Falcon data ingested (flat fee) | $0.00595',
      },
      {
        url: 'https://siemcostcalculator.com/crowdstrike-logscale-pricing',
        publisher: 'SIEM Cost Calculator: CrowdStrike LogScale pricing',
        quote: 'EA discounting at multi-year commits above $250K committed annual spend produces 25-30 percent off list as a routine outcome.',
      },
    ],
  },
  datadog: {
    rangeUsd: [0.95, 3.85],
    confidence: 'published',
    basis:
      'Ingest $0.10/GB plus indexing $1.70 per million events (15-day retention, billed annually). Converted assuming a 1 KB average event (1M events = 1 GB) with 100% of logs indexed: $0.10 + $1.70 = $1.80/GB at list. Event size matters a lot. At 2 KB the indexing part halves (about $0.95/GB). At 500 B, which is common for syslog and firewall events, it doubles (about $3.50/GB). Logs that are ingested but excluded from indexes cost only $0.10/GB. For data Cribl drops, the preset therefore overstates what would have been paid if the customer would otherwise have used exclusion filters. Other retentions, billed annually, per million: 3-day $1.06, 7-day $1.27, 30-day $2.50. Month-to-month is 1.2x and on-demand is 1.5x. Range high = 30-day on-demand at 1 KB ($3.75 + $0.10). Flex Logs storage is extra at $0.05 per million events per month.',
    sources: [
      {
        url: 'https://www.datadoghq.com/pricing/list/',
        publisher: 'Datadog price list',
        quote: 'Logs - Ingestion Per ingested logs (1GB), per month $0.10 ... Per 1M indexed logs (15-day retention), per month $1.70 $2.04 $2.55 ... Per 1M indexed logs (30-day retention), per month $2.50 $3 $3.75 (columns: billed annually / month-to-month / on-demand)',
      },
      {
        url: 'https://www.parseable.com/blog/datadog-log-management-cost',
        publisher: 'Parseable: Datadog log management cost',
        quote: '1 KB average event size or about 1 million events per GB',
      },
    ],
  },
  elastic: {
    rangeUsd: [0.15, 1.1],
    confidence: 'estimate',
    basis:
      "Serverless bills per GB ingested plus per GB-month retained. Both are measured on the fully enriched, normalized size at the end of the ingest pipeline, before compression. Elastic says this is larger than index size and can be larger than the bytes sent, so Elastic's billed GB can exceed the bytes Cribl delivers; treat the preset as a floor per Cribl GB. Preset = Security Analytics Complete, as low as $0.11 ingest + 12 months x $0.019 retention = about $0.34 per billed GB, rounded to $0.35. The rates say 'as low as', so the rate at a given volume may be higher. Range low = Observability Complete $0.09 + 3 months x $0.019 (about $0.15). Range high = the $0.50-1.10 effective rate reported for Elastic Cloud Hosted, which bills provisioned compute and storage, not GB, and is what many `elastic` / `elastic_cloud` destinations point at. Self-managed Elasticsearch has no per-GB fee: the cost is your infrastructure plus the subscription. Egress over 50 GB/month is $0.05/GB.",
    sources: [
      {
        url: 'https://www.elastic.co/pricing/serverless-security',
        publisher: 'Elastic Serverless Security pricing',
        quote: 'Security Analytics Complete ... Ingest Per ingested GB As low as $0.11 Retention Per GB retained per month As low as $0.019 Egress Per GB transferred 50 GB free, then $0.05',
      },
      {
        url: 'https://www.elastic.co/docs/deploy-manage/cloud-organization/billing/security-billing-dimensions',
        publisher: 'Elastic docs: Security billing dimensions',
        quote: 'Data volumes for ingest and retention are based on the fully enriched normalized data size at the end of the ingest pipeline, before Elasticsearch compression is performed, and will be higher than the volumes traditionally reported by Elasticsearch index size. In addition, these volumes might be larger than those reported by cloud provider proxy logs for data going into Elasticsearch.',
      },
      {
        url: 'https://siemcostcalculator.com/elastic-siem-pricing',
        publisher: 'SIEM Cost Calculator: Elastic SIEM pricing',
        quote: 'expect roughly $0.50 to $1.10 per GB ingested as an effective rate once compute and storage are amortised',
      },
    ],
  },
  google_secops: {
    rangeUsd: [1.0, 2.66],
    confidence: 'estimate',
    basis:
      "Sold as a package (Standard / Enterprise / Enterprise Plus): a prepaid data cap in GB, drawn down per GB ingested, with 12 months of hot retention. Google publishes no US list price. The only public unit price is a reseller's (SEP2) UK G-Cloud 14 listing of £2,000 per TB of ingested log data per year, which is £2/GB, or about $2.66/GB at an assumed 1.33 USD/GBP. That is the range high. The $1.50 preset assumes about 44% off list for large multi-year commits, and the $1.00 range low assumes about 62% off at multi-TB/day. Both discounts are assumptions, not sourced. A Forrester TEI composite (20,000 employees) pays $500K a year for licensing, but the study does not state its ingest volume. From Feb 2026, Enterprise and Enterprise Plus contracts above a minimum value exempt some sources (for example Google Cloud audit logs) from the cap.",
    sources: [
      {
        url: 'https://www.applytosupply.digitalmarketplace.service.gov.uk/g-cloud/services/886272716164548',
        publisher: 'UK G-Cloud 14 listing: Google SecOps (SEP2)',
        quote: 'Pricing £2,000 a terabyte a year ... Log data is limited to 365 days, unless a separate GCP bucket is configured for longer term retention.',
      },
      {
        url: 'https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/715803/886272716164548-pricing-document-2024-05-07-1139.pdf',
        publisher: 'UK G-Cloud 14 price list: Google SecOps (SEP2, May 2024)',
        quote: 'Pricing is per TB of ingested log data.',
      },
      {
        url: 'https://docs.cloud.google.com/chronicle/docs/secops/secops-packages',
        publisher: 'Google Cloud docs: SecOps packages',
        quote: 'The pricing for all packages is based on ingestion volume.',
      },
      {
        url: 'https://services.google.com/fh/files/misc/forrester-tei-google-secops-report.pdf',
        publisher: 'Forrester TEI study: Google SecOps',
        quote: 'The composite pays $500,000 annually for its Google SecOps licensing.',
      },
    ],
  },
  sumo: {
    rangeUsd: [1.25, 6.63],
    confidence: 'estimate',
    basis:
      "Sumo has two credit models, and their credit prices should not be mixed. (1) Cloud Flex Credits: Enterprise Suite list is $0.25/credit (US, annual). Ingest burns 25 credits/GB for Continuous ($6.25/GB), 12 for Frequent ($3.00) and 5 for Infrequent ($1.25). Storage is billed separately at 0.05 credits per GB per DAY retained; Sumo's example is 10 GB/day kept 30 days = 5,475 credits/yr. At list that is about $0.375/GB for 30 days and $4.56/GB for a year. Cloud SIEM ingest is 40 credits/GB (Enterprise Security $0.225/credit = $9.00/GB). (2) Enterprise Suite Flex (MSRP $1.50/credit) has no ingest meter. You pay for storage at the same 0.05 credits/GB/day (about $2.25/GB for 30 days) plus per scanned GB (upfront search 10 credits, metered 20). Preset of $2.50 = the average of Continuous and Frequent list ingest ($4.63) less an assumed ~45% negotiated discount, excluding storage. The discount is an assumption, not sourced. Range low of $1.25 = Infrequent ingest at list with no storage. Range high of $6.63 = Continuous ingest + 30-day storage at list. Regional uplifts of +10-40% apply outside the US. The small-scale Essentials AWS listing is $135/month for 1 GB/day with 365-day storage (about $4.44/GB).",
    sources: [
      {
        url: 'https://www.sumologic.com/pricing/cloud-flex-credit',
        publisher: 'Sumo Logic Cloud Flex Credits pricing',
        quote: 'Example 1: Enterprise Suite, US deployment, Annual payment terms $0.25000 List Price Per Credit ... Continuous GB Ingest GB 25 Credits per UOM Frequent GB Ingest GB 12 Credits per UOM GB Storage GB .05 Credits per UOM ... For GB Storage, ingesting 10GB/day for 12-months and retaining that data for thirty (30) calendar days requires approximately 5,475 Credits (i.e. (10GB/day x 30 days retention) x (365 days) x (.05 Credits) = 5,475 Credits) ... Infrequent GB Ingest GB 5 Credits per UOM ... CSE GB Ingest GB 40 Credits per UOM ... Example 1: Enterprise Suite Flex, US deployment, Annual payment terms $1.50 MSRP Per Credit ... Flex Log Storage GB 0.05 credits per UOM Flex Log Upfront Search Scanned GB 10 credits per UOM Flex Log Metered Search Scanned GB 20 credits per UOM',
      },
      {
        url: 'https://aws.amazon.com/marketplace/pp/prodview-qtab72ea35oh2',
        publisher: 'AWS Marketplace: Sumo Logic',
        quote: 'ESS_700_Monthly: 700 monthly credits supporting 1GB Log ingest w 365 days Storage - $135.00/month',
      },
      {
        url: 'https://realm.security/sumo-logic-siem-pricing/',
        publisher: 'Realm Security: Sumo Logic SIEM pricing',
        quote: '$0.2250 per credit times the 40 credit burn rate gives $9.00 per GB',
      },
    ],
  },
  newrelic: {
    rangeUsd: [0.28, 0.6],
    confidence: 'published',
    basis:
      'Per GB ingested per month beyond the 100 GB/month free allowance, with all telemetry on one meter. The original data option is $0.40/GB (preset). Data Plus is $0.60/GB (longer retention, FedRAMP Moderate and HIPAA eligibility). EU data center storage adds $0.05/GB. Range low = 30% off list, the top of the 15-30% discount reported for annual commitments above 1 TB/month. Per-user fees are separate and are not per GB.',
    sources: [
      {
        url: 'https://newrelic.com/pricing',
        publisher: 'New Relic pricing',
        quote: '100 GB of free data ingest per month and $0.40/GB ingested beyond. ... Option 2: Data Plus data ingest ... $0.60/GB beyond free 100 GB limit ... You can also choose to store data in the European Union (EU) data center for an additional $0.05/GB per month.',
      },
      {
        url: 'https://monitoringcost.com/new-relic-pricing',
        publisher: 'MonitoringCost: New Relic pricing',
        quote: 'New Relic discounts annual ingest commitments above 1 TB per month. ... typical discount is 15 to 30 percent versus list.',
      },
    ],
  },
  s3: {
    rangeUsd: [0.021, 0.023],
    confidence: 'published',
    basis:
      "Storage, not ingest. S3 Standard in us-east-1 is $0.023 per GB-month for the first 50 TB, $0.022 for the next 450 TB and $0.021 over 500 TB. It is billed on stored bytes, which are compressed (Cribl's S3 destination gzips by default), and it recurs for every month the data is kept. The meter applies this price once per uncompressed GB that Cribl delivers. So $0.023 per raw GB equals one GB-month, which is roughly a year kept at ~12:1 compression or a month kept uncompressed. For a different case, scale by (months kept / compression ratio). PUT requests cost $0.005 per 1,000, which is negligible at Cribl's multi-MB object sizes. Data transfer in is free.",
    sources: [
      {
        url: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json',
        publisher: 'AWS Price List API: S3, us-east-1',
        quote: '$0.023 per GB - first 50 TB / month of storage used ... $0.022 per GB - next 450 TB / month of storage used ... $0.021 per GB - storage used / month over 500 TB ... $0.005 per 1,000 PUT, COPY, POST, or LIST requests',
      },
    ],
  },
  azure_blob: {
    rangeUsd: [0.0169, 0.0208],
    confidence: 'published',
    basis:
      'Storage, not ingest. Hot tier, LRS, General Block Blob v2, per GB-month: $0.0184 for the first 50 TB in East US 2, West US 2 and Central US (the preset, rounded to $0.018 because the price field takes at most three decimals); $0.0208 in East US; and $0.016928 over 500 TB. It is billed on stored (compressed) bytes and recurs monthly. As with S3, the meter applies this once per uncompressed GB delivered, so it equals one GB-month (roughly a year at ~12:1 compression). Hierarchical namespace (ADLS Gen2) Hot LRS costs the same or slightly less per GB ($0.018-0.0184 in East US 2, $0.0208-0.021 in East US); it differs mainly in transaction pricing. Write operations are $0.05 per 10K, which is negligible for large objects.',
    sources: [
      {
        url: "https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Storage' and armRegionName eq 'eastus2' and meterName eq 'Hot LRS Data Stored'",
        publisher: 'Azure Retail Prices API: Blob Storage, East US 2',
        quote: 'General Block Blob v2 | Hot LRS | 1 GB/Month | tier 0: 0.0184 | tier 51200: 0.017664 | tier 512000: 0.016928; General Block Blob v2 Hierarchical Namespace | tier 0: 0.018; Azure Data Lake Storage Gen2 Hierarchical Namespace | tier 0: 0.0184 (eastus General Block Blob v2 tier 0: 0.0208)',
      },
    ],
  },
  cribl_lake: {
    rangeUsd: [0.043, 0.05],
    confidence: 'published',
    basis:
      "Storage. Cribl-managed Lake is 0.05 credits per GB-month of compressed data stored (list 1 credit = $1). It is billed on compressed bytes, measured daily, and recurs for as long as the data is kept. As with S3, the meter applies this once per uncompressed GB delivered, so it equals one GB-month (roughly a year at ~12:1 compression). Range low = self-managed Bring Your Own Storage at 0.02 credits/GB plus your own cloud storage bill (about $0.023 on S3), about $0.043 in total. Not included: Direct Access ingest (0.10 credits/GB), which applies only to data sent straight to Lake without Stream and so never to Stream's `cribl_lake` destination; and Stream processing credits (0.32/GB on Cloud workers, 0.26/GB on hybrid), which Stream charges at ingest whatever the destination.",
    sources: [
      {
        url: 'https://cribl.io/pricing/lake/',
        publisher: 'Cribl Lake pricing',
        quote: 'Cribl-Managed Data Lake 0.05 Credits / GB 1 credit = $1 ... Direct Access Data Lake 0.10 Credits / GB ... You are only charged for the amount of compressed data stored per month, not the raw ingested data volume. Direct Access charges are based on the total volume of data ingested; storage costs are billed separately at standard Lake rates. ... Pricing - Self-managed BYOS 0.02 Credits / GB',
      },
      {
        url: 'https://assets.ctfassets.net/xnqwd8kotbaj/a0Q1zUZPkkwSa31kMr5DL/6545d082ceb23313f91a758d9acde0b4/BGDE-0002-EN-Pricing_Guide-3-1125.pdf',
        publisher: 'Cribl Pricing Guide (Nov 2025)',
        quote: 'Lake Storage pricing based on 30-day retention • 0.05 Credits/GB if data lake managed by Cribl • 0.02 Credits/GB if self-managed ... Hybrid Workers ... consumes 0.26 of a Cribl Credit per GB ... Cloud Workers ... consumes 0.32 of a Cribl Credit per GB ... Direct Access ingest is charged at 0.10 credits per GB for ingest, plus the standard Lake storage charges.',
      },
    ],
  },
  databricks: {
    rangeUsd: [0.05, 0.064],
    confidence: 'reported',
    basis:
      "Zerobus Ingest (serverless direct write to Unity Catalog Delta tables) is metered at 0.143 DBU per GB on the Jobs Serverless SKU (AWS) or Automated Serverless SKU (Azure). That is $0.050/GB on AWS Premium ($0.35/DBU) and $0.064/GB on AWS Enterprise and Azure Premium ($0.45/DBU; the Azure retail API confirms $0.45 for Premium Automated Serverless). The 6-month GA launch promotion (50% off, reported to end 1 Sep 2026) has ended and is not applied. Delta table storage on S3/ADLS and query compute are extra. This rate applies to Cribl's separate `databricks_zerobus` output type. presets.ts only matches `databricks`, which writes files to Unity Catalog Volumes and costs roughly cloud storage plus load compute, a similar order of magnitude. Suggest adding `databricks_zerobus` to this preset's matchTypes.",
    sources: [
      {
        url: 'https://www.flexera.com/blog/finops/databricks-pricing-guide/',
        publisher: 'Flexera: Databricks pricing guide',
        quote: 'Lakeflow Connect Zerobus Ingest $0.050 per GB (AWS, Premium) ... Lakeflow Connect Premium Zerobus Ingest $0.064 per GB (Azure)',
      },
      {
        url: 'https://www.databricks.com/blog/announcing-general-availability-zerobus-ingest-part-lakeflow-connect',
        publisher: 'Databricks blog: Zerobus Ingest GA',
        quote: 'Pricing is volume-based under the Lakeflow Jobs Serverless SKU. As part of the GA launch, we are introducing a 6-month promotional pricing period.',
      },
      {
        url: 'https://www.sunnydata.ai/blog/lakeflow-connect-free-tier-etl-cost-savings',
        publisher: 'SunnyData: Lakeflow Connect free tier',
        quote: 'a serverless direct-write API priced at $0.050 per GB. A 50% promotional discount is active until September 1, 2026, reducing the rate to 0.0715 DBU per GB.',
      },
      {
        url: "https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Azure Databricks' and armRegionName eq 'eastus'",
        publisher: 'Azure Retail Prices API: Azure Databricks, East US',
        quote: 'Premium Automated Serverless Compute DBU | 1 Hour | 0.45',
      },
    ],
  },
  snowflake: {
    rangeUsd: [0.03, 0.038],
    confidence: 'published',
    basis:
      'Ingestion plus one GB-month of storage. Snowpipe (file loading) and Snowpipe Streaming high-performance architecture both cost 0.0037 credits per GB. Snowpipe Streaming is billed on the uncompressed input bytes, and JSON/CSV files are billed on uncompressed size. At Enterprise edition on-demand, $3/credit (AWS US East), that is $0.0111/GB. Snowpipe Streaming Classic (Java SDK 4.x and older) is instead billed on compute plus 0.01 credits per client-hour. Storage is $23/TB-month on-demand in AWS US East, charged on compressed columnar bytes. As with S3, one GB-month ($0.023) per raw GB approximates keeping the data about a year at ~12:1 compression, and it keeps Snowflake from reading cheaper than S3. Preset = $0.0111 + $0.023 = $0.0341, entered as $0.034 (the price field takes at most three decimals). Range: Standard edition $2/credit ($0.030) to Business Critical $4/credit ($0.038). Excluded: warehouse compute for queries, which usually dominates total Snowflake spend on logs.',
    sources: [
      {
        url: 'https://docs.snowflake.com/en/release-notes/2025/other/2025-12-08-snowpipe-simplified-pricing',
        publisher: 'Snowflake release notes: Snowpipe pricing',
        quote: 'you are now charged a fixed credit amount per gigabyte (0.0037 credits per GB) of data ingested with Snowpipe. ... Text files, such as CSV and JSON, are billed on their uncompressed size.',
      },
      {
        url: 'https://www.snowflake.com/legal-files/CreditConsumptionTable.pdf',
        publisher: 'Snowflake Credit Consumption Table',
        quote: 'Effective: September 25, 2026 ... Snowpipe 0.0037 Platform Credits per GB ... Snowpipe Streaming 0.0037 Platform Credits per uncompressed GB ... Snowpipe Streaming Classic 0.01 Platform Credits per client instance per hour ... Table 2(a): On Demand Platform Credit Pricing ... AWS US East (Northern Virginia) $2.00 $3.00 $4.00 (Standard / Enterprise / Business Critical) ... Table 3(a): Standard Storage Pricing ... AWS US East (Northern Virginia) $23.00 (On Demand, TB/mo)',
      },
      {
        url: 'https://docs.snowflake.com/en/user-guide/snowpipe-streaming/snowpipe-streaming-high-performance-cost',
        publisher: 'Snowflake docs: Snowpipe Streaming cost',
        quote: 'Billing is based on the input bytes received by Snowpipe Streaming, not the final byte count produced in the target table.',
      },
    ],
  },
  internal: {
    rangeUsd: [0, 0],
    confidence: 'published',
    basis:
      "Internal hops (devnull, router, cribl_tcp, cribl_http, default) have no destination charge. Cribl processing credits are billed by Stream at ingest, not by the destination. Cribl's guide notes that data dropped before routing to any destination, including DevNull, is not counted in the ingest rate.",
    sources: [
      {
        url: 'https://assets.ctfassets.net/xnqwd8kotbaj/a0Q1zUZPkkwSa31kMr5DL/6545d082ceb23313f91a758d9acde0b4/BGDE-0002-EN-Pricing_Guide-3-1125.pdf',
        publisher: 'Cribl Pricing Guide (Nov 2025)',
        quote: "We charge on ingress, but you never pay for egress, so you can send your processed data to as many destinations as you'd like. ... There is no cost to send data between Edge Agents and Stream Workers, and no cost to send data between Stream Workers.",
      },
    ],
  },
};

/** The note behind a preset's typical price. */
export function presetNote(id: PresetId | string | undefined): PresetNote | undefined {
  return id === undefined ? undefined : (PRESET_NOTES as Record<string, PresetNote>)[id];
}

/**
 * Destination types that are genuinely free (the `internal` preset's matches plus the built-in
 * `default` output, which only forwards to another output).
 */
export const FREE_OUTPUT_TYPES: readonly string[] = ['devnull', 'cribl_tcp', 'cribl_http', 'router', 'default'];

/** A genuinely free destination type (devnull, default, router, cribl_tcp, cribl_http). */
export function isFreeOutputType(outputType: string | undefined): boolean {
  return outputType !== undefined && FREE_OUTPUT_TYPES.includes(outputType.trim().toLowerCase());
}

const byId = new Map<PresetId, Preset>(PRESETS.map((p) => [p.id, p]));

export function presetById(id: PresetId | string | undefined): Preset | undefined {
  return id === undefined ? undefined : byId.get(id as PresetId);
}

/**
 * Suggests a preset from a destination's `type` (and, for S2S `splunk`, its host):
 * `splunk` pointed at a `*.splunkcloud.com` host is Splunk Cloud. Unmatched types → 'internal'
 * (priced at 0 and flagged unpriced by the caller, SPEC 6). `suggestPresetFor` also reads the
 * destination's description and id.
 */
export function suggestPreset(outputType: string, host?: string): PresetId {
  const t = (outputType ?? '').trim().toLowerCase();
  if (t === 'splunk' && host && /(^|\.)splunkcloud\.com$/i.test(host.trim().replace(/:\d+$/, ''))) return 'splunk_cloud';
  for (const p of PRESETS) {
    if (p.matchTypes.includes(t)) return p.id;
  }
  return 'internal';
}

/** What auto-suggest and the unpriced rule may know about a destination (core/types OutputInfo fits it). */
export interface OutputHint {
  type?: string;
  /** Core-12 (M12): an Output Router's rules; a router that splits across destinations is not free (isFreeOutput). */
  rules?: readonly { output: string; disabled?: boolean }[];
  /** The output id, read for vendor words when neither the description nor the type names a paid preset. */
  id?: string;
  /** "… Priced with the splunk_cloud preset …" (the demo rig's wording) names the preset outright. */
  description?: string;
  /** S2S host: `splunk` to `*.splunkcloud.com` is Splunk Cloud. */
  host?: string;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/[\s-]+/g, '_');

/**
 * The preset a description names: "Priced with the splunk_cloud preset", "priced as Splunk Cloud preset",
 * by id or by label (P0-04: the demo rig's destinations are DevNull outputs that say what they stand for).
 */
export function presetFromDescription(description: string | undefined): PresetId | undefined {
  const m = /\bpriced\s+(?:with|as|at)\s+(?:the\s+)?(.+?)\s+preset\b/i.exec(description ?? '');
  if (!m) return undefined;
  const wanted = norm(m[1]);
  return PRESETS.find((p) => p.id === wanted || norm(p.label) === wanted)?.id;
}

/**
 * Vendor words in an output id, in order (the first word found wins): `mrd_siem_prod` → Splunk Cloud,
 * `mrd_analytics` → Datadog, `mrd_archive_s3` → S3. Read only when the type names no paid preset.
 */
const NAME_HINTS: readonly (readonly [readonly string[], PresetId])[] = [
  [['splunk', 'siem'], 'splunk_cloud'],
  [['sentinel'], 'sentinel'],
  [['crowdstrike', 'logscale', 'humio'], 'crowdstrike_ngsiem'],
  [['datadog', 'analytics'], 'datadog'],
  [['elastic', 'elasticsearch'], 'elastic'],
  [['chronicle', 'secops'], 'google_secops'],
  [['sumo', 'sumologic'], 'sumo'],
  [['newrelic'], 'newrelic'],
  [['s3', 'archive'], 's3'],
  [['blob'], 'azure_blob'],
  [['lake'], 'cribl_lake'],
  [['databricks'], 'databricks'],
  [['snowflake'], 'snowflake'],
];

/** The preset an output id's words suggest (`mrd_siem_prod` → splunk_cloud), if any. */
export function presetFromName(id: string | undefined): PresetId | undefined {
  const words = new Set((id ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  return NAME_HINTS.find(([hints]) => hints.some((w) => words.has(w)))?.[1];
}

/**
 * The suggested preset for a destination (P0-04), strongest evidence first: a preset its description names;
 * its type (and S2S host) when that names a paid preset; vendor words in its id when the type is free or
 * unknown (a DevNull called `siem-prod` stands in for a SIEM); else 'internal'. So 'internal' is suggested
 * only for destinations that nothing marks as paid.
 */
export function suggestPresetFor(o: OutputHint): PresetId {
  const described = presetFromDescription(o.description);
  if (described) return described;
  const byType = suggestPreset(o.type ?? '', o.host);
  if (byType !== 'internal') return byType;
  return presetFromName(o.id) ?? 'internal';
}

/** A destination the demo rig created (its description carries the demo tag, CLAUDE.md). */
export function isDemoTagged(o: OutputHint): boolean {
  return (o.description ?? '').includes(DEMO_TAG);
}

/**
 * A destination that costs nothing and needs no price: a genuinely free type (isFreeOutputType) that nothing
 * marks as standing in for a paid one — no preset in its description, no vendor words in its id, not a demo
 * rig object. A DevNull called `siem-prod` is a SIEM to price, not a free sink (P0-04).
 */
export function isFreeOutput(o: OutputHint | string | undefined): boolean {
  const hint: OutputHint = typeof o === 'string' || o === undefined ? { type: o } : o;
  // Core-12 (M12, #45): a router whose rules send to more than one destination forwards paid traffic one flow cannot
  // attribute; it is not free, so its traffic reads unpriced (price it at its destinations' rate) — never a silent $0.
  if ((hint.type ?? '').trim().toLowerCase() === 'router' && new Set((hint.rules ?? []).filter((r) => r.disabled !== true).map((r) => r.output)).size > 1) return false;
  return isFreeOutputType(hint.type) && !isDemoTagged(hint) && suggestPresetFor(hint) === 'internal';
}

/**
 * Whether a stored price is the member's own rather than its preset's typical value (P1-G01): an entry with
 * no preset, or one whose price differs from the preset's ($1.80 typed on a Splunk Cloud row). Show the math
 * then says "Custom price", never "Preset: Splunk Cloud" beside a price that is not Splunk Cloud's. The
 * preset stays stored: it still says which vendor the destination is.
 */
export function isCustomPrice(entry: { preset?: PresetId | string; milliCentsPerGb: number } | undefined): boolean {
  if (!entry) return false;
  const preset = presetById(entry.preset);
  return preset === undefined || preset.milliCentsPerGb !== entry.milliCentsPerGb;
}

/**
 * True when a price set from this preset leaves the destination effectively UNPRICED: no preset
 * at all, or the `internal` fallback applied to a destination type that is not genuinely free
 * (e.g. a `webhook` that auto-suggest could not match). `internal` on devnull/router/cribl_* is a
 * real $0 price, not an unpriced one.
 */
export function isUnpricedPreset(id: PresetId | undefined, outputType?: string): boolean {
  if (id === undefined) return true;
  if (id !== 'internal') return false;
  return !isFreeOutputType(outputType);
}

// ─── Cribl's own cost: a typical-list suggestion (rules round, usefulness) ──────────────────────────────────────
//
// "Did Cribl pay for itself?" needs Settings → Cribl cost, a figure an admin types. The meter already measures what
// Cribl ingests, so the field can offer a starting point: GB in per day × Cribl's published Stream rate × the days
// in a month. Like every preset it is TYPICAL LIST PRICING, not a quote (the UI labels it "at typical list" until an
// admin enters the contract figure); the words that frame it live in src/copy/en.ts.

/** Cribl Stream on Cloud workers: 0.32 Cribl credits per GB ingested (list 1 credit = $1); hybrid workers 0.26. */
export const CRIBL_STREAM_CLOUD_MILLICENTS_PER_GB = 32_000;
export const CRIBL_STREAM_HYBRID_MILLICENTS_PER_GB = 26_000;
/** Average days in a month. */
export const DAYS_PER_MONTH = 365 / 12;

/** Where the suggestion's rate comes from: shown as-is beside it, like PRESET_NOTES. */
export const CRIBL_COST_NOTE: PresetNote = {
  rangeUsd: [0.26, 0.32],
  confidence: 'published',
  basis:
    'Cribl Stream charges processing credits per GB ingested, whatever the destination: 0.32 credits/GB on Cribl.Cloud workers and 0.26 on hybrid (customer-managed) workers, at a list price of $1 per credit. The suggestion is GB in per day × $0.32 × 365/12 days, with no discount, free tier or committed-use rate; a contract figure replaces it. Cribl Lake storage and Search are billed separately and are not included.',
  sources: [
    {
      url: 'https://assets.ctfassets.net/xnqwd8kotbaj/a0Q1zUZPkkwSa31kMr5DL/6545d082ceb23313f91a758d9acde0b4/BGDE-0002-EN-Pricing_Guide-3-1125.pdf',
      publisher: 'Cribl Pricing Guide (Nov 2025)',
      quote: 'Hybrid Workers ... consumes 0.26 of a Cribl Credit per GB ... Cloud Workers ... consumes 0.32 of a Cribl Credit per GB',
    },
    {
      url: 'https://cribl.io/pricing/lake/',
      publisher: 'Cribl Lake pricing',
      quote: '1 credit = $1',
    },
  ],
};

export interface CriblCostSuggestion {
  /** GB (10^9 bytes) into Cribl per day, as measured. */
  gbPerDay: number;
  /** The Cloud-worker list rate the suggestion uses, millicents per GB. */
  milliCentsPerGb: number;
  /** GB/day × $0.32 × 365/12, in whole cents a month (the unit Settings stores). */
  centsPerMonth: number;
  /** The same at the hybrid-worker rate ($0.26): the low end of the typical range. */
  lowCentsPerMonth: number;
}

/**
 * A typical-list Cribl cost for Settings → Cribl cost, from the bytes Cribl ingests per day (the snapshot's flows
 * summed: FlowFigures.inBPerDay). Undefined when nothing is measured yet: no suggestion rests on no traffic.
 */
export function suggestCriblCost(inBytesPerDay: number): CriblCostSuggestion | undefined {
  if (!Number.isFinite(inBytesPerDay) || inBytesPerDay <= 0) return undefined;
  const gbPerDay = inBytesPerDay / 1e9;
  const cents = (mcPerGb: number): number => Math.round((gbPerDay * mcPerGb * DAYS_PER_MONTH) / 1000);
  return {
    gbPerDay,
    milliCentsPerGb: CRIBL_STREAM_CLOUD_MILLICENTS_PER_GB,
    centsPerMonth: cents(CRIBL_STREAM_CLOUD_MILLICENTS_PER_GB),
    lowCentsPerMonth: cents(CRIBL_STREAM_HYBRID_MILLICENTS_PER_GB),
  };
}
