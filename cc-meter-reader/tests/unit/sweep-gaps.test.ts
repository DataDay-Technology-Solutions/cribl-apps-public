// tests/unit/sweep-gaps.test.ts — an outage longer than the backfill reaches (EPIC_AUDIT P1-E04).
//
// Before: backfill reached back 24 h, so after a 30 h outage the six hours before that floor were never metered and
// nothing recorded the hole — meta and the snapshot had no field for it, the Receipt's figures were simply lower.
// Now backfill reaches back 46 h (the Leader keeps ~2 days, PLATFORM_NOTES N1) in slices of at most 24 h a sweep,
// and whatever is older than that when metering resumes is recorded in meta.gaps, with a helper that says how many
// minutes of any range were never metered.

import { describe, expect, it } from 'vitest';
import type { MeteringGap, RollMinuteDoc } from '../../core/types.ts';
import { MAX_BACKFILL_MS, MAX_METERING_GAPS, MAX_SWEEP_SPAN_MS, recordGap, unmeteredMinutesBetween } from '../../core/sweep.ts';
import { HOUR, MINUTE, createWorld, type World } from '../integration/harness.ts';

const PAY_FLOW = 'default|mrd_payments_api|mrd_payments_api|mrd_pay_sample|mrd_siem_prod';
const quiet = (s: { demo: unknown }): void => void (s.demo = { enabled: false, replayMode: false, profile: false });
const iso = (ms: number): string => new Date(ms).toISOString();

/** A metered world, then `hours` with no sweep; returns the cursor the outage started from. */
async function outage(hours: number): Promise<{ w: World; from: number }> {
  const w = await createWorld({ settings: quiet });
  await w.sweep();
  await w.sweepMinutes(3);
  const from = Date.parse((await w.meta())!.meteredThrough!);
  w.advance(hours * HOUR);
  w.set(Math.floor(w.now() / MINUTE) * MINUTE + 25_000);
  return { w, from };
}

/** Minute rows of one flow stored for [from, to). */
async function rowsBetween(w: World, from: number, to: number): Promise<number> {
  let n = 0;
  for (let h = Math.floor(from / HOUR) * HOUR; h < to; h += HOUR) {
    const doc: RollMinuteDoc | null = await w.docs.getRollMinute(iso(h).slice(0, 13));
    n += (doc?.flows[PAY_FLOW] ?? []).filter((r) => Date.parse(r.t) >= from && Date.parse(r.t) < to).length;
  }
  return n;
}

