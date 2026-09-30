import { describe, expect, it, vi } from 'vitest';
import type { CriblHttp, HttpResult, KvStore, Meta, RollMinuteDoc } from '../../core/types.ts';
import { BudgetExceeded, RateLimited } from '../../core/http.ts';
import { createMemoryKvStore, KvHttpError } from '../../core/kv.ts';
import { CATCH_UP_NOTE, DEFAULT_SWEEP_BUDGET, FIRST_RUN_SEED_MAX_MS, FIRST_RUN_SEED_MS, LOCK_TTL_MS, MAX_BACKFILL_MS, createMeteredTransport, firstRunSeedMs, minuteKey, runSweep } from '../../core/sweep.ts';
import { breakTrim } from '../../core/demo/levers.ts';
import {
  APP_ID,
  BACKEND_API_BASE,
  createBackendDeps,
  createBrowserDeps,
  createConsoleLogger,
  createOwnerId,
  leverDepsFrom,
  linkBaseFrom,
  workspaceFromUrl,
} from '../../core/runtime.ts';
import { expiredKeys } from '../../core/rollups.ts';
import { buildFlows } from '../../core/flows.ts';
import { defaultSettings } from '../../core/settings.ts';
import {
  DAY,
  HOUR,
  MINUTE,
  SINK_ENDPOINT,
  T0,
  createWorld,
  emulatorFetch,
  faultHttp,
  lateDataHttp,
  sumRows,
  type World,
} from '../integration/harness.ts';

const PAY_FLOW = 'default|mrd_payments_api|mrd_payments_api|mrd_pay_sample|mrd_siem_prod';
const PAY_ROUTE = 'route:default:mrd_payments_api';

const minuteDoc = (w: World, ms: number): Promise<RollMinuteDoc | null> => w.docs.getRollMinute(new Date(ms).toISOString().slice(0, 13));

/** Journal-counted sweep: returns the result and the emulator's own count of the calls it received. */
async function countedSweep(w: World, mode: 'ui' | 'manual' | 'scheduled' = 'ui', extra = {}) {
  w.em.resetCalls();
  const r = await w.sweep(mode, extra);
  const calls = w.em.calls();
  // Leader API calls only: webhook POSTs to external hosts are journaled too but are not Leader calls.
  return {
    r,
    journal: calls.recent.filter((e) => e.kind === 'api').length,
    routes: calls.byRoute,
  };
}

async function nextMinute(w: World, extra = {}) {
  w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
  return countedSweep(w, 'ui', extra);
}

