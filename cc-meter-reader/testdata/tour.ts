// testdata/tour.ts — the "Tour with sample data" fixture: demo/sample/tour.json (PRD 8.5, SPEC 15).
//
//   npx tsx testdata/tour.ts          regenerate demo/sample/tour.json (same as scripts/build-fixtures.ts)
//
// A judge installs the release package into an EMPTY workspace. The tour shows what Meter Reader looks
// like on a large enterprise estate — ≈ 30 TB a day from 40 sources in three worker groups (datacenter,
// cloud, apps) into eight destinations (Splunk Cloud, Microsoft Sentinel, Google SecOps, Datadog, Elastic,
// New Relic, Cribl Lake and an S3 archive), each priced at its preset's typical list price
// (core/presets.ts), with 30 days of history: ≈ $65k a day would have been paid without Cribl and ≈ $8.5M
// a year saved. Reductions are what these data types really get: Windows XML ≈ 33 %, firewalls 35–45 %,
// VPC Flow aggregation ≈ 90 %, Kubernetes noise ≈ 65 %, DNS and ESXi logs diverted to Cribl Lake instead
// of Splunk (counterfactual 'other'), and a good share left untouched. Then it plays a script: a change to
// the Splunk-bound Payments API sampling pipeline drops its savings 25 points (≈ $1,250 a day, ≈ $456k a
// year) and the regression card opens at t+25 s naming the commit and its author, caught in 2:51; its
// Slack delivery lands at t+31 s, a cost spike opens at t+70 s, the change is restored and the incident
// closes itself at t+110 s, and the weekly receipt is previewed at t+130 s.
//
// Every number is produced by the REAL core, not typed: the inventory goes through `buildFlows`, each
// minute of each flow is priced by `priceMinute` at `effectivePrices`, folded into the running totals
// with `addMinuteToTotals` / `addOutputMinuteToTotals` (so the headline is `computeHeadline`'s), every
// snapshot is `buildSnapshot`'s, the incidents are opened and closed by `detect()` fed exactly the way
// core/sweep.ts feeds it (ratio per route, $/hour per input), commits are matched by `matchCommit`
// inside the detector, the Slack message is `slackPayload(canonicalPayload(…))` and the weekly receipt
// is `buildWeeklyReceipt`. The generator then ASSERTS its own story (exactly the intended incidents,
// the headline near target, the enterprise envelope, the regression's dollar impact, the file under 400 KB)
// and throws otherwise.
//
// TIME. The detector needs whole minutes; SPEC 15's beats (25/70/110 s) are not 60 s apart. Rule:
//   · t0 (the anchor) is chosen so t0+25 s is a UTC minute boundary — the regression really opens there
//     (break deployed 2:51 earlier, three qualifying minutes, default thresholds), and the base snapshot
//     at t0 legitimately shows the dip before the alert;
//   · the cost spike opens at the next boundary (t0+85 s) and is PLAYED at t+70 s; the recovery closes at
//     the one after (t0+145 s) and is played at t+110 s. The fixture's virtual clock therefore runs at
//     most 35 s ahead of the wall clock, which every relative time in the UI clamps to "just now".
//   · recovery confirmation is 1 minute in the sample workspace's settings (a valid, visible setting;
//     the default is 5) so the close is the detector's own, not a hand-written one.
// The engine (src/tour/engine.ts) shifts every ISO time by (wall clock at start − anchor) and every
// local-day key by the whole days between them, so the sample always reads as happening now.
//
// Determinism: no Date.now(), no Math.random(); noise is `unit()` from testdata/gen.ts. Portability: the
// builder is pure; only the guarded `main` at the bottom touches the file system.

import type {
  Commit,
  Counterfactual,
  DayRow,
  Headline,
  DeliveryLog,
  DeliveryRef,
  Flow,
  FlowKey,
  Incident,
  InventoryDoc,
  ISO,
  Meta,
  MinuteRow,
  ObjectKey,
  PresetId,
  PriceEntry,
  PricesDoc,
  Settings,
  Snapshot,
  TotalsDoc,
  TourStep,
  WeeklyReceipt,
  BaselinesDoc,
} from '../core/types.ts';
import type { TourFixture } from '../src/tour/types.ts';
import { buildFlows, objectKey } from '../core/flows.ts';
import { appendPriceVersion, effectivePrices, emptyPrices, priceMinute, type EffectivePrices } from '../core/pricing.ts';
import { addMinuteToTotals, addOutputMinuteToTotals, emptyTotals } from '../core/rollups.ts';
import { buildSnapshot } from '../core/snapshot.ts';
import { presetById } from '../core/presets.ts';
import { detect, emptyBaselines, shouldEvaluateBudget, type BudgetPoint, type CostPoint, type RatioPoint } from '../core/detector.ts';
import { canonicalPayload, slackPayload, type SlackMessage } from '../core/payloads.ts';
import { buildWeeklyReceipt, previousWeek } from '../core/receipt.ts';
import { defaultSettings } from '../core/settings.ts';
import { humanize } from '../core/humanize.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, fromIso, localDayKey, localMidnightMs, localMonthStartMs, minutesInMonth, toIso } from '../core/time.ts';
import { hashHex40, hashString, unit } from './gen.ts';

// ─── The clock ───────────────────────────────────────────────────────────────

/** Zone the sample workspace reports in (its local days, weekdays and "11:42 AM" times). */
export const TOUR_TZ = 'America/Chicago';
/** t0: Thu Sep 24 2026, 11:41:35 AM in Chicago. t0 + 25 s is the 16:42:00Z minute boundary. */
export const TOUR_ANCHOR_MS = Date.UTC(2026, 8, 24, 16, 41, 35);
/** The sample workspace's worker groups. */
export const TOUR_GROUPS = ['datacenter', 'cloud', 'apps'] as const;
export type TourGroup = (typeof TOUR_GROUPS)[number];
export const HISTORY_DAYS = 30;
/**
 * Saved month to date at t0 (the calibration target, millicents): ≈ $8.5M a year at this estate's run rate
 * (Sep 1 → Sep 24 11:41 AM is 23.5 days; the annualized run rate averages the last 30).
 */
export const TARGET_MTD_M = 545_000 * 100_000;
/** The regression's dollar impact: 25 points on the Splunk-bound Payments API flow ≈ $1,250 a day (≈ $456k a year). */
export const TARGET_IMPACT_M = 125_000_000;
/**
 * The estate's envelope, asserted after calibration so the mix can't drift silently: ≈ 30 TB a day in,
 * $60–90k a day would-have-paid, $7–10M a year saved (Steve 9/26: "enterprise sample").
 */
export const ENVELOPE = {
  tbPerDay: [27, 33],
  whpPerDayUsd: [60_000, 90_000],
  annualizedUsd: [7_000_000, 10_000_000],
} as const;
/** Cribl Stream on hybrid workers: 0.26 credits per GB ingested, 1 credit = $1 (Cribl pricing guide, 11/25). */
export const CRIBL_CREDITS_PER_GB = 0.26;
/** The fixture budget (SPEC 15: keep tour.json < 400 KB). */
export const MAX_FIXTURE_BYTES = 400 * 1024;

/** When each beat plays, in seconds after the tour starts (SPEC 15). */
export const TOUR_AT = {
  regression: 25,
  regressionDelivery: 31,
  restore: 50,
  spike: 70,
  spikeDelivery: 76,
  recovery: 110,
  recoveryDelivery: 112,
  weeklyReceipt: 130,
} as const;
/** How long the finished tour holds its last state before it ends (or loops, in Story mode). */
export const TOUR_HOLD_SEC = 20;

const T0 = TOUR_ANCHOR_MS;
const S = 1000;
/** The regression opens here: the detector's own minute boundary (= t0 + 25 s). */
const REG_OPEN = T0 + 25 * S;
/** The bad change is deployed 2:51 before the alert ("Caught in 2:51"). */
const BREAK_DEPLOY = REG_OPEN - 171 * S;
const BREAK_COMMIT = BREAK_DEPLOY - 17 * S;
/** The restore (t+50 s, exact). */
const RESTORE_DEPLOY = T0 + TOUR_AT.restore * S;
const RESTORE_COMMIT = RESTORE_DEPLOY - 6 * S;
/** Kubernetes prod ×3 from here: two qualifying minutes → the spike opens at the next boundary. */
const SPIKE_START = REG_OPEN - MINUTE_MS;
const SPIKE_MULTIPLIER = 3;
const SPIKE_OPEN = REG_OPEN + MINUTE_MS;
/** The first clean minute after the restore is evaluated here: the regression closes itself. */
const RECOVERY = REG_OPEN + 2 * MINUTE_MS;
/** Exclusive end of the simulation (the last simulated minute starts one minute earlier). */
const SIM_END = RECOVERY;
/**
 * Last night's organic, already-resolved cost spike on the east firewall (the incidents rail's history):
 * 2:05–2:31 AM local. At night the source runs below its long-run (EWMA) baseline, so the detector
 * closes the spike one clean minute after it ends; the same spike at the afternoon peak would stay open
 * until the diurnal curve fell back under baseline + 1σ — correct detector behaviour, wrong story.
 */
const OVERNIGHT_SPIKE_START = Date.UTC(2026, 8, 24, 7, 5);
const OVERNIGHT_SPIKE_END = Date.UTC(2026, 8, 24, 7, 31);
/** The detector runs over the last 27 hours (warm-up included); older history only feeds the totals. */
const DETECT_FROM = T0 - 27 * HOUR_MS;

/** Deliveries land a few seconds after the event (the webhook round trip). */
const DELIVERY_LAG_MS = 6 * S;
const CLOSE_DELIVERY_LAG_MS = 2 * S;

// ─── The sample workspace ────────────────────────────────────────────────────

type Shape = 'office' | 'server' | 'edge' | 'flat';

/** Diurnal amplitude, the local hour of the peak, and the weekend volume factor. */
const SHAPES: Readonly<Record<Shape, { amp: number; peakHour: number; weekend: number }>> = {
  office: { amp: 0.55, peakHour: 13, weekend: 0.42 },
  server: { amp: 0.22, peakHour: 14, weekend: 0.86 },
  edge: { amp: 0.35, peakHour: 20, weekend: 1.08 },
  flat: { amp: 0.08, peakHour: 12, weekend: 0.97 },
};