describe('P1-E04 — backfill after an outage', () => {
  it('reaches back 46 h, in slices of at most 24 h a sweep', () => {
    expect(MAX_BACKFILL_MS).toBe(46 * HOUR);
    expect(MAX_SWEEP_SPAN_MS).toBe(24 * HOUR);
  });

  it('a 30 h outage is metered in full over two sweeps and leaves no gap (0 h with the raised floor)', async () => {
    const { w, from } = await outage(30);
    const first = await w.sweep();
    expect(first.error).toBeUndefined();
    expect(first.minutesProcessed).toBe(24 * 60);
    expect(first.catchUpRemainingMinutes).toBeGreaterThan(5 * 60);
    expect(first.unmeteredMinutes).toBeUndefined();
    expect((await w.meta())!.meteredThrough).toBe(iso(from + 24 * HOUR));
    // The catch-up continues on the next sweep (a tab's next tick, the runner's next minute).
    w.advance(MINUTE);
    const second = await w.sweep();
    expect(second.error).toBeUndefined();
    expect(second.catchUpRemainingMinutes).toBeUndefined();
    const meta = (await w.meta())!;
    const windowEnd = Math.floor((w.now() - 20_000) / MINUTE) * MINUTE;
    expect(meta.meteredThrough).toBe(iso(windowEnd));
    expect(first.minutesProcessed + second.minutesProcessed).toBe((windowEnd - from) / MINUTE);
    expect(meta.gaps).toBeUndefined();
    // Every minute of the outage has its row: nothing silently missing.
    expect(await rowsBetween(w, from, windowEnd)).toBe((windowEnd - from) / MINUTE);
    // Catch-up minutes are metered but judged as catch-up (their incidents carry the note), never "now".
    expect(first.backfilledMinutes).toBe(first.minutesProcessed);
  });

  it('a 50 h outage records the ~4 h older than the Leader keeps as a gap, and meters the other 46 h', async () => {
    const { w, from } = await outage(50);
    const results = [await w.sweep()];
    while (results.at(-1)!.catchUpRemainingMinutes && results.length < 4) {
      w.advance(MINUTE);
      results.push(await w.sweep());
    }
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.error === undefined)).toBe(true);
    const meta = (await w.meta())!;
    expect(meta.gaps).toHaveLength(1);
    const gap = meta.gaps![0];
    expect(gap.from).toBe(iso(from));
    const floor = Date.parse(gap.to);
    expect(gap.minutes).toBe((floor - from) / MINUTE);
    expect(gap.minutes).toBeGreaterThanOrEqual(4 * 60 - 1);
    expect(gap.minutes).toBeLessThanOrEqual(4 * 60 + 1);
    expect(results[0].unmeteredMinutes).toBe(gap.minutes);
    expect(results[1].unmeteredMinutes).toBeUndefined(); // recorded once
    expect(await rowsBetween(w, from, floor)).toBe(0);
    const windowEnd = Math.floor((w.now() - 20_000) / MINUTE) * MINUTE;
    expect(await rowsBetween(w, floor, windowEnd)).toBe((windowEnd - floor) / MINUTE);
    // What the Receipt, the Ledger and the diagnostics say for a range: the hole's minutes inside it.
    const dayStart = Math.floor(from / (24 * HOUR)) * 24 * HOUR;
    expect(unmeteredMinutesBetween(meta.gaps, dayStart, dayStart + 24 * HOUR)).toBe(gap.minutes);
    expect(unmeteredMinutesBetween(meta.gaps, floor, windowEnd)).toBe(0);
    // Later sweeps keep the record.
    w.advance(MINUTE);
    await w.sweep();
    expect((await w.meta())!.gaps).toEqual(meta.gaps);
  });
});

describe('P1-E04 — the gap record', () => {
  const T = Date.UTC(2026, 8, 20, 0, 0, 0);
  const at = iso(T + 100 * HOUR);

  it('adds, merges a gap that grew while metering stayed stopped, and keeps the newest 20', () => {
    const one = recordGap(undefined, T, T + 4 * HOUR + 30_000, at);
    expect(one).toEqual([{ from: iso(T), to: iso(T + 4 * HOUR), minutes: 240, recordedAt: at }]);
    // The same outage seen again with the floor further on: one entry, longer.
    expect(recordGap(one, T, T + 5 * HOUR, at)).toEqual([{ from: iso(T), to: iso(T + 5 * HOUR), minutes: 300, recordedAt: at }]);
    const two = recordGap(one, T + 30 * HOUR, T + 31 * HOUR, at);
    expect(two.map((g) => g.minutes)).toEqual([240, 60]);
    expect(recordGap(two, T, T, at)).toEqual(two); // empty: nothing added
    let many: MeteringGap[] = [];
    for (let i = 0; i < 25; i++) many = recordGap(many, T + i * 10 * HOUR, T + i * 10 * HOUR + HOUR, at);
    expect(many).toHaveLength(MAX_METERING_GAPS);
    expect(many[0].from).toBe(iso(T + 5 * 10 * HOUR));
  });

  it('counts the unmetered minutes inside any range', () => {
    const gaps = recordGap(recordGap(undefined, T, T + 4 * HOUR, at), T + 30 * HOUR, T + 31 * HOUR, at);
    expect(unmeteredMinutesBetween(gaps, T, T + 48 * HOUR)).toBe(300);
    expect(unmeteredMinutesBetween(gaps, T + 3 * HOUR, T + 30.5 * HOUR)).toBe(90);
    expect(unmeteredMinutesBetween(gaps, T + 5 * HOUR, T + 29 * HOUR)).toBe(0);
    expect(unmeteredMinutesBetween(undefined, T, T + HOUR)).toBe(0);
  });
});
