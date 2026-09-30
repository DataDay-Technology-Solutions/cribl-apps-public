// core/weekly.ts — notification jobs outside the sweep: the weekly receipt (SPEC 11, 12.4) and the test send
// (SPEC 12.5). Every runtime uses them: the backend's `weeklyReceipt` / `sendTest` endpoints, the runner
// (`scripts/runner.ts --weekly`, and its Monday 12:00 UTC send), and in the ui runtime the tab itself
// ("Weekly receipt now", "Send test" — DECISIONS D12b). Both go through the delivery router (core/delivery.ts),
// so the receipt reaches the Cribl bell and Cribl notification targets as well as webhooks (NOTIFY-3a issue 4).

import type { DeliveryLog, Incident, Meta, NotificationEndpoint, RollHourDoc, WeeklyReceipt } from './types.ts';
import { RateLimited, defaultSleep } from './http.ts';
import { KEYS, KvHttpError, createKvDocs, type KvDocs } from './kv.ts';
import { defaultSettings, mergeSettings } from './settings.ts';
import { canonicalPayload, testPayload } from './payloads.ts';
import { buildWeeklyReceipt, previousWeek, receiptText, trailingWeek } from './receipt.ts';
import { hourDocKey, mergeRowsByFlow, sumFlowRows } from './rollups.ts';
import { resolveMeterZone } from './rezone.ts';
import { lastAttempt } from './adapters/webhook.ts';
import { createDeliveryRouter, resolveEndpoints, wantsWeeklyReceipt, type DeliveryRouter } from './delivery.ts';
import { createMeteredTransport, LOCK_TTL_MS, NOTIFY_LOG_CAP, type MeteredTransport, type SweepDeps } from './sweep.ts';
import { DAY_MS, MINUTE_MS, addDaysToKey, fromIso, localDayKey, toIso, utcDayKey } from './time.ts';

/** What the weekly receipt and the test send need from the sweep's dependencies. */
export type NotifyJobDeps = Pick<SweepDeps, 'http' | 'kv' | 'webhook' | 'clock' | 'codec' | 'workspace' | 'linkBase'> &
  Partial<Pick<SweepDeps, 'logger' | 'sleep' | 'owner' | 'envWebhooks' | 'defaultTimeZone'>>;

export interface WeeklyOptions {
  /** 'scheduled' (backend, Monday 12:00 UTC) and 'ui' (the tab's automatic send) cover the previous
   *  Monday–Sunday and send once per week; 'manual' ("Weekly receipt now") covers the seven days before today. */
  mode: 'scheduled' | 'manual' | 'ui';
  nowMs?: number;
}

export interface WeeklyResult {
  /**
   * R2 core-11 (a): 'unavailable' — an automatic send met a transient Leader failure (a timeout or network error, a
   * 5xx) and a later tick sends it (the error is in `error`); a manual send reports such a failure as an error.
   * R3 core-2: 'not_metered' — an automatic send whose week ended before metering started (meta.meteringStartedAt):
   * nothing is sent for it, and the week is settled.
   */
  skipped?: 'locked' | 'already_sent' | 'no_endpoints' | 'rate_limited' | 'unavailable' | 'not_metered';
  receipt?: WeeklyReceipt;
  /** SPEC 12.4 text form (what Slack and ServiceNow carry). */
  text?: string;
  /** Endpoints that answered 2xx. */
  sent: number;
  /** Endpoints attempted. */
  endpoints: number;
  deliveries: DeliveryLog[];
  calls: number;
  error?: string;
}

/**
 * Automatic sends happen within this long after Monday 12:00 UTC: the whole week (rules round, usefulness). On the
 * release's open-tab runtime a week whose Monday nobody had the App open used to send nothing; now the first tab (or
 * runner sweep) of the week sends last week's receipt, marked late past WEEKLY_ON_TIME_MS.
 */
export const WEEKLY_AUTO_WINDOW_MS = 7 * DAY_MS;
/** A receipt sent more than this long after Monday 12:00 UTC says it was sent late (WeeklyReceipt.sentLate). */
export const WEEKLY_ON_TIME_MS = DAY_MS;

/** Whether an automatic send at `nowMs` is late: more than WEEKLY_ON_TIME_MS after its Monday 12:00 UTC. */
export function isLateWeekly(nowMs: number): boolean {
  return nowMs - mondayNoonUtc(nowMs) > WEEKLY_ON_TIME_MS;
}