interface SourceSpec {
  id: string;
  group: TourGroup;
  type: string;
  /** Decimal GB per day at diurnal/weekly factor 1, before calibration. */
  gbPerDay: number;
  shape: Shape;
  /** Excluded from calibration (the regression's dollar impact is sized to TARGET_IMPACT_M instead). */
  fixedVolume?: boolean;
  /** No traffic before this instant (the source was onboarded then). */
  activeFrom?: number;
  description: string;
}

interface RetentionChange {
  at: number;
  /** end of the change (exclusive); open-ended when absent */
  until?: number;
  retention: number;
}

interface RouteSpec {
  id: string;
  group: TourGroup;
  name: string;
  filter: string;
  pipeline: string;
  output: string;
  final: boolean;
  /** out/in bytes of the pipeline before any change */
  retention: number;
  changes?: RetentionChange[];
  description: string;
}

interface OutputSpec {
  id: string;
  group: TourGroup;
  type: string;
  description: string;
  price: PriceEntry;
}

interface PipelineSpec {
  id: string;
  group: TourGroup;
  description: string;
  functions: string[];
}

// Commit instants in the history (local Chicago times, fixed so the file is reproducible).
const DAY = DAY_MS;
const at = (daysAgo: number, hourUtc: number, minute: number): number => {
  const d = new Date(T0 - daysAgo * DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, minute, 0);
};
const WIN_PACK_AT = at(21, 19, 5); // Sep 3, 2:05 PM
const PAN_AGG_AT = at(13, 15, 40); // Sep 11, 10:40 AM
const K8S_NOISE_AT = at(6, 20, 30); // Sep 18, 3:30 PM
const OKTA_ONBOARD_AT = at(9, 16, 10); // Sep 15, 11:10 AM

/**
 * Forty sources in three worker groups. Volumes are relative (one calibration factor scales them all to
 * the MTD target, except the fixed-volume Payments API, which sizes the regression); the mix is what
 * makes ≈ 30 TB a day cost ≈ $65k a day: most bytes land on Splunk Cloud and Sentinel.
 */
const SOURCES: readonly SourceSpec[] = [
  // Datacenter: on-prem security telemetry and the payments platform, into Splunk Cloud.
  { id: 'win_dc', group: 'datacenter', type: 'wef', gbPerDay: 1300, shape: 'server', description: 'Windows Event Forwarding from domain controllers' },
  { id: 'win_servers', group: 'datacenter', type: 'wef', gbPerDay: 1500, shape: 'server', description: 'Windows Event Forwarding from member servers' },
  { id: 'win_workstations', group: 'datacenter', type: 'wef', gbPerDay: 2000, shape: 'office', description: 'Windows Event Forwarding from workstations' },
  { id: 'pan_fw_east', group: 'datacenter', type: 'syslog', gbPerDay: 2200, shape: 'server', description: 'Palo Alto NGFW, east data center' },
  { id: 'pan_fw_west', group: 'datacenter', type: 'syslog', gbPerDay: 1600, shape: 'server', description: 'Palo Alto NGFW, west data center' },
  { id: 'cisco_asa', group: 'datacenter', type: 'syslog', gbPerDay: 800, shape: 'server', description: 'Cisco ASA firewalls, branch offices' },
  { id: 'f5_bigip', group: 'datacenter', type: 'syslog', gbPerDay: 450, shape: 'edge', description: 'F5 BIG-IP load balancers and WAF' },
  { id: 'infoblox_dns', group: 'datacenter', type: 'syslog', gbPerDay: 800, shape: 'server', description: 'Infoblox DNS query logs' },
  { id: 'linux_syslog', group: 'datacenter', type: 'syslog', gbPerDay: 650, shape: 'server', description: 'Linux hosts over syslog' },
  { id: 'web_proxy', group: 'datacenter', type: 'syslog', gbPerDay: 750, shape: 'office', description: 'Web proxy access logs' },
  { id: 'vmware_esxi', group: 'datacenter', type: 'syslog', gbPerDay: 300, shape: 'flat', description: 'VMware ESXi and vCenter logs' },
  { id: 'splunk_uf_fleet', group: 'datacenter', type: 'splunk', gbPerDay: 1900, shape: 'server', description: 'Splunk universal forwarders' },
  { id: 'payments_api', group: 'datacenter', type: 'splunk_hec', gbPerDay: 1900, shape: 'server', fixedVolume: true, description: 'Payments API gateway access and error logs' },
  { id: 'sap_audit', group: 'datacenter', type: 'tcp', gbPerDay: 150, shape: 'office', description: 'SAP security audit log' },
  { id: 'oracle_audit', group: 'datacenter', type: 'tcp', gbPerDay: 250, shape: 'server', description: 'Oracle database unified audit trail' },
  // Cloud: AWS, Google Cloud, Microsoft 365, identity and EDR, into Google SecOps and Sentinel.
  { id: 'aws_vpc_flow', group: 'cloud', type: 's3', gbPerDay: 2600, shape: 'flat', description: 'VPC Flow Logs via S3 notifications' },
  { id: 'aws_cloudtrail', group: 'cloud', type: 's3', gbPerDay: 650, shape: 'server', description: 'CloudTrail management and data events' },
  { id: 'aws_guardduty', group: 'cloud', type: 's3', gbPerDay: 25, shape: 'server', description: 'GuardDuty findings' },
  { id: 'aws_waf', group: 'cloud', type: 's3', gbPerDay: 400, shape: 'edge', description: 'AWS WAF logs' },
  { id: 'gcp_audit', group: 'cloud', type: 'google_pubsub', gbPerDay: 280, shape: 'server', description: 'Google Cloud audit logs' },
  { id: 'o365_audit', group: 'cloud', type: 'office365_mgmt', gbPerDay: 500, shape: 'office', description: 'Microsoft 365 management activity' },
  { id: 'entra_signin', group: 'cloud', type: 'azure_event_hub', gbPerDay: 380, shape: 'office', description: 'Microsoft Entra ID sign-in logs' },
  { id: 'azure_activity', group: 'cloud', type: 'azure_event_hub', gbPerDay: 160, shape: 'server', description: 'Azure activity log' },
  { id: 'm365_defender', group: 'cloud', type: 'azure_event_hub', gbPerDay: 450, shape: 'server', description: 'Microsoft Defender XDR events' },
  { id: 'okta_system_log', group: 'cloud', type: 'http', gbPerDay: 90, shape: 'office', activeFrom: OKTA_ONBOARD_AT, description: 'Okta System Log' },
  { id: 'crowdstrike_fdr', group: 'cloud', type: 'crowdstrike', gbPerDay: 1900, shape: 'server', description: 'CrowdStrike Falcon Data Replicator' },
  { id: 'zscaler_zia', group: 'cloud', type: 'tcp', gbPerDay: 1300, shape: 'office', description: 'Zscaler Internet Access web logs (NSS)' },
  { id: 'proofpoint_tap', group: 'cloud', type: 'http', gbPerDay: 120, shape: 'office', description: 'Proofpoint TAP email events' },
  // Apps: Kubernetes and application logs, into Datadog, Elastic and New Relic.
  { id: 'k8s_prod', group: 'apps', type: 'kube_logs', gbPerDay: 1900, shape: 'server', description: 'Production Kubernetes container logs' },
  { id: 'k8s_staging', group: 'apps', type: 'kube_logs', gbPerDay: 300, shape: 'office', description: 'Staging Kubernetes container logs' },
  { id: 'checkout_api', group: 'apps', type: 'http', gbPerDay: 380, shape: 'server', description: 'Checkout API service logs' },
  { id: 'mobile_backend', group: 'apps', type: 'http', gbPerDay: 320, shape: 'edge', description: 'Mobile app backend logs' },
  { id: 'nginx_ingress', group: 'apps', type: 'http', gbPerDay: 350, shape: 'edge', description: 'NGINX ingress controller access logs' },
  { id: 'edge_cdn', group: 'apps', type: 'http', gbPerDay: 500, shape: 'edge', description: 'CDN edge access logs' },
  { id: 'java_services', group: 'apps', type: 'kafka', gbPerDay: 350, shape: 'server', description: 'Java service logs via Kafka' },
  { id: 'istio_mesh', group: 'apps', type: 'kube_logs', gbPerDay: 300, shape: 'server', description: 'Istio service mesh access logs' },
  { id: 'dotnet_services', group: 'apps', type: 'kafka', gbPerDay: 250, shape: 'server', description: '.NET service logs via Kafka' },
  { id: 'kafka_brokers', group: 'apps', type: 'syslog', gbPerDay: 100, shape: 'flat', description: 'Kafka broker logs' },
  { id: 'batch_jobs', group: 'apps', type: 'kafka', gbPerDay: 100, shape: 'flat', description: 'Nightly batch job logs' },
  { id: 'jenkins_ci', group: 'apps', type: 'http', gbPerDay: 80, shape: 'office', description: 'Jenkins CI build logs' },
];

/** A destination priced at its preset's typical list price (core/presets.ts), as "Use suggested prices" would. */
function presetPrice(preset: PresetId, counterfactual: Counterfactual = { kind: 'same' }): PriceEntry {
  const p = presetById(preset);
  if (!p) throw new Error(`tour: no preset ${preset}`);
  return { milliCentsPerGb: p.milliCentsPerGb, preset, counterfactual };
}

/** Eight destinations; every output id lives in exactly one group (budgets are keyed by output id). */
const OUTPUTS: readonly OutputSpec[] = [
  { id: 'splunk_cloud', group: 'datacenter', type: 'splunk_hec', description: 'Splunk Cloud (HEC)', price: presetPrice('splunk_cloud') },
  // Diverted: without Cribl this data would have gone to Splunk Cloud, so it is credited at Splunk's price.
  { id: 'cribl_lake', group: 'datacenter', type: 'cribl_lake', description: 'Cribl Lake', price: presetPrice('cribl_lake', { kind: 'other', outputId: 'splunk_cloud' }) },
  // A full-fidelity copy of every datacenter source. Priced as 'same' (the archive would exist without Cribl
  // too), so it costs what it costs and saves nothing, and would-have-paid − paid = saved holds on every receipt.
  { id: 's3_archive', group: 'datacenter', type: 's3', description: 'Full-fidelity archive', price: presetPrice('s3') },
  { id: 'sentinel', group: 'cloud', type: 'sentinel', description: 'Microsoft Sentinel', price: presetPrice('sentinel') },
  { id: 'google_secops', group: 'cloud', type: 'google_chronicle', description: 'Google SecOps', price: presetPrice('google_secops') },
  { id: 'datadog', group: 'apps', type: 'datadog', description: 'Datadog Logs', price: presetPrice('datadog') },
  { id: 'elastic', group: 'apps', type: 'elastic', description: 'Elastic Cloud', price: presetPrice('elastic') },
  { id: 'newrelic', group: 'apps', type: 'newrelic', description: 'New Relic', price: presetPrice('newrelic') },
];

