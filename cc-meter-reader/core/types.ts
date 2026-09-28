// core/types.ts — the single contract shared by backend/, src/ (UI), scripts/ and tests/.
// Pure types only. Money is integer MILLICENTS everywhere (1 cent = 1,000 mc; $1 = 100,000 mc).
// SPEC v1.2 §4, §5, §7.6, §9.4, §10, §11, §12, §15 are the source; deviations are logged in DECISIONS.md.

export type ISO = string; // ISO-8601 UTC string

// ─── Identity ────────────────────────────────────────────────────────────────
/** `${groupId}|${inputId}|${routeId}|${pipelineId}|${outputId}`; any missing segment is '-'. */
export type FlowKey = string;
export type ObjectKind = 'in' | 'route' | 'pipe' | 'out';
/** `${kind}:${groupId}:${id}` e.g. `pipe:default:mrd_pay_sample`. */
export type ObjectKey = string;

/** 'reconciled' (DECISIONS D20): exact Source and Destination byte counters, passthrough routes pinned, the
 *  remainder of a shared destination split by Cribl's per-route estimates. */
export type Attribution = 'reconciled' | 'route' | 'pipeline' | 'proportional' | 'route-only';
export type Build = 'release' | 'demo';
export type MetricsSource = 'metrics-query' | 'search';

// ─── Prices (SPEC 4, 6, 8) ──────────────────────────────────────────────────
export type PresetId =
  | 'splunk_cloud' | 'splunk_enterprise' | 'sentinel' | 'crowdstrike_ngsiem' | 'datadog' | 'elastic'
  | 'google_secops' | 'sumo' | 'newrelic' | 's3' | 'azure_blob' | 'cribl_lake' | 'databricks' | 'snowflake'
  | 'internal';

export interface Preset {
  id: PresetId;
  label: string;
  /** Destination `type` values that auto-suggest this preset. */
  matchTypes: string[];
  /** Typical list price, millicents per GB (a starting point, NOT a vendor quote). */
  milliCentsPerGb: number;
  /** How the vendor bills (P1-F11): per GB as it is used, a prepaid entitlement realized at renewal, or storage. */
  billing: PresetBilling;
  /** Two characters for the preset picker's vendor tile (P2-W24): 'SC' for Splunk Cloud, 'S3' for Amazon S3. */
  monogram?: string;
}

/**
 * How a preset's vendor bills (P1-F11): 'metered' (charged per GB as it is used, so a cut shows on the next
 * bill), 'entitlement' (a prepaid per-GB/day subscription, commitment tier or credit pool: avoided cost is
 * realized at renewal, when the entitlement is resized), 'storage' (billed on bytes kept, per GB-month).
 */
export type PresetBilling = 'metered' | 'entitlement' | 'storage';

/** How a preset's typical price was established: a vendor price list, a reseller or third-party report, or our arithmetic on those. */
export type PresetConfidence = 'published' | 'reported' | 'estimate';

/** One source behind a preset's typical price: the page, and the words on it that carry the figure. */
export interface PresetSource {
  url: string;
  /** Who published it, as the link reads ('Cribl Pricing Guide (Nov 2025)'), never a raw host (P1-G03). */
  publisher?: string;
  quote: string;
}

/** What a preset's typical price rests on (core/presets.ts PRESET_NOTES; shown on the Prices page and in the README). */
export interface PresetNote {
  /** Typical range in US dollars per GB, [low, high]; the preset's own value lies inside it. */
  rangeUsd: readonly [number, number];
  /** How the per-GB figure is derived from the vendor's pricing model, and its caveats. */
  basis: string;
  confidence: PresetConfidence;
  sources: readonly PresetSource[];
}

export type Counterfactual = { kind: 'same' } | { kind: 'other'; outputId: string } | { kind: 'none' };

export interface PriceEntry {
  milliCentsPerGb: number;
  committedMilliCentsPerGb?: number;
  preset?: PresetId;
  counterfactual?: Counterfactual; // default { kind: 'same' }
}

/** Keys of byOutputId are `${groupId}:${outputId}` when more than one group exists; plain outputId is accepted for the default group. */
export interface PriceVersion {
  effectiveFrom: ISO;
  byOutputId: Record<string, PriceEntry>;
  /** P2-W24: the Cribl username that saved this version (window.getCriblUser), when the platform said. */
  changedBy?: string;
}

export interface PricesDoc {
  schemaVersion: 1;
  updatedAt: ISO;
  versions: PriceVersion[]; // append-only, newest last, ≤ 50
}

// ─── Settings (SPEC 5) ───────────────────────────────────────────────────────
export type HeadlinePeriod = 'mtd' | 'today' | '30d' | 'annualized';
export type Severity = 'info' | 'medium' | 'high';
export type NotifyFormat = 'generic' | 'slack' | 'servicenow';