// ─── Metered transport ───────────────────────────────────────────────────────
describe('createMeteredTransport', () => {
  const okHttp = (statuses: number[]): CriblHttp & { seen: string[] } => {
    const seen: string[] = [];
    return {
      seen,
      async request(method, path) {
        seen.push(`${method} ${path}`);
        const status = statuses.length > 0 ? (statuses.shift() as number) : 200;
        return { status, ok: status < 300, json: {} } as HttpResult;
      },
    };
  };
  const clock = { now: () => 0 };

  it('counts http and KV calls on one counter and caps them before the call is made', async () => {
    const http = okHttp([]);
    const t = createMeteredTransport(http, createMemoryKvStore(), {
      clock,
      hardCap: 3,
    });
    await t.http.request('GET', '/a');
    await t.kv.put('k', '"v"');
    await t.kv.get('k');
    expect(t.calls()).toBe(3);
    await expect(t.kv.list('k')).rejects.toBeInstanceOf(BudgetExceeded);
    await expect(t.http.request('GET', '/b')).rejects.toBeInstanceOf(BudgetExceeded);
    expect(http.seen).toEqual(['GET /a']);
    // The raw path stays usable (and counted) after the cap: cleanup writes.
    await t.rawKv.put('lock', '{}');
    expect(await t.rawKv.get('lock')).toBe('{}');
    await t.rawKv.del('lock');
    expect(await t.rawKv.list('')).toEqual(['k']);
    expect(t.calls()).toBe(7);
  });

  it('retries one 429 after 5 s, then stops the sweep on the next 429 anywhere', async () => {
    const sleeps: number[] = [];
    const http = okHttp([429, 200, 429]);
    const t = createMeteredTransport(http, createMemoryKvStore(), {
      clock,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect((await t.http.request('GET', '/x')).status).toBe(200);
    expect(sleeps).toEqual([5_000]);
    expect(t.retries()).toBe(1);
    await expect(t.http.request('GET', '/y')).rejects.toBeInstanceOf(RateLimited);
    expect(t.calls()).toBe(3);
  });

  it('two 429s on the same call throw RateLimited', async () => {
    const t = createMeteredTransport(okHttp([429, 429]), createMemoryKvStore(), { clock, sleep: async () => undefined });
    await expect(t.http.request('POST', '/q')).rejects.toBeInstanceOf(RateLimited);
    expect(t.calls()).toBe(2);
  });

  it('recognizes a KV 429 by the thrown status and passes other errors through', async () => {
    let failures = 1;
    const kv: KvStore = {
      async get() {
        if (failures-- > 0) throw new KvHttpError('GET', 'k', 429);
        return 'v';
      },
      async put() {
        throw new KvHttpError('PUT', 'k', 500);
      },
      async del() {
        throw new Error('boom');
      },
      async list() {
        return [];
      },
    };
    const t = createMeteredTransport(okHttp([]), kv, {
      clock,
      sleep: async () => undefined,
    });
    expect(await t.kv.get('k')).toBe('v');
    await expect(t.kv.put('k', 'v')).rejects.toMatchObject({ status: 500 });
    await expect(t.kv.del('k')).rejects.toThrow('boom');
    expect(t.retries()).toBe(1);
  });
});

describe('minuteKey', () => {
  it("is the UTC minute 'YYYY-MM-DDTHH:MM'", () => {
    expect(minuteKey(Date.UTC(2026, 8, 28, 15, 7, 59))).toBe('2026-09-28T15:07');
  });
});

// ─── First run, steady state, skips ──────────────────────────────────────────
describe('runSweep — first run and steady state', () => {
  it('a fresh install with no stored inventory sizes its first run from the configuration walk: a whole day for a small estate', async () => {
    // Rules round 2 (usefulness): the documented path (empty KV → Settings → Prices → Start the meter) stores no
    // inventory before the first priced sweep, so the reach used to fall back to one hour.
    const w = await createWorld({ sweep: { firstRunReachMs: undefined } });
    expect(await w.docs.getInventory()).toBeNull();
    const { r, journal } = await countedSweep(w);
    expect(r.error).toBeUndefined();
    expect(r.calls).toBe(journal);
    expect(r.minutesProcessed).toBe(24 * 60);
    const meta = (await w.meta()) as Meta;
    expect(meta.meteredThrough).toBe('2026-09-28T15:00:00.000Z');
    expect(meta.collectingSince).toBe('2026-09-27T15:00:00.000Z');
    expect(meta.gaps).toBeUndefined();
    // Seeded history alerts nobody.
    expect(r.opened).toBe(0);
    expect(w.em.sink()).toEqual([]);
    const totals = await w.docs.getTotals();
    expect((totals?.byDay['2026-09-27']?.minutes ?? 0) + (totals?.byDay['2026-09-28']?.minutes ?? 0)).toBe(24 * 60);
  });

  it('a large estate on a fresh install reaches back as far as its flow-minutes allow, never under an hour', async () => {
    // The judge's 400-flow run seeded 1 h where firstRunSeedMs(400) gives 300 minutes.
    const scale = await createWorld({ preset: 'scale', flows: 400, sweep: { firstRunReachMs: undefined } });
    const r = await scale.sweep('scheduled');
    expect(r.error).toBeUndefined();
    const flowCount = buildFlows((await scale.docs.getInventory())!, defaultSettings(new Date(T0).toISOString(), 'UTC')).length;
    expect(flowCount).toBeGreaterThanOrEqual(400);
    expect(r.minutesProcessed).toBe(firstRunSeedMs(flowCount) / MINUTE);
    expect(r.minutesProcessed).toBeGreaterThan(4 * 60);
    // The snapshot counts the whole estate even when it lists fewer flows (rules round 2: the Ledger read "101 flows").
    expect(r.snapshot?.flowCounts?.flows).toBe(flowCount);
    const other = r.snapshot?.flows.find((f) => f.inputId === 'other' && f.routeId === '-');
    expect((r.snapshot?.flows.length ?? 0) - (other ? 1 : 0) + (other?.folded ?? 0)).toBe(flowCount);
    // A cap on the reach (a runtime behind a tight rate limit) still holds.
    const capped = await createWorld({ sweep: { firstRunReachMs: 3 * HOUR } });
    expect((await capped.sweep()).minutesProcessed).toBe(180);
    expect(firstRunSeedMs(400)).toBe(300 * MINUTE);
    expect(firstRunSeedMs(10, 3 * HOUR)).toBe(3 * HOUR);
    expect(firstRunSeedMs(10, 10 * MINUTE)).toBe(HOUR);
  });

  it('a first run whose last attempt met the rate limit retries with the hour', async () => {
    const w = await createWorld({ sweep: { firstRunReachMs: undefined } });
    await w.docs.putMeta({
      schemaVersion: 1,
      installedAt: new Date(T0 - HOUR).toISOString(),
      collectingSince: new Date(T0 - HOUR).toISOString(),
      appVersion: '1.0.0',
      build: 'demo',
      metricsSource: 'metrics-query',
      sweepErrors: 1,
      lastError: 'rate_limited',
      consecutiveRateLimited: 0,
      sweepCount: 0,
    });
    const r = await w.sweep('scheduled');
    expect(r.error).toBeUndefined();
    expect(r.minutesProcessed).toBe(60);
  });

  it('a fresh install behind a tight rate limit: the day-long first run is stopped, the retry reaches back the hour and completes', async () => {
    // No meta yet (a failed first sweep never creates one): the fallback rests on this runtime's rate-limit memory.
    const w = await createWorld({ options: { rateLimitPerMinute: 50 }, sweep: { firstRunReachMs: undefined } });
    expect(await w.meta()).toBeNull();
    const first = await w.sweep('scheduled');
    expect(first.error).toBe('rate_limited');
    let done: Awaited<ReturnType<typeof w.sweep>> | undefined;
    for (let i = 0; i < 20 && !done; i++) {
      w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
      const r = await w.sweep('scheduled');
      if (!r.skipped && !r.error) done = r;
    }
    expect(done?.minutesProcessed).toBe(60);
  });

  it('seeds the last hour on a fresh install when the reach is capped at an hour, and records everything it did', async () => {
    const w = await createWorld();
    const { r, journal } = await countedSweep(w);
    expect(r.error).toBeUndefined();
    expect(r.minutesProcessed).toBe(60);
    expect(r.backfilledMinutes).toBe(59);
    expect(r.calls).toBe(journal);
    const meta = (await w.meta()) as Meta;
    expect(meta.meteredThrough).toBe('2026-09-28T15:00:00.000Z');
    expect(meta.collectingSince).toBe('2026-09-28T14:00:00.000Z');
    expect(meta.sweepCount).toBe(1);
    expect(meta.lastSweepMode).toBe('ui');
    expect(meta.lastSweepCalls).toBe(r.calls);
    expect(meta.build).toBe('demo');
    expect(meta.callsThisMinute).toEqual({
      minute: '2026-09-28T15:00',
      calls: r.calls,
    });
    expect(r.meta).toEqual(meta);
    // 60 rows for the payments flow, priced (whp > paid > 0, saved = whp − paid).
    const doc = await minuteDoc(w, T0 - HOUR);
    const pay = doc?.flows[PAY_FLOW] ?? [];
    expect(pay).toHaveLength(60);
    for (const row of pay) {
      expect(row.whpM).toBeGreaterThan(row.paidM);
      expect(row.savedM).toBe(row.whpM - row.paidM);
    }
    const snap = await w.docs.getSnapshot();
    expect(snap?.windowEnd).toBe('2026-09-28T15:00:00.000Z');
    expect(snap?.flows.some((f) => f.key === PAY_FLOW && f.savedM > 0)).toBe(true);
    expect(snap?.headline.todayM).toBeGreaterThan(0);
    expect(r.snapshotBytes).toBeLessThanOrEqual(90_000);
    // Lock released (expired in place), totals count each minute once.
    const lock = await w.docs.getLock();
    expect(Date.parse(lock!.expiresAt)).toBeLessThanOrEqual(w.now());
    const totals = await w.docs.getTotals();
    expect(totals?.byDay['2026-09-28']?.minutes).toBe(60);
  });

  it('seeds from collectingSince when meta has no cursor yet, capped at 24 h', async () => {
    const w = await createWorld();
    await w.docs.putMeta({
      schemaVersion: 1,
      installedAt: new Date(T0 - 3 * HOUR).toISOString(),
      collectingSince: new Date(T0 - 3 * HOUR).toISOString(),
      appVersion: '1.0.0',
      build: 'demo',
      metricsSource: 'metrics-query',
      sweepErrors: 0,
      consecutiveRateLimited: 0,
      sweepCount: 0,
    });
    const r = await w.sweep('scheduled');
    expect(r.minutesProcessed).toBe(180);
    const w2 = await createWorld();
    await w2.docs.putMeta({
      schemaVersion: 1,
      installedAt: new Date(T0 - 3 * DAY).toISOString(),
      collectingSince: new Date(T0 - 3 * DAY).toISOString(),
      appVersion: '1.0.0',
      build: 'demo',
      metricsSource: 'metrics-query',
      sweepErrors: 0,
      consecutiveRateLimited: 0,
      sweepCount: 0,
    });
    const r2 = await w2.sweep('scheduled');
    expect(r2.minutesProcessed).toBe(1440);
    // A first run starts collecting where it starts metering (the backfill floor, 46 h back), and records no gap:
    // nothing was due before the first priced sweep.
    const windowEnd = Math.floor((T0 - 20_000) / MINUTE) * MINUTE;
    expect((await w2.meta())?.collectingSince).toBe(new Date(windowEnd - MAX_BACKFILL_MS).toISOString());
    expect((await w2.meta())?.gaps).toBeUndefined();
  });

  it('a first run reaches back as far as the estate allows in one sweep: a day for a small one, an hour at scale', () => {
    expect(firstRunSeedMs(0)).toBe(FIRST_RUN_SEED_MS);
    expect(firstRunSeedMs(10)).toBe(FIRST_RUN_SEED_MAX_MS);
    expect(FIRST_RUN_SEED_MAX_MS).toBe(DAY);
    expect(firstRunSeedMs(200)).toBe(600 * MINUTE);
    expect(firstRunSeedMs(2000)).toBe(HOUR);
    expect(firstRunSeedMs(20_000)).toBe(HOUR);
  });

  it('meters one new minute per steady-state sweep and rewrites the minute before', async () => {
    const w = await createWorld();
    await w.sweep();
    for (let i = 1; i <= 5; i++) {
      const { r, journal } = await nextMinute(w);
      expect(r.error).toBeUndefined();
      expect(r.minutesProcessed).toBe(1);
      expect(r.backfilledMinutes).toBe(0);
      expect(r.calls).toBe(journal);
      expect(r.calls).toBeLessThanOrEqual(DEFAULT_SWEEP_BUDGET);
    }
    const doc = await minuteDoc(w, T0);
    expect(doc?.flows[PAY_FLOW]).toHaveLength(5);
    const totals = await w.docs.getTotals();
    expect(totals?.byDay['2026-09-28']?.minutes).toBe(65);
    expect((await w.meta())?.sweepCount).toBe(6);
  });

  it("skips cheaply in ui mode until a new minute completes ('current', one call)", async () => {
    const w = await createWorld();
    await w.sweep();
    w.advance(30_000);
    const { r, journal } = await countedSweep(w, 'ui');
    expect(r.skipped).toBe('current');
    expect(r.calls).toBe(1);
    expect(journal).toBe(1);
    // "Sweep now" in the same minute still runs: it rewrites the last minute, meters nothing new.
    const m = await w.sweep('manual');
    expect(m.skipped).toBeUndefined();
    expect(m.minutesProcessed).toBe(0);
    expect((await w.meta())?.lastSweepMode).toBe('manual');
  });

  it("returns 'locked' while another owner holds an unexpired lock, and proceeds once it expires", async () => {
    const w = await createWorld();
    await w.docs.acquireLock('tab-b', LOCK_TTL_MS);
    const r = await w.sweep();
    expect(r.skipped).toBe('locked');
    w.advance(LOCK_TTL_MS + 1_000);
    const r2 = await w.sweep();
    expect(r2.skipped).toBeUndefined();
    expect(r2.minutesProcessed).toBeGreaterThan(0);
  });

  it('the release build never reads demo/state', async () => {
    const w = await createWorld({ build: 'release' });
    w.em.resetCalls();
    await w.sweep('scheduled');
    const paths = w.em.calls().recent.map((e) => e.path);
    expect(paths.some((p) => p.includes('demo'))).toBe(false);
    expect((await w.meta())?.build).toBe('release');
  });

  it('tolerates a loosely typed caller (the UI binds runSweep dynamically) by filling defaults', async () => {
    const w = await createWorld();
    const loose = {
      http: w.http,
      kv: w.kv,
      webhook: w.webhook,
      clock: w.deps.clock,
      codec: w.deps.codec,
    } as unknown as Parameters<typeof runSweep>[0];
    const r = await runSweep(loose, { mode: 'ui', nowMs: w.now() });
    expect(r.error).toBeUndefined();
    const meta = await w.meta();
    expect(meta?.appVersion).toBe('0.0.0');
    expect(meta?.build).toBe('release');
  });
});

// ─── Late data, backfill, folds, expiry ──────────────────────────────────────
describe('runSweep — late data and backfill', () => {
  it('rewrites minute N−1 with its settled value and keeps totals equal to the sum of rows', async () => {
    const holder: { late?: ReturnType<typeof lateDataHttp> } = {};
    const w = await createWorld({
      wrapHttp: (h) => (holder.late = lateDataHttp(h)),
    });
    await w.sweep();
    const first = (await minuteDoc(w, T0 - HOUR))?.flows[PAY_FLOW]?.find((r) => r.t === '2026-09-28T14:59:00.000Z');
    await nextMinute(w);
    const rewritten = (await minuteDoc(w, T0 - HOUR))?.flows[PAY_FLOW]?.find((r) => r.t === '2026-09-28T14:59:00.000Z');
    expect(holder.late!.halved).toContain(Date.UTC(2026, 8, 28, 14, 59));
    expect(rewritten!.inB).toBeGreaterThan(first!.inB * 1.9);
    // Totals track the rows exactly (no double count, no lost correction).
    const docs = [await minuteDoc(w, T0 - HOUR), await minuteDoc(w, T0)];
    const all = sumRows(docs, () => true);
    const day = (await w.docs.getTotals())?.byDay['2026-09-28'];
    expect(day?.savedM).toBe(all.savedM);
    expect(day?.whpM).toBe(all.whpM);
    expect(day?.paidM).toBe(all.paidM);
    expect(day?.minutes).toBe(61);
  });

  it('a rewrite after a pack moved the route never counts the minute twice', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(1);
    w.advance(5_000);
    const { applyPack } = await import('../../core/demo/levers.ts');
    expect((await applyPack(w.lever, { routeId: 'mrd_windows_workstations' })).ok).toBe(true);
    await w.sweepMinutes(3);
    const docs = [await minuteDoc(w, T0 - HOUR), await minuteDoc(w, T0)];
    const packKey = 'default|mrd_windows_workstations|mrd_windows_workstations|mrd_win_xml_pack|mrd_siem_prod';
    const rawKey = 'default|mrd_windows_workstations|mrd_windows_workstations|mrd_passthrough|mrd_siem_prod';
    const minutes = new Map<string, number>();
    for (const d of docs)
      for (const k of [packKey, rawKey]) for (const r of d?.flows[k] ?? []) minutes.set(r.t, (minutes.get(r.t) ?? 0) + 1);
    expect([...minutes.values()].every((n) => n === 1)).toBe(true);
    expect(docs[1]?.flows[packKey]?.length).toBeGreaterThan(0);
    const all = sumRows(docs, () => true);
    expect((await w.docs.getTotals())?.byDay['2026-09-28']?.savedM).toBe(all.savedM);
  });

  it('backfills every minute of a 3-hour gap, folds the completed hours, and marks catch-up incidents', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(12); // warm every route (warm-up 10 samples) through 15:12
    // A member breaks the trim in the Cribl UI while no tab is open.
    w.em.control({
      action: 'breakTrim',
      at: Date.UTC(2026, 8, 28, 16, 30, 10),
    });
    w.set(Date.UTC(2026, 8, 28, 18, 12, 20));
    const r = await w.sweep();
    expect(r.error).toBeUndefined();
    expect(r.minutesProcessed).toBe(180);
    expect(r.backfilledMinutes).toBe(179);
    const reg = r.snapshot?.incidents.find((i) => i.type === 'regression' && i.objectKey === PAY_ROUTE);
    expect(reg).toBeDefined();
    expect(reg!.notes).toContain(CATCH_UP_NOTE);
    // Opened at the minute it was caught (16:32 = end of the first regressed minute 16:31), not at sweep time.
    expect(reg!.openedAt).toBe('2026-09-28T16:32:00.000Z');
    expect(reg!.cause).toBe('commit');
    // Hour folds: 15:00, 16:00 and 17:00 are complete.
    const hourDoc = await w.docs.getRollHour('2026-09-28');
    const hours = (hourDoc?.flows[PAY_FLOW] ?? []).map((h) => h.t);
    expect(hours).toEqual(['2026-09-28T14:00:00.000Z', '2026-09-28T15:00:00.000Z', '2026-09-28T16:00:00.000Z', '2026-09-28T17:00:00.000Z']);
    expect(hourDoc?.flows[PAY_FLOW]?.find((h) => h.t === '2026-09-28T16:00:00.000Z')?.samples).toBe(60);
    expect((await w.docs.getTotals())?.byDay['2026-09-28']?.minutes).toBe(60 + 12 + 180);
  });

  it('folds the day into roll/day once its last hour completes', async () => {
    const w = await createWorld({ start: Date.UTC(2026, 8, 28, 23, 30, 20) });
    await w.sweep();
    w.set(Date.UTC(2026, 8, 29, 0, 1, 20));
    const r = await w.sweep();
    expect(r.error).toBeUndefined();
    const dayDoc = await w.docs.getRollDay('2026-09');
    expect(dayDoc?.flows[PAY_FLOW]?.map((d) => d.t)).toEqual(['2026-09-28T00:00:00.000Z']);
  });

  it('expires dated keys past retention at most once an hour', async () => {
    const w = await createWorld();
    const old = new Date(T0 - 30 * HOUR).toISOString().slice(0, 13);
    await w.docs.putRollMinute(old, {
      schemaVersion: 1,
      bucketStart: `${old}:00:00.000Z`,
      flows: {},
    });
    await w.docs.putIncidents('2026-08-01', { schemaVersion: 1, items: [] });
    // The first run is heavy, so its pass has room for part of the work: a delete is one call now that the listings
    // name every chunk (P1-E08). Every pass is stamped; what one had no room for is meta.expiryBacklog, which the next
    // sweeps continue.
    await w.sweep();
    let sweeps = 0;
    const pending = async (): Promise<boolean> => {
      const m = await w.meta();
      return !m?.lastExpiredAt || (m.expiryBacklog ?? 0) > 0;
    };
    while ((await pending()) && sweeps < 5) {
      await nextMinute(w);
      sweeps++;
    }
    expect(await w.docs.getRollMinute(old)).toBeNull();
    expect(await w.docs.getIncidents('2026-08-01')).toBeNull();
    const meta = await w.meta();
    expect(meta?.lastExpiredAt).toBe(new Date(T0 + sweeps * MINUTE).toISOString());
    // Within the hour: no key listing.
    const { routes } = await nextMinute(w);
    expect(routes['POST /kvstore/keys'] ?? 0).toBe(0);
    expect(expiredKeys([`roll/min/${old}`], w.now())).toEqual([`roll/min/${old}`]);
  });
});