/** Each group's `default` output (the built-in forwarder; never priced or listed) points here. */
const DEFAULT_OUTPUT: Readonly<Record<TourGroup, string>> = { datacenter: 'splunk_cloud', cloud: 'sentinel', apps: 'newrelic' };

const PIPELINES: readonly PipelineSpec[] = [
  ...TOUR_GROUPS.map((group): PipelineSpec => ({ id: 'passthrough', group, description: 'No processing', functions: [] })),
  { id: 'win_event_trim', group: 'datacenter', description: 'Drop noisy event codes, remove the XML message body', functions: ['drop', 'eval', 'serialize'] },
  { id: 'win_xml_pack', group: 'datacenter', description: 'Windows XML events pack', functions: ['xml_unroll', 'eval', 'drop'] },
  { id: 'win_ws_trim', group: 'datacenter', description: 'Drop object-access and filtering-platform noise', functions: ['drop'] },
  { id: 'pan_traffic_agg', group: 'datacenter', description: 'Traffic logs to 1-minute summaries', functions: ['parser', 'aggregation'] },
  { id: 'asa_trim', group: 'datacenter', description: 'Drop teardown and NAT messages', functions: ['drop', 'eval'] },
  { id: 'f5_trim', group: 'datacenter', description: 'Remove duplicate headers from request logs', functions: ['eval'] },
  { id: 'syslog_trim', group: 'datacenter', description: 'Remove duplicate timestamps and host fields', functions: ['eval', 'serialize'] },
  { id: 'proxy_trim', group: 'datacenter', description: 'Drop allowed CDN and update traffic', functions: ['drop', 'eval'] },
  { id: 'pay_api_sample', group: 'datacenter', description: 'Sample 2xx access logs 1:10, keep every error', functions: ['sampling', 'eval'] },
  { id: 'dns_to_lake', group: 'datacenter', description: 'Parse DNS queries for Cribl Lake (full fidelity)', functions: ['parser'] },
  { id: 'esxi_to_lake', group: 'datacenter', description: 'Parse ESXi and vCenter logs for Cribl Lake (full fidelity)', functions: ['parser'] },
  { id: 'vpc_flow_agg', group: 'cloud', description: 'Flow records to 1-minute summaries', functions: ['parser', 'aggregation'] },
  { id: 'cloudtrail_dedupe', group: 'cloud', description: 'Suppress duplicate events within 60 s', functions: ['suppress'] },
  { id: 'waf_sample', group: 'cloud', description: 'Sample allowed requests 1:4, keep every block', functions: ['sampling'] },
  { id: 'gcp_audit_trim', group: 'cloud', description: 'Drop data-access reads from service accounts', functions: ['drop'] },
  { id: 'o365_trim', group: 'cloud', description: 'Remove unused audit fields', functions: ['eval'] },
  { id: 'entra_trim', group: 'cloud', description: 'Remove unused sign-in fields', functions: ['eval'] },
  { id: 'azure_activity_trim', group: 'cloud', description: 'Drop read operations', functions: ['drop'] },
  { id: 'edr_dedupe', group: 'cloud', description: 'Suppress repeated process events', functions: ['suppress', 'eval'] },
  { id: 'zscaler_trim', group: 'cloud', description: 'Drop allowed low-risk web categories', functions: ['drop', 'eval'] },
  { id: 'k8s_noise', group: 'apps', description: 'Drop debug, health checks and probe logs', functions: ['drop', 'eval'] },
  { id: 'api_sample', group: 'apps', description: 'Sample 2xx requests 1:4, keep every error', functions: ['sampling', 'eval'] },
  { id: 'mobile_trim', group: 'apps', description: 'Remove device metadata duplicated per event', functions: ['eval'] },
  { id: 'nginx_sample', group: 'apps', description: 'Sample 2xx hits 1:5, keep every error', functions: ['sampling'] },
  { id: 'cdn_sample', group: 'apps', description: 'Sample 2xx hits, aggregate by edge and status', functions: ['sampling', 'aggregation'] },
  { id: 'java_trim', group: 'apps', description: 'Drop DEBUG and fold stack traces', functions: ['drop', 'eval'] },
  { id: 'istio_sample', group: 'apps', description: 'Sample successful mesh calls 1:5', functions: ['sampling'] },
  { id: 'dotnet_trim', group: 'apps', description: 'Drop verbose framework logs', functions: ['drop'] },
  { id: 'kafka_trim', group: 'apps', description: 'Drop routine rebalance and GC messages', functions: ['drop'] },
];

const PAY_RETENTION = 0.25;
const PAY_BROKEN_RETENTION = 0.5;

/** `__inputId=='type:id'`, or several joined with `||` (an exact filter: core/flows claims those inputs). */
function inputFilter(...ids: string[]): string {
  return ids
    .map((id) => {
      const src = SOURCES.find((s) => s.id === id);
      if (!src) throw new Error(`tour: no source ${id}`);
      return `__inputId=='${src.type}:${id}'`;
    })
    .join(' || ');
}

type RouteDef = Omit<RouteSpec, 'filter' | 'final' | 'description'> & { inputs?: string[]; filter?: string; final?: boolean };
const route = (r: RouteDef): RouteSpec => ({
  id: r.id,
  group: r.group,
  name: r.name,
  filter: r.filter ?? inputFilter(...(r.inputs ?? [])),
  pipeline: r.pipeline,
  output: r.output,
  final: r.final ?? true,
  retention: r.retention,
  ...(r.changes ? { changes: r.changes } : {}),
  description: '',
});

const ROUTES: readonly RouteSpec[] = [
  // ── Datacenter ──
  // Non-final: every datacenter source is also archived at full fidelity.
  route({ id: 'r_archive_dc', group: 'datacenter', name: 'Archive the datacenter to S3', filter: 'true', final: false, pipeline: 'passthrough', output: 's3_archive', retention: 1 }),
  route({ id: 'r_win_dc', group: 'datacenter', name: 'Windows DC security', inputs: ['win_dc'], pipeline: 'win_event_trim', output: 'splunk_cloud', retention: 0.67 }),
  route({
    id: 'r_win_servers',
    group: 'datacenter',
    name: 'Windows member servers',
    inputs: ['win_servers'],
    pipeline: 'win_xml_pack',
    output: 'splunk_cloud',
    retention: 1,
    changes: [{ at: WIN_PACK_AT, retention: 0.67 }],
  }),
  route({ id: 'r_win_ws', group: 'datacenter', name: 'Windows workstations', inputs: ['win_workstations'], pipeline: 'win_ws_trim', output: 'splunk_cloud', retention: 0.85 }),
  route({
    id: 'r_pan',
    group: 'datacenter',
    name: 'Palo Alto firewalls',
    inputs: ['pan_fw_east', 'pan_fw_west'],
    pipeline: 'pan_traffic_agg',
    output: 'splunk_cloud',
    retention: 1,
    changes: [{ at: PAN_AGG_AT, retention: 0.6 }],
  }),
  route({ id: 'r_asa', group: 'datacenter', name: 'Cisco ASA', inputs: ['cisco_asa'], pipeline: 'asa_trim', output: 'splunk_cloud', retention: 0.65 }),
  route({ id: 'r_f5', group: 'datacenter', name: 'F5 BIG-IP', inputs: ['f5_bigip'], pipeline: 'f5_trim', output: 'splunk_cloud', retention: 0.75 }),
  // Diverted at full fidelity: the saving is the price difference (Cribl Lake's counterfactual is Splunk Cloud).
  route({ id: 'r_dns', group: 'datacenter', name: 'DNS to Cribl Lake', inputs: ['infoblox_dns'], pipeline: 'dns_to_lake', output: 'cribl_lake', retention: 1 }),
  route({ id: 'r_esxi', group: 'datacenter', name: 'ESXi to Cribl Lake', inputs: ['vmware_esxi'], pipeline: 'esxi_to_lake', output: 'cribl_lake', retention: 1 }),
  route({ id: 'r_syslog', group: 'datacenter', name: 'Linux syslog', inputs: ['linux_syslog'], pipeline: 'syslog_trim', output: 'splunk_cloud', retention: 0.72 }),
  route({ id: 'r_proxy', group: 'datacenter', name: 'Web proxy', inputs: ['web_proxy'], pipeline: 'proxy_trim', output: 'splunk_cloud', retention: 0.6 }),
  route({
    id: 'r_payments',
    group: 'datacenter',
    name: 'Payments API',
    inputs: ['payments_api'],
    pipeline: 'pay_api_sample',
    output: 'splunk_cloud',
    retention: PAY_RETENTION,
    changes: [{ at: BREAK_DEPLOY, until: RESTORE_DEPLOY, retention: PAY_BROKEN_RETENTION }],
  }),
  route({ id: 'r_default_dc', group: 'datacenter', name: 'Everything else to Splunk', filter: 'true', pipeline: 'passthrough', output: 'splunk_cloud', retention: 1 }),
  // ── Cloud ──
  route({ id: 'r_vpc', group: 'cloud', name: 'VPC Flow', inputs: ['aws_vpc_flow'], pipeline: 'vpc_flow_agg', output: 'google_secops', retention: 0.1 }),
  route({ id: 'r_cloudtrail', group: 'cloud', name: 'CloudTrail', inputs: ['aws_cloudtrail'], pipeline: 'cloudtrail_dedupe', output: 'google_secops', retention: 0.72 }),
  route({ id: 'r_guardduty', group: 'cloud', name: 'GuardDuty', inputs: ['aws_guardduty'], pipeline: 'passthrough', output: 'google_secops', retention: 1 }),
  route({ id: 'r_waf', group: 'cloud', name: 'AWS WAF', inputs: ['aws_waf'], pipeline: 'waf_sample', output: 'google_secops', retention: 0.5 }),
  route({ id: 'r_gcp', group: 'cloud', name: 'Google Cloud audit', inputs: ['gcp_audit'], pipeline: 'gcp_audit_trim', output: 'google_secops', retention: 0.8 }),
  route({ id: 'r_o365', group: 'cloud', name: 'Microsoft 365 audit', inputs: ['o365_audit'], pipeline: 'o365_trim', output: 'sentinel', retention: 0.62 }),
  route({ id: 'r_entra', group: 'cloud', name: 'Entra ID sign-ins', inputs: ['entra_signin'], pipeline: 'entra_trim', output: 'sentinel', retention: 0.75 }),
  route({ id: 'r_azure_activity', group: 'cloud', name: 'Azure activity', inputs: ['azure_activity'], pipeline: 'azure_activity_trim', output: 'sentinel', retention: 0.85 }),
  route({ id: 'r_edr', group: 'cloud', name: 'CrowdStrike FDR', inputs: ['crowdstrike_fdr'], pipeline: 'edr_dedupe', output: 'sentinel', retention: 0.6 }),
  route({ id: 'r_zscaler', group: 'cloud', name: 'Zscaler', inputs: ['zscaler_zia'], pipeline: 'zscaler_trim', output: 'sentinel', retention: 0.7 }),
  route({ id: 'r_default_cloud', group: 'cloud', name: 'Everything else to Sentinel', filter: 'true', pipeline: 'passthrough', output: 'sentinel', retention: 1 }),
  // ── Apps ──
  route({
    id: 'r_k8s',
    group: 'apps',
    name: 'Kubernetes prod',
    inputs: ['k8s_prod'],
    pipeline: 'k8s_noise',
    output: 'datadog',
    retention: 0.8,
    changes: [{ at: K8S_NOISE_AT, retention: 0.35 }],
  }),
  route({
    id: 'r_k8s_staging',
    group: 'apps',
    name: 'Kubernetes staging',
    inputs: ['k8s_staging'],
    pipeline: 'k8s_noise',
    output: 'elastic',
    retention: 0.8,
    changes: [{ at: K8S_NOISE_AT, retention: 0.35 }],
  }),
  route({ id: 'r_checkout', group: 'apps', name: 'Checkout API', inputs: ['checkout_api'], pipeline: 'api_sample', output: 'datadog', retention: 0.45 }),
  route({ id: 'r_mobile', group: 'apps', name: 'Mobile backend', inputs: ['mobile_backend'], pipeline: 'mobile_trim', output: 'datadog', retention: 0.6 }),
  route({ id: 'r_nginx', group: 'apps', name: 'NGINX ingress', inputs: ['nginx_ingress'], pipeline: 'nginx_sample', output: 'elastic', retention: 0.35 }),
  route({ id: 'r_cdn', group: 'apps', name: 'Edge CDN', inputs: ['edge_cdn'], pipeline: 'cdn_sample', output: 'elastic', retention: 0.1 }),
  route({ id: 'r_java', group: 'apps', name: 'Java services', inputs: ['java_services'], pipeline: 'java_trim', output: 'newrelic', retention: 0.6 }),
  route({ id: 'r_istio', group: 'apps', name: 'Istio mesh', inputs: ['istio_mesh'], pipeline: 'istio_sample', output: 'newrelic', retention: 0.3 }),
  route({ id: 'r_dotnet', group: 'apps', name: '.NET services', inputs: ['dotnet_services'], pipeline: 'dotnet_trim', output: 'newrelic', retention: 0.65 }),
  route({ id: 'r_kafka', group: 'apps', name: 'Kafka brokers', inputs: ['kafka_brokers'], pipeline: 'kafka_trim', output: 'elastic', retention: 0.5 }),
  route({ id: 'r_default_apps', group: 'apps', name: 'Everything else to New Relic', filter: 'true', pipeline: 'passthrough', output: 'newrelic', retention: 1 }),
];

