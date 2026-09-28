// tests/unit/sweep-rate-limit.test.ts — a Leader that rate-limits the meter (EPIC_AUDIT P1-E01).
//
// Before: at 15 calls a minute every sweep spent 20–24 calls and was stopped by the second 429, every minute, forever
// (1,253 calls an hour, 0 minutes metered); the failure was never recorded because the meta write and the lock release
// went through the same exhausted window, so meta.consecutiveRateLimited stayed 0 and the lock stayed held for its
// TTL; and the one retry waited 5 s whatever the Leader's Retry-After said.
//
// Now the retry waits out Retry-After (at most 60 s), a stopped sweep waits for the window before it records the
// failure and releases the lock, and stopped sweeps back off — the next 2, 4, 8, then 16 minutes are skipped, with no
// Leader call while the runtime remembers it and one meta read when only meta does.

import { describe, expect, it } from 'vitest';
import type { CriblHttp, HttpResult, KvStore } from '../../core/types.ts';
import { RETRY_AFTER_MAX_MS, RateLimited, parseRetryAfter, retryWaitMs } from '../../core/http.ts';
import { KvHttpError, createMemoryKvStore } from '../../core/kv.ts';
import {
  RATE_LIMIT_BACKOFF_MIN,
  backoffMinutes,
  createMeteredTransport,
  nextRateLimit,
  windowWaitMs,
  type SweepResult,
} from '../../core/sweep.ts';
import { HOUR, MINUTE, T0, createWorld, type World } from '../integration/harness.ts';

const clock = { now: () => T0 };
const quiet = (s: { demo: unknown }): void => void (s.demo = { enabled: false, replayMode: false, profile: false });

/** The Leader's per-minute limit for this credential (0 lifts it). */
const limit = (w: World, perMinute: number): void => void w.em.control({ action: 'config', options: { rateLimitPerMinute: perMinute } });

/** Reads lock/meter outside the limiter (the test's own read must not spend the meter's window). */
async function lockAfter(w: World, perMinute: number): Promise<{ owner: string; expiresAt: string } | null> {
  limit(w, 0);
  const lock = await w.docs.getLock();
  limit(w, perMinute);
  return lock;
}

describe('P1-E01 — Retry-After', () => {
  it('reads delta-seconds and HTTP dates, and caps the in-place wait at 60 s', () => {
    expect(parseRetryAfter('40', T0)).toBe(40_000);
    expect(parseRetryAfter(' 1.5 ', T0)).toBe(1_500);
    expect(parseRetryAfter(new Date(T0 + 12_000).toUTCString(), T0)).toBe(12_000);
    expect(parseRetryAfter(new Date(T0 - 12_000).toUTCString(), T0)).toBe(0);
    expect(parseRetryAfter('soon', T0)).toBeUndefined();
    expect(parseRetryAfter(undefined, T0)).toBeUndefined();
    expect(retryWaitMs(undefined, 5_000)).toBe(5_000);
    expect(retryWaitMs(40_000, 5_000)).toBe(40_000);
    expect(retryWaitMs(0, 5_000)).toBe(1_000);
    expect(retryWaitMs(RETRY_AFTER_MAX_MS + 1, 5_000)).toBeUndefined();
    // A stopped sweep waits for the window: the Leader's word, else the next minute (+1 s), never more than 60 s.
    expect(windowWaitMs(25_000, T0)).toBe(25_000);
    expect(windowWaitMs(undefined, T0)).toBe(MINUTE - 20_000 + 1_000);
    expect(windowWaitMs(600_000, T0)).toBe(RETRY_AFTER_MAX_MS);
  });

  it('the one retry waits out the Retry-After of an HTTP answer or a KV error; one over 60 s is not waited for', async () => {
    const sleeps: number[] = [];
    const answers: HttpResult[] = [
      { status: 429, ok: false, headers: { 'retry-after': '40' } },
      { status: 200, ok: true, json: {} },
      { status: 429, ok: false, headers: { 'retry-after': '120' } },
    ];
    const http: CriblHttp = { request: async () => answers.shift() ?? { status: 200, ok: true } };
    const t = createMeteredTransport(http, createMemoryKvStore(), { clock, sleep: async (ms) => void sleeps.push(ms) });
    expect((await t.http.request('GET', '/a')).status).toBe(200);
    expect(sleeps).toEqual([40_000]);
    const second = await t.http.request('GET', '/b').catch((e: unknown) => e);
    expect(second).toBeInstanceOf(RateLimited);
    expect((second as RateLimited).retryAfterMs).toBe(120_000);
    expect(t.limitHits()).toBe(2);

    const kvSleeps: number[] = [];
    let refuse = 1;
    const kv: KvStore = {
      ...createMemoryKvStore(),
      get: async () => {
        if (refuse-- > 0) throw new KvHttpError('GET', 'meta', 429, 'slow down', 30_000);
        return null;
      },
    };
    const k = createMeteredTransport({ request: async () => ({ status: 200, ok: true }) }, kv, { clock, sleep: async (ms) => void kvSleeps.push(ms) });
    expect(await k.kv.get('meta')).toBeNull();
    expect(kvSleeps).toEqual([30_000]);
    // A single long Retry-After stops at once: no doomed retry.
    const long = createMeteredTransport({ request: async () => ({ status: 429, ok: false, headers: { 'retry-after': '90' } }) }, createMemoryKvStore(), {
      clock,
      sleep: async () => {
        throw new Error('must not wait');
      },
    });
    await expect(long.http.request('GET', '/c')).rejects.toBeInstanceOf(RateLimited);
    expect(long.calls()).toBe(1);
  });

  it('a sweep whose 429 names a Retry-After waits it out and meters the minute; a lone 429 schedules no back-off', async () => {
    const w = await createWorld({ settings: quiet });
    await w.sweep();
    let limited = 0;
    const retryAfter: CriblHttp = {
      async request(m, p, b, o) {
        if (limited === 0 && m === 'POST' && p.startsWith('/system/metrics/query')) {
          limited++;
          return { status: 429, ok: false, headers: { 'retry-after': '35' } };
        }
        return w.deps.http.request(m, p, b, o);
      },
    };
    w.set(T0 + MINUTE);
    const r = await w.sweep('ui', { http: retryAfter });
    expect(r.error).toBeUndefined();
    expect(r.minutesProcessed).toBe(1);
    expect(w.now()).toBe(T0 + MINUTE + 35_000);
    expect(r.rateLimit).toEqual({ since: new Date(T0 + MINUTE).toISOString(), streak: 1 });
    w.set(T0 + 2 * MINUTE);
    const next = await w.sweep();
    expect(next.skipped).toBeUndefined();
    expect(next.minutesProcessed).toBe(1);
    expect((await w.meta())!.consecutiveRateLimited).toBe(0);
  });
});