export interface NotificationEndpoint {
  id: string;
  name: string;
  /** https only. Stored as an App setting (SPEC 12.6); the UI re-displays host + last 4 characters only. */
  url: string;
  host: string;
  format: NotifyFormat;
  minSeverity: Severity; // default 'medium'
  weeklyReceipt: boolean; // default true
  lastTest?: { at: ISO; status: number; hostAuthorized: boolean };
  enabled: boolean;
  /**
   * How alerts reach this endpoint (DECISIONS D23, core/delivery.ts). Absent = 'webhook' (a direct POST).
   * 'cribl-bell' posts to the Cribl notification bell; 'cribl-target' goes through a Cribl Notification
   * target via the Search notification relay. Non-webhook endpoints store `url: ''` and `host: ''`.
   */
  channel?: 'webhook' | 'cribl-bell' | 'cribl-target';
  /** 'cribl-target' only: the Cribl Notification target id. No secret is stored in App KV. */
  criblTargetId?: string;
  /**
   * 'cribl-target' only: when a member confirmed that a test alert arrived in the target (rules round 2, craft). The
   * relay's 200 says only that Cribl accepted the event; its routing rests on the SEARCH_NOTIFICATION_<id>_ event-id
   * prefix (core/adapters/cribl-notify.ts, measured on 4.20.1), so an endpoint reads "unconfirmed" until a person saw
   * one arrive. Kept only while the target id is the one confirmed (`confirmedTargetId`). No secret.
   */
  confirmedAt?: ISO;
  confirmedTargetId?: string;
}

/**
 * A direct webhook the runner sends to, as the App may know it (DECISIONS D57): its URL stays in the runner's .env
 * and never reaches KV. Written to meta.deliveryWebhooks by the runner's sweeps (core/env-webhooks.ts).
 */
export interface WebhookDescriptor {
  id: string;
  name: string;
  host: string;
  format: NotifyFormat;
}

export interface Thresholds {
  regressionPoints: number; // 15
  regressionMinutes: number; // 3 (demo profile 1)
  regressionCommitWindowMin: number; // 30
  spikeSigma: number; // 3
  spikeMinutes: number; // 2 (demo profile 1)
  spikeMinCentsPerHour: number; // 500 ($5) — user-entered cents
  budgetWarnPct: number; // 90
  budgetAlertPct: number; // 100
  goodNewsPoints: number; // 15
  cooldownMinutes: number; // 60
  ewmaAlpha: number; // 0.0014 ≈ 24 h memory (2/(1440+1))
  warmupSamples: number; // 10
  recoveryMinutes: number; // 5 (demo profile 1)
  /** DECISIONS D26: a regression must cost at least this much per day to open (default 500 = $5/day). */
  regressionMinCentsPerDay?: number;
}

export interface Settings {
  schemaVersion: 1;
  updatedAt: ISO;
  displayTimezone: string; // IANA
  headlinePeriodDefault: HeadlinePeriod; // 'mtd'
  /** chime: the takeover's chime when an alert lands (P2-W19); absent = off. */
  presenter: { headlinePeriod: HeadlinePeriod; qrUrl?: string; chime?: boolean }; // 'annualized'
  /** Single-character shortcuts (P, Y, ?, /, the levers) on or off (WCAG 2.1.4, EPIC_AUDIT P1-A09); absent = on. */
  keyboard?: { singleKeyShortcuts: boolean };
  live: { pollSeconds: number; presenterPollSeconds: number }; // 10 / 5
  criblCostCentsPerMonth?: number;
  /**
   * Rules round 2 (usefulness): the Cribl cost was saved from "Use this estimate" (Cribl's published list price × the
   * measured ingest), not a contract figure: the Receipt and the report say so beside the net. Absent = a contract cost.
   */
  criblCostEstimate?: true;
  /** A monthly savings goal (P2-W20): the Receipt's month-to-date pace strip reads against it. */
  savingsGoalCentsPerMonth?: number;
  budgets: Record<string, { centsPerMonth: number }>; // by outputId
  thresholds: Thresholds;
  goodNewsEnabled: boolean; // false
  excludedObjectKeys: ObjectKey[];
  /** P1-F07: objects a member muted from an alert ("Mute for 24 hours"): nothing opens on them until `until` (App KV, never Cribl config). */
  mutes?: Record<ObjectKey, { until: ISO; by?: string }>;
  includeInternal: boolean; // false
  notifications: NotificationEndpoint[];
  humanize: Record<string, string>;
  demo: { enabled: boolean; replayMode: boolean; profile: boolean }; // false/false/true
  /** 'backend' (scheduled meter) or 'ui' (PRD 2.6 fallback: the open tab meters every 30 s). */
  runtime: 'backend' | 'ui';
}