/** Plain-words names for every id (settings.humanize), so no screen ever shows a raw id. */
export const TOUR_LABELS: Readonly<Record<string, string>> = {
  // sources
  win_dc: 'Windows DC security',
  win_servers: 'Windows servers',
  win_workstations: 'Windows workstations',
  pan_fw_east: 'Palo Alto firewall east',
  pan_fw_west: 'Palo Alto firewall west',
  cisco_asa: 'Cisco ASA',
  f5_bigip: 'F5 BIG-IP',
  infoblox_dns: 'Infoblox DNS',
  linux_syslog: 'Linux syslog',
  web_proxy: 'Web proxy',
  vmware_esxi: 'VMware ESXi',
  splunk_uf_fleet: 'Splunk forwarder fleet',
  payments_api: 'Payments API',
  sap_audit: 'SAP security audit',
  oracle_audit: 'Oracle audit trail',
  aws_vpc_flow: 'AWS VPC Flow Logs',
  aws_cloudtrail: 'AWS CloudTrail',
  aws_guardduty: 'AWS GuardDuty',
  aws_waf: 'AWS WAF',
  gcp_audit: 'Google Cloud audit logs',
  o365_audit: 'Microsoft 365 audit',
  entra_signin: 'Entra ID sign-ins',
  azure_activity: 'Azure activity log',
  m365_defender: 'Microsoft Defender XDR',
  okta_system_log: 'Okta System Log',
  crowdstrike_fdr: 'CrowdStrike FDR',
  zscaler_zia: 'Zscaler web logs',
  proofpoint_tap: 'Proofpoint TAP',
  k8s_prod: 'Kubernetes prod',
  k8s_staging: 'Kubernetes staging',
  checkout_api: 'Checkout API',
  mobile_backend: 'Mobile backend',
  nginx_ingress: 'NGINX ingress',
  edge_cdn: 'Edge CDN',
  java_services: 'Java services',
  istio_mesh: 'Istio mesh',
  dotnet_services: '.NET services',
  kafka_brokers: 'Kafka brokers',
  batch_jobs: 'Batch jobs',
  jenkins_ci: 'Jenkins CI',
  // destinations
  splunk_cloud: 'Splunk Cloud',
  sentinel: 'Microsoft Sentinel',
  google_secops: 'Google SecOps',
  datadog: 'Datadog',
  elastic: 'Elastic',
  newrelic: 'New Relic',
  cribl_lake: 'Cribl Lake',
  s3_archive: 'S3 archive',
  // pipelines
  passthrough: 'Passthrough',
  win_event_trim: 'Windows event trimming',
  win_xml_pack: 'Windows XML pack',
  win_ws_trim: 'Windows workstation trimming',
  pan_traffic_agg: 'Palo Alto traffic aggregation',
  asa_trim: 'Cisco ASA trimming',
  f5_trim: 'F5 trimming',
  syslog_trim: 'Syslog trimming',
  proxy_trim: 'Web proxy trimming',
  pay_api_sample: 'Payments API sampling',
  dns_to_lake: 'DNS to Cribl Lake',
  esxi_to_lake: 'ESXi to Cribl Lake',
  vpc_flow_agg: 'VPC Flow aggregation',
  cloudtrail_dedupe: 'CloudTrail duplicate suppression',
  waf_sample: 'AWS WAF sampling',
  gcp_audit_trim: 'Google Cloud audit trimming',
  o365_trim: 'Microsoft 365 audit trimming',
  entra_trim: 'Entra ID sign-in trimming',
  azure_activity_trim: 'Azure activity trimming',
  edr_dedupe: 'CrowdStrike FDR duplicate suppression',
  zscaler_trim: 'Zscaler trimming',
  k8s_noise: 'Kubernetes noise filter',
  api_sample: 'Checkout API sampling',
  mobile_trim: 'Mobile backend trimming',
  nginx_sample: 'NGINX sampling',
  cdn_sample: 'CDN sampling and aggregation',
  java_trim: 'Java log trimming',
  istio_sample: 'Istio mesh sampling',
  dotnet_trim: '.NET log trimming',
  kafka_trim: 'Kafka broker trimming',
  // routes (only passthrough routes are labelled by route; the rest by what their pipeline does)
  r_archive_dc: 'Archive the datacenter to S3',
  r_guardduty: 'GuardDuty',
  r_default_dc: 'Everything else to Splunk',
  r_default_cloud: 'Everything else to Sentinel',
  r_default_apps: 'Everything else to New Relic',
};

/**
 * The sample workspace's "minimum spike per hour": $75 (the default $5 suits a small org; on a $65k-a-day
 * estate every morning ramp clears it). A visible, valid setting, like `recoveryMinutes` 1 below. It keeps
 * organic intraday swings (≤ ≈ $55 an hour per source here) and the broken trim's own cost rise on the
 * Payments API input (≈ $52 an hour, the same money the regression already reports) from paging, while the
 * two real spikes clear it with room: Kubernetes prod ×3 (≈ +$120 an hour) and the overnight firewall
 * (≈ +$190 an hour). The generator asserts the resulting story exactly.
 */
const SPIKE_MIN_CENTS_PER_HOUR = 7_500;

const SLACK_ENDPOINT_ID = 'slack-finops';
const WORKSPACE_NAME = 'sample-enterprise';
/** The sample workspace's admin: the prices' setter and the author of most of its commits. */
const TOUR_ADMIN = 'Steve Koelpin';

// ─── Commits (the change timeline) ───────────────────────────────────────────

const pipeFile = (group: TourGroup, id: string): string => `groups/${group}/local/cribl/pipelines/${id}/conf.yml`;
const groupFile = (group: TourGroup, rel: string): string => `groups/${group}/local/cribl/${rel}`;

interface CommitSpec {
  group: TourGroup;
  message: string;
  author: string;
  committedAt: number;
  /** deploy lag after the commit */
  deployAfterMs: number;
  files: string[];
}

const BREAK_MESSAGE = 'Keep full payload on payments API errors';

