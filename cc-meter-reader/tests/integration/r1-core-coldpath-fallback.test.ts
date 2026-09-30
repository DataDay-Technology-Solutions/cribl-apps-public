// tests/integration/r1-core-coldpath-fallback.test.ts — founder-build r1 core-14 (FINDINGS_R1 m18, #44; seeded from
// AA/skeptic2-f44/zz-s2f44.test.ts). A metrics timeout or 5xx — or the sweep's time budget — on a long range (the first
// run's day of history, or a catch-up after a closed tab) was retried unchanged every sweep: a failed first sweep wrote
// no meta, the fallback to the hour never engaged (it looked only at rate limits and budgets), and a Leader that cannot
// answer a day-long query never let metering start. Now such a failure is recorded (a minimal meta on a fresh install):
// a first run then meters the newest hour first (D63's fallback, now also after a metrics timeout or 5xx), and a
// catch-up halves its span (never under an hour) until one succeeds, keeps the span that worked until it has caught
// up, then goes back to the full span — forward, so no minute is lost.

import { describe, expect, it } from 'vitest';
import type { CriblHttp } from '../../core/types.ts';
import { HOUR, MINUTE, createWorld, rigPrices, type World } from './harness.ts';

const LONG = 3 * HOUR;

/** The Leader answers 504 (or takes 40 s per call) to a metrics query longer than 3 h; `spans` records every query. */
function slowLeader(kind: '504' | 'slow', spans: number[], world: () => World): (inner: CriblHttp) => CriblHttp {
  return (inner) => ({
    async request(m, p, b, o) {
      if (m === 'POST' && p.includes('/system/metrics/query')) {
        const q = b as { earliest: number; latest: number };
        const span = (q.latest - q.earliest) * (q.latest < 1e12 ? 1000 : 1);
        spans.push(span);
        if (span > LONG) {
          if (kind === '504') return { status: 504, ok: false, text: 'Gateway Timeout' };
          world().advance(40_000);
        }
      }
      return inner.request(m, p, b, o);
    },
  });
}

async function firstRun(kind: '504' | 'slow') {
  const spans: number[] = [];
  let w!: World;
  w = await createWorld({ bare: true, wrapHttp: slowLeader(kind, spans, () => w), sweep: { firstRunReachMs: undefined } });
  await w.docs.putPrices(rigPrices(w.now()));
  const rows: { error?: string; minutes: number; meta: boolean; lastError?: string; meteredThrough?: string; span: number }[] = [];
  for (let i = 0; i < 6; i++) {
    spans.length = 0;
    w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
    const r = await w.sweep('ui');
    const meta = await w.meta();
    rows.push({ ...(r.error ? { error: r.error } : {}), minutes: r.minutesProcessed, meta: !!meta, ...(meta?.lastError ? { lastError: meta.lastError } : {}), ...(meta?.meteredThrough ? { meteredThrough: meta.meteredThrough } : {}), span: Math.max(0, ...spans) });
    if (meta?.meteredThrough) break;
  }
  return { w, rows };
}

describe('core-14 · m18: a cold path that fails is not retried unchanged', () => {
  for (const kind of ['504', 'slow'] as const) {
    it(`first run, the Leader ${kind === '504' ? 'answers 504' : 'takes 40 s a call'} for ranges over 3 h: the failure is recorded, the newest hour is metered next`, async () => {
      const { rows, w } = await firstRun(kind);
      // The first attempt fails and leaves a record (before: no meta at all, so nothing ever changed).
      expect(rows[0].error).toBeDefined();
      expect(rows[0].meta).toBe(true);
      expect(rows[0].lastError).toBe(rows[0].error);
      // The retry meters the newest hour (D63's fallback), which the Leader answers.
      expect(rows.map((r) => Math.round(r.span / HOUR))).toEqual([24, 1]);
      const done = rows.at(-1)!;
      expect(done.error).toBeUndefined();
      expect(done.minutes).toBeGreaterThanOrEqual(60);
      expect(Date.parse(done.meteredThrough!)).toBeGreaterThan(w.now() - 2 * MINUTE);
      // Caught up: the next steady sweep asks for a minute or two, and nothing is left to retry.
      w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
      const next = await w.sweep('ui');
      expect(next.error).toBeUndefined();
      expect((await w.meta())?.metricsSpanMs).toBeUndefined();
    }, 120_000);
  }

  it('a catch-up after a 15 h gap: the span halves until one works, keeps it until caught up, loses no minute', async () => {
    const spans: number[] = [];
    let w!: World;
    let failing = false;
    w = await createWorld({
      wrapHttp: (inner) => {
        const slow = slowLeader('504', spans, () => w)(inner);
        return { request: (m, p, b, o) => (failing ? slow.request(m, p, b, o) : inner.request(m, p, b, o)) };
      },
    });
    await w.sweep('ui');
    await w.sweepMinutes(3);
    const before = Date.parse((await w.meta())!.meteredThrough!);
    w.advance(15 * HOUR);
    failing = true;
    let minutes = 0;
    let sweeps = 0;
    const errors: string[] = [];
    while (sweeps < 20) {
      sweeps++;
      w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
      const r = await w.sweep('ui');
      if (r.error) errors.push(r.error);
      minutes += r.minutesProcessed;
      const through = Date.parse((await w.meta())!.meteredThrough!);
      if (w.now() - through <= 2 * MINUTE) break;
    }
    expect(errors.length).toBeGreaterThan(0); // it did fail at first
    expect(errors.length).toBeLessThanOrEqual(4);
    expect(sweeps).toBeLessThan(20);
    const through = Date.parse((await w.meta())!.meteredThrough!);
    expect(through % MINUTE).toBe(0); // every slice ended on a minute boundary
    // Every minute from the old cursor to now was metered: none recorded as a gap.
    expect(minutes).toBe(Math.round((through - before) / MINUTE));
    expect((await w.meta())?.gaps ?? []).toEqual([]);
    expect((await w.meta())?.metricsSpanMs).toBeUndefined();
  }, 120_000);
});