// ─── Inventory (SPEC 4, 7 step 3) ────────────────────────────────────────────
export interface InputInfo {
  id: string;
  type: string;
  disabled?: boolean;
  description?: string;
  /** Pre-processing pipeline id (Source → Processing settings). */
  pipeline?: string;
  /** QuickConnect connections (bypass routes). */
  connections?: { output: string; pipeline?: string }[];
  sendToRoutes?: boolean;
}
export interface OutputInfo {
  id: string;
  type: string;
  disabled?: boolean;
  description?: string;
  /** Output-level post-processing pipeline, if any. */
  pipeline?: string;
  /** For the built-in `default` output (type 'default'): the output id it forwards to. */
  defaultId?: string;
}
export interface PipelineFunctionInfo {
  id: string; // function type e.g. 'eval', 'sampling', 'drop'
  description?: string;
  disabled?: boolean;
  filter?: string;
}
export interface PipelineInfo {
  id: string;
  description?: string;
  functions: PipelineFunctionInfo[];
  /** 'pack:<packId>' style references resolve here with packId set. */
  packId?: string;
  /** Pipeline `conf.output`: where a route with no `output` of its own sends this pipeline's events. */
  output?: string;
}
export interface RouteInfo {
  id: string;
  name?: string;
  filter: string;
  pipeline: string;
  output?: string;
  final?: boolean;
  disabled?: boolean;
  description?: string;
}
export interface GroupInventory {
  inputs: InputInfo[];
  outputs: OutputInfo[];
  pipelines: PipelineInfo[];
  routes: RouteInfo[];
  /** id of the routing table (usually 'default'). */
  routeTableId?: string;
}
export interface InventoryDoc {
  schemaVersion: 1;
  updatedAt: ISO;
  hash: string;
  byGroup: Record<string, GroupInventory>;
  /** When each group's config was last read (refreshes go oldest first; a commit newer than it forces one). */
  groupsFetchedAt?: Record<string, ISO>;
}

/** One priced path through the routing table. */
export interface Flow {
  key: FlowKey;
  groupId: string;
  inputId: string; // '-' when unattributed
  routeId: string;
  pipelineId: string;
  outputId: string;
  attribution: Attribution;
}

// ─── Throughput (adapter output, SPEC 7 step 4) ──────────────────────────────
export interface ByteEvent {
  bytes: number;
  events: number;
}
/** Everything one metrics query returns for one window, summed across workers/processes. Missing = 0. */
export interface MetricsWindow {
  windowStart: ISO;
  windowEnd: ISO;
  /** keyed by `${groupId}:${inputId}` */
  inputs: Record<string, ByteEvent>;
  /** keyed by `${groupId}:${outputId}` */
  outputs: Record<string, ByteEvent>;
  /** keyed by `${groupId}:${routeId}` — present only if the metrics API reports route-level series */
  routesIn?: Record<string, ByteEvent>;
  routesOut?: Record<string, ByteEvent>;
  /** keyed by `${groupId}:${pipelineId}` */
  pipelinesIn?: Record<string, ByteEvent>;
  pipelinesOut?: Record<string, ByteEvent>;
  /** which series existed in this window's answer (for attribution + Show the math) */
  has: { routeBytes: boolean; pipelineBytes: boolean };
}

// ─── Rollups (SPEC 4) ────────────────────────────────────────────────────────
export interface MinuteRow { t: ISO; inB: number; outB: number; inE: number; outE: number; whpM: number; paidM: number; savedM: number }
export interface HourRow { t: ISO; inB: number; outB: number; whpM: number; paidM: number; savedM: number; samples: number }
export interface DayRow { t: ISO; inB: number; outB: number; whpM: number; paidM: number; savedM: number }

export interface RollMinuteDoc { schemaVersion: 1; bucketStart: ISO; flows: Record<FlowKey, MinuteRow[]> } // key roll:min:YYYY-MM-DDTHH
export interface RollHourDoc { schemaVersion: 1; day: string; flows: Record<FlowKey, HourRow[]> } // key roll:hour:YYYY-MM-DD
export interface RollDayDoc { schemaVersion: 1; month: string; flows: Record<FlowKey, DayRow[]> } // key roll:day:YYYY-MM

/** Running per-period totals the headline reads without re-summing history every sweep. */
export interface TotalsDoc {
  schemaVersion: 1;
  updatedAt: ISO;
  /** local-date (displayTimezone) → totals for that day */
  byDay: Record<string, { whpM: number; paidM: number; savedM: number; minutes: number }>;
  /** local-month (YYYY-MM, displayTimezone) → `${groupId}:${outputId}` → month-to-date totals (budget pace, destination MTD). */
  byOutputMonth?: Record<string, Record<string, OutputMonthTotals>>;
  /**
   * Exclusive end of the minutes these totals include (REVIEW-3a #5): a minute before it is a replacement,
   * at or after it is new. Trusted only while `meteredAt === updatedAt` (a writer that doesn't know the cursor
   * changes updatedAt and leaves it stale).
   */
  meteredThrough?: ISO;
  meteredAt?: ISO;
}
export interface OutputMonthTotals { whpM: number; paidM: number; savedM: number }