const COMMITS: readonly CommitSpec[] = [
  { group: 'datacenter', message: 'Archive every datacenter source to S3 at full fidelity', author: 'Dana Kim', committedAt: at(29, 15, 20), deployAfterMs: 95 * S, files: [groupFile('datacenter', 'pipelines/route.yml'), groupFile('datacenter', 'outputs.yml')] },
  { group: 'apps', message: 'Sample edge CDN access logs and aggregate by status', author: TOUR_ADMIN, committedAt: at(27, 21, 5), deployAfterMs: 70 * S, files: [groupFile('apps', 'pipelines/route.yml'), pipeFile('apps', 'cdn_sample')] },
  { group: 'datacenter', message: 'Keep DNS query logs in Cribl Lake for 90 days', author: 'Priya Singh', committedAt: at(25, 16, 40), deployAfterMs: 60 * S, files: [groupFile('datacenter', 'outputs.yml')] },
  { group: 'datacenter', message: 'Apply the Windows XML pack to member server events', author: TOUR_ADMIN, committedAt: WIN_PACK_AT - 80 * S, deployAfterMs: 80 * S, files: [pipeFile('datacenter', 'win_xml_pack')] },
  { group: 'cloud', message: 'Suppress duplicate CloudTrail events within 60 seconds', author: TOUR_ADMIN, committedAt: at(17, 14, 50), deployAfterMs: 60 * S, files: [pipeFile('cloud', 'cloudtrail_dedupe')] },
  { group: 'cloud', message: 'Add account and region to VPC Flow summaries', author: TOUR_ADMIN, committedAt: at(15, 18, 10), deployAfterMs: 75 * S, files: [pipeFile('cloud', 'vpc_flow_agg')] },
  { group: 'datacenter', message: 'Aggregate Palo Alto traffic logs to 1-minute summaries', author: TOUR_ADMIN, committedAt: PAN_AGG_AT - 65 * S, deployAfterMs: 65 * S, files: [pipeFile('datacenter', 'pan_traffic_agg')] },
  { group: 'cloud', message: 'Onboard Okta System Log', author: TOUR_ADMIN, committedAt: OKTA_ONBOARD_AT - 50 * S, deployAfterMs: 50 * S, files: [groupFile('cloud', 'inputs.yml'), groupFile('cloud', 'pipelines/route.yml')] },
  { group: 'apps', message: 'Drop Kubernetes debug and health-check noise', author: TOUR_ADMIN, committedAt: K8S_NOISE_AT - 75 * S, deployAfterMs: 75 * S, files: [pipeFile('apps', 'k8s_noise')] },
  { group: 'datacenter', message: 'Raise Splunk HEC batch size to 512 KB', author: 'Dana Kim', committedAt: at(3, 17, 25), deployAfterMs: 55 * S, files: [groupFile('datacenter', 'outputs.yml')] },
  { group: 'cloud', message: 'Remove unused Microsoft 365 audit fields', author: TOUR_ADMIN, committedAt: at(1, 20, 15), deployAfterMs: 60 * S, files: [pipeFile('cloud', 'o365_trim')] },
  // The tour's regression, and its restore.
  { group: 'datacenter', message: BREAK_MESSAGE, author: TOUR_ADMIN, committedAt: BREAK_COMMIT, deployAfterMs: BREAK_DEPLOY - BREAK_COMMIT, files: [pipeFile('datacenter', 'pay_api_sample')] },
  {
    group: 'datacenter',
    message: `Revert "${BREAK_MESSAGE}"`,
    author: TOUR_ADMIN,
    committedAt: RESTORE_COMMIT,
    deployAfterMs: RESTORE_DEPLOY - RESTORE_COMMIT,
    files: [pipeFile('datacenter', 'pay_api_sample')],
  },
];

function buildCommits(): Commit[] {
  return COMMITS.map((c) => ({
    hash: hashHex40(`meter-reader-tour|${c.message}|${c.committedAt}`),
    message: c.message,
    author: c.author,
    committedAt: toIso(c.committedAt),
    deployedAt: toIso(c.committedAt + c.deployAfterMs),
    groupId: c.group,
    files: c.files,
    source: 'api' as const,
  })).sort((a, b) => fromIso(b.committedAt) - fromIso(a.committedAt));
}

// ─── Inventory, flows, prices, settings ──────────────────────────────────────

export function tourInventory(updatedAtMs: number): InventoryDoc {
  const byGroup: InventoryDoc['byGroup'] = {};
  for (const g of TOUR_GROUPS) {
    byGroup[g] = {
      inputs: SOURCES.filter((s) => s.group === g).map((s) => ({ id: s.id, type: s.type, description: s.description })),
      outputs: [
        ...OUTPUTS.filter((o) => o.group === g).map((o) => ({ id: o.id, type: o.type, description: o.description })),
        { id: 'default', type: 'default', defaultId: DEFAULT_OUTPUT[g], description: 'Default destination' },
      ],
      pipelines: PIPELINES.filter((p) => p.group === g).map((p) => ({ id: p.id, description: p.description, functions: p.functions.map((id) => ({ id })) })),
      routes: ROUTES.filter((r) => r.group === g).map((r) => ({
        id: r.id,
        name: r.name,
        filter: r.filter,
        pipeline: r.pipeline,
        output: r.output,
        final: r.final,
        ...(r.description ? { description: r.description } : {}),
      })),
      routeTableId: 'default',
    };
  }
  return {
    schemaVersion: 1,
    updatedAt: toIso(updatedAtMs),
    hash: hashHex40('meter-reader-tour|inventory').slice(0, 16),
    byGroup,
  };
}

function tourPrices(effectiveFromMs: number): PricesDoc {
  const byOutputId: Record<string, PriceEntry> = {};
  for (const o of OUTPUTS) byOutputId[`${o.group}:${o.id}`] = { ...o.price };
  // The sample's admin set these prices (P2-W24): Show the math and Settings → Prices read "set by Steve Koelpin".
  return appendPriceVersion(emptyPrices(toIso(effectiveFromMs)), byOutputId, effectiveFromMs, TOUR_ADMIN);
}

function tourSettings(budgets: Settings['budgets'], criblCostCentsPerMonth: number, savedAtMs: number): Settings {
  const s = defaultSettings(toIso(savedAtMs), TOUR_TZ);
  return {
    ...s,
    updatedAt: toIso(savedAtMs),
    criblCostCentsPerMonth,
    budgets,
    thresholds: { ...s.thresholds, recoveryMinutes: 1, spikeMinCentsPerHour: SPIKE_MIN_CENTS_PER_HOUR },
    notifications: [
      // D57: a Cribl notification target (its Slack URL stays in Cribl); no build stores a webhook URL.
      {
        id: SLACK_ENDPOINT_ID,
        name: 'FinOps alerts',
        url: '',
        host: '',
        format: 'generic',
        minSeverity: 'medium',
        weeklyReceipt: true,
        lastTest: { at: toIso(savedAtMs + 40 * S), status: 200, hostAuthorized: true },
        enabled: true,
        channel: 'cribl-target',
        criblTargetId: 'finops_slack',
      },
    ],
    humanize: { ...TOUR_LABELS },
    runtime: 'ui',
  };
}

// ─── Volumes ─────────────────────────────────────────────────────────────────

interface HourContext {
  dayKey: string;
  monthKey: string;
  dayStartIso: ISO;
  /** local hour of the hour's start (fractional minutes are added per minute) */
  localHour: number;
  weekend: boolean;
}

function createHourContext(tz: string): (ms: number) => HourContext {
  const cache = new Map<number, HourContext>();
  return (ms) => {
    const h = Math.floor(ms / HOUR_MS) * HOUR_MS;
    let c = cache.get(h);
    if (!c) {
      const dayKey = localDayKey(h, tz);
      const midnight = localMidnightMs(h, tz);
      const dow = new Date(`${dayKey}T00:00:00.000Z`).getUTCDay();
      c = {
        dayKey,
        monthKey: dayKey.slice(0, 7),
        dayStartIso: toIso(midnight),
        localHour: (h - midnight) / HOUR_MS,
        weekend: dow === 0 || dow === 6,
      };
      cache.set(h, c);
    }
    return c;
  };
}

function volumeFactor(src: SourceSpec, ms: number, ctx: HourContext, srcSalt: number): number {
  const shape = SHAPES[src.shape];
  const hour = ctx.localHour + (ms % HOUR_MS) / HOUR_MS;
  const diurnal = 1 + shape.amp * Math.cos((2 * Math.PI * (hour - shape.peakHour)) / 24);
  const weekly = ctx.weekend ? shape.weekend : 1;
  const noise = 1 + 0.04 * (2 * unit(srcSalt, Math.floor(ms / MINUTE_MS)) - 1);
  // Day-to-day variation (±7 %, one draw per source per local day) and ≈ 0.25 % a day of data growth,
  // so the 30-day trend reads like a real estate rather than a metronome.
  const dayIndex = Math.floor((ms - (T0 - HISTORY_DAYS * DAY_MS)) / DAY_MS);
  const daily = 1 + 0.07 * (2 * unit(srcSalt, 99, hashString(ctx.dayKey)) - 1);
  const growth = 1 + 0.0025 * (dayIndex - HISTORY_DAYS);
  return diurnal * weekly * noise * daily * growth;
}

/** Share of the minute [m, m+60 s) during which a change starting at `from` (and ending at `until`) applies. */
function coverage(m: number, from: number, until = Number.POSITIVE_INFINITY): number {
  const lo = Math.max(m, from);
  const hi = Math.min(m + MINUTE_MS, until);
  return hi > lo ? (hi - lo) / MINUTE_MS : 0;
}

function retentionAt(route: RouteSpec, m: number): number {
  let r = route.retention;
  for (const c of route.changes ?? []) {
    const share = coverage(m, c.at, c.until);
    // Permanent changes fully applied from their first whole minute; the minute they land in is blended.
    if (share > 0) r = r * (1 - share) + c.retention * share;
    else if (c.until === undefined && m >= c.at) r = c.retention;
  }
  return r;
}

function volumeMultiplier(src: SourceSpec, m: number): number {
  let x = 1;
  if (src.id === 'k8s_prod') x *= 1 + (SPIKE_MULTIPLIER - 1) * coverage(m, SPIKE_START);
  if (src.id === 'pan_fw_east') x *= 1 + (SPIKE_MULTIPLIER - 1) * coverage(m, OVERNIGHT_SPIKE_START, OVERNIGHT_SPIKE_END);
  return x;
}

// ─── The simulation ──────────────────────────────────────────────────────────

interface PlannedSnapshot {
  at: number; // tour seconds
  sweepAtMs: number;
  windowEndMs: number;
}

const SNAPSHOTS: readonly PlannedSnapshot[] = [
  { at: 0, sweepAtMs: T0, windowEndMs: Math.floor(T0 / MINUTE_MS) * MINUTE_MS },
  { at: TOUR_AT.regression, sweepAtMs: REG_OPEN, windowEndMs: REG_OPEN },
  { at: TOUR_AT.spike, sweepAtMs: SPIKE_OPEN, windowEndMs: SPIKE_OPEN },
  { at: TOUR_AT.recovery, sweepAtMs: RECOVERY, windowEndMs: RECOVERY },
];

