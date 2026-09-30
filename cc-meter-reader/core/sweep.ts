// core/sweep.ts — one metering pass: the whole meter (SPEC 7, adapted by DECISIONS D3, D11, D12b, D13, D17).
//
// runSweep() runs in two places from this one module: the open App tab every 30 s as the member (runtime
// 'ui', the primary release) and the scheduled `meter` backend endpoint (runtime 'backend'). Steps:
//
//   0. Every mode but Sweep now: one `meta` read; if the last settled minute is already metered, stop ('current').
//      A runner or backend that finds a tab metered it checks in (one meta write, deliveryOwner) so the tab keeps
//      leaving alerts to it, and sweeps in full only when that tab left alerts to deliver (P1-E05). A minute is
//      metered only once it ended SETTLE_MS (20 s) ago, in every runtime: the Leader answers a just-ended minute
//      with no rows for its first seconds (REVIEW-3a #1).
//   1. lock/meter (130 s, re-entrant per owner). Held → { skipped: 'locked' }. A slow sweep renews it before
//      steps 8 and 10; if another runtime took it meanwhile the writes are abandoned ('lock_lost', P1-E02).
//      When the KV store refused the last sweep's writes (a full store; meta.kvWriteFailingSince), the key expiry
//      pass runs now, before the writes it would follow can fail again: once per failing streak, then hourly (P1-E03).
//   2. Reads: settings, prices, inventory, baselines, timeline, demo/state (demo build), totals, the
//      previous snapshot, and the incident docs of days that still hold open incidents. Without a prices
//      document nothing is metered (REVIEW-3a #3): the inventory is refreshed and meta written, and the
//      first sweep after prices are saved meters the seed hour at the first price (DECISIONS D25).
//   3. Range: every whole minute since meta.meteredThrough (first run: up to a whole day back, as much as the
//      estate's size allows in one sweep — firstRunSeedMs — or collectingSince when it says further), reaching back
//      at most 46 h — what the Leader keeps, less a margin; anything older is recorded in meta.gaps (never on a first
//      run: nothing was due before it) — and at most 24 h of it per sweep (the next sweep continues), plus a rewrite
//      of the minute before (late data, SPEC 7 step 2). EPIC_AUDIT P1-E04. Minutes before the first price was saved
//      are seeded history: priced at the first price (D25) and learned from, never alerted on.
//   4. Timeline refresh every 5 min / Sweep now (optional work planned under the call budget). Worker groups
//      are listed at least hourly; a listed group the inventory lacks, or one with a newer commit, is read
//      regardless of the plan (EPIC_AUDIT P0-02); the periodic 10-minute refresh reads the least recently read
//      groups the plan fits.
//   5. One set of three metrics queries over the whole range (inputs, outputs, routes), per minute. Empty
//      minutes right after a minute with traffic are held back for up to 3 minutes (not metered, the cursor
//      not advanced): the Leader may not have them yet.
//   6. Per minute, oldest first: attribution → pricing (the price version in force that minute) → the
//      minute rows (one doc per UTC hour) → running totals corrected for replaced rows → detection
//      (catch-up minutes flag what they open; coarse minutes are metered but not judged).
//   7. Before accepting a regression with no matching commit: one timeline refresh, then rematch.
//   8. Durable writes, only while the sweep is inside its 100 s time budget: minute docs, hour/day folds,
//      totals (carrying their own cursor, REVIEW-3a #5), baselines, inventory, timeline, incident docs.
//   9. Notifications (endpoint filters, cooldown, a 2-minute wait after a failed attempt, retries) →
//      incident.deliveries and notify/log (≤ 200). A tab defers them to a runner or backend that swept in the
//      last 90 s: those deliver webhooks, the tab on a Standard plan cannot (REVIEW-3a #2).
//  10. Incident docs again (deliveries), notify log, hourly key expiry, snapshot (compacted to ≤ 90 KB), meta.
//      Then the lock is released (expired in place).
//
// Every Leader call — KV included — goes through one metered transport: counted, capped when the caller
// sets a hard budget, and on HTTP 429 retried once after the Leader's Retry-After (at most 60 s; 5 s when it sends
// none); a second 429 stops the sweep ('rate_limited'). A stopped sweep waits for the Leader's window to reopen
// before it records the failure and releases the lock, and the sweeps the limit stopped back off: the next
// 2, 4, 8, then 16 minutes are skipped with no call at all (EPIC_AUDIT P1-E01).
// Money is integer millicents; the sweep never writes Cribl configuration.

import type {
  Attribution,
  BaselinesDoc,
  Build,
  ByteEvent,
  Clock,
  Commit,
  CriblHttp,
  DeliveryLog,
  Flow,
  FlowKey,
  Incident,
  InventoryDoc,
  KvStore,
  Logger,
  Meta,
  MeteringGap,
  MetricsWindow,
  MinuteRow,
  NotificationEndpoint,
  NotifyEvent,
  ObjectKey,
  OutputInfo,
  PricesDoc,
  RollDayDoc,
  RollHourDoc,
  RollMinuteDoc,
  Settings,
  Severity,
  Snapshot,
  TimelineDoc,
  TotalsDoc,
  WebhookSender,
} from './types.ts';
import type { Codec } from './codec.ts';
import { BudgetExceeded, RATE_LIMIT_RETRY_MS, RETRY_AFTER_MAX_MS, RateLimited, defaultSleep, retryAfterOf, retryWaitMs, type HttpMethod } from './http.ts';
import { KEYS, KvHttpError, createKvDocs, type KvDocs } from './kv.ts';
import { defaultSettings, mergeSettings } from './settings.ts';
import { effectivePrices, emptyPrices, meteredMinutesInMonth, priceMinute, type EffectivePrices } from './pricing.ts';
import { attributeWindow, buildFlows, objectKey, parseObjectKey, passthroughPipelines } from './flows.ts';
import { fetchMetrics } from './adapters/metrics.ts';
import { fetchGroupInventory, inventoryHash, workerGroupIds } from './adapters/config.ts';
import { fetchCommits } from './adapters/version.ts';
import { WEBHOOK_TIMEOUT_MS, isTimeoutAttempt, lastAttempt } from './adapters/webhook.ts';
import { channelOf, createDeliveryRouter, deliveryOrder, resolveEndpoints } from './delivery.ts';
import { webhookDescriptor } from './env-webhooks.ts';
import * as urls from './adapters/cribl-urls.ts';
import {
  addMinuteToTotals,
  addOutputMinuteToTotals,
  datedKeyStartMs,
  dayDocKey,
  emptyTotals,
  expiredKeys,
  foldDayRows,
  foldHourRows,
  hourDocKey,
  mergeRowsByFlow,
  minuteDocKey,
  MINUTE_RETENTION_MS,
  minuteRetentionHours,
  outputMonthTotals,
  pruneTotals,
  upsertDayRows,
  upsertHourRows,
  upsertMinuteRows,
} from './rollups.ts';
import {
  DEFAULT_REGRESSION_MIN_CENTS_PER_DAY,
  detect,
  effectiveThresholds,
  emptyBaselines,
  rematchIncidents,
  shouldEvaluateBudget,
  type BudgetPoint,
  type CostPoint,
  type RatioPoint,
} from './detector.ts';
import { allCommits, commitTimeMs, mergeCommits } from './timeline.ts';
import { MAX_INCIDENT_DELIVERIES, incidentsDocKey, isFinalFailure, mergeIncidentUpdates, nextEndpointRecord, recordDeliveryRef, shouldNotify } from './incidents.ts';
import { CATCH_UP_NOTE, canonicalPayload } from './payloads.ts';
import { buildSnapshot, compactSnapshot, snapshotBytes } from './snapshot.ts';
import { hourBuckets, minuteBuckets, resolveMeterZone, rezonePlan, rezoneStraddleHours, rezoneTotals, type MoneyBucket } from './rezone.ts';
import { humanize } from './humanize.ts';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  canonicalZoneName,
  fromIso,
  hourFloor,
  isValidTimeZone,
  localDayKey,
  localMonthKey,
  minuteFloor,
  toIso,
  utcDayKey,
  utcHourKey,
} from './time.ts';

// ─── Constants ───────────────────────────────────────────────────────────────
/** Planning target for one steady-state sweep, KV included (SPEC 7: the backend default is 50/min). */
export const DEFAULT_SWEEP_BUDGET = 35;
/**
 * lock/meter lifetime (SPEC 7 step 1): the 100 s time budget plus 30 s, so a sweep that is still inside its budget
 * never loses the lock to a tab's tick (EPIC_AUDIT P1-E02: at ~4.5 s a call the old 90 s lock expired at 95 s,
 * while the writes were still running). A slow sweep also renews it before its writes (LOCK_RENEW_BELOW_MS).
 */
export const LOCK_TTL_MS = 130_000;
/**
 * Before the durable writes (step 8) and again before step 10, a sweep renews its lock when less than this much of
 * it is left, so each stage of writes starts with at least this long. A normal sweep (~1 s) never renews; one at
 * ~4.5 s a call renews once, after step 10's time check (EPIC_AUDIT P1-E02).
 */
export const LOCK_RENEW_BELOW_MS = 45_000;
/** Clock skew allowed between runtimes: the release expires the lock with one PUT only this far inside its life. */
const LOCK_SKEW_MS = 5_000;
/** Past this, writes are abandoned except meta.sweepErrors++ (DECISIONS D3: the endpoint cap is 120 s). */
export const SWEEP_TIME_BUDGET_MS = 100_000;
/** Notifications stop being sent past this point in a sweep, leaving room for the writes before the 100 s abort. */
export const NOTIFY_TIME_BUDGET_MS = 45_000;
/**
 * Backfill never reaches further back than this (DECISIONS D11): 46 h, two hours inside the ~2 days the Leader's
 * metrics store keeps (PLATFORM_NOTES N1). Anything older when metering resumes is recorded in meta.gaps (P1-E04).
 */
export const MAX_BACKFILL_MS = 46 * HOUR_MS;
/**
 * One sweep meters at most this much of a catch-up; the rest continues on the next sweep (P1-E04). It keeps the worst
 * sweep where the 24 h backfill always was (~76 calls), inside the time budget and a rate limit's window.
 */
export const MAX_SWEEP_SPAN_MS = 24 * HOUR_MS;
/** Gaps meta keeps (the newest). */
export const MAX_METERING_GAPS = 20;
/** The first run's shortest reach back (and the unpriced sweeps' collectingSince seed): one hour. */
export const FIRST_RUN_SEED_MS = 60 * MINUTE_MS;
/** … and its longest: one sweep's span, a whole day, so the first priced sweep completes the seed by itself. */
export const FIRST_RUN_SEED_MAX_MS = MAX_SWEEP_SPAN_MS;
/**
 * The flow-minutes a first run may meter: what the proven first sweep meters at scale (60 minutes × 2,000 flows under
 * 20 s, tests/integration/perf.test.ts). A smaller estate reaches further back for the same work.
 */
export const FIRST_RUN_FLOW_MINUTES = 120_000;

/**
 * How far the first priced sweep reaches back (rules round, usefulness): a fresh install's first Receipt used to rest
 * on one hour of traffic, annualized. It now rests on up to a whole day — as much as FIRST_RUN_FLOW_MINUTES buys for
 * this many flows, never under an hour — priced at the first price (D25). Seeded minutes open no incident
 * (DetectInput.learnOnly). Unknown flows (no inventory yet): the hour.
 */
export function firstRunSeedMs(flowCount: number, maxMs: number = FIRST_RUN_SEED_MAX_MS): number {
  if (!(flowCount > 0)) return FIRST_RUN_SEED_MS;
  const minutes = Math.floor(FIRST_RUN_FLOW_MINUTES / flowCount);
  return Math.max(FIRST_RUN_SEED_MS, Math.min(maxMs, FIRST_RUN_SEED_MAX_MS, minutes * MINUTE_MS));
}
/**
 * A minute is metered only once it ended at least this long ago (REVIEW-3a #1): the Leader's metrics store
 * answers a just-ended minute with NO rows for the first ~6–7 s (measured live), so a sweep in that gap
 * would record the minute as zero traffic and never judge it. Every runtime waits 20 s.
 */
export const SETTLE_MS = 20_000;
/**
 * Trailing empty minutes right after a minute with traffic are held back (not metered, meteredThrough not
 * advanced) while they ended less than this long before the metering window: the Leader may simply not have
 * them yet. After that they are metered as genuinely quiet.
 */
export const HOLD_EMPTY_MAX_MS = 3 * MINUTE_MS;
export const TIMELINE_EVERY_MIN = 5;
export const INVENTORY_EVERY_MIN = 10;
export const MAX_INVENTORY_EVERY_MIN = 60;
export const EXPIRE_EVERY_MS = HOUR_MS;
/**
 * Calls an expiry pass run first — after a sweep failed on a KV write the store refused (P1-E03) — leaves for the rest
 * of a steady-state sweep; its deletes take what the plan has beyond that (a longer backlog continues next sweep).
 */
const EXPIRY_FIRST_RESERVE = 20;
/** A backlog continues before the hour is up only in a sweep with room for at least this many deletes (P1-E08). */
const EXPIRY_MIN_BATCH = 5;
/**
 * Founder-build r1 core-7 (M11, #43): a due expiry pass (the hour is up, or a backlog is left) runs whatever the sweep
 * has spent — at ~500 flows a steady sweep spends 36–76 calls, past the plan's room, and expiry never ran. It is bounded:
 * the listings (2) and this many delete calls, or the largest expired document with its chunks if that is more (one
 * whole document always goes; ~52 calls at the 2,000-flow preset). A backlog continues the same way next sweep.
 */
export const EXPIRY_RESERVE_DELETES = 30;
export const NOTIFY_LOG_CAP = 200;
/** Snapshot JSON target: one plain KV value (DECISIONS D13). */
export const SNAPSHOT_MAX_BYTES = 90_000;
/** Commits read per group on a timeline refresh (SPEC 10). */
export const COMMITS_PER_REFRESH = 50;
/** `version/show` lookups per refresh at most. */
export const MAX_FILE_LOOKUPS = 5;
/** A periodic (or Sweep now) inventory refresh reads at most this many groups, the least recently read first. */
export const MAX_GROUPS_PER_REFRESH = 3;
/** Listed worker groups the inventory lacks are read regardless of the plan, at most this many per sweep (P0-02). */
export const MAX_MISSING_GROUPS_PER_SWEEP = 8;
/** Leader calls one group's config read costs (inputs, outputs, pipelines, routes). */
const GROUP_READ_CALLS = 4;
/** Incidents opened on a backfilled minute carry this note ("caught on catch-up"; core/payloads.ts). */
export { CATCH_UP_NOTE };
/** A failed delivery attempt waits this long before the next one (REVIEW-3a #2). */
export const FAILED_ATTEMPT_COOLDOWN_MS = 2 * MINUTE_MS;
/** A tab leaves delivery to a runner or backend that completed a sweep this recently (REVIEW-3a #2). */
export const DELIVERY_OWNER_FRESH_MS = 90_000;
/** A closure (or one-shot good news) no sweep delivered is picked up by a later sweep for this long. */
export const UNDELIVERED_CLOSURE_MS = 10 * MINUTE_MS;
/** Calls held back for the conditional writes a sweep may need (incident docs before and after delivery, notify log). */
const RESERVE_CALLS = 6;
/** Older incident docs than this many days are not read for open incidents (the snapshot copy stands in). */
const MAX_OPEN_INCIDENT_DAYS = 5;
/** Parallel KV document reads. */
const READ_CONCURRENCY = 6;
/**
 * Minutes skipped after a sweep the Leader's rate limit stopped (EPIC_AUDIT P1-E01): the 1st, 2nd, 3rd, 4th+ stopped
 * sweep of a streak skips the next 2, 4, 8, then 16 minutes (runner and tab alike) — no Leader call at all while this
 * runtime remembers it, one `meta` read otherwise. A sweep whose retry got past its 429 completes and schedules
 * nothing: a lever burst, or a presenter tab sharing the minute, must never delay an alert on stage.
 */