// ─── Baselines + detector state (SPEC 9) ─────────────────────────────────────
export interface Baseline {
  mean: number;
  variance: number;
  samples: number;
  /** warm-up buffer until `samples >= warmupSamples` */
  warm: number[];
}
export interface RuleState {
  /** consecutive qualifying minutes for the rule currently being counted */
  streak: number;
  firstQualifyingAt?: ISO;
  /** EWMA mean frozen at the first qualifying minute (regression/goodnews) */
  frozenBaseline?: number;
  /** consecutive clean minutes while an incident is open */
  recoveryStreak: number;
  /** P1-F06 spike: when the last spike on this object opened (outside the demo profile, one per object per 24 h) */
  lastOpenedAt?: ISO;
  /** P1-F06 spike, while open: the level the readings hold (the mean of the run), its minutes, and consecutive misses */
  level?: number;
  levelMinutes?: number;
  levelMisses?: number;
}
export interface BaselinesDoc {
  schemaVersion: 1;
  updatedAt: ISO;
  byObject: Record<ObjectKey, Baseline>;
  rules: Record<string, RuleState>; // key `${type}|${objectKey}`
  /** last budget-pace evaluation (hourly outside the demo profile) */
  budgetEvaluatedAt?: ISO;
}

// ─── Change timeline (SPEC 10) ───────────────────────────────────────────────
/**
 * The entries a commit edited in its group's route table (`pipelines/route.yml`), read from the `version/show` hunks
 * (core/timeline.ts routeTableEdits). Every route edit rewrites that one shared file, so the file list alone cannot
 * say WHICH route changed: this can. `ids` are entries named by their `- id:` line in the hunk, `names` by their
 * `name:` line when the id sits outside the hunk's context, `filters` the `filter:` lines of changed entries neither
 * names; `unresolved` when a changed entry could not be named at all (a hunk too big to show, say).
 */
export interface RouteTableEdits {
  ids: string[];
  names: string[];
  filters?: string[];
  unresolved?: true;
}
export interface Commit {
  hash: string;
  message: string;
  author: string;
  committedAt: ISO;
  deployedAt?: ISO;
  groupId: string;
  files: string[];
  source: 'api' | 'demo';
  /** What the commit changed in the group's route table, when its diff was read (absent: not read, or no route table). */
  routeTable?: RouteTableEdits;
}
export type CommitMatch = 'files' | 'message' | 'nearby';
export interface CommitRef {
  hash: string;
  message: string;
  author: string;
  committedAt: ISO;
  deployedAt?: ISO;
  groupId: string;
  match: CommitMatch;
}
export interface TimelineDoc {
  schemaVersion: 1;
  updatedAt: ISO;
  byGroup: Record<string, Commit[]>; // newest first, ≤ 200 per group
}

// ─── Incidents + notifications (SPEC 9.4, 12) ────────────────────────────────
export type IncidentType = 'spike' | 'regression' | 'budget' | 'goodnews';
export interface DeliveryRef { endpointId: string; status: number; at: ISO; error?: string }
export interface Incident {
  id: string;
  type: IncidentType;
  severity: Severity;
  objectKey: ObjectKey;
  label: string;
  /** destination output id the object feeds (for payloads) */
  outputId?: string;
  openedAt: ISO;
  /** Last 2xx delivery to any endpoint (the cooldown clock). A failed attempt never sets it. */
  lastNotifiedAt?: ISO;
  /** Last delivery attempt, successful or not (a failed one waits 2 minutes before the next try). */
  lastAttemptAt?: ISO;
  /**
   * When the sweep that opened it ran, for incidents opened on catch-up (a backfilled minute): openedAt is
   * the minute the change showed, caughtInSec is measured to it, and detection came later (core/payloads.ts
   * caughtInSeconds()).
   */
  detectedAt?: ISO;
  closedAt?: ISO;
  cause?: 'commit' | 'unknown';
  commit?: CommitRef;
  /** ratio for regression/goodnews; $/hour millicents for spike; pct for budget */
  before: number;
  /**
   * The worst reading while open, in the unit `before` uses: the reading that opened it, deepened while
   * open for a regression (DECISIONS D45). Never rewritten on close (D47): the drop an incident reports is
   * the drop that happened, and the reading at close lives in `recoveredTo`. Display goes through
   * core/incidents.ts incidentReadings(), which also reads incidents closed before D47.
   */
  after: number;
  /** The reading at close (D47), in the unit `after` uses. Absent while open and on incidents closed before D47. */
  recoveredTo?: number;
  impactPerDayM: number;
  caughtInSec?: number;
  notes: string[]; // e.g. 'demo-profile', 'demo', 'sample'
  deliveries: DeliveryRef[];
  /**
   * P1-F07: a member closed it — accepted the drop as the new normal (the baseline re-learns it there), muted the
   * object for a while, or stopped alerting on the object. Absent: the detector closed it (recovered, a new normal
   * it measured, below the $/day floor).
   */
  closedReason?: 'accepted' | 'muted' | 'excluded';
  /** P1-F07: who closed it (the Cribl member's name, else username); absent when the detector closed it. */
  closedBy?: string;
}
export interface IncidentsDoc { schemaVersion: 1; items: Incident[] } // key incidents:YYYY-MM-DD