interface IncidentEvent {
  kind: 'open' | 'close';
  at: number;
  incident: Incident;
}

interface SimResult {
  flows: Flow[];
  totalsAt: Map<number, TotalsDoc>;
  minuteRows: Record<FlowKey, MinuteRow[]>;
  dayRows: Record<FlowKey, DayRow[]>;
  events: IncidentEvent[];
  baselinesAt: Map<number, BaselinesDoc>;
  /** month-to-date paid per output key at t0 (for budgets) */
  mtdPaidByOutput: Map<string, number>;
  /** month-to-date saved per source at t0 (calibration separates the fixed-volume source) */
  mtdSavedByInput: Map<string, number>;
  /** the 30 days before t0: bytes in (per source, once), would-have-paid and saved, and minutes */
  last30: { inB: number; whpM: number; savedM: number; minutes: number };
}

interface SimOptions {
  scale: number;
  /** volume factor of the fixed-volume source (sizes the regression's dollar impact) */
  fixedScale: number;
  settings: Settings;
  prices: PricesDoc;
  inventory: InventoryDoc;
  commits: Commit[];
  collectingSinceMs: number;
}

function simulate(opts: SimOptions): SimResult {
  const { settings, prices, inventory } = opts;
  const tz = settings.displayTimezone;
  const flows = buildFlows(inventory, settings);
  const hourCtx = createHourContext(tz);
  const sourceById = new Map(SOURCES.map((s) => [s.id, s]));
  const routeById = new Map(ROUTES.map((r) => [r.id, r]));
  const outputType = new Map(OUTPUTS.map((o) => [o.id, o.type]));
  const outputGroup = new Map(OUTPUTS.map((o) => [o.id, o.group]));
  const salt = new Map(SOURCES.map((s) => [s.id, hashString(`tour|${s.id}`)]));

  // Every source reaches exactly one FINAL route (plus the datacenter archive copy), or its bytes would be
  // counted twice: the inventory's filters must claim what they are meant to claim.
  const finalFlows = new Map<string, number>();
  for (const f of flows) if (routeById.get(f.routeId)?.final) finalFlows.set(f.inputId, (finalFlows.get(f.inputId) ?? 0) + 1);
  for (const src of SOURCES) {
    if (finalFlows.get(src.id) !== 1) throw new Error(`tour: ${src.id} reaches ${finalFlows.get(src.id) ?? 0} final routes, expected 1`);
  }

  const priceCache = new Map<string, EffectivePrices>();
  const priceOf = (f: Flow, m: number): EffectivePrices => {
    const key = `${f.outputId}|${m >= fromIso(prices.versions[0].effectiveFrom) ? 1 : 0}`;
    let p = priceCache.get(key);
    if (!p) {
      p = effectivePrices(prices, f.groupId, f.outputId, m, outputType.get(f.outputId));
      priceCache.set(key, p);
    }
    return p;
  };

  // Flows grouped as core/sweep.ts groups them for the detector.
  const byRoute = new Map<ObjectKey, Flow[]>();
  const byInput = new Map<ObjectKey, Flow[]>();
  const push = (map: Map<ObjectKey, Flow[]>, key: ObjectKey, f: Flow): void => {
    const list = map.get(key);
    if (list) list.push(f);
    else map.set(key, [f]);
  };
  for (const f of flows) {
    if (f.routeId !== '-') push(byRoute, objectKey('route', f.groupId, f.routeId), f);
    if (f.inputId !== '-') push(byInput, objectKey('in', f.groupId, f.inputId), f);
  }
  const routeLabel = (f: Flow): string => humanize(f.pipelineId === 'passthrough' ? f.routeId : f.pipelineId, settings.humanize);

  let totals: TotalsDoc = emptyTotals(toIso(opts.collectingSinceMs));
  const totalsAt = new Map<number, TotalsDoc>();
  const keepRowsFrom = SIM_END - DAY_MS - 2 * HOUR_MS;
  const minuteRows: Record<FlowKey, MinuteRow[]> = {};
  const dayRows: Record<FlowKey, DayRow[]> = {};
  const lastDayRow = new Map<FlowKey, DayRow>();
  const events: IncidentEvent[] = [];
  const baselinesAt = new Map<number, BaselinesDoc>();
  let baselines = emptyBaselines(toIso(DETECT_FROM));
  const open = new Map<string, Incident>();
  const whpWindow = new Map<ObjectKey, number[]>(); // last 60 minutes of route would-have-paid
  const mtdPaidByOutput = new Map<string, number>();
  const mtdSavedByInput = new Map<string, number>();
  const last30 = { inB: 0, whpM: 0, savedM: 0, minutes: 0 };
  const last30From = T0 - HISTORY_DAYS * DAY_MS;
  const snapshotEnds = new Set(SNAPSHOTS.map((p) => p.windowEndMs));
  const t0MonthStart = localMonthStartMs(T0, tz);

  const start = Math.floor(opts.collectingSinceMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let m = start; m < SIM_END; m += MINUTE_MS) {
    const ctx = hourCtx(m);
    const tIso = toIso(m);
    const rows: Record<FlowKey, MinuteRow> = {};
    const agg = { whpM: 0, paidM: 0, savedM: 0 };
    const byOutput = new Map<string, { whpM: number; paidM: number; savedM: number }>();

    const srcBytes = new Map<string, number>();
    for (const src of SOURCES) {
      if (src.activeFrom !== undefined && m < src.activeFrom) continue;
      const gbDay = src.gbPerDay * (src.fixedVolume ? opts.fixedScale : opts.scale);
      const bytes = Math.round(((gbDay * 1e9) / 1440) * volumeFactor(src, m, ctx, salt.get(src.id)!) * volumeMultiplier(src, m));
      srcBytes.set(src.id, bytes);
      if (m >= last30From && m < T0) last30.inB += bytes;
    }
    if (m >= last30From && m < T0) last30.minutes += 1;
    const inMtd = m >= t0MonthStart && m < T0;

    for (const f of flows) {
      const inB = srcBytes.get(f.inputId) ?? 0;
      if (inB <= 0) continue;
      const route = routeById.get(f.routeId)!;
      const jitter = route.retention < 1 ? 1 + 0.01 * (2 * unit(salt.get(f.inputId)!, 7, Math.floor(m / MINUTE_MS)) - 1) : 1;
      const outB = Math.round(inB * Math.min(1, retentionAt(route, m) * jitter));
      const src = sourceById.get(f.inputId)!;
      const eventBytes = src.type === 'wef' ? 1800 : src.type === 's3' ? 420 : 650;
      const inE = Math.max(1, Math.round(inB / eventBytes));
      const outE = Math.max(0, Math.round(inE * (outB / inB)));
      const p = priceOf(f, m);
      const money = priceMinute({ inB, outB }, p.paidMcPerGb, p.whpMcPerGb, p.counterfactual);
      const row: MinuteRow = { t: tIso, inB, outB, inE, outE, ...money };
      rows[f.key] = row;
      agg.whpM += money.whpM;
      agg.paidM += money.paidM;
      agg.savedM += money.savedM;
      if (inMtd) mtdSavedByInput.set(f.inputId, (mtdSavedByInput.get(f.inputId) ?? 0) + money.savedM);
      if (m >= last30From && m < T0) {
        last30.whpM += money.whpM;
        last30.savedM += money.savedM;
      }
      const outKey = `${f.groupId}:${f.outputId}`;
      const o = byOutput.get(outKey) ?? { whpM: 0, paidM: 0, savedM: 0 };
      o.whpM += money.whpM;
      o.paidM += money.paidM;
      o.savedM += money.savedM;
      byOutput.set(outKey, o);

      // Per-flow day rows (roll.day).
      let d = lastDayRow.get(f.key);
      if (!d || d.t !== ctx.dayStartIso) {
        d = { t: ctx.dayStartIso, inB: 0, outB: 0, whpM: 0, paidM: 0, savedM: 0 };
        (dayRows[f.key] ??= []).push(d);
        lastDayRow.set(f.key, d);
      }
      d.inB += inB;
      d.outB += outB;
      d.whpM += money.whpM;
      d.paidM += money.paidM;
      d.savedM += money.savedM;

      if (m >= keepRowsFrom) (minuteRows[f.key] ??= []).push(row);
    }

    totals = addMinuteToTotals(totals, ctx.dayKey, agg);
    for (const [outKey, money] of byOutput) {
      totals = addOutputMinuteToTotals(totals, ctx.monthKey, outKey, money);
      if (inMtd) mtdPaidByOutput.set(outKey, (mtdPaidByOutput.get(outKey) ?? 0) + money.paidM);
    }

    // Rolling hour of route would-have-paid (the regression's dollar impact), primed before detection.
    if (m >= DETECT_FROM - HOUR_MS) {
      for (const [route, fs] of byRoute) {
        let whp = 0;
        for (const f of fs) whp += rows[f.key]?.whpM ?? 0;
        const w = whpWindow.get(route) ?? [];
        w.push(whp);
        if (w.length > 60) w.shift();
        whpWindow.set(route, w);
      }
    }

    // The detector, fed exactly like core/sweep.ts (one evaluation per completed minute).
    if (m >= DETECT_FROM) {
      const nowMs = m + MINUTE_MS;
      const ratioSeries: Record<ObjectKey, RatioPoint> = {};
      for (const [route, fs] of byRoute) {
        let saved = 0;
        let whp = 0;
        for (const f of fs) {
          saved += rows[f.key]?.savedM ?? 0;
          whp += rows[f.key]?.whpM ?? 0;
        }
        const w = whpWindow.get(route) ?? [];
        const whpPerDayM = w.length > 0 ? Math.round((w.reduce((a, b) => a + b, 0) * 1440) / w.length) : 0;
        ratioSeries[route] = { x: whp > 0 ? saved / whp : null, whpPerDayM, label: routeLabel(fs[0]), outputId: fs[0].outputId };
      }
      const costSeries: Record<ObjectKey, CostPoint> = {};
      for (const [input, fs] of byInput) {
        let paid = 0;
        for (const f of fs) paid += rows[f.key]?.paidM ?? 0;
        costSeries[input] = { x: paid * 60, label: humanize(fs[0].inputId, settings.humanize), outputId: fs[0].outputId };
      }
      const budgetSeries: Record<ObjectKey, BudgetPoint> = {};
      for (const [outputId, b] of Object.entries(settings.budgets ?? {})) {
        const group = outputGroup.get(outputId)!;
        budgetSeries[objectKey('out', group, outputId)] = {
          paidMtdM: totals.byOutputMonth?.[ctx.monthKey]?.[`${group}:${outputId}`]?.paidM ?? 0,
          budgetCentsPerMonth: b.centsPerMonth,
          label: humanize(outputId, settings.humanize),
        };
      }
      const res = detect({
        nowMs,
        minuteStartMs: m,
        settings,
        baselines,
        openIncidents: [...open.values()],
        ratioSeries,
        costSeries,
        budgetSeries,
        muted: {},
        commits: opts.commits.filter((c) => fromIso(c.deployedAt ?? c.committedAt) <= nowMs),
        inventory,
        evaluateBudget: shouldEvaluateBudget(baselines, nowMs, settings),
      });
      baselines = res.baselines;
      for (const inc of res.opened) {
        const withNote: Incident = { ...inc, notes: [...inc.notes, 'sample'] };
        open.set(inc.id, withNote);
        events.push({ kind: 'open', at: nowMs, incident: withNote });
      }
      for (const inc of res.updated) open.set(inc.id, { ...inc });
      for (const inc of res.closed) {
        open.delete(inc.id);
        events.push({ kind: 'close', at: nowMs, incident: inc });
      }
    }

    if (snapshotEnds.has(m + MINUTE_MS)) {
      totalsAt.set(m + MINUTE_MS, totals);
      baselinesAt.set(m + MINUTE_MS, baselines);
    }
  }

  return { flows, totalsAt, minuteRows, dayRows, events, baselinesAt, mtdPaidByOutput, mtdSavedByInput, last30 };
}

