// tests/integration/perf.test.ts — SPEC 16 "Performance" against the 2,000-flow synthetic estate
// (testdata/scale.ts: three worker groups, three hosts × four worker processes each): the sweep's compute stays
// far under 20 s and the snapshot fits one KV value (≤ 90 KB) after compaction (DECISIONS D13).

import { describe, expect, it } from 'vitest';
import { detectCodec } from '../../core/codec.ts';
import { SNAPSHOT_MAX_BYTES } from '../../core/sweep.ts';
import { appendPriceVersion, emptyPrices } from '../../core/pricing.ts';
import type { PriceEntry } from '../../core/types.ts';
import { DAY, MINUTE, createWorld } from './harness.ts';

describe('2,000-flow scale', () => {
  it('first run (60 minutes × 2,000 flows) and steady-state sweeps finish well under 20 s; snapshot ≤ 90 KB', async () => {
    const w = await createWorld({
      preset: 'scale',
      flows: 2000,
      codec: detectCodec(),
    });
    let started = performance.now();
    const seed = await w.sweep('scheduled');
    const seedMs = performance.now() - started;
    expect(seed.error).toBeUndefined();
    expect(seed.minutesProcessed).toBe(60);
    expect(seedMs).toBeLessThan(20_000);
    const inventory = await w.docs.getInventory();
    const routes = Object.values(inventory!.byGroup).reduce((s, g) => s + g.routes.length, 0);
    expect(routes).toBeGreaterThanOrEqual(2000);
    expect(Object.keys(inventory!.byGroup)).toHaveLength(3);
    // Price every destination of the estate ($1.50/GB) from a day ago, as a customer would on first run.
    const byOutputId: Record<string, PriceEntry> = {};
    for (const [gid, g] of Object.entries(inventory!.byGroup))
      for (const o of g.outputs) byOutputId[`${gid}:${o.id}`] = { milliCentsPerGb: 150_000 };
    await w.docs.putPrices(appendPriceVersion(emptyPrices(''), byOutputId, w.now() - DAY));

    for (let i = 0; i < 3; i++) {
      w.advance(MINUTE);
      started = performance.now();
      const r = await w.sweep('scheduled');
      const ms = performance.now() - started;
      expect(r.error).toBeUndefined();
      expect(r.minutesProcessed).toBe(1);
      expect(ms).toBeLessThan(20_000);
      expect(r.snapshotBytes).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
      const stored = await w.docs.getSnapshot();
      expect(JSON.stringify(stored).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
      // Compaction keeps the biggest flows and folds the rest into one 'other' row; the headline is untouched.
      expect(stored!.flows.length).toBeLessThanOrEqual(501);
      expect(stored!.flows.some((f) => f.inputId === 'other')).toBe(true);
      expect(stored!.headline.todayM).toBeGreaterThan(0);
    }
  }, 120_000);

  it('a 2,000-flow backfill of one hour after a gap stays under 20 s', async () => {
    const w = await createWorld({
      preset: 'scale',
      flows: 2000,
      codec: detectCodec(),
    });
    const through = Math.floor(w.now() / MINUTE) * MINUTE - 60 * MINUTE;
    await w.docs.putMeta({
      schemaVersion: 1,
      installedAt: new Date(w.now() - DAY).toISOString(),
      collectingSince: new Date(w.now() - DAY).toISOString(),
      appVersion: '1.0.0',
      build: 'release',
      metricsSource: 'metrics-query',
      sweepErrors: 0,
      consecutiveRateLimited: 0,
      sweepCount: 10,
      meteredThrough: new Date(through).toISOString(),
    });
    const started = performance.now();
    const r = await w.sweep('scheduled');
    expect(r.error).toBeUndefined();
    expect(r.minutesProcessed).toBe(60);
    expect(performance.now() - started).toBeLessThan(20_000);
  }, 120_000);
});