describe('P1-E01 — back-off', () => {
  it('schedules 2, 4, 8, then 16 minutes, from the minute the sweep started', () => {
    expect(RATE_LIMIT_BACKOFF_MIN).toEqual([2, 4, 8, 16]);
    expect([1, 2, 3, 4, 5, 9].map(backoffMinutes)).toEqual([2, 4, 8, 16, 16, 16]);
    const at = T0 + 7 * MINUTE; // 15:07:20
    expect(nextRateLimit({ streak: 0 }, false, false, at)).toBeUndefined();
    expect(nextRateLimit({ streak: 0 }, true, false, at)).toEqual({ since: new Date(at).toISOString(), streak: 1 });
    expect(nextRateLimit({ streak: 0 }, true, true, at)).toEqual({ since: new Date(at).toISOString(), streak: 1, until: '2026-09-28T15:10:00.000Z' });
    // A sweep that completed after its retry metered its minutes: however long the streak, no back-off (the next
    // minute's alert must not wait on a presenter tab sharing the Leader's allowance).
    expect(nextRateLimit({ streak: 1, since: 'S' }, true, false, at)).toEqual({ since: 'S', streak: 2 });
    expect(nextRateLimit({ streak: 1, since: 'S' }, true, true, at)).toEqual({ since: 'S', streak: 2, until: '2026-09-28T15:12:00.000Z' });
    expect(nextRateLimit({ streak: 3, since: 'S' }, true, true, at)?.until).toBe('2026-09-28T15:24:00.000Z');
  });

  it('with a 15/min limiter: under 200 calls in the hour after the first failure, the streak counts up, the lock is free after every sweep, and the first sweep after recovery backfills', async () => {
    const w = await createWorld({ settings: quiet });
    await w.sweep();
    await w.sweepMinutes(2);
    const before = (await w.meta())!;
    limit(w, 15);

    const results: { at: number; r: SweepResult }[] = [];
    let firstFailure = Number.NaN;
    let streak = 0;
    while (!(w.now() - firstFailure >= HOUR)) {
      const [r] = await w.sweepMinutes(1);
      const at = Math.floor(w.now() / MINUTE) * MINUTE; // the minute it ran in (a stopped sweep waits into the next)
      results.push({ at, r });
      if (r.skipped === 'rate_limited') {
        if (Number.isNaN(firstFailure)) firstFailure = w.now();
        streak++;
        // The failure is on record — it waited for the window — and the lock is not held past the sweep.
        limit(w, 0);
        const meta = (await w.meta())!;
        limit(w, 15);
        expect(meta.consecutiveRateLimited).toBe(streak);
        expect(meta.lastError).toBe('rate_limited');
        expect(Date.parse(meta.rateLimitedUntil!)).toBeGreaterThan(w.now());
        const lock = await lockAfter(w, 15);
        expect(Date.parse(lock!.expiresAt)).toBeLessThanOrEqual(w.now());
      } else {
        // Every other sweep inside the limit is a back-off skip with no Leader call.
        expect(r).toMatchObject({ skipped: 'backoff', error: 'rate_limited', calls: 0 });
      }
    }
    const hour = results.filter((x) => x.r.calls > 0);
    const calls = hour.reduce((n, x) => n + x.r.calls, 0);
    expect(calls).toBeLessThan(200);
    expect(streak).toBeGreaterThanOrEqual(5);
    expect(streak).toBeLessThanOrEqual(7);
    expect(results.every((x) => x.r.minutesProcessed === 0)).toBe(true);

    // The limit lifts: the first sweep once the back-off ends meters the whole backlog and ends the streak.
    limit(w, 0);
    let recovered: SweepResult | undefined;
    for (let i = 0; i < 20 && !recovered; i++) {
      const [r] = await w.sweepMinutes(1);
      if (r.skipped !== 'backoff') recovered = r;
    }
    expect(recovered?.error).toBeUndefined();
    const meta = (await w.meta())!;
    const windowEnd = Math.floor((w.now() - 20_000) / MINUTE) * MINUTE;
    expect(meta.meteredThrough).toBe(new Date(windowEnd).toISOString());
    expect(recovered!.minutesProcessed).toBe((windowEnd - Date.parse(before.meteredThrough!)) / MINUTE);
    expect(recovered!.backfilledMinutes).toBe(recovered!.minutesProcessed - 1);
    expect(meta.consecutiveRateLimited).toBe(0);
    expect(meta.rateLimitedSince).toBeUndefined();
    expect(meta.rateLimitedUntil).toBeUndefined();
  });

  it('holds the back-off in memory when the Leader refuses even the failure record, and shares it through meta with another runtime', async () => {
    const w = await createWorld({ settings: quiet });
    await w.sweep();
    const twice = (): CriblHttp => {
      let n = 0;
      return {
        request: (m, p, b, o) => (m === 'POST' && p.startsWith('/system/metrics/query') && n++ < 2 ? Promise.resolve({ status: 429, ok: false }) : w.deps.http.request(m, p, b, o)),
      };
    };
    // The tab's KV answers 429 to every meta write for a while: the record never lands.
    let refuseMeta = true;
    const tabKv: KvStore = {
      get: (k) => w.kv.get(k),
      list: (p) => w.kv.list(p),
      del: (k) => w.kv.del(k),
      put: (k, v) => (refuseMeta && k === 'meta' ? Promise.reject(new KvHttpError('PUT', k, 429, 'slow down')) : w.kv.put(k, v)),
    };
    w.set(T0 + MINUTE);
    const stopped = await w.sweep('ui', { http: twice(), kv: tabKv });
    expect(stopped.skipped).toBe('rate_limited');
    expect((await w.meta())!.consecutiveRateLimited).toBe(0); // not on record…
    w.set(T0 + 2 * MINUTE);
    const held = await w.sweep('ui', { kv: tabKv });
    expect(held).toMatchObject({ skipped: 'backoff', error: 'rate_limited', calls: 0 }); // …but this runtime remembers
    // Sweep now is the member asking: it always tries.
    refuseMeta = false;
    const manual = await w.sweep('manual', { kv: tabKv });
    expect(manual.skipped).toBeUndefined();

    // Another stopped sweep, recorded this time; the runner (its own transports) reads the back-off from meta.
    w.set(T0 + 3 * MINUTE);
    const again = await w.sweep('ui', { http: twice(), kv: tabKv });
    expect(again.skipped).toBe('rate_limited');
    const meta = (await w.meta())!;
    expect(meta.rateLimitedUntil).toBeDefined();
    w.set(T0 + 4 * MINUTE + 5_000);
    const runnerKv: KvStore = { ...w.kv };
    const runner = await w.sweep('scheduled', { kv: runnerKv, owner: 'runner:workhorse:7', runtime: 'backend' });
    expect(runner).toMatchObject({ skipped: 'backoff', error: 'rate_limited', calls: 1 });
    expect(runner.meta?.rateLimitedUntil).toBe(meta.rateLimitedUntil);
    expect(runner.rateLimit?.since).toBe(meta.rateLimitedSince);
  });
});