// ─── Incidents over time, deliveries ─────────────────────────────────────────

interface IncidentStory {
  open: Incident;
  close?: Incident;
  deliveries: DeliveryLog[];
}

function incidentStories(events: IncidentEvent[]): Map<string, IncidentStory> {
  const stories = new Map<string, IncidentStory>();
  for (const e of events) {
    if (e.kind === 'open') {
      const d: DeliveryLog = {
        endpointId: SLACK_ENDPOINT_ID,
        event: 'incident.opened',
        incidentId: e.incident.id,
        status: 200,
        attempt: 1,
        at: toIso(e.at + DELIVERY_LAG_MS),
        kind: 'notify',
      };
      stories.set(e.incident.id, { open: e.incident, deliveries: [d] });
    } else {
      const s = stories.get(e.incident.id);
      if (!s) throw new Error(`tour: close without open for ${e.incident.id}`);
      s.close = e.incident;
      s.deliveries.push({
        endpointId: SLACK_ENDPOINT_ID,
        event: 'incident.closed',
        incidentId: e.incident.id,
        status: 200,
        attempt: 1,
        at: toIso(e.at + CLOSE_DELIVERY_LAG_MS),
        kind: 'notify',
      });
    }
  }
  return stories;
}

/** The incident as the app would hold it at instant `t` (deliveries and close applied up to t). */
function incidentAt(story: IncidentStory, t: number): Incident | undefined {
  if (fromIso(story.open.openedAt) > t) return undefined;
  const closed = story.close && fromIso(story.close.closedAt!) <= t;
  const base = closed ? story.close! : story.open;
  const refs: DeliveryRef[] = story.deliveries.filter((d) => fromIso(d.at) <= t).map((d) => ({ endpointId: d.endpointId, status: d.status, at: d.at }));
  const inc: Incident = { ...base, deliveries: refs };
  if (!closed) delete inc.closedAt;
  if (refs.length > 0) inc.lastNotifiedAt = refs[refs.length - 1].at;
  else delete inc.lastNotifiedAt;
  return inc;
}

function weeklyDeliveries(collectingSinceMs: number): DeliveryLog[] {
  const out: DeliveryLog[] = [];
  // Mondays 12:00 UTC (the automatic send) since collecting began.
  for (let t = Date.UTC(2026, 8, 21, 12, 0, 4); t > collectingSinceMs; t -= 7 * DAY_MS) {
    out.push({ endpointId: SLACK_ENDPOINT_ID, event: 'receipt.weekly', status: 200, attempt: 1, at: toIso(t), kind: 'notify' });
  }
  return out;
}

// ─── Size: floats rounded, nothing else touched ──────────────────────────────

/** Rounds every non-integer number to 4 decimals (ratios, sparklines, rates). Money is integer and untouched. */
export function roundFloats<T>(value: T, digits = 4): T {
  const f = 10 ** digits;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'number') return Number.isInteger(v) || !Number.isFinite(v) ? v : Math.round(v * f) / f;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

// ─── The builder ─────────────────────────────────────────────────────────────

/** The estate's size and money over the 30 days before t0, in the units ENVELOPE states. */
export interface TourEnvelope {
  tbPerDay: number;
  whpPerDayUsd: number;
  annualizedUsd: number;
}

function tourEnvelope(last30: SimResult['last30'], headline: Headline): TourEnvelope {
  const perDay = (v: number) => (v / Math.max(1, last30.minutes)) * 1440;
  return { tbPerDay: perDay(last30.inB) / 1e12, whpPerDayUsd: perDay(last30.whpM) / 100_000, annualizedUsd: headline.annualizedM / 100_000 };
}

export interface BuiltTour {
  doc: TourFixture;
  /** serialized size of the doc in bytes (UTF-8) */
  bytes: number;
  /** the estate's size and money (asserted against ENVELOPE) */
  envelope: TourEnvelope;
  /** per-flow detector evidence for tests */
  events: { kind: 'open' | 'close'; at: ISO; type: string; objectKey: string }[];
}

function budgetFor(paidMtdM: number, elapsedMin: number, monthMin: number): number {
  // Budgets sit at ≈ 128 % of the projected month, rounded up to $500: comfortably under warn (90 %).
  const projectedCents = ((paidMtdM / elapsedMin) * monthMin) / 1000;
  return Math.ceil((projectedCents * 1.28) / 50_000) * 50_000;
}

/**
 * Builds the tour fixture. Pure and deterministic: the same code always yields the same file.
 * Throws when the story it produced is not the story it was asked for.
 */