// ─── Detection, commits, notifications ───────────────────────────────────────
describe('runSweep — detection and notifications', () => {
  it('break → regression naming the lever commit → webhook → restore → recovered', async () => {
    const w = await createWorld();
    await w.sweep();
    await w.sweepMinutes(2);
    w.advance(10_000);
    const lever = await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' });
    expect(lever.ok).toBe(true);
    const results = await w.sweepMinutes(3);
    const opened = results.find((r) => r.opened > 0);
    expect(opened?.notified).toBe(1);
    const inc = opened!.snapshot!.incidents.find((i) => i.objectKey === PAY_ROUTE)!;
    expect(inc.type).toBe('regression');
    expect(inc.severity).toBe('high');
    expect(inc.cause).toBe('commit');
    expect(inc.commit?.hash).toBe(lever.ok ? lever.commit : '');
    expect(inc.commit?.author).toBe('s.koelpin');
    expect(inc.label).toBe('Payments API sampling');
    expect(inc.notes).toContain('demo-profile');
    expect(inc.before).toBeCloseTo(0.75, 1);
    expect(inc.after).toBeCloseTo(0.5, 1);
    expect(inc.impactPerDayM).toBeGreaterThan(2_000_000);
    expect(inc.deliveries).toEqual([expect.objectContaining({ endpointId: SINK_ENDPOINT.id, status: 200 })]);
    expect(inc.lastNotifiedAt).toBeDefined();
    const sink = w.em.sink();
    expect(sink[0].host).toBe('webhook.site');
    expect(sink[0].json).toMatchObject({
      event: 'incident.opened',
      app: 'meter-reader',
      workspace: 'main-example-org',
      incident: {
        title: 'Savings dropped: Payments API sampling',
        cause: 'commit',
      },
    });
    expect(opened!.snapshot!.flows.find((f) => f.key === PAY_FLOW)?.state).toBe('regression');
    // Persisted: the incident doc and the delivery log.
    const doc = await w.docs.getIncidents(inc.openedAt.slice(0, 10));
    expect(doc?.items.map((i) => i.id)).toContain(inc.id);
    expect((await w.docs.getNotifyLog())?.items.at(-1)).toMatchObject({
      endpointId: SINK_ENDPOINT.id,
      event: 'incident.opened',
      status: 200,
    });
    // Restore: the incident closes itself through the recovery rule and the sink hears about it.
    w.em.control({ action: 'restore' });
    const after = await w.sweepMinutes(3);
    const closed = after.find((r) => r.closed > 0);
    expect(closed).toBeDefined();
    expect(w.em.sink()[0].json).toMatchObject({ event: 'incident.closed' });
  });

  it('refreshes the timeline once before accepting an unmatched regression, then names the commit', async () => {
    const w = await createWorld({ sweep: { timelineEveryMin: 0 } });
    await w.sweep();
    await w.sweepMinutes(2);
    const { commits } = w.em.control({ action: 'breakTrim' }) as {
      commits: { hash: string }[];
    };
    w.em.resetCalls();
    const results = await w.sweepMinutes(3);
    const opened = results.find((r) => r.opened > 0)!;
    const inc = opened.snapshot!.incidents.find((i) => i.objectKey === PAY_ROUTE)!;
    expect(inc.cause).toBe('commit');
    expect(inc.severity).toBe('high');
    expect(inc.commit?.hash).toBe(commits[0].hash);
    expect(w.em.calls().byRoute['GET /m/:gid/version']).toBe(1);
  });

  it('honors endpoint filters: disabled endpoints and minSeverity above the incident send nothing', async () => {
    const w = await createWorld({
      settings: (s) => {
        s.notifications = [
          { ...SINK_ENDPOINT, id: 'off', enabled: false },
          { ...SINK_ENDPOINT, id: 'high-only', minSeverity: 'high' },
        ];
        s.demo.profile = true;
      },
      sweep: { timelineEveryMin: 0 },
    });
    await w.sweep();
    await w.sweepMinutes(2);
    // Hide the commit from the timeline refresh so the regression stays 'medium'.
    const inner = w.deps.http;
    const hidden: CriblHttp = {
      request: (m, p, b, o) =>
        p.startsWith('/m/default/version') ? Promise.resolve({ status: 403, ok: false, text: 'forbidden' }) : inner.request(m, p, b, o),
    };
    w.em.control({ action: 'breakTrim' });
    const results = await w.sweepMinutes(3, { http: hidden });
    const opened = results.find((r) => r.opened > 0)!;
    expect(opened.snapshot!.incidents[0].severity).toBe('medium');
    expect(opened.notified).toBe(0);
    expect(w.em.sink()).toHaveLength(0);
    expect(w.logs.some((l) => l.level === 'warn' && l.msg.includes('timeline refresh'))).toBe(true);
  });

  it('re-notifies an open incident after the cooldown, and records a refused host without retrying forever', async () => {
    const w = await createWorld({
      settings: (s) => {
        s.thresholds.cooldownMinutes = 3;
        s.notifications = [
          SINK_ENDPOINT,
          {
            ...SINK_ENDPOINT,
            id: 'denied',
            url: 'https://relay.example.com/hook',
            host: 'relay.example.com',
          },
        ];
      },
    });
    await w.sweep();
    await w.sweepMinutes(2);
    await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' });
    const results = await w.sweepMinutes(8);
    const sent = w.em.sink().filter((e) => (e.json as { incident?: { id: string } })?.incident);
    const events = sent.map((e) => (e.json as { event: string }).event).reverse();
    expect(events[0]).toBe('incident.opened');
    expect(events).toContain('incident.updated');
    const last = results.at(-1)!.snapshot!.incidents[0];
    expect(last.deliveries.some((d) => d.endpointId === 'denied' && d.status === 403 && d.error === 'host_not_authorized')).toBe(true);
    // A 403 is not retried: one attempt per notification.
    const log = (await w.docs.getNotifyLog())!.items.filter((i) => i.endpointId === 'denied');
    expect(log.every((i) => i.attempt === 1)).toBe(true);
  });

  it('a dead webhook cannot keep a minute from being recorded: sending stops at the notification budget', async () => {
    // Each dead endpoint costs one 10 s timeout a sweep (P1-E07), so it takes six to reach the 45 s budget.
    const dead = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
      ...SINK_ENDPOINT,
      id: `dead-${id}`,
      url: `https://dead-${id}.example.com/hook`,
      host: `dead-${id}.example.com`,
    }));
    const w = await createWorld({ settings: (s) => void (s.notifications = dead) });
    await w.sweep();
    await w.sweepMinutes(2);
    await breakTrim(w.lever, { pipelineId: 'mrd_pay_sample' });
    // Every attempt hangs for its full 10 s timeout, then fails.
    const webhook = {
      post: async () => {
        w.advance(10_000);
        return { status: 0, error: 'timeout after 10000 ms' };
      },
    };
    const results = await w.sweepMinutes(3, { webhook });
    const opened = results.find((r) => r.opened > 0)!;
    expect(opened.error).toBeUndefined();
    expect(opened.notified).toBe(0);
    const inc = opened.snapshot!.incidents.find((i) => i.objectKey === PAY_ROUTE)!;
    expect(inc.deliveries.map((d) => d.endpointId)).toEqual(['dead-a', 'dead-b', 'dead-c', 'dead-d', 'dead-e']);
    expect(inc.deliveries.every((d) => d.status === 0)).toBe(true);
    expect(w.logs.some((l) => l.msg.includes('notification time budget spent'))).toBe(true);
    // Persisted despite the dead endpoints: the incident, and the minute cursor moved on.
    expect((await w.docs.getIncidents(inc.openedAt.slice(0, 10)))!.items.some((i) => i.id === inc.id)).toBe(true);
    const last = results.at(-1)!;
    expect((await w.meta())!.meteredThrough).toBe(last.meta!.meteredThrough);
    expect(Date.parse(last.meta!.meteredThrough!)).toBeGreaterThan(Date.parse(opened.meta!.meteredThrough!));
    // A failed attempt never starts the cooldown clock (REVIEW-3a #2): no lastNotifiedAt, only lastAttemptAt.
    const stored = (await w.docs.getIncidents(inc.openedAt.slice(0, 10)))!.items.find((i) => i.id === inc.id)!;
    expect(stored.lastNotifiedAt).toBeUndefined();
    expect(stored.lastAttemptAt).toBeDefined();
  });

  it('opens a budget-pace incident when the destination is on course to overspend', async () => {
    // $5 a month: the SPEC 9.3 pace (month-to-date paid ÷ minutes elapsed in the month × minutes in the month)
    // crosses it about 27 metered minutes into the seed hour.
    const w = await createWorld({
      settings: (s) => void (s.budgets = { mrd_siem_prod: { centsPerMonth: 500 } }),
    });
    const r = await w.sweep();
    const inc = r.snapshot!.incidents.find((i) => i.type === 'budget');
    expect(inc).toMatchObject({
      objectKey: 'out:default:mrd_siem_prod',
      severity: 'high',
      outputId: 'mrd_siem_prod',
    });
    expect(inc!.after).toBeGreaterThan(100);
    expect(inc!.notes).toContain(CATCH_UP_NOTE);
  });
});