export type NotifyEvent = 'incident.opened' | 'incident.updated' | 'incident.closed' | 'receipt.weekly' | 'test';
export interface DeliveryLog {
  endpointId: string;
  event: NotifyEvent | 'demo';
  incidentId?: string;
  status: number; // 0 = network error
  attempt: number;
  at: ISO;
  error?: string; // 'host_not_authorized' on proxy 403
  kind?: 'notify' | 'demo';
  detail?: string;
}
export interface NotifyLogDoc { schemaVersion: 1; items: DeliveryLog[] } // last 200

// ─── Demo state (SPEC 11) ────────────────────────────────────────────────────
export interface DemoState {
  schemaVersion: 1;
  rigAppliedAt?: ISO;
  routes: Record<string, { previousPipelineId: string; previousPreProcessingId?: string; appliedAt: ISO; level: 'pack' | 'aggressive' }>;
  scene?: { name: string; step: string; startedAt: ISO; expectedAlertAt?: ISO; stepAt?: ISO; /** when each step began, by step index ('' = not recorded); the console's run of show */ stepsAt?: ISO[]; changed: { trims: string[]; rates: string[]; budgets: string[]; routes: string[] } };
  measuredLagSec: number; // default 240 until measured
  trim: Record<string, { functionIndex: number; previous: Record<string, unknown>; brokenAt: ISO }>;
  rates: Record<string, { baselineEps: number; multiplier: number; setAt: ISO }>;
  muted: Record<ObjectKey, ISO>; // until
  inFlight?: { lever: string; since: ISO };
  budgetsOverride?: Record<string, { previousCentsPerMonth?: number }>;
  /** Leader calls spent by demo levers in one UTC minute ('YYYY-MM-DDTHH:MM'); added to meta.callsThisMinute for the lever budget. */
  leverCalls?: { minute: string; calls: number };
}