export function buildTourDoc(): BuiltTour {
  const tz = TOUR_TZ;
  const collectingSinceMs = localMidnightMs(T0 - (HISTORY_DAYS + 1) * DAY_MS, tz) + 9 * HOUR_MS + 12 * MINUTE_MS;
  const installedAtMs = collectingSinceMs - 20 * MINUTE_MS;
  const settingsSavedAt = collectingSinceMs - 6 * MINUTE_MS;
  const inventory = tourInventory(T0 - 4 * MINUTE_MS);
  const prices = tourPrices(collectingSinceMs - 5 * MINUTE_MS);
  const commits = buildCommits();

  // Pass 1 at scale 1 → calibrate volumes to the MTD target and size the budgets.
  const probe = simulate({ scale: 1, fixedScale: 1, settings: tourSettings({}, 0, settingsSavedAt), prices, inventory, commits, collectingSinceMs });
  // The regression's impact is linear in the payments volume: size it to TARGET_IMPACT_M.
  const probeImpact = probe.events.find((e) => e.kind === 'open' && e.incident.type === 'regression')?.incident.impactPerDayM ?? 0;
  const fixedScale = probeImpact > 0 ? TARGET_IMPACT_M / probeImpact : 1;
  // Saved is linear in each volume factor: MTD = scale × (everything else) + fixedScale × (the fixed source).
  const fixedIds = new Set(SOURCES.filter((src) => src.fixedVolume).map((src) => src.id));
  let probeFixed = 0;
  let probeRest = 0;
  for (const [id, v] of probe.mtdSavedByInput) {
    if (fixedIds.has(id)) probeFixed += v;
    else probeRest += v;
  }
  const scale = (TARGET_MTD_M - fixedScale * probeFixed) / probeRest;

  const elapsedMin = (T0 - localMonthStartMs(T0, tz)) / MINUTE_MS;
  const monthMin = minutesInMonth(T0, tz);
  const outputGroupOf = (id: string): TourGroup => OUTPUTS.find((o) => o.id === id)!.group;
  const budgets: Settings['budgets'] = {};
  for (const id of ['splunk_cloud', 'sentinel', 'datadog']) {
    budgets[id] = { centsPerMonth: budgetFor((probe.mtdPaidByOutput.get(`${outputGroupOf(id)}:${id}`) ?? 0) * scale, elapsedMin, monthMin) };
  }

  // Pass 2: the fixture. The Cribl cost only feeds the headline's Net saved and Payback (never the
  // detector), so it is sized from this pass's own volume: GB a day × the hybrid-worker credit rate.
  const simSettings = tourSettings(budgets, 0, settingsSavedAt);
  const sim = simulate({ scale, fixedScale, settings: simSettings, prices, inventory, commits, collectingSinceMs });
  const gbPerDay = (sim.last30.inB / sim.last30.minutes) * (1440 / 1e9);
  const criblCostCentsPerMonth = Math.round((gbPerDay * CRIBL_CREDITS_PER_GB * 365) / 12 / 5_000) * 5_000 * 100;
  const settings: Settings = { ...simSettings, criblCostCentsPerMonth };
  const stories = incidentStories(sim.events);
  const history = weeklyDeliveries(collectingSinceMs);
  const allDeliveries = [...history, ...[...stories.values()].flatMap((s) => s.deliveries)];

  const snapshotAt = (p: PlannedSnapshot): Snapshot => {
    const t = p.sweepAtMs;
    const incidents = [...stories.values()].map((s) => incidentAt(s, t)).filter((i): i is Incident => !!i);
    const rows: Record<FlowKey, MinuteRow[]> = {};
    for (const [k, list] of Object.entries(sim.minuteRows)) rows[k] = list.filter((r) => fromIso(r.t) < p.windowEndMs && fromIso(r.t) >= p.windowEndMs - DAY_MS);
    return buildSnapshot({
      sweepAtMs: t,
      windowStartMs: p.windowEndMs - MINUTE_MS,
      windowEndMs: p.windowEndMs,
      mode: 'sample',
      settings,
      prices,
      inventory,
      flows: sim.flows,
      minuteRows: rows,
      totals: sim.totalsAt.get(p.windowEndMs)!,
      collectingSinceMs,
      incidents,
      timeline: commits.filter((c) => fromIso(c.committedAt) <= t),
      deliveries: allDeliveries.filter((d) => fromIso(d.at) <= t),
      muted: {},
      // Baselines omitted on purpose: every priced route is warm by t0, and routes that can never
      // learn a ratio (the S3 archive copy prices nothing as saved) would otherwise read "learning".
      calls: 23,
      metricsSource: 'metrics-query',
      previous: null,
    });
  };
  const snapshots = SNAPSHOTS.map((p) => roundFloats(snapshotAt(p)));
  const [base, atRegression, atSpike, atRecovery] = snapshots;

  // ── The story the detector told, checked ────────────────────────────────
  const describe = (e: IncidentEvent) => `${e.kind} ${e.incident.type} ${e.incident.objectKey} @ ${toIso(e.at)}`;
  const expected = [
    `open spike in:datacenter:pan_fw_east @ ${toIso(OVERNIGHT_SPIKE_START + 2 * MINUTE_MS)}`,
    `close spike in:datacenter:pan_fw_east @ ${toIso(OVERNIGHT_SPIKE_END + MINUTE_MS)}`,
    `open regression route:datacenter:r_payments @ ${toIso(REG_OPEN)}`,
    `open spike in:apps:k8s_prod @ ${toIso(SPIKE_OPEN)}`,
    `close regression route:datacenter:r_payments @ ${toIso(RECOVERY)}`,
  ];
  const got = sim.events.map(describe);
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new Error(`tour: the detector told a different story.\n  expected:\n    ${expected.join('\n    ')}\n  got:\n    ${got.join('\n    ') || '(nothing)'}`);
  }
  const regression = sim.events.find((e) => e.incident.type === 'regression' && e.kind === 'open')!.incident;
  const breakCommit = commits.find((c) => c.message === BREAK_MESSAGE)!;
  if (regression.cause !== 'commit' || regression.commit?.hash !== breakCommit.hash || regression.severity !== 'high') {
    throw new Error(`tour: the regression was not attributed to the breaking commit (${JSON.stringify(regression.commit)})`);
  }
  if (regression.caughtInSec !== 171) throw new Error(`tour: caught in ${regression.caughtInSec} s, expected 171`);
  const spike = sim.events.find((e) => e.incident.type === 'spike' && e.kind === 'open' && e.incident.objectKey.endsWith(':k8s_prod'))!.incident;
  const mtd = base.headline.mtdM;
  if (Math.abs(mtd - TARGET_MTD_M) > TARGET_MTD_M * 0.01) throw new Error(`tour: MTD ${mtd} is not within 1 % of ${TARGET_MTD_M}`);
  const mtds = snapshots.map((s) => s.headline.mtdM);
  if (mtds.some((v, i) => i > 0 && v < mtds[i - 1])) throw new Error(`tour: the headline goes backwards ${mtds.join(' → ')}`);
  if (snapshots.some((s) => s.unpricedOutputIds.length > 0)) throw new Error('tour: a destination is unpriced');
  const openCounts = snapshots.map((s) => s.openIncidents).join(',');
  if (openCounts !== '0,1,2,1') throw new Error(`tour: open incidents per snapshot ${openCounts}, expected 0,1,2,1`);
  for (const d of base.destinations) {
    if (d.budget && d.budget.pct >= settings.thresholds.budgetWarnPct) throw new Error(`tour: ${d.outputId} is at ${d.budget.pct}% of budget`);
  }
  // The enterprise envelope (≈ 30 TB a day, $60–90k a day would-have-paid, $7–10M a year saved).
  const envelope = tourEnvelope(sim.last30, base.headline);
  const outside = (Object.keys(ENVELOPE) as (keyof typeof ENVELOPE)[]).filter((k) => envelope[k] < ENVELOPE[k][0] || envelope[k] > ENVELOPE[k][1]);
  if (outside.length > 0) throw new Error(`tour: outside the enterprise envelope: ${outside.map((k) => `${k} ${Math.round(envelope[k])}`).join(', ')}`);
  if (Math.abs(regression.impactPerDayM - TARGET_IMPACT_M) > TARGET_IMPACT_M * 0.01) throw new Error(`tour: regression impact ${regression.impactPerDayM}, expected ≈ ${TARGET_IMPACT_M}`);

  // ── Script (SPEC 15) ─────────────────────────────────────────────────────
  const storyOf = (inc: Incident): IncidentStory => stories.get(inc.id)!;
  const regStory = storyOf(regression);
  const spikeStory = storyOf(spike);
  const restoreCommit = commits.find((c) => c.message.startsWith('Revert'))!;
  const script: TourStep[] = [
    { at: TOUR_AT.regression, action: 'snapshot', payload: atRegression },
    { at: TOUR_AT.regression, action: 'incident.open', payload: roundFloats(incidentAt(regStory, REG_OPEN)!) },
    { at: TOUR_AT.regressionDelivery, action: 'delivery', payload: regStory.deliveries[0] },
    { at: TOUR_AT.restore, action: 'commit', payload: restoreCommit },
    { at: TOUR_AT.spike, action: 'snapshot', payload: atSpike },
    { at: TOUR_AT.spike, action: 'incident.open', payload: roundFloats(incidentAt(spikeStory, SPIKE_OPEN)!) },
    { at: TOUR_AT.spikeDelivery, action: 'delivery', payload: spikeStory.deliveries[0] },
    { at: TOUR_AT.recovery, action: 'snapshot', payload: atRecovery },
    { at: TOUR_AT.recovery, action: 'incident.close', payload: roundFloats(incidentAt(regStory, RECOVERY)!) },
    { at: TOUR_AT.recoveryDelivery, action: 'delivery', payload: regStory.deliveries[1] },
    { at: TOUR_AT.weeklyReceipt, action: 'caption', payload: { id: 'weekly-receipt' } },
  ];

  // ── The Slack message and the weekly receipt ─────────────────────────────
  const regAtOpen = incidentAt(regStory, REG_OPEN)!;
  const slackMessage: SlackMessage = slackPayload(
    canonicalPayload('incident.opened', { incident: regAtOpen, workspace: WORKSPACE_NAME, linkBase: '', labels: settings.humanize, sentAt: regStory.deliveries[0].at }),
    { tz, labels: settings.humanize },
  );
  const week = previousWeek(T0 + TOUR_AT.weeklyReceipt * S, tz);
  const weeklyReceipt: WeeklyReceipt = roundFloats(
    buildWeeklyReceipt({
      periodStartMs: week.startMs,
      periodEndMs: week.endMs,
      tz,
      rowsByFlow: sim.dayRows,
      labels: settings.humanize,
      openIncidents: [incidentAt(spikeStory, T0 + TOUR_AT.weeklyReceipt * S)!],
    }),
  );

  const meta: Meta = {
    schemaVersion: 1,
    installedAt: toIso(installedAtMs),
    collectingSince: toIso(collectingSinceMs),
    appVersion: '1.0.0',
    build: 'release',
    metricsSource: 'metrics-query',
    lastSweepAt: base.sweepAt,
    lastSweepMs: 4_100,
    lastSweepCalls: 23,
    lastSweepMode: 'ui',
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: Math.round((T0 - collectingSinceMs) / MINUTE_MS),
    meteredThrough: base.windowEnd,
    lastWeeklySentAt: history[0]?.at,
    timelineRefreshedAt: toIso(T0 - 41 * S),
    inventoryRefreshEveryMin: 10,
  };

  // roll.day: per-flow day rows for the two weeks the weekly receipt reads (its week, and the week before
  // for its trend) — the receipt's evidence. Nothing on screen reads day rows (the 30-day history is the
  // snapshot's own trend), and 30 days × 55 flows would be ≈ 210 KB of the 400 KB budget. Every flow keeps its key.
  const rollFrom = week.startMs - (week.endMs - week.startMs);
  const roll = {
    day: roundFloats(
      Object.fromEntries(sim.flows.map((f) => [f.key, (sim.dayRows[f.key] ?? []).filter((r) => fromIso(r.t) >= rollFrom && fromIso(r.t) < week.endMs)])),
    ),
  };
  const doc: TourFixture = {
    schemaVersion: 1,
    generatedAt: toIso(T0),
    source: 'tour',
    settings,
    prices,
    snapshot: base,
    incidents: base.incidents,
    timeline: commits.filter((c) => fromIso(c.committedAt) <= T0),
    notifyLog: allDeliveries.filter((d) => fromIso(d.at) <= T0).sort((a, b) => fromIso(b.at) - fromIso(a.at)),
    script,
    slackMessage,
    weeklyReceipt,
    anchor: toIso(T0),
    timezone: tz,
    meta,
    inventory,
    roll,
    workspace: { name: WORKSPACE_NAME, sources: SOURCES.length, destinations: OUTPUTS.length, historyDays: HISTORY_DAYS },
    durationSec: TOUR_AT.weeklyReceipt + TOUR_HOLD_SEC,
  };

  const bytes = serializedBytes(doc);
  if (bytes >= MAX_FIXTURE_BYTES) throw new Error(`tour: tour.json would be ${bytes} bytes (limit ${MAX_FIXTURE_BYTES})`);

  return {
    doc,
    bytes,
    envelope,
    events: sim.events.map((e) => ({ kind: e.kind, at: toIso(e.at), type: e.incident.type, objectKey: e.incident.objectKey })),
  };
}

/** The file's exact text (stable key order as built, two-space indent would double the size: none). */
export function serializeTour(doc: TourFixture): string {
  return `${JSON.stringify(doc)}\n`;
}

function serializedBytes(doc: TourFixture): number {
  return new TextEncoder().encode(serializeTour(doc)).length;
}

/** Where the fixture lives, relative to the repository root. */
export const TOUR_JSON_PATH = 'demo/sample/tour.json';

// ─── `npx tsx testdata/tour.ts` ───────────────────────────────────────────────

const isMain = typeof process !== 'undefined' && Array.isArray(process.argv) && /testdata[\\/]tour\.ts$/.test(process.argv[1] ?? '');
if (isMain) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const built = buildTourDoc();
  const out = resolve(process.cwd(), TOUR_JSON_PATH);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, serializeTour(built.doc));
  const h = built.doc.snapshot.headline;
  console.log(`wrote ${TOUR_JSON_PATH}: ${(built.bytes / 1024).toFixed(1)} KB · MTD saved $${Math.round(h.mtdM / 100_000).toLocaleString('en-US')} · ${built.events.length} detector events`);
}