// ─── Failures ────────────────────────────────────────────────────────────────
describe('runSweep — failures', () => {
  it('a 403 on the metrics query fails the sweep without advancing; the next sweep catches up', async () => {
    const w = await createWorld();
    await w.sweep();
    const denied = faultHttp(w.deps.http, (m, p) => m === 'POST' && p.startsWith('/system/metrics/query'), 403, 3);
    const { r } = await nextMinute(w, { http: denied });
    expect(r.error).toMatch(/metrics .* query failed: HTTP 403/);
    const meta = (await w.meta())!;
    expect(meta.sweepErrors).toBe(1);
    expect(meta.lastError).toBe(r.error);
    expect(meta.meteredThrough).toBe('2026-09-28T15:00:00.000Z');
    const lock = await w.docs.getLock();
    expect(Date.parse(lock!.expiresAt)).toBeLessThanOrEqual(w.now());
    const { r: r2 } = await nextMinute(w);
    expect(r2.error).toBeUndefined();
    expect(r2.minutesProcessed).toBe(2);
    expect((await w.meta())!.lastError).toBeUndefined();
  });

  it('never creates meta from a failed first sweep', async () => {
    const w = await createWorld({
      wrapHttp: (h) => faultHttp(h, (m, p) => p.startsWith('/system/metrics/query'), 403, 3),
    });
    const r = await w.sweep();
    expect(r.error).toBeDefined();
    expect(await w.meta()).toBeNull();
  });

  it('keeps the stored inventory when a config read fails, and fails cleanly with none', async () => {
    const w = await createWorld({
      wrapHttp: (h) => faultHttp(h, (_m, p) => p === '/m/default/system/inputs', 500, 1),
    });
    const r = await w.sweep();
    expect(r.error).toMatch(/no inventory/);
    const r2 = await w.sweep('manual');
    expect(r2.error).toBeUndefined();
    const w2 = await createWorld();
    await w2.sweep();
    const f = faultHttp(w2.deps.http, (_m, p) => p === '/m/default/pipelines', 500, 1);
    const r3 = await w2.sweep('manual', { http: f });
    expect(r3.error).toBeUndefined();
    expect(f.hits).toBe(1);
    expect(w2.logs.some((l) => l.msg.includes('inventory for default failed'))).toBe(true);
  });

  it('keeps the known groups when listing worker groups fails', async () => {
    const w = await createWorld();
    await w.sweep();
    const f = faultHttp(w.deps.http, (_m, p) => p === '/products/stream/groups', 500, 1);
    const r = await w.sweep('manual', { http: f });
    expect(r.error).toBeUndefined();
    expect(f.hits).toBe(1);
    expect(w.logs.some((l) => l.msg.includes('listing worker groups failed'))).toBe(true);
  });

  it('one 429 is retried after 5 s and changes nothing; two stop the sweep as rate_limited and back off (P1-E01)', async () => {
    const w = await createWorld();
    await w.sweep();
    const once = faultHttp(w.deps.http, (m, p) => m === 'POST' && p.startsWith('/system/metrics/query'), 429, 1);
    w.set(T0 + MINUTE);
    const r = await w.sweep('ui', { http: once });
    expect(r.error).toBeUndefined();
    expect(w.now()).toBe(T0 + MINUTE + 5_000);
    // A lone 429 the retry got past is contention, not a limit: no back-off, the next sweep runs and ends the streak.
    expect(r.rateLimit).toMatchObject({ streak: 1 });
    expect(r.rateLimit?.until).toBeUndefined();
    w.set(T0 + 2 * MINUTE);
    const clean = await w.sweep();
    expect(clean.skipped).toBeUndefined();
    expect(clean.rateLimit).toBeUndefined();
    expect((await w.meta())!.consecutiveRateLimited).toBe(0);

    // Three stopped sweeps, each after the back-off the one before scheduled: 2, then 4 minutes skipped.
    let at = T0 + 3 * MINUTE;
    for (let i = 1; i <= 3; i++) {
      const twice = faultHttp(w.deps.http, (m, p) => m === 'POST' && p.startsWith('/system/metrics/query'), 429, 2);
      w.set(at);
      const rl = await w.sweep('ui', { http: twice });
      expect(rl.skipped).toBe('rate_limited');
      expect(rl.error).toBe('rate_limited');
      const meta = (await w.meta())!;
      expect(meta.consecutiveRateLimited).toBe(i);
      expect(meta.lastError).toBe('rate_limited');
      expect(meta.rateLimitedSince).toBe(new Date(T0 + 3 * MINUTE).toISOString());
      const until = Date.parse(meta.rateLimitedUntil!);
      expect(until).toBe(Math.floor(at / MINUTE) * MINUTE + ([2, 4, 8][i - 1] + 1) * MINUTE);
      // Inside the back-off the sweep makes no call and says it is rate limited.
      w.set(until - 30_000);
      const held = await countedSweep(w);
      expect(held.r).toMatchObject({ skipped: 'backoff', error: 'rate_limited', calls: 0 });
      expect(held.journal).toBe(0);
      at = until + 20_000;
    }
    expect((await w.meta())!.inventoryRefreshEveryMin).toBe(20);
    w.set(at);
    const ok = await w.sweep();
    expect(ok.error).toBeUndefined();
    expect(ok.minutesProcessed).toBeGreaterThan(10); // the whole back-off, backfilled
    const meta = (await w.meta())!;
    expect(meta.meteredThrough).toBe(new Date(Math.floor((at - 20_000) / MINUTE) * MINUTE).toISOString());
    expect(meta.consecutiveRateLimited).toBe(0);
    expect(meta.rateLimitedSince).toBeUndefined();
    expect(meta.rateLimitedUntil).toBeUndefined();
    expect(meta.inventoryRefreshEveryMin).toBe(20);
  });

  it('a 429 before the lock is taken stops quietly with nothing to release', async () => {
    const w = await createWorld();
    const kv: KvStore = {
      ...w.kv,
      get: () => Promise.reject(new KvHttpError('GET', 'meta', 429)),
    };
    const r = await w.sweep('ui', { kv });
    expect(r.skipped).toBe('rate_limited');
    const r2 = await w.sweep('ui', {
      kv: { ...w.kv, get: () => Promise.reject(new Error('socket hang up')) },
    });
    expect(r2.error).toBe('socket hang up');
    const r3 = await w.sweep('ui', { budget: 0 });
    expect(r3.skipped).toBe('budget');
  });

  it('abandons writes past the 100 s time budget and only counts the error', async () => {
    const w = await createWorld();
    await w.sweep();
    const slow: CriblHttp = {
      request: async (m, p, b, o) => {
        if (m === 'POST' && p.startsWith('/system/metrics/query')) w.advance(101_000 / 3);
        return w.deps.http.request(m, p, b, o);
      },
    };
    w.set(T0 + MINUTE + 20_000);
    const r = await w.sweep('ui', { http: slow });
    expect(r.error).toBe('time_budget');
    const meta = (await w.meta())!;
    expect(meta.sweepErrors).toBe(1);
    expect(meta.meteredThrough).toBe('2026-09-28T15:00:00.000Z');
    expect((await minuteDoc(w, T0))?.flows[PAY_FLOW]).toBeUndefined();
  });

  it('stops with skipped budget when a hard budget is too small for the work', async () => {
    const w = await createWorld();
    const r = await w.sweep('ui', { budget: 12 });
    expect(r.skipped).toBe('budget');
    expect(r.error).toBe('budget');
  });

  it('records a lock-release failure without failing the sweep', async () => {
    const w = await createWorld();
    let puts = 0;
    const kv: KvStore = {
      ...w.kv,
      put: async (k, v) => {
        if (k === 'lock/meter' && ++puts === 2) throw new Error('release failed');
        return w.kv.put(k, v);
      },
    };
    const r = await w.sweep('ui', { kv });
    expect(r.error).toBeUndefined();
    expect(w.logs.some((l) => l.msg.includes('lock release failed'))).toBe(true);
  });
});