export interface Meta {
  schemaVersion: 1;
  installedAt: ISO;
  collectingSince: ISO;
  appVersion: string;
  build: Build;
  metricsSource: MetricsSource;
  lastSweepAt?: ISO;
  lastSweepMs?: number;
  lastSweepCalls?: number;
  lastSweepMode?: 'scheduled' | 'manual' | 'ui';
  /** lock/meter owner of the last completed sweep: `ui:<tab id>`, `runner:<pid>` or `runner:<host>:<pid>`, `backend:<id>`. */
  lastSweepOwner?: string;
  /**
   * The runner or backend that delivers alerts (a `runner:`/`backend:` lock owner) and when it last swept or,
   * finding the minute already metered by a tab, checked in (EPIC_AUDIT P1-E05). Carried by every sweep, so a
   * tab that wins the minute keeps leaving delivery to it while this is under 90 s old.
   */
  deliveryOwner?: string;
  deliveryOwnerAt?: ISO;
  /** Set by a tab sweep that left alerts to the delivery owner: that owner's next sweep runs in full. */
  deliveryDeferredAt?: ISO;
  /**
   * The direct webhooks the delivery owner (the runner) sends to, from its .env (D57): names and hosts only, so
   * Settings and the incident cards can say where an alert went. Carried forward by every other sweep.
   */
  deliveryWebhooks?: WebhookDescriptor[];
  lastError?: string;
  /**
   * Since when sweeps have been failing on a KV write the store refused (a full store: 507, 413, 5xx); cleared by the
   * next sweep that completes. While it is set, a sweep runs the key expiry pass before its reads (EPIC_AUDIT P1-E03).
   */
  kvWriteFailingSince?: ISO;
  sweepErrors: number;
  consecutiveRateLimited: number;
  /** First sweep of the current rate-limited streak (EPIC_AUDIT P1-E01): "Rate limited since HH:MM". Cleared by a sweep that meets no limit. */
  rateLimitedSince?: ISO;
  /** Sweeps are skipped until this instant (the back-off after rate-limited sweeps: 2, 4, 8, then 16 minutes). */
  rateLimitedUntil?: ISO;
  sweepCount: number;
  /** Leader API calls spent per UTC minute by sweeps + demo levers (budget sharing, SPEC 7). */
  callsThisMinute?: { minute: string; calls: number };
  /** Exclusive end of the last metered minute (the sweep's cursor; backfill starts here). */
  meteredThrough?: ISO;
  /** Last automatic weekly receipt (scheduled or ui runtime), so Monday 12:00 UTC sends once. */
  lastWeeklySentAt?: ISO;
  /** Last expiry pass over dated keys (at most hourly). */
  lastExpiredAt?: ISO;
  /** Dated keys (roll/*, incidents/*) left in the App's KV after the last expiry pass: the store's size for the diag panel. */
  kvDatedKeys?: number;
  /** Expired keys the last expiry pass had no room to delete; a later sweep with room continues (EPIC_AUDIT P1-E08). */
  expiryBacklog?: number;
  /** Last change-timeline refresh from the version API (demo lever appends do not count). */
  timelineRefreshedAt?: ISO;
  /** Inventory refresh interval in minutes (10; doubled after three rate-limited sweeps, max 60). */
  inventoryRefreshEveryMin?: number;
  /** Stream worker groups the last successful listing named, in its order (re-listed at least hourly). */
  groupsKnown?: string[];
  /** When that listing was read. */
  groupsListedAt?: ISO;
  /** Worker groups the inventory holds: the ones the metrics query covers ("N of M worker groups metered"). */
  groupsMetered?: string[];
  /** Last time a due inventory refresh did not fit the sweep's call plan (the stored inventory stood). */
  inventorySkippedAt?: ISO;
  /**
   * Stretches no sweep could meter because they were older than the Leader keeps metrics when metering resumed
   * (EPIC_AUDIT P1-E04), newest last, at most 20. The Receipt, the Ledger and the diagnostics panel say
   * "N h not metered on <date>" from them; figures over a range that overlaps one are that much lower.
   */
  gaps?: MeteringGap[];
}

/** A stretch that was never metered (P1-E04): [from, to), whole minutes. */
export interface MeteringGap {
  from: ISO;
  to: ISO;
  minutes: number;
  /** When a sweep found it (the one that resumed metering after it). */
  recordedAt: ISO;
}

