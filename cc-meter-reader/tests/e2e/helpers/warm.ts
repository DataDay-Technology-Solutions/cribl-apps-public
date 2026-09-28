// tests/e2e/helpers/warm.ts — a WARM workspace in the emulator, and a meter for the tab's Leader call rate.
//
// Warm = what a member finds on a workspace that has been metered for weeks: 40 days of rollup history priced
// at the rig's prices (testdata/rollups.ts via the `seedRollups` control action), the inventory the sweep keeps
// (`seedInventory`), settings in the 'ui' runtime, and `meta` + `snapshot` as the last sweep left them — by the
// runner (`lastOwner: 'runner'`; keep it fresh with `runnerSweep`) or by a tab that has since closed. A cold
// install would measure the first-run seed hour and the inventory walk instead of the steady state.
//
// The meter reads the emulator's own journal (GET /mock-api/_calls): every call the page makes to the emulated
// Leader, KV included, with its time. Control actions (runnerSweep, faults) are never journaled, so a test can
// drive the org during a measurement without counting itself.

import type { Page } from '@playwright/test';
import { computeHeadline } from '../../../core/pricing.ts';
import { defaultSettings } from '../../../core/settings.ts';
import { DAY_MS, MINUTE_MS, localDayKey, localDayStartMs } from '../../../core/time.ts';
import type { Meta, Settings, Snapshot, TotalsDoc } from '../../../core/types.ts';
import { mondayNoonUtc } from '../../../core/weekly.ts';
import { gotoApp, waitForHydration } from './app.ts';
import { RIG_PRICES, kvGet, mockControl, resetCalls, resetMock } from './mock.ts';

export const WARM_TZ = 'America/Chicago';

export interface WarmOptions {
  /** Who ran the last sweep: the runner (35 s ago, so it is fresh) or a tab that has since closed. Default 'tab'. */
  lastOwner?: 'runner' | 'tab';
  /** settings.live overrides (poll intervals). */
  live?: Partial<Settings['live']>;
  /** Emulator options (MockOptions), e.g. { rateLimitPerMinute: 50 }. */
  options?: Record<string, unknown>;
}

export interface WarmWorkspace {
  at: number;
  since: number;
}