// ─── Call budget (S16 in unit form) ──────────────────────────────────────────
describe('runSweep — call budget', () => {
  it('stays within 35 Leader calls on every steady-state sweep for 70 minutes (refreshes, folds, expiry, an incident)', async () => {
    const w = await createWorld({ sweep: { budget: DEFAULT_SWEEP_BUDGET } });
    await w.sweep('ui', { budget: undefined });
    const seen = new Set<string>();
    let worst = 0;
    for (let i = 0; i < 70; i++) {
      if (i === 30) w.em.control({ action: 'breakTrim' });
      if (i === 40) w.em.control({ action: 'restore' });
      const { r, journal, routes } = await nextMinute(w);
      expect(r.error).toBeUndefined();
      expect(r.calls).toBe(journal);
      expect(r.calls).toBeLessThanOrEqual(DEFAULT_SWEEP_BUDGET);
      worst = Math.max(worst, r.calls);
      for (const k of Object.keys(routes)) seen.add(k);
    }
    // The measured sweeps included every kind of optional work.
    expect(seen).toContain('GET /m/:gid/system/inputs');
    expect(seen).toContain('GET /m/:gid/version');
    expect(seen).toContain('POST /kvstore/keys');
    expect(seen).toContain('POST webhook.site');
    expect(worst).toBeGreaterThan(20);
  });
});