/** The most recent Monday 12:00 UTC at or before `nowMs`. */
export function mondayNoonUtc(nowMs: number): number {
  const d = new Date(nowMs);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  const noon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday, 12);
  return noon > nowMs ? noon - 7 * DAY_MS : noon;
}

/**
 * The automatic weekly receipt (the open tab in the ui runtime, and the runner): due once Monday 12:00 UTC has passed,
 * any time before the next one (WEEKLY_AUTO_WINDOW_MS), when this week's receipt has not gone out yet and metering
 * reached the week it reports. A send more than a day late says so (isLateWeekly).
 *
 * Founder-build r3 core-2 (FINDINGS_R3 #1, D83): "reached the week" is `meta.meteringStartedAt` (the first metering
 * sweep's wall time) before the end of the reported week — the local week before Monday 12:00 UTC, in `opts.timeZone`
 * when the caller knows the workspace's zone. Without the zone the bound is Monday 12:00 UTC itself (no zone's week
 * ends later), and runWeeklyReceipt, which knows the zone, makes the exact call. A fresh install's first sweep
 * back-fills up to a day (D63), so collectingSince alone said yes for a week nobody metered. A workspace without the
 * field (metering before r3) keeps the old rule: collectingSince before Monday 12:00 UTC.
 */
export function shouldAutoSendWeekly(
  meta: Pick<Meta, 'lastWeeklySentAt' | 'collectingSince' | 'meteringStartedAt'> | null | undefined,
  nowMs: number,
  opts: { windowMs?: number; timeZone?: string } = {},
): boolean {
  const noon = mondayNoonUtc(nowMs);
  if (nowMs - noon > (opts.windowMs ?? WEEKLY_AUTO_WINDOW_MS)) return false;
  const last = meta?.lastWeeklySentAt ? fromIso(meta.lastWeeklySentAt) : Number.NaN;
  if (last >= noon) return false;
  const started = meta?.meteringStartedAt ? fromIso(meta.meteringStartedAt) : Number.NaN;
  if (Number.isFinite(started)) return started < (opts.timeZone ? weekEndMs(noon, opts.timeZone) : noon);
  const since = meta?.collectingSince ? fromIso(meta.collectingSince) : Number.NaN;
  return since < noon;
}

/** The end of the local week the automatic send at Monday 12:00 UTC `noon` reports (previousWeek); noon on a bad zone. */
function weekEndMs(noon: number, tz: string): number {
  try {
    return previousWeek(noon, tz).endMs;
  } catch {
    return noon;
  }
}

/** R3 core-2: whether metering had started before `endMs` (true for a workspace without meta.meteringStartedAt). */
function meteredBefore(meta: Pick<Meta, 'meteringStartedAt'> | null | undefined, endMs: number): boolean {
  const started = meta?.meteringStartedAt ? fromIso(meta.meteringStartedAt) : Number.NaN;
  return !Number.isFinite(started) || started < endMs;
}