export const RATE_LIMIT_BACKOFF_MIN: readonly number[] = [2, 4, 8, 16];

const PASSTHROUGH_PIPELINES = new Set(['-', '', 'passthrough', 'mrd_passthrough']);

// ─── Public types ────────────────────────────────────────────────────────────
export interface SweepDeps {
  http: CriblHttp;
  kv: KvStore;
  webhook: WebhookSender;
  clock: Clock;
  codec: Codec;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  /** lock/meter owner: this tab's id (ui) or the invocation id (backend). */
  owner: string;
  appVersion: string;
  build: Build;
  runtime: 'backend' | 'ui';
  /** Workspace name or id for notification payloads. */
  workspace: string;
  /** App base URL for Ledger deep links in payloads. */
  linkBase: string;
  /**
   * Hard cap on Leader calls (KV included): a call past it stops the sweep with skipped 'budget'. Optional
   * work is planned under it. Omitted: optional work is planned under DEFAULT_SWEEP_BUDGET, with no hard stop
   * (a 24-hour backfill legitimately needs more calls than a steady-state minute).
   */
  budget?: number;
  /** Minutes between periodic timeline refreshes (default 5; 0 disables the periodic refresh). */
  timelineEveryMin?: number;
  /** Minutes between inventory refreshes (default 10, or meta's rate-limit-doubled interval). */
  inventoryEveryMin?: number;
  /**
   * The longest a first priced sweep reaches back (default FIRST_RUN_SEED_MAX_MS, a day; never under
   * FIRST_RUN_SEED_MS). A runtime behind a tight Leader rate limit can lower it: the day's reach costs one catch-up
   * sweep's calls (~80). A first run whose previous attempt met the rate limit or a budget reaches back the hour.
   */
  firstRunReachMs?: number;
  /**
   * Direct webhooks this runtime sends to, from its own environment (the runner's .env; DECISIONS D57,
   * core/env-webhooks.ts): App KV never holds a webhook URL. Delivered after the stored Cribl channels; their
   * descriptors (no URL) go to meta.deliveryWebhooks so the App can name them.
   */
  envWebhooks?: readonly NotificationEndpoint[];
  /**
   * Founder-build r1 core-2 (FINDINGS_R1 B1, contract C1'): the zone a workspace with no settings document is metered
   * in — the tab passes the browser's zone. Omitted: 'UTC' (the runner, the Enterprise backend and every existing
   * test keep what they did). A stored `settings.displayTimezone` always wins; r2 core-4 (C1''): after it, the zone the
   * totals were kept in (`totals.zone`), so a runtime's own default applies only to a workspace that has none.
   */
  defaultTimeZone?: string;
}

export interface SweepOptions {
  mode: 'scheduled' | 'manual' | 'ui';
  nowMs?: number;
}

export interface SweepResult {
  /** 'current': the last completed minute was already metered (the cheap check; a runner's result carries meta). */
  /** 'no_prices': no prices document yet, so nothing was metered (the inventory was refreshed, meta written). */
  /**
   * 'backoff': the Leader rate-limited recent sweeps and this one is inside the back-off (P1-E01); it made no call, or
   * one `meta` read. It carries error 'rate_limited', so every surface reads it as rate limited.
   */
  skipped?: 'locked' | 'rate_limited' | 'budget' | 'current' | 'no_prices' | 'backoff';
  /** Leader API calls made, KV included. */
  calls: number;
  ms: number;
  /** New minutes metered (the rewritten late minute is not counted). */
  minutesProcessed: number;
  /** New minutes older than the last completed minute (caught up after a gap). */
  backfilledMinutes: number;
  /** Empty minutes held back after a minute with traffic (the Leader may not have them yet); retried next sweep. */
  heldMinutes?: number;
  /** Minutes this sweep found older than the Leader keeps and recorded in meta.gaps: never metered (P1-E04). */
  unmeteredMinutes?: number;
  /** A catch-up longer than one sweep's span stopped here; the next sweep continues it (P1-E04). */
  catchUpRemainingMinutes?: number;
  opened: number;
  closed: number;
  /** Notifications delivered (2xx), one per incident × endpoint. */
  notified: number;
  snapshotBytes: number;
  error?: string;
  /** What the sweep just wrote, so the UI can skip its next poll. */
  snapshot?: Snapshot;
  meta?: Meta;
  /** Founder-build r1 core-13 (M7): this sweep's delivery attempts (the runner's heartbeat keeps a fail-streak per endpoint). */
  attempts?: DeliveryLog[];
  /**
   * Founder-build r2 core-3: the enabled endpoints this sweep delivers to (absent when it deferred to another runtime or
   * stopped before delivery); the runner's heartbeat drops the fail-streak of an endpoint no longer among them.
   */
  deliveryEndpoints?: string[];
  /** R2 core-3: the reminder cadence those endpoints are re-tried at (thresholds.cooldownMinutes), for the heartbeat's age-out. */
  deliveryReminderMinutes?: number;
  /**
   * Set while the Leader is rate-limiting this meter (P1-E01): since when (the first limited sweep of the streak),
   * until when sweeps are skipped (absent when this sweep scheduled no back-off), and how many sweeps in a row met
   * the limit. Settings → Runtime and the diagnostics panel say "Rate limited since HH:MM" from it.
   */
  rateLimit?: RateLimitStatus;
}

export interface RateLimitStatus {
  since: string;
  until?: string;
  streak: number;
}

// ─── Metered transport (shared by the sweep, the weekly receipt and the levers) ──────────────
export interface MeteredTransport {
  http: CriblHttp;
  kv: KvStore;
  /** The same KV, counted but outside the cap and the 429 policy: cleanup writes after a stop. */
  rawKv: KvStore;
  calls(): number;
  /** 429s answered with the one allowed retry. */
  retries(): number;
  /** 429s seen, the retried one included (P1-E01: a sweep that saw any met the Leader's limit). */
  limitHits(): number;
}

export interface MeteredTransportOptions {
  clock: Clock;
  sleep?: (ms: number) => Promise<void>;
  /** A call past this many throws BudgetExceeded before it is made. */
  hardCap?: number;
  retryDelayMs?: number;
}

function statusOf(e: unknown): number | undefined {
  const s = e !== null && typeof e === 'object' ? (e as { status?: unknown }).status : undefined;
  return typeof s === 'number' ? s : undefined;
}

/**
 * Wraps a CriblHttp and a KvStore in ONE call counter and ONE 429 policy (SPEC 7 step 13): the first 429
 * waits `retryDelayMs` (5 s) and retries that call once; any further 429 throws RateLimited. KV 429s are
 * recognized by the `status` of the error the store throws.
 */
export function createMeteredTransport(http: CriblHttp, kv: KvStore, opts: MeteredTransportOptions): MeteredTransport {
  const sleep = opts.sleep ?? defaultSleep;
  const delay = opts.retryDelayMs ?? RATE_LIMIT_RETRY_MS;
  let calls = 0;
  let hits = 0;
  let retries = 0;

  const take = (method: HttpMethod, path: string): void => {
    if (opts.hardCap !== undefined && calls + 1 > opts.hardCap) throw new BudgetExceeded(opts.hardCap, calls, method, path);
    calls++;
  };

  async function metered<T>(method: HttpMethod, path: string, attempt: () => Promise<T>, limited: (value: T) => boolean): Promise<T> {
    for (;;) {
      take(method, path);
      let value: T | undefined;
      let answer: unknown;
      let was429: boolean;
      try {
        value = await attempt();
        was429 = limited(value);
        answer = value;
      } catch (e) {
        if (statusOf(e) !== 429) throw e;
        was429 = true;
        answer = e;
      }
      if (!was429) return value as T;
      hits++;
      // The Leader's Retry-After, when it sent one: retrying sooner only earns another 429 (P1-E01).
      const after = retryAfterOf(answer, opts.clock.now());
      if (hits > 1) throw new RateLimited(method, path, after);
      const wait = retryWaitMs(after, delay);
      if (wait === undefined) throw new RateLimited(method, path, after);
      retries++;
      await sleep(wait);
    }
  }

  const never = (): boolean => false;
  const kvPath = (key: string): string => `/kvstore/${key}`;
  return {
    http: {
      request: (method, path, body, reqOpts) =>
        metered(
          method,
          path,
          () => http.request(method, path, body, reqOpts),
          (r) => r.status === 429,
        ),
    },
    kv: {
      get: (key) => metered('GET', kvPath(key), () => kv.get(key), never),
      put: (key, value) => metered('PUT', kvPath(key), () => kv.put(key, value), never),
      del: (key) => metered('DELETE', kvPath(key), () => kv.del(key), never),
      list: (prefix) => metered('POST', '/kvstore/keys', () => kv.list(prefix), never),
    },
    rawKv: {
      get: (key) => (calls++, kv.get(key)),
      put: (key, value) => (calls++, kv.put(key, value)),
      del: (key) => (calls++, kv.del(key)),
      list: (prefix) => (calls++, kv.list(prefix)),
    },
    calls: () => calls,
    retries: () => retries,
    limitHits: () => hits,
  };
}

// ─── Rate-limit back-off (P1-E01) ────────────────────────────────────────────
/** What one runtime remembers between its sweeps about the Leader's rate limit (process memory, beside meta). */
export interface RateLimitMemory {
  streak: number;
  since?: number;
  until?: number;
}

/**
 * Keyed by the runtime's KV store object — stable for a tab (src/state/runtime.ts builds it once) and for the runner
 * (it keeps one set of transports) — so the back-off holds even when the Leader refuses the very write that would
 * record it in meta, and never leaks between two runtimes (or two test worlds) in one process.
 */
const rateMemory = new WeakMap<object, RateLimitMemory>();

export function rateLimitMemoryFor(kv: object): RateLimitMemory {
  let m = rateMemory.get(kv);
  if (!m) rateMemory.set(kv, (m = { streak: 0 }));
  return m;
}

/** Minutes skipped after the `streak`-th limited sweep in a row: 2, 4, 8, then 16. */
export function backoffMinutes(streak: number): number {
  const i = Math.max(1, Math.min(streak, RATE_LIMIT_BACKOFF_MIN.length)) - 1;
  return RATE_LIMIT_BACKOFF_MIN[i];
}

/**
 * The streak after a sweep. A sweep that met no 429 ends it. One that met the limit extends it (so the UI can say
 * "rate limited since"), and schedules a back-off only when the limit stopped it: the next backoffMinutes(streak)
 * minutes are skipped, counted from the minute the sweep started. A sweep that completed after its retry metered its
 * minutes; skipping the next ones would only delay detection.
 */
export function nextRateLimit(
  prev: { streak: number; since?: string },
  limited: boolean,
  stopped: boolean,
  startedMs: number,
): RateLimitStatus | undefined {
  if (!limited) return undefined;
  const streak = prev.streak + 1;
  const since = prev.since ?? toIso(startedMs);
  if (!stopped) return { since, streak };
  return { since, streak, until: toIso(minuteFloor(startedMs) + (backoffMinutes(streak) + 1) * MINUTE_MS) };
}

/** A back-off in force at `nowMs` from this runtime's memory or from meta (another runtime's), else undefined. */
export function backoffInForce(mem: RateLimitMemory, meta: Pick<Meta, 'rateLimitedUntil' | 'rateLimitedSince' | 'consecutiveRateLimited'> | null | undefined, nowMs: number): RateLimitStatus | undefined {
  const metaUntil = meta?.rateLimitedUntil ? fromIso(meta.rateLimitedUntil) : Number.NaN;
  const memUntil = mem.until ?? Number.NaN;
  const until = Math.max(Number.isFinite(metaUntil) ? metaUntil : -Infinity, Number.isFinite(memUntil) ? memUntil : -Infinity);
  if (!(nowMs < until)) return undefined;
  const sinceMs = meta?.rateLimitedSince ? fromIso(meta.rateLimitedSince) : (mem.since ?? nowMs);
  return { since: toIso(Number.isFinite(sinceMs) ? sinceMs : nowMs), until: toIso(until), streak: Math.max(mem.streak, meta?.consecutiveRateLimited ?? 0) };
}

/** Records a sweep's rate-limit outcome in this runtime's memory. */
function remember(mem: RateLimitMemory, status: RateLimitStatus | undefined): void {
  if (!status) {
    mem.streak = 0;
    delete mem.since;
    delete mem.until;
    return;
  }
  mem.streak = status.streak;
  mem.since = fromIso(status.since);
  if (status.until) mem.until = fromIso(status.until);
  else delete mem.until;
}

// ─── Metering gaps (P1-E04) ──────────────────────────────────────────────────
/**
 * meta.gaps with [fromMs, toMs) added: a gap that starts where a recorded one does replaces it (metering stayed stopped
 * while the floor moved on), one that touches or overlaps the newest is merged into it; the newest MAX_METERING_GAPS kept.
 */
export function recordGap(gaps: readonly MeteringGap[] | undefined, fromMs: number, toMs: number, nowIso: string): MeteringGap[] {
  const from = minuteFloor(fromMs);
  const to = minuteFloor(toMs);
  const list = [...(gaps ?? [])];
  if (!(to > from)) return list;
  const last = list.at(-1);
  if (last && fromIso(last.from) <= to && from <= fromIso(last.to)) {
    const f = Math.min(fromIso(last.from), from);
    const t = Math.max(fromIso(last.to), to);
    list[list.length - 1] = { from: toIso(f), to: toIso(t), minutes: Math.round((t - f) / MINUTE_MS), recordedAt: nowIso };
  } else {
    list.push({ from: toIso(from), to: toIso(to), minutes: Math.round((to - from) / MINUTE_MS), recordedAt: nowIso });
  }
  return list.slice(-MAX_METERING_GAPS);
}

/** Minutes of the recorded gaps inside [fromMs, toMs): what a range's figures are missing (the UI's caption). */
export function unmeteredMinutesBetween(gaps: readonly MeteringGap[] | undefined, fromMs: number, toMs: number): number {
  let ms = 0;
  for (const g of gaps ?? []) {
    const a = Math.max(fromIso(g.from), fromMs);
    const b = Math.min(fromIso(g.to), toMs);
    if (b > a) ms += b - a;
  }
  return Math.round(ms / MINUTE_MS);
}

/** How long a stopped sweep waits for the Leader's window before its failure record and lock release (≤ 60 s). */
export function windowWaitMs(retryAfterMs: number | undefined, nowMs: number): number {
  const toNextMinute = minuteFloor(nowMs) + MINUTE_MS - nowMs + 1_000;
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(1_000, retryAfterMs ?? toNextMinute));
}

// ─── Small helpers ───────────────────────────────────────────────────────────
const NOOP_LOGGER: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Resolved extends SweepDeps {
  sleep: (ms: number) => Promise<void>;
}

/** Fills what a loosely typed caller (the UI binds runSweep dynamically) may have left out. */
function resolveDeps(deps: SweepDeps): Resolved {
  const partial = deps as Partial<SweepDeps> & Pick<SweepDeps, 'http' | 'kv' | 'webhook' | 'clock' | 'codec'>;
  return {
    ...deps,
    logger: partial.logger ?? NOOP_LOGGER,
    sleep: partial.sleep ?? defaultSleep,
    owner: partial.owner || `sweep:${partial.runtime ?? 'ui'}`,
    appVersion: partial.appVersion ?? '0.0.0',
    build: partial.build ?? 'release',
    runtime: partial.runtime ?? 'ui',
    workspace: partial.workspace ?? '',
    linkBase: partial.linkBase ?? '',
  };
}