// ─── Runtimes ────────────────────────────────────────────────────────────────
describe('core/runtime', () => {
  it('derives the workspace and the Ledger link base from the Leader URL', () => {
    expect(workspaceFromUrl('https://main-example-org.cribl.cloud/api/v1')).toBe('main-example-org');
    expect(workspaceFromUrl('https://leader.example.com:9000/api/v1')).toBe('leader.example.com');
    expect(workspaceFromUrl(undefined)).toBe('');
    expect(workspaceFromUrl('/api/v1')).toBe('');
    // Founder-build r1 core-8 (M10 #34, C2): always the shell's `/apps/a/<app>`, whatever the iframe's base path — a
    // `/app-ui/…` link clicked in Slack's web client, Gmail or PagerDuty opened the bare iframe page outside Cribl.
    expect(linkBaseFrom('https://main-x.cribl.cloud/api/v1', '/app-ui/meter-reader/')).toBe(`https://main-x.cribl.cloud/apps/a/${APP_ID}`);
    expect(linkBaseFrom('https://main-x.cribl.cloud/api/v1', undefined)).toBe(`https://main-x.cribl.cloud/apps/a/${APP_ID}`);
    expect(linkBaseFrom('https://main-x.cribl.cloud/api/v1', 'app-ui/x')).toBe(`https://main-x.cribl.cloud/apps/a/${APP_ID}`);
    expect(linkBaseFrom(undefined, '/app-ui/x/')).toBe(`/apps/a/${APP_ID}`);
    expect(APP_ID).toBe('meter-reader');
  });

  it('builds lock owners and a console logger', () => {
    expect(createOwnerId('ui', { crypto: { randomUUID: () => 'abc' } })).toBe('ui:abc');
    expect(createOwnerId('backend', {})).toMatch(/^backend:[a-z0-9]+-[a-z0-9]+$/);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logger = createConsoleLogger('[t]');
    logger.info('hello');
    logger.warn('careful', { a: 1 });
    expect(info).toHaveBeenCalledWith('[t] hello');
    expect(warn).toHaveBeenCalledWith('[t] careful', { a: 1 });
    info.mockRestore();
    warn.mockRestore();
  });

  it('createBrowserDeps meters through CRIBL_API_URL end to end (KV, metrics, webhooks)', async () => {
    const w = await createWorld();
    const fetch = emulatorFetch(w.em);
    expect(() => createBrowserDeps({}, { appVersion: '1.0.0', build: 'demo' })).toThrow(/CRIBL_API_URL/);
    const deps = createBrowserDeps(
      {
        CRIBL_API_URL: 'https://main-example-org.cribl.cloud/mock-api/v1/',
        CRIBL_BASE_PATH: '/app-ui/meter-reader',
        fetch,
        crypto: { randomUUID: () => 'tab1' },
      },
      { appVersion: '1.2.3', build: 'demo', budget: 60, logger: w.deps.logger },
    );
    expect(deps.owner).toBe('ui:tab1');
    expect(deps.runtime).toBe('ui');
    expect(deps.workspace).toBe('main-example-org');
    expect(deps.linkBase).toBe('https://main-example-org.cribl.cloud/apps/a/meter-reader');
    expect(deps.budget).toBe(60);
    const r = await runSweep({ ...deps, clock: w.deps.clock, sleep: w.deps.sleep }, { mode: 'ui' });
    expect(r.error).toBeUndefined();
    expect(r.minutesProcessed).toBe(60);
    expect((await w.meta())?.appVersion).toBe('1.2.3');
  });

  it('createBackendDeps uses relative /api/v1 and finds fetch at call time', async () => {
    const w = await createWorld();
    const seen: string[] = [];
    const fetch = emulatorFetch(w.em);
    vi.stubGlobal('fetch', (url: string, init: never) => {
      seen.push(url);
      return fetch(url, init);
    });
    try {
      const deps = createBackendDeps({
        requestUrl: 'https://main-x.cribl.cloud/api/v1/a/meter-reader/endpoints/meter',
        appVersion: '9.9.9',
        build: 'release',
        budget: 99,
      });
      expect(deps.runtime).toBe('backend');
      expect(deps.owner).toMatch(/^backend:/);
      expect(deps.workspace).toBe('main-x');
      expect(deps.linkBase).toBe(`https://main-x.cribl.cloud/apps/a/${APP_ID}`);
      const r = await runSweep({ ...deps, clock: w.deps.clock, sleep: w.deps.sleep }, { mode: 'scheduled' });
      expect(r.error).toBeUndefined();
      expect(seen.every((u) => u.startsWith(`${BACKEND_API_BASE}/`))).toBe(true);
      const defaults = createBackendDeps();
      expect(defaults.appVersion).toBe('0.0.0');
      expect(defaults.build).toBe('release');
      expect(defaults.workspace).toBe('');
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal('fetch', undefined);
    try {
      expect(() => createBackendDeps()).toThrow(/fetch is not available/);
      expect(() => createBrowserDeps({ CRIBL_API_URL: 'https://x/api/v1' }, { appVersion: '1', build: 'release' })).toThrow(
        /fetch is not available/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leverDepsFrom carries the transports, the author and the lock owner', async () => {
    const w = await createWorld();
    const ld = leverDepsFrom(w.deps, 'alice', { minuteBudget: 40 });
    expect(ld).toMatchObject({
      author: 'alice',
      owner: 'tab-a',
      minuteBudget: 40,
      http: w.deps.http,
      kv: w.deps.kv,
    });
    expect(ld.sleep).toBe(w.deps.sleep);
    const bare = leverDepsFrom({ ...w.deps, sleep: undefined }, 'bob');
    expect(bare.sleep).toBeUndefined();
  });
});