function docsFor(deps: NotifyJobDeps, t: MeteredTransport, raw = false): KvDocs {
  return createKvDocs({
    kv: raw ? t.rawKv : t.kv,
    codec: deps.codec,
    clock: deps.clock,
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}

/** The router for one job, over the job's metered transport (Cribl channels call the Leader). */
function routerFor(deps: NotifyJobDeps, t: MeteredTransport): DeliveryRouter {
  return createDeliveryRouter({
    http: t.http,
    webhook: deps.webhook,
    clock: deps.clock,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}

/** R2 core-11 (a): a KV call the Leader did not answer (status 0: a timeout or a dropped connection) or answered 5xx. */
function transientLeaderFailure(e: unknown): boolean {
  return e instanceof KvHttpError && (e.status === 0 || e.status >= 500);
}

/** How a browser words a fetch it did not complete (WebKit, Chromium, Firefox), when the error is its own. */
const ABORTED_FETCH = /load failed|failed to fetch|networkerror when attempting to fetch|access control checks|network connection was lost|the operation was aborted/i;

/**
 * Founder-build r3 core-3 (FT-R111-4): a request that never completed — a KV call answered status 0 (a dropped
 * connection, a navigation that cancelled it), or the browser's own AbortError / fetch TypeError. Not a defect.
 */
function abortedRequest(e: unknown): boolean {
  if (e instanceof KvHttpError) return e.status === 0;
  if (!(e instanceof Error)) return false;
  return e.name === 'AbortError' || (e.name === 'TypeError' && ABORTED_FETCH.test(e.message));
}

/** Founder-build r3 core-1: attempts at recording a delivered weekly receipt (meta.lastWeeklySentAt) within one call. */
export const WEEKLY_RECORD_ATTEMPTS = 3;
/** The wait before the second record attempt; it doubles before each later one (1 s, then 2 s). */
export const WEEKLY_RECORD_RETRY_MS = 1_000;

/**
 * Records a delivered automatic receipt (meta.lastWeeklySentAt), so no later tick sends it again (founder-build r3
 * core-1, FINDINGS_R3 #7). A transient Leader failure (a timeout or dropped connection, a 5xx, the Leader's rate
 * limit) is retried within the call, at most WEEKLY_RECORD_ATTEMPTS times; nothing here throws or re-enters the send:
 * a record that still fails is a warning, and the caller reports what it sent.
 */
async function recordWeeklySent(
  docs: KvDocs,
  meta: Meta,
  nowIso: string,
  deps: NotifyJobDeps,
  delivered: { sent: number; endpoints: number },
): Promise<boolean> {
  let waitMs = WEEKLY_RECORD_RETRY_MS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= WEEKLY_RECORD_ATTEMPTS; attempt++) {
    try {
      await docs.putMeta({ ...meta, lastWeeklySentAt: nowIso });
      return true;
    } catch (e) {
      lastError = e;
      if (!(transientLeaderFailure(e) || e instanceof RateLimited) || attempt === WEEKLY_RECORD_ATTEMPTS) break;
      await (deps.sleep ?? defaultSleep)(waitMs);
      waitMs *= 2;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  deps.logger?.warn(
    `weekly receipt: sent to ${delivered.sent} of ${delivered.endpoints} endpoint(s), but meta.lastWeeklySentAt could not be recorded (${message}); a later sweep may send it again`,
  );
  return false;
}

/** Appends delivery attempts to notify/log (≤ 200). Failures are logged, never thrown. */
async function appendLog(docs: KvDocs, logs: DeliveryLog[], deps: NotifyJobDeps): Promise<void> {
  if (logs.length === 0) return;
  try {
    const log = (await docs.getNotifyLog()) ?? {
      schemaVersion: 1 as const,
      items: [],
    };
    await docs.putNotifyLog({
      schemaVersion: 1,
      items: [...log.items, ...logs].slice(-NOTIFY_LOG_CAP),
    });
  } catch (e) {
    deps.logger?.warn('notify/log could not be updated', e);
  }
}

/**
 * Builds the weekly receipt from the hour rollups and sends it through the delivery router to every enabled
 * endpoint that takes it (`wantsWeeklyReceipt`: webhooks, the Cribl bell — on by default — and Cribl targets).
 * Automatic modes hold the sweep lock and record `meta.lastWeeklySentAt`.
 */
export async function runWeeklyReceipt(deps: NotifyJobDeps, opts: WeeklyOptions): Promise<WeeklyResult> {
  const clock = deps.clock;
  const nowMs = opts.nowMs ?? clock.now();
  const nowIso = toIso(nowMs);
  const t = createMeteredTransport(deps.http, deps.kv, {
    clock,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const docs = docsFor(deps, t);
  const auto = opts.mode !== 'manual';
  const owner = `${deps.owner || 'weekly'}:weekly`;
  const result = (r: Partial<WeeklyResult>): WeeklyResult => ({
    sent: 0,
    endpoints: 0,
    deliveries: [],
    ...r,
    calls: t.calls(),
  });

  let locked = false;
  try {
    if (auto) {
      locked = await docs.acquireLock(owner, LOCK_TTL_MS);
      if (!locked) return result({ skipped: 'locked' });
    }
    const [stored, meta, totals, snapshot, prices] = await Promise.all([docs.getSettings(), docs.getMeta(), docs.getTotals(), docs.getSnapshot(), docs.getPrices()]);
    if (auto && meta?.lastWeeklySentAt && fromIso(meta.lastWeeklySentAt) >= mondayNoonUtc(nowMs))
      return result({ skipped: 'already_sent' });
    // C1'' (founder-build r2 core-4): a settings-less workspace's week is in the zone its sweeps bucket it — the totals'
    // zone, else the tab's (resolveMeterZone) — so the UTC runner reports the week the member's screens show.
    const settings = mergeSettings(stored ?? {}, defaultSettings(nowIso, resolveMeterZone(stored, totals, deps.defaultTimeZone)));
    // D57: the runner's .env webhooks join the stored Cribl channels (no webhook URL is ever read from KV).
    const endpoints = resolveEndpoints([...settings.notifications, ...(deps.envWebhooks ?? [])]).filter(wantsWeeklyReceipt);
    if (endpoints.length === 0) return result({ skipped: 'no_endpoints' });

    const tz = settings.displayTimezone || 'UTC';
    // An automatic send covers the local week before its Monday 12:00 UTC, whenever in the week it goes out: a late
    // send (Thursday's first open) reports the same week the Monday send would have, in every zone.
    const noon = mondayNoonUtc(nowMs);
    const period = auto ? previousWeek(noon, tz) : trailingWeek(nowMs, tz);
    // R3 core-2 (FINDINGS_R3 #1): an automatic send never reports a week that ended before metering started (a fresh
    // install's back-filled day); the zone-free check upstream (shouldAutoSendWeekly) cannot tell for Monday morning UTC.
    if (auto && !meteredBefore(meta, period.endMs)) return result({ skipped: 'not_metered' });
    const late = auto && isLateWeekly(nowMs);
    // Hour rollups of every UTC day the local week overlaps.
    const keys: string[] = [];
    for (let day = utcDayKey(period.startMs); day <= utcDayKey(period.endMs - 1); day = addDaysToKey(day, 1))
      keys.push(hourDocKey(fromIso(`${day}T00:00:00.000Z`)));
    const hourDocs: (RollHourDoc | null)[] = [];
    for (const k of keys) hourDocs.push(await docs.getRollHour(k));
    const flowSums = sumFlowRows(mergeRowsByFlow(hourDocs), period.startMs, period.endMs);

    // The prior week from the running totals (local days), for the trend line.
    const startKey = localDayKey(period.startMs, tz);
    let priorSavedM: number | undefined;
    for (let i = 1; i <= 7; i++) {
      const d = totals?.byDay?.[addDaysToKey(startKey, -i)];
      if (d) priorSavedM = (priorSavedM ?? 0) + d.savedM;
    }
    const open: Incident[] = (snapshot?.incidents ?? []).filter((i) => !i.closedAt);
    // P0-23: the minutes metered in the week's local days, against the minutes the week held.
    let weekMinutes = 0;
    for (let i = 0; i < 7; i++) weekMinutes += totals?.byDay?.[addDaysToKey(startKey, i)]?.minutes ?? 0;
    const receipt = buildWeeklyReceipt({
      periodStartMs: period.startMs,
      periodEndMs: period.endMs,
      tz,
      flowSums,
      labels: settings.humanize,
      ...(priorSavedM !== undefined ? { priorSavedM } : {}),
      openIncidents: open,
      basis: {
        prices,
        destinations: snapshot?.destinations ?? [],
        coverage: { unit: 'minutes', metered: weekMinutes, expected: Math.round((period.endMs - period.startMs) / MINUTE_MS) },
      },
      ...(deps.linkBase ? { linkBase: deps.linkBase } : {}),
    });
    if (late) receipt.sentLate = true;

    const canonical = canonicalPayload('receipt.weekly', {
      receipt,
      workspace: deps.workspace,
      linkBase: deps.linkBase,
      labels: settings.humanize,
      sentAt: nowIso,
    });
    const router = routerFor(deps, t);
    const logs: DeliveryLog[] = [];
    let sent = 0;
    let attempted = 0;
    for (const ep of endpoints) {
      const attempts = await router.deliver({
        endpoint: ep,
        event: 'receipt.weekly',
        canonical,
        tz,
        labels: settings.humanize,
      });
      logs.push(...attempts);
      const last = lastAttempt(attempts);
      if (!last) continue; // the default bell, skipped on a Leader without the bell API
      attempted++;
      if (last.status >= 200 && last.status < 300) sent++;
    }
    // Founder-build r3 core-1 (FINDINGS_R3 #7): the send is done. Recording it is its own step, retried within this
    // call and never re-entering the send path: a failed record used to surface as 'unavailable', and the next tick
    // sent the receipt again (every endpoint twice) while this result said sent 0.
    if (auto && meta) await recordWeeklySent(docs, meta, nowIso, deps, { sent, endpoints: attempted });
    await appendLog(docs, logs, deps);
    return result({
      receipt,
      text: receiptText(receipt),
      sent,
      endpoints: attempted,
      deliveries: logs,
    });
  } catch (e) {
    if (e instanceof RateLimited) return result({ skipped: 'rate_limited', error: 'rate_limited' });
    const message = e instanceof Error ? e.message : String(e);
    // R2 core-11 (a): a transient Leader failure (a KV read that timed out, a dropped connection, a 5xx) is not the
    // job failing: an automatic send is retried by a later tick (an error settles the week for a tab, and a Monday
    // blip meant no receipt that week). A manual send still reports it to the member who pressed the button.
    // Founder-build r3 core-3 (FT-R111-4): a request the browser cut short (a navigation cancelled it: HTTP 0, "Load
    // failed", "access control checks", an AbortError) is the request not completing, not the job failing: a warning.
    const cutShort = abortedRequest(e);
    if (auto && (transientLeaderFailure(e) || cutShort)) {
      deps.logger?.warn(`weekly receipt: the Leader did not answer (${message}); a later sweep sends it`);
      return result({ skipped: 'unavailable', error: message });
    }
    if (cutShort) {
      deps.logger?.warn(`weekly receipt: the request did not complete (${message}); nothing was sent`);
      return result({ error: message });
    }
    // The message is in the line itself, so a console that prints only "Error" for the object still names the cause.
    deps.logger?.error(`weekly receipt failed: ${message}`, e);
    return result({ error: message });
  } finally {
    if (locked)
      await docsFor(deps, t, true)
        .putDoc(KEYS.lock, { owner, expiresAt: toIso(clock.now()) })
        .catch(() => undefined);
  }
}

export interface TestSendResult {
  /** HTTP status of the last attempt (0 = network error or endpoint not found). */
  status: number;
  /** false when the platform proxy refused the host (403): it needs an External API Access entry. */
  hostAuthorized: boolean;
  attempts: number;
  deliveries: DeliveryLog[];
  error?: string;
  calls: number;
}

/**
 * SPEC 12.5: posts `event: 'test'` with a synthetic, sample-noted incident to one endpoint and returns the
 * status. Pass the endpoint itself (an unsaved form) or its id (looked up in settings).
 */
export async function sendTestNotification(
  deps: NotifyJobDeps,
  args: {
    endpointId?: string;
    endpoint?: NotificationEndpoint;
    nowMs?: number;
  },
): Promise<TestSendResult> {
  const clock = deps.clock;
  const nowMs = args.nowMs ?? clock.now();
  const t = createMeteredTransport(deps.http, deps.kv, {
    clock,
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
  const docs = docsFor(deps, t);
  const out = (r: Omit<TestSendResult, 'calls'>): TestSendResult => ({
    ...r,
    calls: t.calls(),
  });
  try {
    const stored = await docs.getSettings();
    // C1'' (r2 core-4): the zone the sweeps meter in; the totals are read only when no settings document names one.
    const zone = resolveMeterZone(stored, stored?.displayTimezone ? null : await docs.getTotals(), deps.defaultTimeZone);
    const settings = mergeSettings(stored ?? {}, defaultSettings(toIso(nowMs), zone));
    const endpoint = args.endpoint ?? [...settings.notifications, ...(deps.envWebhooks ?? [])].find((e) => e.id === args.endpointId);
    if (!endpoint)
      return out({
        status: 0,
        hostAuthorized: false,
        attempts: 0,
        deliveries: [],
        error: 'not_found',
      });
    const canonical = testPayload(deps.workspace, toIso(nowMs), deps.linkBase);
    // Through the router, so a Cribl bell or target endpoint is tested on its own channel (not as a URL).
    const incidentId = canonical.incident?.id;
    const logs = await routerFor(deps, t).deliver({
      endpoint,
      event: 'test',
      canonical,
      ...(incidentId ? { incidentId } : {}),
      tz: settings.displayTimezone,
      labels: settings.humanize,
    });
    await appendLog(docs, logs, deps);
    const last = lastAttempt(logs);
    const status = last?.status ?? 0;
    const r: Omit<TestSendResult, 'calls'> = {
      status,
      hostAuthorized: status !== 403,
      attempts: logs.length,
      deliveries: logs,
    };
    if (last?.error) r.error = last.error;
    return out(r);
  } catch (e) {
    return out({
      status: 0,
      hostAuthorized: false,
      attempts: 0,
      deliveries: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