// ─── Snapshot (SPEC 7.6) ─────────────────────────────────────────────────────
export type FlowState = 'ok' | 'spike' | 'regression' | 'unpriced' | 'learning';
export interface FlowFigures {
  key: FlowKey;
  groupId: string;
  inputId: string;
  routeId: string;
  /** The route's own name in Cribl (inventory), when it has one other than its id: the Ledger and What if name the route by it. */
  routeName?: string;
  pipelineId: string;
  outputId: string;
  /** last completed minute */
  inB: number;
  outB: number;
  whpM: number;
  paidM: number;
  savedM: number;
  ratio: number;
  ratePerHourM: number; // paid $/hour, millicents
  savedPerDayM: number; // savedM of the last 60 minutes × 24 (or extrapolated)
  whpPerDayM: number;
  paidPerDayM: number;
  inBPerDay: number;
  outBPerDay: number;
  attribution: Attribution;
  sparkline: number[]; // ratio or saved per minute, ≤ 30 points
  state: FlowState;
  muted?: boolean;
  mutedUntil?: ISO;
  /** P1-F07: muted by a member ("Mute for 24 hours", settings.mutes), not by a demo change */
  mutedByMember?: true;
  /**
   * P1-F02: its destination's counterfactual credits it at ANOTHER destination's price ("without Cribl this data
   * would go to …"): its would-have-paid, so its savings, rest on that assumption rather than on bytes it dropped.
   */
  diverted?: true;
  /** P1-F02: the destination it is credited at (the counterfactual's outputId) */
  divertedTo?: string;
  /**
   * P1-F03: per day, what this flow costs beyond what it would have without Cribl (out priced above in: an
   * enrichment or GeoIP pipeline that grows bytes). Saved stays ≥ 0; this is the other side. Absent when 0.
   */
  addedPerDayM?: number;
  /**
   * Rules round 2: on the 'Other' row a compacted snapshot folds the smaller flows into (core/snapshot.ts
   * compactSnapshot), how many flows it holds. Absent on every real flow.
   */
  folded?: number;
}
export interface DestinationFigures {
  groupId: string;
  outputId: string;
  type: string;
  whpPerDayM: number;
  paidPerDayM: number;
  savedPerDayM: number;
  mtdPaidM: number;
  mtdSavedM: number;
  mtdWhpM: number;
  /** P0-17: minutes metered this month — what the MTD figures cover and what budget pace projects over */
  mtdMinutes?: number;
  milliCentsPerGb: number;
  counterfactual: Counterfactual;
  unpriced: boolean;
  /** P1-F01: the counterfactual names a destination with no price, so the credit is unknown (`unpriced` is set too); absent otherwise */
  counterfactualUnpriced?: true;
  budget?: { centsPerMonth: number; projectedM: number; pct: number };
}
export interface TopSaver {
  objectKey: ObjectKey;
  label: string;
  savedPerDayM: number;
  ratio: number;
  groupId: string;
  pipelineId: string;
  /** P1-F02: its savings are a diversion credit (credited at another destination's price), not bytes dropped */
  diverted?: true;
}
export interface Headline {
  todayM: number;
  mtdM: number;
  d30M: number;
  annualizedM: number;
  annualizedFromDays: number;
  whpMtdM: number;
  paidMtdM: number;
  ratioMtd: number;
  whpTodayM: number;
  paidTodayM: number;
  whp30dM: number;
  paid30dM: number;
  netMtdM?: number;
  paybackX?: number;
  /**
   * P0-23 coverage: minutes metered in the period (Σ totals.byDay minutes) and the whole minutes the period has
   * held up to what the sweep metered through — "27,540 of 34,560 minutes metered". Absent in older snapshots.
   */
  minutesMtd?: number;
  expectedMinutesMtd?: number;
  minutesToday?: number;
  expectedMinutesToday?: number;
  minutes30d?: number;
  expectedMinutes30d?: number;
  /**
   * P1-F02: month to date, what Cribl saved by reducing bytes (measured) and by diverting data a destination is
   * credited for at another's price (an assumption); reducedMtdM + divertedMtdM = mtdM. Absent without per-
   * destination month totals.
   */
  reducedMtdM?: number;
  divertedMtdM?: number;
  /** P1-F03: per day, the cost Cribl adds on flows that send out more than they would have cost (and how many) */
  addedPerDayM?: number;
  addedFlows?: number;
}
export interface TrendPoint { day: string; savedM: number; whpM: number; paidM: number }
export interface Snapshot {
  schemaVersion: 1;
  sweepAt: ISO;
  windowStart: ISO;
  windowEnd: ISO;
  mode: 'scheduled' | 'manual' | 'ui' | 'sample';
  headline: Headline;
  ratePerSecM: number;
  flows: FlowFigures[];
  destinations: DestinationFigures[];
  topSavers: TopSaver[];
  unpricedOutputIds: string[];
  openIncidents: number;
  incidents: Incident[]; // open + closed in the last 24 h, newest first, ≤ 50
  trend: TrendPoint[]; // last 30 local days
  /** 24 h of per-minute savings ratio for the whole workspace, ≤ 288 points (5-minute buckets) */
  ratioSeries: { t: ISO; ratio: number }[];
  timeline: Commit[]; // newest first, ≤ 30
  /**
   * Commits of the last 7 days that did not fit `timeline` (its 30, or 10 / 5 once the snapshot is compacted): the
   * Ledger's Changes list then says it shows the latest ones only (review W2). Absent when every one is there.
   */
  timelineTruncated?: true;
  deliveries: DeliveryLog[]; // newest first, ≤ 20
  calls: number;
  collectingSince: ISO;
  metricsSource: MetricsSource;
  attributionSummary: Attribution;
  /**
   * Rules round 2 (usefulness): the estate the sweep metered, counted before a 90 KB snapshot folds its smaller flows
   * into 'Other' (compactSnapshot keeps the 500, 250, 100 or 50 largest): every flow, and the distinct routes and
   * sources the detector watches. `flows.length` is only what the snapshot still lists. Absent on older snapshots.
   */
  flowCounts?: { flows: number; routes: number; sources: number };
}

// ─── Notification payload (SPEC 12.1) ────────────────────────────────────────
export interface CanonicalPayload {
  schemaVersion: 1;
  app: 'meter-reader';
  event: NotifyEvent;
  sentAt: ISO;
  workspace: string;
  incident?: {
    id: string;
    type: IncidentType;
    severity: Severity;
    title: string;
    object: { kind: 'input' | 'route' | 'pipeline' | 'output'; id: string; label: string; group: string; destination?: string };
    before: { ratio?: number; value?: number };
    /** the worst reading while open; `{}` for an incident closed before D47 (the drop was not kept) */
    after: { ratio?: number; value?: number };
    /** closed incidents: the reading at close (D47) */
    recoveredTo?: { ratio?: number; value?: number };
    /** P1-F07: closed by a member (accepted as the new normal, muted, alerts stopped), and by whom */
    closedReason?: 'accepted' | 'muted' | 'excluded';
    closedBy?: string;
    impact: { perDayMillicents: number; perDay: string; perYear: string };
    cause?: 'commit' | 'unknown';
    commit?: { hash: string; message: string; author: string; deployedAt?: ISO; match: CommitMatch };
    caughtInSeconds?: number;
    openedAt: ISO;
    closedAt?: ISO;
    link: string;
    notes: string[];
  };
  receipt?: WeeklyReceipt;
}