/** 'YYYY-MM-DDTHH:MM' of the UTC minute (meta.callsThisMinute, demo/state.leverCalls). */
export function minuteKey(ms: number): string {
  return toIso(minuteFloor(ms)).slice(0, 16);
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

type Money = { whpM: number; paidM: number; savedM: number };
const zeroMoney = (): Money => ({ whpM: 0, paidM: 0, savedM: 0 });
const addMoney = (acc: Money, r: Money): void => {
  acc.whpM += r.whpM;
  acc.paidM += r.paidM;
  acc.savedM += r.savedM;
};

/** A minute's money in one minute doc, workspace-wide and per `${groupId}:${outputId}`. */
function moneyAt(doc: RollMinuteDoc | undefined, t: string): { any: boolean; total: Money; byOutput: Map<string, Money> } {
  const total = zeroMoney();
  const byOutput = new Map<string, Money>();
  let any = false;
  for (const [key, rows] of Object.entries(doc?.flows ?? {})) {
    const row = rows.find((r) => r.t === t);
    if (!row) continue;
    any = true;
    addMoney(total, row);
    const parts = key.split('|');
    const outKey = `${parts[0]}:${parts[4]}`;
    const acc = byOutput.get(outKey) ?? zeroMoney();
    addMoney(acc, row);
    byOutput.set(outKey, acc);
  }
  return { any, total, byOutput };
}

/**
 * The minute doc with minute `t` replaced by `rows`: rows other flows kept for `t` are dropped, so a rewrite
 * after the flow set changed (a pack moved a route to another pipeline) never counts the minute twice.
 */
function replaceMinute(doc: RollMinuteDoc | undefined, hourIso: string, t: string, rows: Record<FlowKey, MinuteRow>): RollMinuteDoc {
  const flows: Record<FlowKey, MinuteRow[]> = {};
  for (const [key, list] of Object.entries(doc?.flows ?? {})) {
    const kept = rows[key] ? list : list.filter((r) => r.t !== t);
    if (kept.length > 0) flows[key] = kept;
  }
  return upsertMinuteRows({ schemaVersion: 1, bucketStart: doc?.bucketStart ?? hourIso, flows }, hourIso, rows);
}

/** How a route is named on an incident: what its pipeline does, unless it is a passthrough. */
function routeLabel(flow: Flow, inventory: InventoryDoc | null, labels: Record<string, string>): string {
  if (!PASSTHROUGH_PIPELINES.has(flow.pipelineId)) return humanize(flow.pipelineId, labels);
  const route = inventory?.byGroup?.[flow.groupId]?.routes?.find((r) => r.id === flow.routeId);
  return humanize(route?.name && !labels[flow.routeId] ? route.name : flow.routeId, labels);
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Any input or output counted bytes or events in this minute. */
export function windowHasTraffic(w: Pick<MetricsWindow, 'inputs' | 'outputs'>): boolean {
  const any = (m: Record<string, ByteEvent> | undefined): boolean => Object.values(m ?? {}).some((v) => v.bytes > 0 || v.events > 0);
  return any(w.inputs) || any(w.outputs);
}

/**
 * Where metering stops this sweep (REVIEW-3a #1). A run of empty minutes at the end of the range, right after
 * a minute with traffic, is held back — neither metered nor passed by the cursor — while its first minute
 * ended less than HOLD_EMPTY_MAX_MS before `windowEnd`: the Leader may not have it yet. Past that it is
 * metered as genuinely quiet. A hold never reaches before `newStart` (it only trims new minutes).
 * `hadTraffic(i)` reports minute i of `windows` (sorted ascending) — the window itself, or its stored rows.
 */
export function holdBackEnd(windows: readonly { windowStart: string }[], hadTraffic: (i: number) => boolean, newStart: number, windowEnd: number): number {
  let last = -1;
  for (let i = windows.length - 1; i >= 0; i--) {
    if (hadTraffic(i)) {
      last = i;
      break;
    }
  }
  if (last < 0 || last === windows.length - 1) return windowEnd;
  const heldStart = Math.max(fromIso(windows[last + 1].windowStart), newStart);
  if (!(heldStart < windowEnd)) return windowEnd;
  return windowEnd - (heldStart + MINUTE_MS) < HOLD_EMPTY_MAX_MS ? heldStart : windowEnd;
}

/** A lock owner that runs outside the tab: the runner (`runner:…`) or the App backend (`backend:…`). */
function isScheduledOwner(o: string | undefined): boolean {
  return !!o && (o.startsWith('runner:') || o.startsWith('backend:') || o === 'sweep:backend');
}

/**
 * A runner or backend other than `owner` swept, or checked in (meta.deliveryOwner, P1-E05), less than
 * DELIVERY_OWNER_FRESH_MS ago: a tab leaves notifications to it (it can post webhooks; a tab on a plan without
 * App proxies cannot).
 */
export function deliveryOwnedElsewhere(
  meta: Pick<Meta, 'lastSweepOwner' | 'lastSweepAt' | 'deliveryOwner' | 'deliveryOwnerAt'> | null | undefined,
  owner: string,
  nowMs: number,
): boolean {
  const fresh = (o: string | undefined, atIso: string | undefined): boolean => {
    if (!o || o === owner || !isScheduledOwner(o)) return false;
    const at = atIso ? fromIso(atIso) : Number.NaN;
    return nowMs - at < DELIVERY_OWNER_FRESH_MS;
  };
  return fresh(meta?.lastSweepOwner, meta?.lastSweepAt) || fresh(meta?.deliveryOwner, meta?.deliveryOwnerAt);
}

/** The last delivery attempt failed less than FAILED_ATTEMPT_COOLDOWN_MS ago. */
export function inFailedAttemptCooldown(i: Pick<Incident, 'lastAttemptAt' | 'lastNotifiedAt'>, nowMs: number): boolean {
  const at = i.lastAttemptAt ? fromIso(i.lastAttemptAt) : Number.NaN;
  if (!Number.isFinite(at)) return false;
  const ok = i.lastNotifiedAt ? fromIso(i.lastNotifiedAt) : Number.NaN;
  return !(ok >= at) && nowMs - at < FAILED_ATTEMPT_COOLDOWN_MS;
}

/**
 * A closed incident whose closure no sweep delivered (a tab that deferred to the runner, a failed send), closed
 * less than UNDELIVERED_CLOSURE_MS ago: a recovery of an incident someone was told about, or one-shot good news.
 *
 * Founder-build r2 core-2 (FINDINGS_R2 #5): per endpoint when the incident keeps per-endpoint records (r1 core-9). The
 * closure stays pending while an endpoint that was told of the opening (good news: any endpoint that tried it) has
 * not delivered since the close and either has not been tried since (a deferring tab) or failed retryably; a final
 * failure (a 4xx) is not retried. The bell's 2xx no longer hides a webhook's failed closure. `endpointIds`, when
 * given, limits it to the endpoints still delivering (a removed or disabled one never holds a closure open).
 */
export function undeliveredClosure(i: Incident, nowMs: number, endpointIds?: ReadonlySet<string>): boolean {
  const closed = i.closedAt ? fromIso(i.closedAt) : Number.NaN;
  if (!Number.isFinite(closed) || !(nowMs - closed < UNDELIVERED_CLOSURE_MS)) return false;
  const records = Object.entries(i.notified ?? {});
  if (records.length > 0) {
    return records.some(([id, own]) => {
      if (endpointIds && !endpointIds.has(id)) return false;
      const okAt = own.ok ? fromIso(own.ok) : Number.NaN;
      if (okAt >= closed) return false; // delivered since the close
      if (i.type !== 'goodnews' && !Number.isFinite(okAt)) return false; // never told of the opening
      if (!(fromIso(own.at) >= closed)) return true; // not tried since the close
      return !(own.status >= 200 && own.status < 300) && !isFinalFailure(own);
    });
  }
  const told = i.lastNotifiedAt ? fromIso(i.lastNotifiedAt) : Number.NaN;
  if (told >= closed) return false;
  return Number.isFinite(told) || i.type === 'goodnews';
}

/**
 * Planning: may `cost` more calls run, given `stillNeeded` calls the sweep must still make? Optional work
 * plans under the target (the hard budget, else DEFAULT_SWEEP_BUDGET). Forced work — Sweep now, a missing or
 * stale-by-commit inventory, the refresh before an unmatched regression — is bounded only by the hard budget.
 */
function roomFor(t: MeteredTransport, limit: number, cost: number, stillNeeded: number): number {
  return limit - t.calls() - cost - stillNeeded;
}

// ─── The sweep ───────────────────────────────────────────────────────────────
interface IncidentChange {
  incident: Incident;
  event: NotifyEvent;
  prevSeverity?: Severity;
}

/**
 * One metering pass. Never throws: failures come back as `error` (and `meta.sweepErrors++`), rate limits and
 * budget stops as `skipped`. The lock is always released.
 */
export async function runSweep(deps: SweepDeps, opts: SweepOptions): Promise<SweepResult> {
  const d = resolveDeps(deps);
  const startedAt = d.clock.now();
  const nowMs = opts.nowMs ?? startedAt;
  const t = createMeteredTransport(d.http, d.kv, {
    clock: d.clock,
    sleep: d.sleep,
    hardCap: deps.budget,
  });
  const docs = createKvDocs({
    kv: t.kv,
    codec: d.codec,
    clock: d.clock,
    logger: d.logger,
  });
  const rawDocs = createKvDocs({
    kv: t.rawKv,
    codec: d.codec,
    clock: d.clock,
    logger: d.logger,
  });
  const base: SweepResult = {
    calls: 0,
    ms: 0,
    minutesProcessed: 0,
    backfilledMinutes: 0,
    opened: 0,
    closed: 0,
    notified: 0,
    snapshotBytes: 0,
  };
  const done = (r: Partial<SweepResult>): SweepResult => ({
    ...base,
    ...r,
    calls: t.calls(),
    ms: d.clock.now() - startedAt,
  });
  // Only minutes that ended at least SETTLE_MS ago (REVIEW-3a #1).
  const windowEnd = minuteFloor(nowMs - SETTLE_MS);

  // 0. The cheap check (every mode but Sweep now): nothing to do until a new minute completes (P1-E05).
  let meta: Meta | null = null;
  let metaRead = false;
  let locked = false;
  // When this sweep last wrote lock/meter (taken before the write, so the lock lives at least LOCK_TTL_MS past it).
  const lock: LockHold = { at: startedAt };
  // What the sweep did that meta keeps even when it then fails (the expiry pass, P1-E03).
  const progress: SweepProgress = {};
  // P1-E01: what this runtime remembers of the Leader's rate limit, beside meta (which the limit may keep it from writing).
  const mem = rateLimitMemoryFor(d.kv);
  const prevRate = (): { streak: number; since?: string } => {
    const since = meta?.rateLimitedSince ?? (mem.since !== undefined ? toIso(mem.since) : undefined);
    return { streak: Math.max(mem.streak, meta?.consecutiveRateLimited ?? 0), ...(since ? { since } : {}) };
  };
  const backingOff = (status: RateLimitStatus, withMeta: Meta | null): SweepResult => {
    d.logger.info(`sweep: rate limited by the Leader since ${status.since}; backing off until ${status.until}`);
    return done({ skipped: 'backoff', error: 'rate_limited', rateLimit: status, ...(withMeta ? { meta: withMeta } : {}) });
  };
  try {
    if (opts.mode !== 'manual') {
      // 0a. Inside a back-off this runtime scheduled: no Leader call at all (P1-E01). Sweep now always tries.
      const remembered = backoffInForce(mem, null, nowMs);
      if (remembered) return backingOff(remembered, null);
      meta = await docs.getMeta();
      metaRead = true;
      // Another runtime's sweep that met no limit ended the streak; a back-off it (or this runtime) wrote holds.
      if (meta && !(meta.consecutiveRateLimited > 0) && !meta.rateLimitedUntil) remember(mem, undefined);
      const recorded = backoffInForce(mem, meta, nowMs);
      if (recorded) return backingOff(recorded, meta);
      const through = meta?.meteredThrough ? fromIso(meta.meteredThrough) : Number.NaN;
      if (through >= windowEnd) {
        if (d.runtime === 'ui') return done({ skipped: 'current' });
        const current = await scheduledCheckIn(d, docs, meta as Meta, nowMs);
        if (current) return done(current);
      }
    }
    // 1. Lock.
    lock.at = d.clock.now();
    locked = await docs.acquireLock(d.owner, LOCK_TTL_MS);
    if (!locked) return done({ skipped: 'locked' });
  } catch (e) {
    if (e instanceof RateLimited) {
      // Stopped before the lock: nothing to record or release; the back-off lives in this runtime's memory.
      const rate = nextRateLimit(prevRate(), true, true, nowMs);
      remember(mem, rate);
      return done({ skipped: 'rate_limited', error: 'rate_limited', ...(rate ? { rateLimit: rate } : {}) });
    }
    if (e instanceof BudgetExceeded) return done({ skipped: 'budget', error: 'budget' });
    d.logger.error('sweep: could not start', e);
    return done({ error: describeError(e) });
  }

  let outcome: Partial<SweepResult>;
  try {
    if (!metaRead) {
      meta = await docs.getMeta();
      metaRead = true;
    }
    outcome = await sweepLocked({
      d,
      mode: opts.mode,
      nowMs,
      windowEnd,
      startedAt,
      t,
      docs,
      meta,
      lock,
      progress,
      prevRate: prevRate(),
    });
    remember(mem, progress.rate ?? undefined);
    if (progress.rate) outcome = { ...outcome, rateLimit: progress.rate };
  } catch (e) {
    if (e instanceof LockLost) {
      // Another runtime holds lock/meter now and meters these minutes itself: nothing more is written — no meta
      // (it would race that runtime's), no release (the lock is not ours to expire).
      d.logger.warn(`sweep stopped: ${e.message}`);
      return done({ skipped: 'locked', error: 'lock_lost' });
    }
    const stopped = e instanceof RateLimited || e instanceof BudgetExceeded || e instanceof TimeBudgetExceeded;
    const code =
      e instanceof RateLimited
        ? 'rate_limited'
        : e instanceof BudgetExceeded
          ? 'budget'
          : e instanceof TimeBudgetExceeded
            ? 'time_budget'
            : describeError(e);
    if (stopped) d.logger.warn(`sweep stopped: ${code}`);
    else d.logger.error('sweep failed', e);
    const rateLimited = e instanceof RateLimited;
    if (rateLimited) {
      // P1-E01: the failure record and the lock release would meet the same exhausted window. Wait for it to reopen
      // (the Leader's Retry-After, else the next minute; at most 60 s), so meta says what happened and the lock is free.
      const wait = windowWaitMs(e.retryAfterMs, d.clock.now());
      d.logger.warn(`sweep: waiting ${Math.round(wait / 1000)} s for the Leader's rate-limit window before recording the failure`);
      await d.sleep(wait);
    }
    const limited = rateLimited || t.limitHits() > 0;
    const rate = limited ? nextRateLimit(prevRate(), true, rateLimited, nowMs) : undefined;
    if (limited) remember(mem, rate);
    const timelineAt = await writeFetchedTimeline(rawDocs, progress, toIso(nowMs), d.logger);
    const metaAfter = await recordFailure(rawDocs, meta, metaRead, code, rateLimited, d.logger, {
      kvRefused: isKvWriteRefusal(e),
      progress,
      nowIso: toIso(nowMs),
      app: { appVersion: d.appVersion, build: d.build },
      ...(rate ? { rate } : {}),
      ...(timelineAt ? { timelineRefreshedAt: timelineAt } : {}),
    });
    const skipped = rateLimited ? 'rate_limited' : e instanceof BudgetExceeded ? 'budget' : undefined;
    outcome = {
      ...(skipped ? { skipped } : {}),
      error: code,
      ...(metaAfter ? { meta: metaAfter } : {}),
      ...(rate ? { rateLimit: rate } : {}),
    };
  }
  await releaseLock(rawDocs, d, lock.at);
  return done(outcome);
}

/**
 * A runner or backend found the minute already metered (P1-E05). Returns the 'current' result, or null when the
 * sweep must still run in full: the tab that metered it left alerts to deliver (meta.deliveryDeferredAt).
 *
 * When a tab metered the minute, the runner checks in: one meta write stamping deliveryOwner/deliveryOwnerAt, so
 * the tab's next sweep still leaves delivery to it (DELIVERY_OWNER_FRESH_MS) and the App still sees a live runner.
 * That write is the one meta write made outside the lock. What it can lose is bounded: 'current' means no sweep
 * can be metering now, so the only writers that could land inside its read-to-write gap (a fraction of a second)
 * are a Sweep now finishing (its refresh timestamps; the next sweep refreshes again) and a tab's Monday receipt
 * (lastWeeklySentAt, so a second automatic receipt becomes possible once a week). meteredThrough cannot move back:
 * it already reaches this minute.
 */
async function scheduledCheckIn(d: Resolved, docs: KvDocs, meta: Meta, nowMs: number): Promise<Partial<SweepResult> | null> {
  if (meta.deliveryDeferredAt) {
    d.logger.info('sweep: this minute is metered, but the tab that metered it left alerts to deliver; sweeping in full');
    return null;
  }
  if (isScheduledOwner(meta.lastSweepOwner)) return { skipped: 'current', meta };
  const stamped: Meta = { ...meta, deliveryOwner: d.owner, deliveryOwnerAt: toIso(nowMs) };
  try {
    await docs.putMeta(stamped);
    return { skipped: 'current', meta: stamped };
  } catch (e) {
    if (e instanceof RateLimited) return { skipped: 'rate_limited', error: 'rate_limited' };
    if (e instanceof BudgetExceeded) return { skipped: 'budget', error: 'budget' };
    d.logger.warn('sweep: could not check in (the next sweep tries again)', describeError(e));
    return { skipped: 'current', meta };
  }
}

class TimeBudgetExceeded extends Error {
  constructor(ms: number) {
    super(`sweep exceeded its ${SWEEP_TIME_BUDGET_MS / 1000} s time budget (${Math.round(ms / 1000)} s); writes abandoned`);
    this.name = 'TimeBudgetExceeded';
  }
}

/** lock/meter names another owner when this sweep went to renew it: its writes are abandoned (P1-E02). */
class LockLost extends Error {
  constructor(ms: number, holder: string | undefined) {
    super(`lock/meter was taken${holder ? ` by ${holder}` : ''} ${Math.round(ms / 1000)} s into the sweep; writes abandoned`);
    this.name = 'LockLost';
  }
}

/** When the sweep last wrote lock/meter (read before the write: the lock lives at least LOCK_TTL_MS past it). */
interface LockHold {
  at: number;
}

/** What a sweep did that its meta keeps, on success and on failure alike (P1-E03). */
interface SweepProgress {
  /** An expiry pass finished this sweep (every expired key it listed is gone). */
  lastExpiredAt?: string;
  /** Dated keys left after this sweep's expiry pass. */
  kvDatedKeys?: number;
  /** An expiry pass ran this sweep (finished or not): step 10 does not run another. */
  expiryRan?: boolean;
  /** Expired keys the pass had no room to delete (P1-E08): a later sweep with room continues before the hour is up. */
  expiryBacklog?: number;
  /** Core-7 (M11): the minute documents' retention this sweep's expiry pass used (meta.minuteRetentionHours). */
  minuteRetentionHours?: number;
  /** Core-14 (m18): the range this sweep planned (a failure halves the next catch-up span from it), and whether it was a first run. */
  planned?: { spanMs: number; firstRun: boolean };
  /** Core-14 (m18): the catch-up span cap meta keeps after this sweep (undefined: none, caught up). */
  metricsSpanMs?: number;
  /** The change timeline this sweep fetched and has not written yet (P1-E08: a stopped sweep still writes it). */
  timeline?: { groups: Map<string, Commit[]>; written: boolean };
  /** The rate-limit streak meta records after this sweep (P1-E01); null when it met no limit. */
  rate?: RateLimitStatus | null;
}

/** A KV write the store refused — a full store (507), a value it would not take (413), a 5xx — not a rate limit. */
function isKvWriteRefusal(e: unknown): boolean {
  return e instanceof KvHttpError && e.op === 'PUT' && e.status >= 400 && e.status !== 429;
}

/**
 * One expiry pass over the dated keys (roll/*, incidents/*): two listings, then the keys past retention are deleted
 * while `room()` (calls) lasts. The listings show every chunk key, so a delete needs no pre-read: one call for a plain
 * document, one more per chunk (EPIC_AUDIT P1-E08). Every pass is stamped (progress.lastExpiredAt); what it had no
 * room for is progress.expiryBacklog, which a later sweep with room continues before the hour is up.
 */
async function expireKeys(
  docs: KvDocs,
  nowMs: number,
  room: () => number,
  progress: SweepProgress,
  reserve?: ExpiryReserve,
): Promise<{ listed: number; expired: number; deleted: number }> {
  progress.expiryRan = true;
  const [roll, incidents] = [await docs.listKeysWithChunks('roll/'), await docs.listKeysWithChunks('incidents/')];
  const keys = [...roll.keys, ...incidents.keys];
  const chunks = { ...roll.chunks, ...incidents.chunks };
  // Core-7 (M11): minute documents kept as long as ~400 keys allow on this estate (25 h up to ~16 keys a document).
  const retentionH = minuteRetentionHours(roll.keys, roll.chunks);
  progress.minuteRetentionHours = retentionH;
  // Oldest first, so a bounded pass frees what has been expired longest.
  const expired = expiredKeys(keys, nowMs, { minuteRetentionMs: retentionH * HOUR_MS }).sort((a, b) => datedKeyStartMs(a) - datedKeyStartMs(b) || (a < b ? -1 : 1));
  const cost = (k: string): number => 1 + (chunks[k]?.length ?? 0);
  // A reserved pass (core-7): its own allowance — the reserve, or one whole largest expired document if that is more —
  // under the hard budget when the runtime has one.
  const allowance = reserve ? Math.max(reserve.deletes, ...expired.map(cost)) : Number.POSITIVE_INFINITY;
  let used = 0;
  let deleted = 0;
  for (const k of expired) {
    const listed = chunks[k] ?? [];
    const c = 1 + listed.length;
    if (reserve ? used + c > allowance || (reserve.hardRoom !== undefined && reserve.hardRoom() < c) : room() < c) break;
    await docs.del(k, { listed });
    used += c;
    deleted++;
  }
  progress.kvDatedKeys = keys.length - deleted;
  progress.lastExpiredAt = toIso(nowMs);
  progress.expiryBacklog = expired.length - deleted;
  return { listed: keys.length, expired: expired.length, deleted };
}

/**
 * The expiry pass as optional work: a listing or a delete the store refuses is logged and left for the next pass,
 * never the reason a sweep that metered its minutes fails to write its snapshot and meta. A rate limit or the call
 * budget still stops the sweep.
 */
/** Core-7 (M11): a reserved expiry pass's bound — delete calls beyond the listings, and the hard budget's room if any. */
interface ExpiryReserve {
  deletes: number;
  hardRoom?: () => number;
}

async function expireKeysSafely(
  docs: KvDocs,
  nowMs: number,
  room: () => number,
  progress: SweepProgress,
  logger: Logger,
  reserve?: ExpiryReserve,
): Promise<{ listed: number; expired: number; deleted: number } | undefined> {
  try {
    return await expireKeys(docs, nowMs, room, progress, reserve);
  } catch (e) {
    if (e instanceof RateLimited || e instanceof BudgetExceeded) throw e;
    logger.warn('sweep: the key expiry pass failed; the next pass tries again', describeError(e));
    return undefined;
  }
}

/**
 * Before a stage of writes (P1-E02): renews lock/meter when less than LOCK_RENEW_BELOW_MS of it is left, through the
 * metered transport. The renewal reads the lock first (a runtime whose clock runs ahead may have taken it "expired"),
 * and LockLost abandons this sweep's writes rather than interleaving them with that runtime's.
 */
async function keepLock(a: Pick<LockedArgs, 'd' | 'docs' | 'lock' | 'startedAt'>, stage: string): Promise<void> {
  const before = a.d.clock.now();
  if (a.lock.at + LOCK_TTL_MS - before >= LOCK_RENEW_BELOW_MS) return;
  if (!(await a.docs.renewLock(a.d.owner, LOCK_TTL_MS))) {
    const holder = await a.docs.getLock().catch(() => null);
    throw new LockLost(before - a.startedAt, holder?.owner);
  }
  a.lock.at = before;
  a.d.logger.info(`sweep: renewed lock/meter before ${stage} (${Math.round((before - a.startedAt) / 1000)} s into the sweep)`);
}

/** Expires the lock in place: one PUT while it is certainly still ours, else the checked release. */
async function releaseLock(rawDocs: KvDocs, d: Resolved, lockedAt: number): Promise<void> {
  try {
    const now = d.clock.now();
    if (now - lockedAt < LOCK_TTL_MS - LOCK_SKEW_MS)
      await rawDocs.putDoc(KEYS.lock, {
        owner: d.owner,
        expiresAt: toIso(now),
      });
    else await rawDocs.releaseLock(d.owner);
  } catch (e) {
    d.logger.warn('sweep: lock release failed (it expires on its own)', e);
  }
}

/**
 * A sweep stopped after it fetched the change timeline (a budget, a rate limit, the time budget): the commits it paid
 * for are merged into the stored timeline anyway, so the next sweep does not fetch them again (EPIC_AUDIT P1-E08).
 * Returns the refresh time for meta.timelineRefreshedAt, or undefined when there was nothing to write or it failed.
 */
async function writeFetchedTimeline(rawDocs: KvDocs, progress: SweepProgress, nowIso: string, logger: Logger): Promise<string | undefined> {
  const pending = progress.timeline;
  if (!pending || pending.written || pending.groups.size === 0) return undefined;
  try {
    let fresh: TimelineDoc = (await rawDocs.getTimeline()) ?? { schemaVersion: 1, updatedAt: nowIso, byGroup: {} };
    for (const [gid, list] of pending.groups) fresh = mergeCommits(fresh, gid, list, nowIso);
    await rawDocs.putTimeline(fresh);
    pending.written = true;
    return nowIso;
  } catch (e) {
    logger.warn('sweep: could not keep the fetched timeline after the stop (the next sweep fetches it again)', e);
    return undefined;
  }
}

/**
 * Founder-build r1 core-14 (m18, #44): a failure a shorter range can avoid — the Leader's rate limit or the sweep's call
 * or time budget (D63), a metrics query that failed (a 5xx, a timeout) — as opposed to one no range changes.
 */
export function coldPathFailure(code: string | undefined): boolean {
  if (!code) return false;
  // A metrics query's 5xx or no answer (HTTP 0) — never a 4xx (a refused grant is not fixed by a shorter range).
  return code === 'rate_limited' || code === 'budget' || code === 'time_budget' || (/^metrics /.test(code) && /HTTP (5\d\d|0)\b/.test(code)) || /timeout/i.test(code);
}

/** meta after a failed or stopped sweep: sweepErrors++, lastError, rate-limit streak (SPEC 7 step 13, 19.12). */
async function recordFailure(
  rawDocs: KvDocs,
  meta: Meta | null,
  metaRead: boolean,
  code: string,
  rateLimited: boolean,
  logger: Logger,
  more: { kvRefused: boolean; progress: SweepProgress; nowIso: string; rate?: RateLimitStatus; timelineRefreshedAt?: string; app?: { appVersion: string; build: Build } },
): Promise<Meta | null> {
  try {
    let current = metaRead ? meta : await rawDocs.getMeta();
    if (!current) {
      // A failed first sweep writes no meta, so the next run seeds normally — except a failure a shorter range avoids
      // (core-14, m18): without a record the same day-long range was retried unchanged forever. A minimal meta keeps
      // the failure, and the next first run meters the newest hour (planRange: lastFailedOnLimits).
      if (!coldPathFailure(code) || !more.app) return null;
      current = {
        schemaVersion: 1,
        installedAt: more.nowIso,
        collectingSince: more.nowIso,
        appVersion: more.app.appVersion,
        build: more.app.build,
        metricsSource: 'metrics-query',
        sweepErrors: 0,
        consecutiveRateLimited: 0,
        sweepCount: 0,
      };
    }
    const next: Meta = {
      ...current,
      sweepErrors: (current.sweepErrors ?? 0) + 1,
      lastError: code,
    };
    // Core-14 (m18): a catch-up that failed on its range meters half that span next time (never under an hour).
    const planned = more.progress.planned;
    if (planned && !planned.firstRun && coldPathFailure(code) && code !== 'rate_limited') {
      // Whole minutes, so every slice ends on a minute boundary (the cursor stays minute-aligned).
      next.metricsSpanMs = Math.max(FIRST_RUN_SEED_MS, Math.floor(Math.min(planned.spanMs, current.metricsSpanMs ?? planned.spanMs) / 2 / MINUTE_MS) * MINUTE_MS);
    }
    // P1-E03: the first refused write starts the streak (a later failure of another kind does not end it; the next
    // completed sweep does), and an expiry pass this sweep ran is kept, so the next sweep does not repeat it.
    if (more.kvRefused) next.kvWriteFailingSince = current.kvWriteFailingSince ?? more.nowIso;
    if (more.progress.lastExpiredAt) next.lastExpiredAt = more.progress.lastExpiredAt;
    if (more.timelineRefreshedAt) next.timelineRefreshedAt = more.timelineRefreshedAt;
    if (more.progress.kvDatedKeys !== undefined) next.kvDatedKeys = more.progress.kvDatedKeys;
    if (more.progress.expiryBacklog !== undefined) {
      if (more.progress.expiryBacklog > 0) next.expiryBacklog = more.progress.expiryBacklog;
      else delete next.expiryBacklog;
    }
    // P1-E01: the streak (and the back-off it scheduled) of a sweep that met the Leader's limit. A failure that met
    // none leaves the streak as it was: it proves nothing about the limit.
    if (more.rate) {
      next.consecutiveRateLimited = more.rate.streak;
      next.rateLimitedSince = more.rate.since;
      if (more.rate.until) next.rateLimitedUntil = more.rate.until;
      else delete next.rateLimitedUntil;
    }
    if (rateLimited) {
      next.consecutiveRateLimited = Math.max(next.consecutiveRateLimited ?? 0, (current.consecutiveRateLimited ?? 0) + 1);
      if (next.consecutiveRateLimited % 3 === 0) {
        next.inventoryRefreshEveryMin = Math.min(MAX_INVENTORY_EVERY_MIN, (current.inventoryRefreshEveryMin ?? INVENTORY_EVERY_MIN) * 2);
      }
    }
    await rawDocs.putMeta(next);
    return next;
  } catch (e) {
    logger.warn('sweep: could not record the failure in meta', e);
    return null;
  }
}

interface LockedArgs {
  d: Resolved;
  mode: SweepOptions['mode'];
  nowMs: number;
  windowEnd: number;
  startedAt: number;
  t: MeteredTransport;
  docs: KvDocs;
  meta: Meta | null;
  lock: LockHold;
  progress: SweepProgress;
  /** The rate-limit streak before this sweep (P1-E01). */
  prevRate: { streak: number; since?: string };
}

async function sweepLocked(a: LockedArgs): Promise<Partial<SweepResult>> {
  const { d, mode, nowMs, windowEnd, t, docs, meta } = a;
  const nowIso = toIso(nowMs);
  const target = d.budget ?? DEFAULT_SWEEP_BUDGET;
  /** Core-7 (M11): a reserved expiry pass, under the hard budget (keeping `keep` calls for the writes after it) when there is one. */
  const reserveFor = (keep: number): ExpiryReserve => ({
    deletes: EXPIRY_RESERVE_DELETES,
    ...(d.budget !== undefined ? { hardRoom: () => (d.budget as number) - t.calls() - keep } : {}),
  });
  const limitFor = (force: boolean): number => (force ? (d.budget ?? Number.POSITIVE_INFINITY) : target);
  const demoBuild = d.build === 'demo';
  const { progress } = a;

  // 1b. The KV store refused the last sweep's writes (P1-E03): every sweep would fail at its first write again, so
  // the hourly expiry pass — which sits after those writes — would never run to free keys. Run it first, once per
  // failing streak and then hourly, with what the plan leaves beyond a steady-state sweep.
  const failingSince = meta?.kvWriteFailingSince ? fromIso(meta.kvWriteFailingSince) : Number.NaN;
  const expiredBefore = meta?.lastExpiredAt ? fromIso(meta.lastExpiredAt) : Number.NaN;
  const backlogBefore = meta?.expiryBacklog ?? 0;
  if (Number.isFinite(failingSince) && (!(expiredBefore >= failingSince) || !(nowMs - expiredBefore < EXPIRE_EVERY_MS) || backlogBefore > 0)) {
    // Core-7 (M11): reserved, so a full store frees at least one whole document even when the sweep's plan has no room
    // (at 2,000 flows one hour's minute document is ~52 keys; the old room of ~13 deleted nothing and metering stopped).
    const pass = await expireKeysSafely(docs, nowMs, () => target - t.calls() - EXPIRY_FIRST_RESERVE, progress, d.logger, reserveFor(EXPIRY_FIRST_RESERVE));
    if (pass)
      d.logger.warn(
        `sweep: the KV store has refused writes since ${meta?.kvWriteFailingSince}; expiry pass first: ${pass.deleted} of ${pass.expired} expired key(s) deleted, ${pass.listed - pass.deleted} dated key(s) left`,
      );
  }

  // 2. Reads.
  const [storedSettings, storedPrices, storedInventory, storedBaselines, storedTimeline, demoState, storedTotals, prevSnapshot] =
    await Promise.all([
      docs.getSettings(),
      docs.getPrices(),
      docs.getInventory(),
      docs.getBaselines(),
      docs.getTimeline(),
      demoBuild ? docs.getDemoState() : Promise.resolve(null),
      docs.getTotals(),
      docs.getSnapshot(),
    ]);
  // R2 core-4 (C1''): the zone is the stored settings' zone, else the zone the totals were kept in, else this runtime's
  // default (the tab's browser zone), else UTC: a settings-less workspace settles in one zone (no re-bucketing ping-pong).
  const settings: Settings = mergeSettings(storedSettings ?? {}, defaultSettings(nowIso, resolveMeterZone(storedSettings, storedTotals, d.defaultTimeZone)));
  const tz = canonicalZoneName(settings.displayTimezone || 'UTC');
  // C1': the zone the stored totals are keyed in — recorded since core-2; before it, the stored settings' zone, else
  // UTC (what a settings-less install bucketed in). A different zone re-buckets them below (core/rezone.ts).
  const totalsZone = storedTotals?.zone
    ? canonicalZoneName(storedTotals.zone)
    : storedSettings && typeof storedSettings.displayTimezone === 'string' && isValidTimeZone(storedSettings.displayTimezone)
      ? canonicalZoneName(storedSettings.displayTimezone)
      : 'UTC';
  const labels = settings.humanize ?? {};
  const prices: PricesDoc = storedPrices ?? emptyPrices(nowIso);
  let inventory: InventoryDoc | null = storedInventory;
  let baselines: BaselinesDoc = storedBaselines ?? emptyBaselines(nowIso);
  let timeline: TimelineDoc = storedTimeline ?? {
    schemaVersion: 1,
    updatedAt: nowIso,
    byGroup: {},
  };
  let totals: TotalsDoc = storedTotals ?? emptyTotals(nowIso);
  // REVIEW-3a #5: the totals say which minutes they include. The cursor is trusted only when the sweep that
  // wrote it also wrote this version of the doc (an older writer changes updatedAt and leaves it stale).
  const totalsThrough =
    storedTotals?.meteredThrough !== undefined && storedTotals.meteredAt === storedTotals.updatedAt
      ? fromIso(storedTotals.meteredThrough)
      : Number.NaN;
  // REVIEW-3a #3: nothing is metered until a price exists; the first sweep after Save prices the seed (D25).
  const priced = (storedPrices?.versions ?? []).length > 0;
  const th = effectiveThresholds(settings);
  const muted = demoState?.muted ?? {};

  /** The worker-group fields meta carries (step 4b sets them; until then, what meta already said). */
  let groupFields: Pick<Meta, 'groupsKnown' | 'groupsListedAt' | 'groupsMetered' | 'inventorySkippedAt'> = {
    ...(meta?.groupsKnown ? { groupsKnown: meta.groupsKnown } : {}),
    ...(meta?.groupsListedAt ? { groupsListedAt: meta.groupsListedAt } : {}),
    ...(meta?.groupsMetered ? { groupsMetered: meta.groupsMetered } : {}),
    ...(meta?.inventorySkippedAt ? { inventorySkippedAt: meta.inventorySkippedAt } : {}),
  };
  /** meta after a completed sweep (written last; the two calls it counts are this PUT and the lock release). */
  const sweptMeta = (m: {
    collectingSince: string;
    meteredThrough?: string;
    timelineRefreshedAt?: string;
    lastExpiredAt?: string;
    deliveryDeferredAt?: string;
    gap?: { from: number; to: number };
    /** Core-14 (m18): the catch-up span cap to keep (a sliced catch-up that has not caught up yet). */
    metricsSpanMs?: number;
    /** R3 core-2: this sweep metered a first run (no cursor before it): it stamps meta.meteringStartedAt, once. */
    firstMetering?: boolean;
  }): Meta => {
    const minute = minuteKey(nowMs);
    const callsNow = t.calls() + 2;
    const next: Meta = {
      schemaVersion: 1,
      installedAt: meta?.installedAt ?? nowIso,
      collectingSince: m.collectingSince,
      appVersion: d.appVersion,
      build: d.build,
      metricsSource: 'metrics-query',
      lastSweepAt: nowIso,
      lastSweepMs: d.clock.now() - a.startedAt,
      lastSweepCalls: callsNow,
      lastSweepMode: mode,
      lastSweepOwner: d.owner,
      sweepErrors: meta?.sweepErrors ?? 0,
      consecutiveRateLimited: 0,
      sweepCount: (meta?.sweepCount ?? 0) + 1,
      callsThisMinute: {
        minute,
        calls: (meta?.callsThisMinute?.minute === minute ? meta.callsThisMinute.calls : 0) + callsNow,
      },
    };
    if (m.meteredThrough) next.meteredThrough = m.meteredThrough;
    if (m.metricsSpanMs !== undefined && m.metricsSpanMs > 0) next.metricsSpanMs = m.metricsSpanMs;
    if (meta?.lastWeeklySentAt) next.lastWeeklySentAt = meta.lastWeeklySentAt;
    // R3 core-2 (FINDINGS_R3 #1, D83): when metering started — written once, by the first run that metered, and carried
    // forward by every later sweep. A workspace already metering without it (an upgrade) is never stamped: the weekly
    // receipt keeps the collectingSince rule there.
    const meteringStartedAt = meta?.meteringStartedAt ?? (m.firstMetering ? nowIso : undefined);
    if (meteringStartedAt) next.meteringStartedAt = meteringStartedAt;
    if (m.lastExpiredAt) next.lastExpiredAt = m.lastExpiredAt;
    const datedKeys = progress.kvDatedKeys ?? meta?.kvDatedKeys;
    if (datedKeys !== undefined) next.kvDatedKeys = datedKeys;
    const backlogAfter = progress.expiryBacklog ?? meta?.expiryBacklog ?? 0;
    if (backlogAfter > 0) next.expiryBacklog = backlogAfter;
    const retentionH = progress.minuteRetentionHours ?? meta?.minuteRetentionHours;
    if (retentionH !== undefined) next.minuteRetentionHours = retentionH;
    if (m.timelineRefreshedAt) next.timelineRefreshedAt = m.timelineRefreshedAt;
    if (meta?.inventoryRefreshEveryMin !== undefined) next.inventoryRefreshEveryMin = meta.inventoryRefreshEveryMin;
    Object.assign(next, groupFields);
    // P1-E05: a runner or backend sweeping is the delivery owner; any other sweep carries the last one forward.
    if (d.runtime !== 'ui' && isScheduledOwner(d.owner)) {
      next.deliveryOwner = d.owner;
      next.deliveryOwnerAt = nowIso;
    } else if (meta?.deliveryOwner && meta.deliveryOwnerAt) {
      next.deliveryOwner = meta.deliveryOwner;
      next.deliveryOwnerAt = meta.deliveryOwnerAt;
    }
    if (m.deliveryDeferredAt) next.deliveryDeferredAt = m.deliveryDeferredAt;
    // D57: the runner names its .env webhooks (no URL); any other sweep carries the last list forward.
    const webhooks = d.envWebhooks !== undefined ? d.envWebhooks.map(webhookDescriptor) : meta?.deliveryWebhooks;
    if (webhooks && webhooks.length > 0) next.deliveryWebhooks = webhooks;
    const gaps = m.gap ? recordGap(meta?.gaps, m.gap.from, m.gap.to, nowIso) : meta?.gaps;
    if (gaps && gaps.length > 0) next.gaps = gaps;
    // P1-E01: a completed sweep that met the Leader's limit (its retry got past a 429) extends the streak but schedules
    // no back-off; one that met none ends it.
    const rate = nextRateLimit(a.prevRate, t.limitHits() > 0, false, nowMs);
    progress.rate = rate ?? null;
    if (rate) {
      next.consecutiveRateLimited = rate.streak;
      next.rateLimitedSince = rate.since;
      if (rate.until) next.rateLimitedUntil = rate.until;
    }
    return next;
  };

  // Open incidents: the docs of every day the previous snapshot still shows an open incident for
  // (authoritative — a demo reset may have closed some), else today's and yesterday's.
  const incidentDocs = new Map<string, Incident[]>();
  const prevOpen = (prevSnapshot?.incidents ?? []).filter((i) => !i.closedAt);
  const dayKeys = new Set(prevOpen.map((i) => incidentsDocKey(fromIso(i.openedAt))));
  if (!prevSnapshot || (prevSnapshot.openIncidents ?? 0) > prevOpen.length) {
    dayKeys.add(incidentsDocKey(nowMs));
    dayKeys.add(incidentsDocKey(nowMs - DAY_MS));
  }
  const oldestDay = incidentsDocKey(nowMs - MAX_OPEN_INCIDENT_DAYS * DAY_MS);
  const toRead = [...dayKeys].filter((k) => k >= oldestDay).sort();
  const incidentReads = await mapLimit(toRead, READ_CONCURRENCY, (k) => docs.getIncidents(k));
  toRead.forEach((k, i) => incidentDocs.set(k, incidentReads[i]?.items ?? []));
  const openById = new Map<string, Incident>();
  for (const i of prevOpen) if (!incidentDocs.has(incidentsDocKey(fromIso(i.openedAt)))) openById.set(i.id, i);
  for (const items of incidentDocs.values()) for (const i of items) if (!i.closedAt) openById.set(i.id, i);

  // 3. Range.
  const floorLimit = windowEnd - MAX_BACKFILL_MS;
  const oldThrough = meta?.meteredThrough ? fromIso(meta.meteredThrough) : Number.NaN;
  const firstRun = !Number.isFinite(oldThrough);
  const storedSince = meta?.collectingSince ? fromIso(meta.collectingSince) : Number.NaN;
  // The range this sweep meters. A first run reaches back as far as the estate's size allows (firstRunSeedMs). On a
  // fresh install nothing has stored an inventory yet (the Prices screen walks the configuration itself), so the flow
  // count is only known after step 4b's walk: the range is sized again there (rules round 2, usefulness: the cold path
  // seeded one hour where D63 promised up to a day).
  // A first run whose last attempt met the Leader's rate limit or a call/time budget retries with the hour, so a
  // tight limit can never keep the first run from completing.
  // Core-14 (m18): a metrics query that failed on the day-long range (a 5xx, a timeout) falls back to the hour too.
  const lastFailedOnLimits = a.prevRate.streak > 0 || coldPathFailure(meta?.lastError);
  const reachMax = firstRun && lastFailedOnLimits ? FIRST_RUN_SEED_MS : (d.firstRunReachMs ?? FIRST_RUN_SEED_MAX_MS);
  const planRange = (seedFlows: number) => {
    let newStart: number;
    if (firstRun) {
      // As far back as the estate's size allows (firstRunSeedMs), or collectingSince when it says further.
      const bySize = windowEnd - firstRunSeedMs(seedFlows, reachMax);
      const seed = Number.isFinite(storedSince) && storedSince < windowEnd ? Math.min(minuteFloor(storedSince), bySize) : bySize;
      newStart = Math.max(seed, floorLimit);
    } else {
      newStart = Math.max(Math.min(oldThrough, windowEnd), floorLimit);
    }
    let queryStart = newStart;
    if (!firstRun) {
      const rewrite = Math.min(newStart, windowEnd) - MINUTE_MS;
      if (rewrite < oldThrough && rewrite >= floorLimit - MINUTE_MS) queryStart = rewrite;
    }
    // A first run starts collecting where it starts metering: the unpriced sweeps' collectingSince is only a seed (the
    // time spent pricing would otherwise read as minutes never metered, and as a gap).
    const collectingSinceMs = firstRun ? newStart : Number.isFinite(storedSince) ? Math.min(storedSince, newStart) : newStart;
    // P1-E04: one sweep meters at most MAX_SWEEP_SPAN_MS of a catch-up; the next sweep continues from its cursor. Core-14
    // (m18): after a catch-up's metrics query failed, at most meta.metricsSpanMs (half the span that failed).
    const spanCap = !firstRun && meta?.metricsSpanMs && meta.metricsSpanMs > 0 ? Math.min(MAX_SWEEP_SPAN_MS, meta.metricsSpanMs) : MAX_SWEEP_SPAN_MS;
    const rangeEnd = Math.min(windowEnd, newStart + spanCap);
    const touchedHours: number[] = [];
    for (let h = hourFloor(queryStart); h < rangeEnd; h += HOUR_MS) touchedHours.push(h);
    return { newStart, queryStart, collectingSinceMs, rangeEnd, sliced: rangeEnd < windowEnd, touchedHours };
  };
  let { newStart, queryStart, collectingSinceMs, rangeEnd, sliced, touchedHours } = planRange(
    storedInventory ? buildFlows(storedInventory, settings).length : 0,
  );
  progress.planned = { spanMs: rangeEnd - newStart, firstRun };
  // P1-E04: minutes older than the backfill floor when metering resumes were never metered — recorded, never silent.
  // A first run resumes nothing, so it records none.
  const gapFrom = firstRun ? Number.NaN : oldThrough;
  const gap = gapFrom < floorLimit ? { from: gapFrom, to: floorLimit } : undefined;
  if (gap)
    d.logger.warn(
      `sweep: ${Math.round((gap.to - gap.from) / MINUTE_MS)} minute(s) from ${toIso(gap.from)} are older than the Leader keeps metrics and were never metered; recorded in meta.gaps`,
    );
  const snapshotHoursFor = (end: number): number[] => [...new Set([hourFloor(end - HOUR_MS), hourFloor(end - MINUTE_MS)])];
  // Hours completed by `end`, the UTC days holding them, and the days whose last hour completed.
  const foldsFor = (end: number): { hours: number[]; days: string[]; dayFolds: string[] } => {
    const hours = touchedHours.filter((h) => h + HOUR_MS <= end);
    return {
      hours,
      days: [...new Set(hours.map((h) => utcDayKey(h)))],
      dayFolds: [...new Set(hours.filter((h) => (h + HOUR_MS) % DAY_MS === 0).map((h) => utcDayKey(h)))],
    };
  };
  let readHours: number[] = [];
  let foldDays: string[] = [];
  let dayFolds: string[] = [];
  const planReads = (): void => {
    readHours = [...new Set([...touchedHours, ...snapshotHoursFor(rangeEnd)])].sort((x, y) => x - y);
    ({ days: foldDays, dayFolds } = foldsFor(rangeEnd));
  };
  planReads();

  // Calls that must still happen after the optional refreshes (planning only).
  const mandatoryAfterRefresh = (): number =>
    3 + readHours.length + touchedHours.length + foldDays.length * 2 + dayFolds.length * 2 + 5 + RESERVE_CALLS;

  // 4a. Timeline refresh (every 5 min, Sweep now, or never read).
  let knownGroups = Object.keys(inventory?.byGroup ?? {});
  const refreshed = new Map<string, Commit[]>();
  // What was fetched is written even if the sweep then stops (P1-E08): a refresh is never paid for twice.
  progress.timeline = { groups: refreshed, written: false };
  const refreshTimeline = async (groups: string[], stillNeeded: number, force: boolean): Promise<boolean> => {
    if (groups.length === 0) return false;
    const room = roomFor(t, limitFor(force), groups.length + 2, stillNeeded);
    if (room < 0) return false;
    const perGroupShow = Math.max(0, Math.min(MAX_FILE_LOOKUPS, Math.floor(room / groups.length)));
    let any = false;
    for (const gid of groups) {
      try {
        const commits = await fetchCommits(t.http, gid, COMMITS_PER_REFRESH, {
          withFiles: perGroupShow > 0,
          maxShow: perGroupShow,
          cached: timeline.byGroup[gid] ?? [],
        });
        refreshed.set(gid, commits);
        timeline = mergeCommits(timeline, gid, commits, nowIso);
        any = true;
      } catch (e) {
        if (e instanceof RateLimited || e instanceof BudgetExceeded) throw e;
        d.logger.warn(`sweep: timeline refresh for ${gid} failed; keeping the stored timeline`, describeError(e));
      }
    }
    return any;
  };
  const timelineEvery = d.timelineEveryMin ?? TIMELINE_EVERY_MIN;
  const lastTimelineRefresh = meta?.timelineRefreshedAt ? fromIso(meta.timelineRefreshedAt) : Number.NaN;
  const timelineDue =
    mode === 'manual' || !storedTimeline || (timelineEvery > 0 && !(nowMs - lastTimelineRefresh < timelineEvery * MINUTE_MS));
  let timelineRefreshed = false;
  if (priced && timelineDue && knownGroups.length > 0)
    timelineRefreshed = await refreshTimeline(knownGroups, mandatoryAfterRefresh(), mode === 'manual');

  // 4b. Worker groups and the inventory (EPIC_AUDIT P0-02). The listing is re-read at least hourly and is
  // never gated by the plan (one call). Groups it names that the inventory lacks are read regardless of the
  // plan — the first run of a many-group org included — bounded only by the hard budget and
  // MAX_MISSING_GROUPS_PER_SWEEP (the rest follow on the next sweeps), `default` first. A commit newer than a
  // group's last read forces that group. The periodic refresh is optional work: the least recently read groups,
  // as many as the plan fits; a due refresh that fits nothing is logged and recorded in meta, and once the
  // inventory is MAX_INVENTORY_EVERY_MIN old it is forced. A known group is dropped only when a successful,
  // non-empty listing no longer names it — never for want of calls.
  const inventoryEvery = d.inventoryEveryMin ?? meta?.inventoryRefreshEveryMin ?? INVENTORY_EVERY_MIN;
  const invAt = inventory ? fromIso(inventory.updatedAt) : Number.NaN;
  const fetchedAt = (gid: string): number => {
    const at = inventory?.groupsFetchedAt?.[gid];
    return at ? fromIso(at) : invAt;
  };
  let listing: string[] | undefined = Array.isArray(meta?.groupsKnown) ? [...meta.groupsKnown] : undefined;
  let listedAt = meta?.groupsListedAt;
  let listedNow = false;
  const listedAtMs = listedAt ? fromIso(listedAt) : Number.NaN;
  if (!inventory || mode === 'manual' || !listing || !Number.isFinite(listedAtMs) || utcHourKey(listedAtMs) !== utcHourKey(nowMs)) {
    const res = await t.http.request('GET', urls.streamGroups());
    if (res.ok) {
      listing = workerGroupIds(res.json);
      listedAt = nowIso;
      listedNow = true;
    } else d.logger.warn(`sweep: listing worker groups failed (HTTP ${res.status}); keeping the known groups`);
  }
  const listed = listing && listing.length > 0 ? listing : knownGroups.length > 0 ? knownGroups : ['default'];
  // A commit in force during the metered minutes, at or after the group's last read (≥: a commit in the same
  // instant as the read may not be in it). One at or after windowEnd changes nothing this sweep meters.
  const committedSince = (gid: string): boolean => {
    const since = fetchedAt(gid);
    return (
      Number.isFinite(since) &&
      (timeline.byGroup[gid] ?? []).some((c) => {
        const at = commitTimeMs(c);
        return at >= since && at < rangeEnd;
      })
    );
  };
  const inInventory = (gid: string): boolean => !!inventory?.byGroup?.[gid];
  const byAge = (a: string, b: string): number => (fetchedAt(a) || 0) - (fetchedAt(b) || 0) || listed.indexOf(a) - listed.indexOf(b);
  const missing = listed.filter((g) => !inInventory(g)).sort((a, b) => Number(b === 'default') - Number(a === 'default'));
  const forced = [...new Set([...missing.slice(0, MAX_MISSING_GROUPS_PER_SWEEP), ...knownGroups.filter((g) => listed.includes(g) && committedSince(g))])];
  if (mode === 'manual') for (const g of knownGroups.filter((x) => listed.includes(x)).sort(byAge).slice(0, MAX_GROUPS_PER_REFRESH)) if (!forced.includes(g)) forced.push(g);
  // Forced reads: bounded by the hard budget only (a first run always reads at least one group). The +1 is the
  // inventory write any read brings.
  const forcedFit = Math.floor(roomFor(t, limitFor(true), 1, mandatoryAfterRefresh()) / GROUP_READ_CALLS);
  const groupReads = forced.slice(0, Math.max(inventory ? 0 : 1, Math.min(forced.length, forcedFit)));
  const waiting = missing.length - groupReads.filter((g) => !inInventory(g)).length;
  if (waiting > 0) d.logger.info(`sweep: ${waiting} listed worker group(s) not read yet; the next sweep reads them`);
  // Optional periodic refresh: the least recently read groups, as many as the plan fits.
  let inventorySkippedAt = meta?.inventorySkippedAt;
  const periodicDue = !!inventory && mode !== 'manual' && !(nowMs - invAt < inventoryEvery * MINUTE_MS);
  if (periodicDue) {
    const stale = !(nowMs - invAt < MAX_INVENTORY_EVERY_MIN * MINUTE_MS);
    const candidates = knownGroups.filter((g) => listed.includes(g) && !groupReads.includes(g)).sort(byAge);
    // The inventory write rides on RESERVE_CALLS here: planning it too would never fit one group of a many-group org.
    const fit = Math.floor(roomFor(t, limitFor(stale), groupReads.length * GROUP_READ_CALLS, mandatoryAfterRefresh()) / GROUP_READ_CALLS);
    const take = Math.min(candidates.length, MAX_GROUPS_PER_REFRESH, Math.max(0, fit));
    groupReads.push(...candidates.slice(0, take));
    if (take === 0 && candidates.length > 0 && groupReads.length === 0) {
      inventorySkippedAt = nowIso;
      d.logger.info(
        `sweep: inventory refresh due (${Math.round((nowMs - invAt) / MINUTE_MS)} min old) does not fit the ${target}-call plan; keeping the stored inventory (forced at ${MAX_INVENTORY_EVERY_MIN} min)`,
      );
    }
  }
  let inventoryRefreshed = false;
  const byGroup: InventoryDoc['byGroup'] = { ...(inventory?.byGroup ?? {}) };
  const readAt: Record<string, string> = { ...(inventory?.groupsFetchedAt ?? {}) };
  let dropped = 0;
  if (listedNow && listing && listing.length > 0) {
    for (const gid of Object.keys(byGroup)) {
      if (listing.includes(gid)) continue;
      delete byGroup[gid];
      delete readAt[gid];
      dropped++;
      d.logger.info(`sweep: worker group ${gid} is no longer listed by the Leader; dropped from the inventory`);
    }
  }
  let fetched = 0;
  for (const gid of groupReads) {
    try {
      byGroup[gid] = await fetchGroupInventory(t.http, gid);
      readAt[gid] = nowIso;
      fetched++;
    } catch (e) {
      if (e instanceof RateLimited || e instanceof BudgetExceeded) throw e;
      d.logger.warn(`sweep: inventory for ${gid} failed; keeping the stored copy`, describeError(e));
    }
  }
  if (fetched > 0 || dropped > 0) {
    for (const gid of Object.keys(readAt)) if (!byGroup[gid]) delete readAt[gid];
    inventory = {
      schemaVersion: 1,
      updatedAt: fetched > 0 ? nowIso : (inventory?.updatedAt ?? nowIso),
      hash: inventoryHash(byGroup),
      byGroup,
      groupsFetchedAt: readAt,
    };
    inventoryRefreshed = true;
  } else if (!inventory) {
    throw new Error('no inventory: every config read failed and none is stored');
  }
  if (!inventory) throw new Error('no inventory');
  knownGroups = Object.keys(inventory.byGroup);
  if (firstRun && !storedInventory) {
    // A fresh install: this sweep's walk is the first inventory, so the first run is sized from it (D63's reach, up to
    // a day). Only a priced sweep meters; an unpriced one keeps the hour floor it writes as collectingSince.
    const hourPlan = { newStart, queryStart, collectingSinceMs, rangeEnd, sliced, touchedHours };
    ({ newStart, queryStart, collectingSinceMs, rangeEnd, sliced, touchedHours } = planRange(buildFlows(inventory, settings).length));
    progress.planned = { spanMs: rangeEnd - newStart, firstRun };
    planReads();
    if (d.budget !== undefined && roomFor(t, d.budget, 0, mandatoryAfterRefresh()) < 0) {
      // A hard call budget that cannot carry the longer reach keeps the hour this sweep planned with.
      ({ newStart, queryStart, collectingSinceMs, rangeEnd, sliced, touchedHours } = hourPlan);
      planReads();
      d.logger.info(`sweep: the first run keeps its hour of history; the ${d.budget}-call budget does not fit a longer reach`);
    }
  }
  groupFields = {
    ...(listing ? { groupsKnown: listing } : {}),
    ...(listedAt ? { groupsListedAt: listedAt } : {}),
    groupsMetered: knownGroups,
    ...(inventorySkippedAt ? { inventorySkippedAt } : {}),
  };
  if (!priced) {
    // REVIEW-3a #3: no price yet, so nothing is metered and neither cursor moves. The inventory (the Prices
    // screen lists its destinations) and meta (lastSweepAt tells the screen to re-read it) are written; no
    // snapshot, so a fresh install still lands on the first-run card. collectingSince is set once, an hour
    // back, as a floor: the first sweep after Save meters from there or further back (up to a day, by the
    // estate's size: firstRunSeedMs), every minute at the first price (D25), and restarts collectingSince there.
    assertTime(a);
    await keepLock(a, 'the inventory and meta writes');
    if (inventoryRefreshed) await docs.putInventory(inventory);
    const unpricedMeta = sweptMeta({
      collectingSince: meta?.collectingSince ?? toIso(windowEnd - FIRST_RUN_SEED_MS),
      ...(meta?.meteredThrough ? { meteredThrough: meta.meteredThrough } : {}),
      timelineRefreshedAt: meta?.timelineRefreshedAt,
      lastExpiredAt: progress.lastExpiredAt ?? meta?.lastExpiredAt,
    });
    await docs.putMeta(unpricedMeta);
    d.logger.info('sweep: no prices yet; nothing metered (the inventory is fresh for the Prices screen)');
    return { skipped: 'no_prices', meta: unpricedMeta };
  }

  const flows = buildFlows(inventory, settings);
  if (!timelineRefreshed && !storedTimeline && knownGroups.length > 0)
    timelineRefreshed = await refreshTimeline(knownGroups, mandatoryAfterRefresh(), false);

  // 5. Metrics for the whole range (three calls).
  const metrics = await fetchMetrics(t.http, knownGroups, queryStart, rangeEnd, { inventory });
  for (const err of metrics.errors)
    d.logger.warn(`sweep: metrics ${err.query} query failed (HTTP ${err.status}); attribution falls back`, err.message);
  const windows = [...metrics.windows].sort((x, y) => fromIso(x.windowStart) - fromIso(y.windowStart));

  // Minute docs of every hour the range touches, plus the last hour's (the snapshot reads 60 minutes).
  const hourKeys = readHours.map((h) => minuteDocKey(h));
  const hourDocs = await mapLimit(hourKeys, READ_CONCURRENCY, (k) => docs.getRollMinute(k));
  const minuteDocs = new Map<number, RollMinuteDoc | undefined>();
  readHours.forEach((h, i) => minuteDocs.set(h, hourDocs[i] ?? undefined));
  const dirtyHours = new Set<number>();

  // 5b. C1' (founder-build r1 core-2, FINDINGS_R1 B1): the totals were keyed in another zone (a settings-less install
  // metered in UTC, or the member changed Settings → display timezone). Re-bucket the current month into this sweep's
  // zone from the rollups before any new minute is added (core/rezone.ts: money and minutes conserved per old day).
  const totalsEnd = Number.isFinite(totalsThrough) ? totalsThrough : oldThrough;
  if (storedTotals && totalsZone !== tz) {
    const plan = rezonePlan(totalsZone, tz, nowMs, totalsEnd, storedSince);
    if (plan && plan.hours.length > 0) {
      const hourSet = new Set(plan.hours);
      const buckets: MoneyBucket[] = [];
      const covered = new Set<number>();
      // Minute rows the sweep already holds are exact (and cover the hour in progress, not folded yet).
      for (const h of plan.hours) {
        const md = minuteDocs.get(h);
        if (!md) continue;
        buckets.push(...minuteBuckets(md.flows).filter((b) => b.startMs < totalsEnd));
        covered.add(h);
      }
      // R2 core-4 (#11): an hour a local midnight cuts off the hour (a +5:30 zone) splits exactly only from its minute
      // rows: read them while they are kept, before the hour rollups stand in for it (a time split).
      const retentionMs = (meta?.minuteRetentionHours ?? MINUTE_RETENTION_MS / HOUR_MS) * HOUR_MS;
      const straddle = rezoneStraddleHours(plan).filter((h) => !covered.has(h) && nowMs - h < retentionMs);
      const straddleDocs = await mapLimit(straddle, READ_CONCURRENCY, (h) => docs.getRollMinute(minuteDocKey(h)));
      straddleDocs.forEach((md, i) => {
        if (!md) return;
        buckets.push(...minuteBuckets(md.flows).filter((b) => b.startMs < totalsEnd));
        covered.add(straddle[i]);
      });
      // Then the hour rollups (one document per UTC day), for every hour the minute rows did not cover.
      const dayDocs = await mapLimit(plan.utcDays, READ_CONCURRENCY, (day) => docs.getRollHour(hourDocKey(fromIso(`${day}T00:00:00.000Z`))));
      const folded = new Set<number>();
      dayDocs.forEach((hd) => {
        const bs = hourBuckets(hd?.flows, new Set([...hourSet].filter((h) => !covered.has(h))));
        for (const b of bs) folded.add(b.startMs);
        buckets.push(...bs);
      });
      // An hour neither holds (a fold that never ran): its minute document, while it is kept (25 h).
      const missing = plan.hours.filter((h) => !covered.has(h) && !folded.has(h) && nowMs - h <= 24 * HOUR_MS);
      const extra = await mapLimit(missing, READ_CONCURRENCY, (h) => docs.getRollMinute(minuteDocKey(h)));
      extra.forEach((md) => {
        if (md) buckets.push(...minuteBuckets(md.flows).filter((b) => b.startMs < totalsEnd));
      });
      totals = rezoneTotals(totals, plan, { buckets, collectingSinceMs: storedSince, gaps: meta?.gaps ?? [] });
      d.logger.info(`sweep: the totals were kept in ${totalsZone}; re-bucketed from ${toIso(plan.startMs)} into ${tz}`);
    } else {
      totals = { ...totals, zone: tz };
    }
  }

  // REVIEW-3a #1: hold back trailing empty minutes after traffic (the minute before newStart counts through
  // its stored rows too, so an empty rewrite answer is not mistaken for quiet).
  // A catch-up slice ends in the past: nothing there can be too new for the Leader, so nothing is held back.
  const meterEnd = sliced
    ? rangeEnd
    : holdBackEnd(
        windows,
        (i) => windowHasTraffic(windows[i]) || (fromIso(windows[i].windowStart) < newStart && moneyAt(minuteDocs.get(hourFloor(fromIso(windows[i].windowStart))), windows[i].windowStart).any),
        newStart,
        windowEnd,
      );
  const heldMinutes = Math.round((rangeEnd - meterEnd) / MINUTE_MS);
  if (heldMinutes > 0) d.logger.info(`sweep: holding ${heldMinutes} empty minute(s) after traffic; the Leader may not have them yet`);

  // 6. Per minute: price, roll up, detect.
  const priceTimes = (prices.versions ?? [])
    .map((v) => fromIso(v.effectiveFrom))
    .filter((x) => !Number.isNaN(x))
    .sort((x, y) => x - y);
  const epochOf = (ms: number): number => {
    let lo = 0;
    let hi = priceTimes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (priceTimes[mid] <= ms) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // Seeded history ends when the first price was saved: an earlier minute is priced at that first price (D25) and
  // learned from, but never alerted on (DetectInput.learnOnly).
  const firstPricedMs = priceTimes.length > 0 ? priceTimes[0] : Number.NaN;
  const priceCache = new Map<string, EffectivePrices>();
  // Core-12 (M12): the whole output (its type, and a router's rules), so a splitting router reads unpriced.
  const outputTypes = new Map<string, OutputInfo>();
  for (const [gid, g] of Object.entries(inventory.byGroup)) for (const o of g.outputs ?? []) outputTypes.set(`${gid}:${o.id}`, o);
  const pricesAt = (groupId: string, outputId: string, ms: number): EffectivePrices => {
    const key = `${groupId}:${outputId}#${epochOf(ms)}`;
    let p = priceCache.get(key);
    if (!p) {
      p = effectivePrices(prices, groupId, outputId, ms, outputTypes.get(`${groupId}:${outputId}`));
      priceCache.set(key, p);
    }
    return p;
  };

  // Per-route rolling hour of would-have-paid (dollar impact), primed from rows already stored.
  const flowsByRoute = new Map<ObjectKey, Flow[]>();
  const flowsByInput = new Map<ObjectKey, Flow[]>();
  for (const f of flows) {
    if (f.routeId !== '-') {
      const k = objectKey('route', f.groupId, f.routeId);
      (flowsByRoute.get(k) ?? flowsByRoute.set(k, []).get(k)!).push(f);
    }
    if (f.inputId !== '-') {
      const k = objectKey('in', f.groupId, f.inputId);
      (flowsByInput.get(k) ?? flowsByInput.set(k, []).get(k)!).push(f);
    }
  }
  const routeOfFlow = new Map<FlowKey, ObjectKey>();
  for (const [k, fs] of flowsByRoute) for (const f of fs) routeOfFlow.set(f.key, k);
  const whpHistory = new Map<ObjectKey, Map<number, number>>();
  const noteWhp = (route: ObjectKey, minute: number, whp: number): void => {
    let m = whpHistory.get(route);
    if (!m) whpHistory.set(route, (m = new Map()));
    m.set(minute, whp);
    // Minutes arrive in ascending order, so the map stays one rolling hour long (a 24 h backfill stays linear).
    for (const at of m.keys()) {
      if (at > minute - HOUR_MS) break;
      m.delete(at);
    }
  };
  for (const doc of minuteDocs.values()) {
    for (const [key, rows] of Object.entries(doc?.flows ?? {})) {
      const route = routeOfFlow.get(key);
      if (!route) continue;
      for (const r of rows) {
        const m = fromIso(r.t);
        if (m >= newStart - HOUR_MS && m < newStart) noteWhp(route, m, (whpHistory.get(route)?.get(m) ?? 0) + r.whpM);
      }
    }
  }
  const whpPerDay = (route: ObjectKey, minute: number): number => {
    const m = whpHistory.get(route);
    if (!m) return 0;
    let sum = 0;
    let n = 0;
    for (const [at, v] of m) {
      if (at > minute - HOUR_MS && at <= minute) {
        sum += v;
        n++;
      }
    }
    return n > 0 ? Math.round((sum * 1440) / n) : 0;
  };

  const detectCursor = storedBaselines?.updatedAt ? fromIso(storedBaselines.updatedAt) : Number.NaN;
  const commits = (): Commit[] => allCommits(timeline);
  const changes = new Map<string, IncidentChange>();
  const unmatched = new Set<string>();
  let lastAttribution: Record<FlowKey, Attribution> | undefined;
  let minutesProcessed = 0;
  let backfilledMinutes = 0;
  let detected = false;

  const passthrough = passthroughPipelines(inventory);
  for (const w of windows) {
    const m = fromIso(w.windowStart);
    if (m >= meterEnd) break;
    const tIso = w.windowStart;
    const hour = hourFloor(m);
    const doc = minuteDocs.get(hour);
    const isNew = m >= newStart;
    const attrib = attributeWindow(flows, w, { passthroughPipelines: passthrough });
    const rows: Record<FlowKey, MinuteRow> = {};
    for (const f of flows) {
      const a = attrib[f.key];
      if (!a) continue;
      if (!(a.inB > 0 || a.outB > 0 || a.inE > 0 || a.outE > 0)) continue; // no traffic: no row
      const p = pricesAt(f.groupId, f.outputId, m);
      const money = priceMinute({ inB: a.inB, outB: a.outB }, p.paidMcPerGb, p.whpMcPerGb, p.counterfactual);
      rows[f.key] = {
        t: tIso,
        inB: a.inB,
        outB: a.outB,
        inE: a.inE,
        outE: a.outE,
        ...money,
      };
    }
    const before = moneyAt(doc, tIso);
    // An empty answer never erases a stored minute that had traffic (a late or failed read of the rewrite).
    if (!isNew && before.any && Object.keys(rows).length === 0) continue;
    const nextDoc = replaceMinute(doc, toIso(hour), tIso, rows);
    minuteDocs.set(hour, nextDoc);
    dirtyHours.add(hour);
    const after = moneyAt(nextDoc, tIso);

    // Already in the totals? Their own cursor says (REVIEW-3a #5); without a trusted cursor, a minute before
    // the meta cursor or one that already has rows is a replacement.
    const replaced = Number.isFinite(totalsThrough) ? m < totalsThrough : !isNew || before.any;
    totals = addMinuteToTotals(totals, localDayKey(m, tz), after.total, replaced ? before.total : undefined, nowIso);
    const month = localMonthKey(m, tz);
    for (const outKey of new Set([...before.byOutput.keys(), ...after.byOutput.keys()])) {
      totals = addOutputMinuteToTotals(
        totals,
        month,
        outKey,
        after.byOutput.get(outKey) ?? zeroMoney(),
        replaced ? (before.byOutput.get(outKey) ?? zeroMoney()) : undefined,
      );
    }
    if (m + MINUTE_MS === meterEnd) lastAttribution = Object.fromEntries(Object.entries(attrib).map(([k, v]) => [k, v.attribution]));
    if (!isNew) continue;
    minutesProcessed++;
    const catchUp = m + MINUTE_MS < (sliced ? windowEnd : meterEnd);
    if (catchUp) backfilledMinutes++;

    // Route would-have-paid for the rolling impact figure.
    for (const [route, fs] of flowsByRoute) {
      let whp = 0;
      for (const f of fs) whp += rows[f.key]?.whpM ?? 0;
      noteWhp(route, m, whp);
    }

    const minuteEnd = m + MINUTE_MS;
    if (w.coarse || !(minuteEnd > detectCursor || Number.isNaN(detectCursor))) continue;
    // The newest minute is judged "now", but never a full minute past its end: baselines.updatedAt (this value)
    // is the cursor above, and a sweep that runs late (the settle puts it 20–80 s past the minute's end) or
    // holds the next minute back must still leave that next minute to be judged when it is metered.
    const evalNow = minuteEnd === meterEnd ? Math.min(Math.max(nowMs, minuteEnd), minuteEnd + MINUTE_MS - 1_000) : minuteEnd;

    const ratioSeries: Record<ObjectKey, RatioPoint> = {};
    for (const [route, fs] of flowsByRoute) {
      let saved = 0;
      let whp = 0;
      for (const f of fs) {
        saved += rows[f.key]?.savedM ?? 0;
        whp += rows[f.key]?.whpM ?? 0;
      }
      ratioSeries[route] = {
        x: whp > 0 ? saved / whp : null,
        whpPerDayM: whpPerDay(route, m),
        label: routeLabel(fs[0], inventory, labels),
        outputId: fs[0].outputId,
      };
    }
    const costSeries: Record<ObjectKey, CostPoint> = {};
    for (const [input, fs] of flowsByInput) {
      let paid = 0;
      for (const f of fs) paid += rows[f.key]?.paidM ?? 0;
      costSeries[input] = {
        x: paid * 60,
        label: humanize(fs[0].inputId, labels),
        outputId: fs[0].outputId,
      };
    }
    const budgetSeries: Record<ObjectKey, BudgetPoint> = {};
    for (const [outputId, b] of Object.entries(settings.budgets ?? {})) {
      if (!(b?.centsPerMonth > 0)) continue;
      for (const gid of knownGroups) {
        if (!flows.some((f) => f.groupId === gid && f.outputId === outputId)) continue;
        budgetSeries[objectKey('out', gid, outputId)] = {
          paidMtdM: outputMonthTotals(totals, month, `${gid}:${outputId}`).paidM,
          budgetCentsPerMonth: b.centsPerMonth,
          label: humanize(outputId, labels),
        };
      }
    }

    const res = detect({
      nowMs: evalNow,
      minuteStartMs: m,
      settings,
      baselines,
      openIncidents: [...openById.values()],
      ratioSeries,
      costSeries,
      budgetSeries,
      muted,
      commits: commits(),
      inventory,
      evaluateBudget: shouldEvaluateBudget(baselines, evalNow, settings),
      // P0-17 (loaned from WP-F): budget pace projects over the minutes metered this month, not since the 1st.
      budgetMinutesMtd: meteredMinutesInMonth(totals, month),
      collectingSinceMs,
      ...(minuteEnd <= firstPricedMs ? { learnOnly: true } : {}),
    });
    baselines = res.baselines;
    detected = true;
    for (const inc of res.opened) {
      // Caught on catch-up: openedAt stays the minute the change showed (D11); detection is now (REVIEW-3a #13).
      // A late sweep's newest minute is judged a little before now, too: its detection time is recorded as well.
      const late = catchUp ? { ...inc, notes: [...inc.notes, CATCH_UP_NOTE] } : inc;
      const opened = evalNow < nowMs ? { ...late, detectedAt: nowIso } : late;
      if (!opened.closedAt) openById.set(opened.id, opened);
      changes.set(opened.id, { incident: opened, event: 'incident.opened' });
      if (res.unmatchedRegressions.includes(inc.id)) unmatched.add(inc.id);
    }
    for (const inc of res.updated) {
      const prev = changes.get(inc.id);
      const was = openById.get(inc.id);
      openById.set(inc.id, inc);
      changes.set(inc.id, {
        incident: inc,
        event: prev?.event === 'incident.opened' ? 'incident.opened' : 'incident.updated',
        prevSeverity: prev?.prevSeverity ?? was?.severity,
      });
    }
    for (const inc of res.closed) {
      const prev = changes.get(inc.id);
      openById.delete(inc.id);
      changes.set(inc.id, {
        incident: inc,
        event: prev?.event === 'incident.opened' ? 'incident.opened' : 'incident.closed',
      });
    }
  }

  // 7. Refresh the timeline once before accepting a regression with no matching commit (SPEC 7 step 9).
  const pendingUnmatched = [...unmatched].filter((id) => changes.get(id)?.incident.cause === 'unknown');
  if (pendingUnmatched.length > 0 && !timelineRefreshed) {
    const groups = [...new Set(pendingUnmatched.map((id) => parseObjectKey(changes.get(id)!.incident.objectKey)?.groupId))].filter(
      (g): g is string => !!g,
    );
    const stillNeeded = touchedHours.length + foldDays.length * 2 + dayFolds.length * 2 + 5 + RESERVE_CALLS;
    timelineRefreshed = await refreshTimeline(groups, stillNeeded, true);
  }
  if (timelineRefreshed) {
    const candidates = [...new Map([...openById.values(), ...[...changes.values()].map((c) => c.incident)].map((i) => [i.id, i])).values()];
    const { incidents: rematched, upgraded } = rematchIncidents(candidates, commits(), inventory, th.regressionCommitWindowMin);
    for (const inc of rematched) {
      if (!upgraded.includes(inc.id)) continue;
      const prev = changes.get(inc.id);
      const was = prev?.incident ?? openById.get(inc.id);
      if (!inc.closedAt) openById.set(inc.id, inc);
      changes.set(inc.id, {
        incident: inc,
        event: prev?.event ?? 'incident.updated',
        prevSeverity: prev?.prevSeverity ?? was?.severity,
      });
    }
  }

  // 8. Durable writes, before any notification (REVIEW-3a #5): a sweep that dies while sending has already
  // recorded its minutes, totals, baselines and incidents, so the next one neither loses a minute nor
  // re-opens the incident under a new id. Minute docs go before totals: totals never run ahead of the rows.
  assertTime(a);
  await keepLock(a, 'the durable writes');
  const writes: Promise<unknown>[] = [];
  const hourDocWrites = [...dirtyHours].sort((x, y) => x - y);
  await mapLimit(hourDocWrites, READ_CONCURRENCY, (h) => docs.putRollMinute(minuteDocKey(h), minuteDocs.get(h) as RollMinuteDoc));

  // Hour folds (every hour completed by the metered range), then day folds (a day whose last hour folded).
  const folds = foldsFor(meterEnd);
  const hourDocsByDay = new Map<string, RollHourDoc | null>();
  for (const day of folds.days) {
    const key = hourDocKey(fromIso(`${day}T00:00:00.000Z`));
    let hd: RollHourDoc | null = await docs.getRollHour(key);
    for (const h of folds.hours.filter((x) => utcDayKey(x) === day)) {
      const md = minuteDocs.get(h);
      if (md) hd = upsertHourRows(hd, day, foldHourRows(md));
    }
    hourDocsByDay.set(day, hd);
    if (hd) await docs.putRollHour(key, hd);
  }
  for (const day of folds.dayFolds) {
    const hd = hourDocsByDay.get(day);
    if (!hd) continue;
    const dayMs = fromIso(`${day}T00:00:00.000Z`);
    const key = dayDocKey(dayMs);
    const dd: RollDayDoc | null = await docs.getRollDay(key);
    await docs.putRollDay(key, upsertDayRows(dd, day.slice(0, 7), foldDayRows(hd)));
  }

  totals = { ...pruneTotals(totals), updatedAt: nowIso, meteredThrough: toIso(meterEnd), meteredAt: nowIso, zone: tz };
  writes.push(docs.putTotals(totals));
  if (detected || !storedBaselines) writes.push(docs.putBaselines(baselines));
  if (inventoryRefreshed) writes.push(docs.putInventory(inventory));
  await Promise.all(writes);

  if (refreshed.size > 0) {
    // Re-read so a lever's append made during this sweep survives; the API sighting merges into it.
    let fresh = (await docs.getTimeline()) ?? {
      schemaVersion: 1 as const,
      updatedAt: nowIso,
      byGroup: {},
    };
    for (const [gid, list] of refreshed) fresh = mergeCommits(fresh, gid, list, nowIso);
    timeline = fresh;
    await docs.putTimeline(fresh);
    progress.timeline.written = true;
  }

  // Incident docs: each incident in the doc of the UTC day it opened.
  const writeIncidents = async (list: Incident[]): Promise<void> => {
    const byDoc = new Map<string, Incident[]>();
    for (const inc of list) {
      const k = incidentsDocKey(fromIso(inc.openedAt));
      (byDoc.get(k) ?? byDoc.set(k, []).get(k)!).push(inc);
    }
    for (const [k, items] of byDoc) {
      const baseItems = incidentDocs.has(k) ? (incidentDocs.get(k) as Incident[]) : ((await docs.getIncidents(k))?.items ?? []);
      const merged = mergeIncidentUpdates(baseItems, [], items, []);
      incidentDocs.set(k, merged);
      await docs.putIncidents(k, { schemaVersion: 1, items: merged });
    }
  };
  await writeIncidents([...changes.values()].map((c) => c.incident));

  // 9. Notifications.
  const logs: DeliveryLog[] = [];
  let notified = 0;
  const pickedUp = new Set<string>();
  // A tab leaves delivery to a runner or backend that swept moments ago: they can post webhooks, and the
  // incidents this tab changed reach them through the docs (never-told opens, undelivered closures).
  const deferred = d.runtime === 'ui' && deliveryOwnedElsewhere(meta, d.owner, nowMs);
  if (deferred) d.logger.info('sweep: a runner or backend swept in the last 90 s; it delivers the alerts');
  // What a deferring tab leaves to it (P1-E05): while meta says so, that runner's cheap check sweeps in full. Open
  // incidents count too, for their cooldown re-sends.
  const leftToDeliver =
    deferred &&
    (changes.size > 0 || openById.size > 0 || (prevSnapshot?.incidents ?? []).some((i) => !openById.has(i.id) && undeliveredClosure(i, nowMs)));
  // Stored endpoints plus the default-on Cribl bell (core/delivery.ts, DECISIONS D23).
  // Cribl channels, then direct webhooks, then the implicit bell (P1-E07).
  const endpoints = deferred ? [] : deliveryOrder(resolveEndpoints([...settings.notifications, ...(d.envWebhooks ?? [])]).filter((e) => e.enabled));
  if (endpoints.length > 0) {
    // Cribl channels (bell, notification targets) call the Leader through the metered transport.
    const router = createDeliveryRouter({ http: t.http, webhook: d.webhook, clock: d.clock, sleep: d.sleep, logger: d.logger });
    const candidates: IncidentChange[] = [...changes.values()];
    for (const inc of openById.values()) {
      if (changes.has(inc.id)) continue;
      pickedUp.add(inc.id);
      // Never told (another sweep deferred, or every attempt failed): it is still news of an opening.
      candidates.push({ incident: inc, event: inc.lastNotifiedAt ? 'incident.updated' : 'incident.opened' });
    }
    const delivering = new Set(endpoints.map((e) => e.id));
    for (const inc of prevSnapshot?.incidents ?? []) {
      if (changes.has(inc.id) || openById.has(inc.id) || !undeliveredClosure(inc, nowMs, delivering)) continue;
      pickedUp.add(inc.id);
      candidates.push({ incident: inc, event: inc.type === 'goodnews' ? 'incident.opened' : 'incident.closed' });
    }
    let outOfTime = false;
    // P1-E07: an endpoint whose attempt timed out is down for the rest of this sweep — the next incident does not
    // wait on it again, and the healthy endpoints still hear about every incident now. The next sweep tries it again.
    const down = new Set<string>();
    for (const c of candidates) {
      let incident = c.incident;
      // A failed attempt waits two minutes; lastNotifiedAt (the cooldown clock) moves only on a 2xx. Core-9 (M8): an
      // incident that keeps per-endpoint state waits per endpoint instead (shouldNotify), so a webhook that failed is
      // retried even when the bell delivered.
      if (!incident.notified && inFailedAttemptCooldown(incident, nowMs)) continue;
      let attempted = false;
      let delivered = false;
      for (const ep of endpoints) {
        if (down.has(ep.id)) continue;
        if (!shouldNotify(incident, ep, nowMs, th.cooldownMinutes, c.prevSeverity, FAILED_ATTEMPT_COOLDOWN_MS)) continue;
        // Core-9 (M8): an endpoint that never delivered this open incident hears it as an opening, not an update.
        const own = incident.notified?.[ep.id];
        const event: NotifyEvent = c.event === 'incident.updated' && !incident.closedAt && own !== undefined && !own.ok ? 'incident.opened' : c.event;
        // A dead endpoint costs one 10 s timeout a sweep (then it is skipped, P1-E07). Past the notification budget the
        // sweep stops sending and still writes, so a broken webhook can never keep a minute from being recorded.
        if (d.clock.now() - a.startedAt > NOTIFY_TIME_BUDGET_MS) {
          if (!outOfTime) d.logger.warn('sweep: notification time budget spent; remaining notifications wait for the next sweep');
          outOfTime = true;
          break;
        }
        const canonical = canonicalPayload(event, {
          incident,
          workspace: d.workspace,
          linkBase: d.linkBase,
          labels,
          sentAt: nowIso,
          // Core-10 (M9): a below-floor close names the floor this workspace set.
          regressionFloorCentsPerDay: th.regressionMinCentsPerDay ?? DEFAULT_REGRESSION_MIN_CENTS_PER_DAY,
        });
        // A direct webhook gets one attempt a sweep (its retry is the next sweep): three 10 s timeouts and the back-off
        // between them were ~40 s per incident on one dead host (P1-E07). The Cribl channels keep their quick retries.
        const webhook = channelOf(ep) === 'webhook';
        const sentAt = d.clock.now();
        const attempts = await router.deliver({ endpoint: ep, event, canonical, incidentId: incident.id, tz, labels, ...(webhook ? { backoffMs: [] } : {}) });
        logs.push(...attempts);
        const failedSlow = attempts.length > 0 && attempts.every((x) => x.status === 0) && d.clock.now() - sentAt >= WEBHOOK_TIMEOUT_MS;
        if (attempts.some(isTimeoutAttempt) || failedSlow) {
          down.add(ep.id);
          d.logger.warn(`sweep: ${ep.name || ep.id} did not answer within ${WEBHOOK_TIMEOUT_MS / 1000} s; skipped for the rest of this sweep, retried next sweep`);
        }
        const last = lastAttempt(attempts);
        if (!last) continue;
        attempted = true;
        const ok = last.status >= 200 && last.status < 300;
        if (ok) {
          notified++;
          delivered = true;
        }
        // Core-9 (M8): this endpoint's own state (its last attempt, and its last 2xx); r2 core-1: its failures in a row
        // and whether the last one is final, which set when it is tried again (shouldNotify).
        incident = { ...incident, notified: { ...(incident.notified ?? {}), [ep.id]: nextEndpointRecord(own, last, incident.closedAt) } };
        const ref = {
          endpointId: ep.id,
          status: last.status,
          at: last.at,
          ...(last.error ? { error: last.error } : {}),
        };
        // R2 core-1: one failed ref per endpoint (replaced), and an endpoint's last delivery is never evicted.
        incident = { ...incident, deliveries: recordDeliveryRef(incident.deliveries, ref, MAX_INCIDENT_DELIVERIES) };
      }
      if (!attempted) continue;
      incident = { ...incident, lastAttemptAt: nowIso, ...(delivered ? { lastNotifiedAt: nowIso } : {}) };
      changes.set(incident.id, { ...c, incident });
      if (!incident.closedAt) openById.set(incident.id, incident);
    }
  }

  // 10. Incident docs again with what was delivered, then the log, expiry, snapshot and meta.
  assertTime(a);
  await keepLock(a, 'the snapshot and meta writes');
  const attemptedNow = [...changes.values()].filter((c) => c.incident.lastAttemptAt === nowIso).map((c) => c.incident);
  if (attemptedNow.length > 0) await writeIncidents(attemptedNow);

  let deliveries: DeliveryLog[] = prevSnapshot?.deliveries ?? [];
  if (logs.length > 0) {
    const log = (await docs.getNotifyLog()) ?? {
      schemaVersion: 1 as const,
      items: [],
    };
    const items = [...log.items, ...logs].slice(-NOTIFY_LOG_CAP);
    await docs.putNotifyLog({ schemaVersion: 1, items });
    deliveries = items;
  }

  // Hourly expiry of dated keys when the plan has room for the two listings (a skipped pass runs next sweep), unless
  // the pass already ran first this sweep (1b). A backlog the last pass had no room for continues sooner, but only in
  // a sweep with room for EXPIRY_MIN_BATCH deletes beyond the listings — never two listings to delete nothing (P1-E08).
  const lastExpiry = meta?.lastExpiredAt ? fromIso(meta.lastExpiredAt) : Number.NaN;
  const hourlyDue = !(nowMs - lastExpiry < EXPIRE_EVERY_MS);
  const backlogDue = (meta?.expiryBacklog ?? 0) > 0;
  const hourly = hourlyDue && roomFor(t, target, 2, 3) >= 0;
  const backlog = backlogDue && roomFor(t, target, 2 + EXPIRY_MIN_BATCH, 3) >= 0;
  if (!progress.expiryRan && (hourly || backlog)) await expireKeysSafely(docs, nowMs, () => target - t.calls() - 3, progress, d.logger);
  // Core-7 (M11, #43): due but the plan has no room (a large estate's sweep spends more than the plan): run it anyway,
  // bounded by the reserve, so expiry runs at any flow count and the store never fills.
  else if (!progress.expiryRan && (hourlyDue || backlogDue)) await expireKeysSafely(docs, nowMs, () => 0, progress, d.logger, reserveFor(3));
  const lastExpiredAt = progress.lastExpiredAt ?? meta?.lastExpiredAt;

  // Snapshot: the 60 minutes up to meterEnd (an hour a hold reaches back into is read now if it wasn't).
  const snapshotHours = snapshotHoursFor(meterEnd);
  for (const h of snapshotHours) if (!minuteDocs.has(h)) minuteDocs.set(h, (await docs.getRollMinute(minuteDocKey(h))) ?? undefined);
  const snapshotRows = mergeRowsByFlow(snapshotHours.map((h) => minuteDocs.get(h)));
  const snapshotIncidents = new Map<string, Incident>();
  for (const i of prevSnapshot?.incidents ?? []) snapshotIncidents.set(i.id, i);
  for (const items of incidentDocs.values()) for (const i of items) snapshotIncidents.set(i.id, i);
  for (const i of openById.values()) snapshotIncidents.set(i.id, i);
  for (const c of changes.values()) snapshotIncidents.set(c.incident.id, c.incident);
  const plannedFinal = t.calls() + 3; // snapshot, meta, lock release
  const snapshot = compactSnapshot(
    buildSnapshot({
      sweepAtMs: nowMs,
      windowStartMs: meterEnd - MINUTE_MS,
      windowEndMs: meterEnd,
      mode,
      settings,
      prices,
      inventory,
      flows,
      minuteRows: snapshotRows,
      ...(lastAttribution ? { attribution: lastAttribution } : {}),
      totals,
      collectingSinceMs,
      incidents: [...snapshotIncidents.values()],
      timeline,
      deliveries,
      muted,
      baselines,
      calls: plannedFinal,
      metricsSource: 'metrics-query',
      previous: prevSnapshot,
      zone: tz,
      // Core-14 (m3): a backfill's every minute feeds the 24 h ratio series (steady state: the same hours as the snapshot).
      ...(minuteDocs.size > snapshotHours.length ? { ratioRows: mergeRowsByFlow([...minuteDocs.values()]) } : {}),
      // Core-6 (#42): where the rows it holds begin (the first run's seed hour, or the snapshot's first hour).
      ...(minuteDocs.size > 0 ? { rowsFromMs: Math.min(...minuteDocs.keys()) } : {}),
    }),
    SNAPSHOT_MAX_BYTES,
  );
  const bytes = snapshotBytes(snapshot);
  await docs.putSnapshot(snapshot);

  // Meta, last.
  const nextMeta = sweptMeta({
    collectingSince: toIso(collectingSinceMs),
    meteredThrough: toIso(meterEnd),
    timelineRefreshedAt: refreshed.size > 0 ? nowIso : meta?.timelineRefreshedAt,
    lastExpiredAt,
    ...(leftToDeliver ? { deliveryDeferredAt: nowIso } : {}),
    ...(gap ? { gap } : {}),
    // Core-14 (m18): a catch-up that is still slicing keeps the span that worked; caught up, it goes back to the full span.
    ...(sliced && meta?.metricsSpanMs ? { metricsSpanMs: meta.metricsSpanMs } : {}),
    ...(firstRun ? { firstMetering: true } : {}),
  });
  await docs.putMeta(nextMeta);

  // What this sweep's detector opened and closed (a picked-up delivery is not a new opening or closing).
  let opened = 0;
  let closed = 0;
  for (const c of changes.values()) {
    if (pickedUp.has(c.incident.id)) continue;
    if (c.event === 'incident.opened') opened++;
    if (c.incident.closedAt) closed++;
  }
  return {
    minutesProcessed,
    backfilledMinutes,
    ...(heldMinutes > 0 ? { heldMinutes } : {}),
    ...(gap ? { unmeteredMinutes: Math.round((gap.to - gap.from) / MINUTE_MS) } : {}),
    ...(sliced ? { catchUpRemainingMinutes: Math.round((windowEnd - meterEnd) / MINUTE_MS) } : {}),
    opened,
    closed,
    notified,
    snapshotBytes: bytes,
    snapshot,
    meta: nextMeta,
    ...(logs.length > 0 ? { attempts: logs } : {}),
    ...(deferred ? {} : { deliveryEndpoints: endpoints.map((e) => e.id), deliveryReminderMinutes: th.cooldownMinutes }),
  };
}

/** Throws once the sweep is past its time budget, so writes are abandoned (meta.sweepErrors++ only). */
function assertTime(a: Pick<LockedArgs, 'd' | 'startedAt'>): void {
  const elapsed = a.d.clock.now() - a.startedAt;
  if (elapsed > SWEEP_TIME_BUDGET_MS) throw new TimeBudgetExceeded(elapsed);
}