async function putKv(page: Page, docs: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (entries) => {
    for (const [key, value] of entries) {
      const r = await fetch(`/mock-api/v1/kvstore/${key}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(value) });
      if (r.status >= 300) throw new Error(`PUT ${key} → ${r.status}`);
    }
  }, Object.entries(docs));
}

/** Resets the emulated org to a warm workspace (see the header). Leaves the page on /first-run; open a view next. */
export async function warmWorkspace(page: Page, opts: WarmOptions = {}): Promise<WarmWorkspace> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  if (opts.options) await mockControl(page, { action: 'config', options: opts.options });
  const at = await page.evaluate(() => Date.now());
  const since = localDayStartMs(localDayKey(at - 40 * DAY_MS, WARM_TZ), WARM_TZ) + (21 * 60 + 41) * MINUTE_MS;
  const seeded = await mockControl(page, { action: 'seedRollups', at, since, tz: WARM_TZ, prices: RIG_PRICES });
  if (!seeded.ok) throw new Error(`seedRollups failed: ${JSON.stringify(seeded)}`);
  await mockControl(page, { action: 'seedInventory', at });
  const totals = JSON.parse((await kvGet(page, 'totals')) ?? '{}') as TotalsDoc;
  const headline = computeHeadline(totals, at, WARM_TZ, since);
  const iso = (ms: number): string => new Date(ms).toISOString();
  const minute = Math.floor(at / MINUTE_MS) * MINUTE_MS;
  const base = defaultSettings(iso(at), WARM_TZ, 'ui');
  const settings: Settings = { ...base, live: { ...base.live, ...(opts.live ?? {}) } };
  const snapshot: Snapshot = {
    schemaVersion: 1,
    sweepAt: iso(at - 35_000),
    windowStart: iso(minute - MINUTE_MS),
    windowEnd: iso(minute),
    mode: 'scheduled',
    headline,
    ratePerSecM: Math.round(headline.todayM / Math.max(1, (at - localDayStartMs(localDayKey(at, WARM_TZ), WARM_TZ)) / 1000)),
    flows: [],
    destinations: [],
    topSavers: [],
    unpricedOutputIds: [],
    openIncidents: 0,
    incidents: [],
    trend: [],
    ratioSeries: [],
    timeline: [],
    deliveries: [],
    calls: 23,
    collectingSince: iso(since),
    metricsSource: 'metrics-query',
    attributionSummary: 'reconciled',
  };
  const meta: Meta = {
    schemaVersion: 1,
    installedAt: iso(since),
    collectingSince: iso(since),
    appVersion: '1.1.0',
    build: 'release',
    metricsSource: 'metrics-query',
    lastSweepAt: iso(at - 35_000),
    lastSweepMs: 800,
    lastSweepCalls: 23,
    lastSweepMode: opts.lastOwner === 'runner' ? 'scheduled' : 'ui',
    lastSweepOwner: opts.lastOwner === 'runner' ? 'runner:workhorse:1' : 'ui:a-tab-that-closed',
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: 57_600,
    meteredThrough: iso(minute),
    timelineRefreshedAt: iso(at - 35_000),
    inventoryRefreshEveryMin: 10,
    // Weeks of metering have sent this week's receipt: the automatic send (any time in the week since core/weekly.ts
    // WEEKLY_AUTO_WINDOW_MS became the whole week) must not add its reads to what a test measures.
    lastWeeklySentAt: iso(mondayNoonUtc(at)),
  };
  await putKv(page, { settings, prices: RIG_PRICES, meta, snapshot });
  return { at, since };
}

// ─── The meter ───────────────────────────────────────────────────────────────

export interface JournalEntry {
  at: number;
  method: string;
  path: string;
  route: string;
  status: number;
  kind: string;
}

/**
 * A call's family: KV reads and writes by document family (`GET kv:snapshot`, `PUT kv:roll/min`; the emulator's
 * route collapses every key to `/kvstore/*`), everything else by the emulator's route.
 */
export function familyOf(e: Pick<JournalEntry, 'method' | 'path' | 'route'>): string {
  const kv = /^\/kvstore\/([^?]+)/.exec(e.path);
  if (!kv || kv[1] === 'keys') return e.route;
  const key = decodeURIComponent(kv[1]);
  const family = /^roll\/(min|hour|day)\//.exec(key)?.[0].slice(0, -1) ?? (key.startsWith('incidents/') ? 'incidents/*' : key.replace(/\/c\/\d+$/, '/c/*'));
  return `${e.method} kv:${family}`;
}

export interface CallRate {
  /** Calls in each whole minute from the navigation (the last one may be partial and is left out). */
  perMinute: number[];
  /** The first minute: hydration, the first sweep, the first polls. */
  firstMinute: number;
  /** The mean of every minute after the first. */
  steadyPerMinute: number;
  /** The busiest minute after the first. */
  steadyPeak: number;
  /** Calls by family after the first minute, per minute (what to cut when the budget breaks): `GET kv:snapshot`,
   * `GET kv:roll/hour`, `POST /system/metrics/query` … (the emulator's route, with KV keys by family). */
  steadyByFamily: Record<string, number>;
  /** Every call counted, oldest first. */
  entries: JournalEntry[];
  statuses: Record<string, number>;
  total: number;
}

/** Reads the journal (newest first, at most 500 entries) and buckets the page's Leader calls into minutes from `t0`. */
export async function callRate(page: Page, t0: number, minutes: number): Promise<CallRate> {
  const journal = await page.evaluate(async () => ((await (await fetch('/mock-api/_calls')).json()) as { total: number; recent: JournalEntry[] }));
  const entries = journal.recent.filter((e) => e.kind === 'api' && e.at >= t0 && e.at < t0 + minutes * 60_000);
  if (journal.total > entries.length + 5 && journal.recent.length >= 500) throw new Error(`the journal overflowed (${journal.total} calls): measure a shorter window`);
  const perMinute = Array.from({ length: minutes }, (_, m) => entries.filter((e) => Math.floor((e.at - t0) / 60_000) === m).length);
  const steady = perMinute.slice(1);
  const steadyEntries = entries.filter((e) => e.at >= t0 + 60_000);
  const steadyByFamily: Record<string, number> = {};
  for (const e of steadyEntries) steadyByFamily[familyOf(e)] = (steadyByFamily[familyOf(e)] ?? 0) + 1;
  for (const k of Object.keys(steadyByFamily)) steadyByFamily[k] = Math.round((steadyByFamily[k] / Math.max(1, steady.length)) * 10) / 10;
  const statuses: Record<string, number> = {};
  for (const e of entries) statuses[e.status] = (statuses[e.status] ?? 0) + 1;
  return {
    perMinute,
    firstMinute: perMinute[0] ?? 0,
    steadyPerMinute: steady.length ? Math.round((steady.reduce((a, b) => a + b, 0) / steady.length) * 10) / 10 : 0,
    steadyPeak: steady.length ? Math.max(...steady) : 0,
    steadyByFamily: Object.fromEntries(Object.entries(steadyByFamily).sort((a, b) => b[1] - a[1])),
    statuses,
    total: entries.length,
    entries: [...entries].sort((a, b) => a.at - b.at),
  };
}

/**
 * Opens `path` on the warm workspace and measures `minutes` whole minutes of calls from the navigation.
 * `during(elapsedMs)` runs about every `stepMs` (drive the org: a runner sweep, a key press).
 */
export async function measureView(
  page: Page,
  path: string,
  opts: { minutes?: number; stepMs?: number; during?: (elapsedMs: number) => Promise<void> } = {},
): Promise<CallRate> {
  const minutes = opts.minutes ?? 3;
  const stepMs = opts.stepMs ?? 10_000;
  await resetCalls(page);
  const t0 = await page.evaluate(() => Date.now());
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  const end = t0 + minutes * 60_000;
  for (;;) {
    const now = await page.evaluate(() => Date.now());
    if (now >= end) break;
    if (opts.during) await opts.during(now - t0);
    await page.waitForTimeout(Math.min(stepMs, Math.max(0, end - (await page.evaluate(() => Date.now())))));
  }
  return callRate(page, t0, minutes);
}