/** P0-23: what a forwarded receipt's dollars rest on, printed as its Basis block (core/receipt.ts). */
export interface ReceiptBasis {
  /** one per destination that carries money in the period, the largest would-have-paid first */
  prices: ReceiptBasisPrice[];
  /** destinations with no price: every figure above excludes them */
  unpricedCount: number;
  /** how much of the period was metered ('minutes', or whole UTC 'days' for a day-grained range) */
  coverage?: { unit: 'minutes' | 'days'; metered: number; expected: number };
}
export interface ReceiptBasisPrice {
  label: string;
  milliCentsPerGb: number;
  /** 'preset': a preset's typical list price as picked; 'custom': a price typed in (a contract rate) */
  source?: 'preset' | 'custom';
  presetLabel?: string;
  /** counterfactual 'other': this destination's data is credited at another destination's price */
  creditedAt?: { label: string; milliCentsPerGb: number; unpriced?: true; whpM?: number };
  /** counterfactual 'none': its data never counts as savings */
  noSavings?: true;
}

export interface WeeklyReceipt {
  periodStart: ISO;
  periodEnd: ISO;
  label: string; // "Sep 21–27, 2026"
  lines: { label: string; savedM: number; diverted?: true }[]; // top savers, ≤ 5; P1-F02: `diverted` lines are diversion credits
  savedM: number;
  whpM: number;
  paidM: number;
  ratio: number;
  /** P1-F02: of savedM, what was a diversion credit (the rest was bytes dropped); absent when none */
  divertedM?: number;
  priorSavedM?: number;
  trendPct?: number;
  openIncidents: { title: string }[];
  /** P0-23: the prices, credits, exclusions and coverage behind the figures (absent in older receipts) */
  basis?: ReceiptBasis;
  /** P0-23: the Receipt showing this week as a custom range (absent without a link base, and in older receipts) */
  link?: string;
  /** an automatic send more than a day after its Monday 12:00 UTC (the first metering since): the receipt says so */
  sentLate?: true;
}

// ─── Tour / replay / story (SPEC 15) ─────────────────────────────────────────
export type TourAction = 'snapshot' | 'incident.open' | 'incident.close' | 'delivery' | 'caption' | 'commit';
export interface TourStep { at: number; action: TourAction; payload: unknown }
export interface TourDoc {
  schemaVersion: 1;
  generatedAt: ISO;
  source: 'tour' | 'replay';
  settings: Settings;
  prices: PricesDoc;
  snapshot: Snapshot;
  incidents: Incident[];
  timeline: Commit[];
  notifyLog: DeliveryLog[];
  script: TourStep[];
  /** Slack Block Kit message the tour renders on its 'slack' beat */
  slackMessage?: unknown;
  weeklyReceipt?: WeeklyReceipt;
}
export type StoryView = 'title' | 'receipt' | 'presenter' | 'flow' | 'ledger' | 'slack' | 'receipt-weekly' | 'summary' | 'ask' | 'how';
export interface StoryCallout { target: string; label: string; at?: number }
export interface StoryBeat {
  id: string;
  seconds: number;
  caption: string | string[];
  view: StoryView;
  actions: TourStep[];
  callouts: StoryCallout[];
}
export interface StoryDoc { schemaVersion: 1; source: 'tour' | 'replay'; loop: true; beats: StoryBeat[] }

// ─── I/O abstractions (implemented by backend runtime, UI and tests) ─────────
export interface HttpResult { status: number; ok: boolean; json?: unknown; text?: string; headers?: Record<string, string> }
/** Every Leader API call (KV included) goes through this so a sweep can count and cap itself. */
export interface CriblHttp {
  request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, opts?: { timeoutMs?: number; raw?: boolean }): Promise<HttpResult>;
}
/** App-scoped KV. `get` returns null on 404. Values are strings (JSON). */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
/** External webhook POST through the platform proxy. */
export interface WebhookSender {
  post(url: string, body: string, timeoutMs: number): Promise<{ status: number; error?: string }>;
  /** False for a URL this sender refuses to post to (the runner's optional MR_WEBHOOK_HOSTS list). */
  allows?(url: string): boolean;
}
export interface Clock { now(): number }
export interface Logger { info(msg: string, data?: unknown): void; warn(msg: string, data?: unknown): void; error(msg: string, data?: unknown): void }
