// tests/unit/goal.test.ts — core/goal.ts (P2-W20): the goal's pace, this week so far, and the price basis.

import { describe, expect, it } from 'vitest';
import { MIN_PACE_MINUTES, changePct, goalPace, mondayOf, priceBasis, weekFromTrend, weekWindow } from '../../core/goal.ts';
import { DAY_MS, addDaysToKey, localDayStartMs } from '../../core/time.ts';
import type { PricesDoc, TrendPoint } from '../../core/types.ts';

const TZ = 'America/Chicago';
const $ = (d: number) => Math.round(d * 100_000);
// Sat Sep 26 2026, 3:00 PM Chicago (20:00Z): day 26 of a 30-day month.
const SWEEP = Date.parse('2026-09-26T20:00:00Z');

describe('goalPace', () => {
  it('projects the month at the month-to-date rate and says whether it clears the goal', () => {
    const monthStart = localDayStartMs('2026-09-01', TZ);
    const minutes = (SWEEP - monthStart) / 60_000;
    const saved = $(180_000);
    const p = goalPace({ savedMtdM: saved, goalCentsPerMonth: 25_000_000, sweepMs: SWEEP, tz: TZ })!;
    const monthEnd = localDayStartMs('2026-10-01', TZ);
    const expected = Math.round(saved + (saved / minutes) * ((monthEnd - SWEEP) / 60_000));
    expect(p.goalM).toBe($(250_000));
    expect(p.projectedM).toBe(expected);
    expect(p.onPace).toBe(false);
    expect(p.gapM).toBe(expected - $(250_000));
    expect(p.lastDayMs).toBe(monthEnd - 1);
    expect(goalPace({ savedMtdM: saved, goalCentsPerMonth: 15_000_000, sweepMs: SWEEP, tz: TZ })!.onPace).toBe(true);
  });

  it('prorates from when collecting began, and abstains from a projection before an hour is metered', () => {
    const since = SWEEP - 2 * DAY_MS;
    const p = goalPace({ savedMtdM: $(20_000), goalCentsPerMonth: 10_000_000, sweepMs: SWEEP, collectingSinceMs: since, tz: TZ })!;
    expect(p.meteredMinutes).toBe(2 * 1440);
    // $10k a day for the 4 days and 4 hours left: well past $100k.
    expect(p.projectedM).toBeGreaterThan($(60_000));
    const early = goalPace({ savedMtdM: $(50), goalCentsPerMonth: 10_000_000, sweepMs: SWEEP, collectingSinceMs: SWEEP - (MIN_PACE_MINUTES - 1) * 60_000, tz: TZ })!;
    expect(early.projectedM).toBeUndefined();
    expect(early.onPace).toBeUndefined();
  });

  it('is undefined without a goal', () => {
    expect(goalPace({ savedMtdM: $(1), goalCentsPerMonth: undefined, sweepMs: SWEEP, tz: TZ })).toBeUndefined();
    expect(goalPace({ savedMtdM: $(1), goalCentsPerMonth: 0, sweepMs: SWEEP, tz: TZ })).toBeUndefined();
  });
});

describe('this week so far', () => {
  it('starts on local Monday and mirrors the span a week earlier', () => {
    expect(mondayOf('2026-09-26')).toBe('2026-09-21');
    expect(mondayOf('2026-09-21')).toBe('2026-09-21');
    expect(mondayOf('2026-09-27')).toBe('2026-09-21');
    const w = weekWindow(SWEEP, TZ);
    expect(w.startMs).toBe(localDayStartMs('2026-09-21', TZ));
    expect(w.priorStartMs).toBe(w.startMs - 7 * DAY_MS);
    expect(w.priorEndMs).toBe(SWEEP - 7 * DAY_MS);
  });

  it('sums Monday to today from the daily totals and compares whole days only', () => {
    const trend: TrendPoint[] = [];
    for (let i = -13; i <= 0; i++) {
      const day = addDaysToKey('2026-09-26', i);
      const saved = i > -7 ? 120 : 100; // this week 20 % up
      trend.push({ day, savedM: $(saved), whpM: $(saved * 2), paidM: $(saved) });
    }
    const w = weekFromTrend(trend, SWEEP, TZ, localDayStartMs('2026-09-01', TZ));
    expect(w.days).toBe(6); // Mon–Sat
    expect(w.savedM).toBe($(720));
    expect(w.compare).toEqual({ savedM: $(600), priorSavedM: $(500), days: 5 });
    expect(changePct(w.compare!.savedM, w.compare!.priorSavedM)).toBe(20);
    // Collecting began after the prior Monday: no comparison.
    expect(weekFromTrend(trend, SWEEP, TZ, localDayStartMs('2026-09-16', TZ)).compare).toBeUndefined();
  });
});

describe('priceBasis', () => {
  const prices = (byOutputId: PricesDoc['versions'][number]['byOutputId']): PricesDoc => ({
    schemaVersion: 1,
    updatedAt: '2026-09-01T00:00:00Z',
    versions: [{ effectiveFrom: '2026-09-01T00:00:00Z', byOutputId }],
  });
  const dests = [
    { groupId: 'default', outputId: 'siem' },
    { groupId: 'default', outputId: 'dd' },
    { groupId: 'default', outputId: 'new', unpriced: true },
  ];
  it('is typical while any priced destination uses its preset’s typical price, contract once every one has an entered rate', () => {
    expect(priceBasis(prices({ siem: { milliCentsPerGb: 225_000, preset: 'splunk_cloud' }, dd: { milliCentsPerGb: 150_000, preset: 'datadog' } }), dests, SWEEP)).toBe('typical');
    expect(priceBasis(prices({ siem: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' }, dd: { milliCentsPerGb: 150_000, preset: 'datadog' } }), dests, SWEEP)).toBe('contract');
    // A committed price is a contract rate even at the preset's figure.
    expect(
      priceBasis(prices({ siem: { milliCentsPerGb: 225_000, preset: 'splunk_cloud', committedMilliCentsPerGb: 200_000 }, dd: { milliCentsPerGb: 99_000 } }), dests, SWEEP),
    ).toBe('contract');
    expect(priceBasis(null, dests, SWEEP)).toBe('typical');
    expect(priceBasis(null, [dests[2]], SWEEP)).toBe('none');
  });
});
