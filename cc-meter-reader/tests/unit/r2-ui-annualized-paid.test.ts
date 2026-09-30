// tests/unit/r2-ui-annualized-paid.test.ts — founder-build round 2, ui-1 (FINDINGS_EXTRA BO-3): the annualized run
// rate's would-have-paid and paid scale by the same factor as its saved figure, over the same days
// (src/views/Receipt/model.ts annualizedParts), and print footed through core/format.ts footMoney (D53).
//
// Before the fix Paid was derived as would-have-paid − saved, which hides spend that saves nothing (a destination
// whose counterfactual is "none" is paid for and saves nothing): EX3 printed Paid $146,000, 43 % low, the only period
// where Paid read below Saved. Evidence: Media/…/ops/app-assurance/extra/fuzz/results/examples.json (EX3),
// fuzz/skeptic1-annualized-paid/.
//
// The property is stated over the run rate's own days (annualizedDays: the last 30 local days, today included, from
// the day collecting began), which is what "annualized paid ÷ saved = MTD paid ÷ saved" means whenever those days are
// the month's; EX3's days are homogeneous, so there it is literally the MTD ratio.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fmtDollars, footMoney } from '../../core/format.ts';
import { addDaysToKey, localDayKey } from '../../core/time.ts';
import type { Headline, Snapshot, TrendPoint } from '../../core/types.ts';
import { annualizedDays, periodFigures } from '../../src/views/Receipt/model.ts';
import { TOUR_FIXTURE } from '../../src/tour/fixture.ts';

const D = 100_000; // millicents per dollar
const TZ = 'UTC';
const SWEEP = '2026-09-27T23:59:00.000Z';

function snapshotOf(trend: TrendPoint[], headline: Partial<Headline>, collectingSince = `${trend[0]?.day ?? '2026-09-19'}T00:00:00.000Z`): Snapshot {
  return {
    schemaVersion: 1,
    sweepAt: SWEEP,
    collectingSince,
    headline: headline as Headline,
    trend,
    flows: [],
    destinations: [],
    topSavers: [],
    incidents: [],
    unpricedOutputIds: [],
    openIncidents: 0,
  } as unknown as Snapshot;
}

function printed(f: { whpM: number; paidM: number; savedM: number }): [string, string, string] {
  const p = footMoney(f);
  return [fmtDollars(p.whpM), fmtDollars(p.paidM), fmtDollars(p.savedM)];
}

describe('ui-1 (BO-3): annualized paid scales with saved', () => {
  // EX3: every day the SIEM would have paid $1,000, paid $400 and saved $600, and an archive whose counterfactual is
  // "none" costs $300 (would have paid $0, saved $0). Run rate $219,000 a year.
  const days = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'];
  const day = { whpM: 1000 * D, paidM: 700 * D, savedM: 600 * D };
  const n = days.length;
  const ex3 = snapshotOf(
    days.map((d) => ({ day: d, ...day })),
    {
      todayM: day.savedM,
      mtdM: n * day.savedM,
      d30M: n * day.savedM,
      annualizedM: 600 * 365 * D,
      annualizedFromDays: n,
      whpMtdM: n * day.whpM,
      paidMtdM: n * day.paidM,
      ratioMtd: 0.6,
      whpTodayM: day.whpM,
      paidTodayM: day.paidM,
      whp30dM: n * day.whpM,
      paid30dM: n * day.paidM,
    },
  );

  it('EX3 prints $365,000 / $255,500 / $219,000 (was Paid $146,000)', () => {
    const f = periodFigures(ex3, 'annualized', TZ);
    expect(f.derivedFrom).toBe('trend');
    expect(printed(f)).toEqual(['$365,000', '$255,500', '$219,000']);
    // Paid never reads below what it reads month to date, relative to saved.
    const mtd = periodFigures(ex3, 'mtd', TZ);
    expect(f.paidM / f.savedM).toBeCloseTo(mtd.paidM / mtd.savedM, 9);
    expect(f.whpM / f.savedM).toBeCloseTo(mtd.whpM / mtd.savedM, 9);
  });

  it('EX3 without a trend (the ratio fallback) scales the 30-day paid the same way', () => {
    const noTrend = { ...ex3, trend: [] };
    const f = periodFigures(noTrend, 'annualized', TZ);
    expect(f.derivedFrom).toBe('ratio');
    expect(printed(f)).toEqual(['$365,000', '$255,500', '$219,000']);
  });

  it('the ratio fallback uses today when there is no 30-day figure, then month to date', () => {
    const today = snapshotOf([], { todayM: 600 * D, whpTodayM: 1000 * D, paidTodayM: 700 * D, annualizedM: 219_000 * D, whp30dM: 0, d30M: 0, paid30dM: 0, mtdM: 0, whpMtdM: 0, paidMtdM: 0, ratioMtd: 0 });
    expect(printed(periodFigures(today, 'annualized', TZ))).toEqual(['$365,000', '$255,500', '$219,000']);
    const mtd = snapshotOf([], { todayM: 0, whpTodayM: 0, paidTodayM: 0, annualizedM: 219_000 * D, whp30dM: 0, d30M: 0, paid30dM: 0, mtdM: 6_000 * D, whpMtdM: 10_000 * D, paidMtdM: 7_000 * D, ratioMtd: 0.6 });
    expect(printed(periodFigures(mtd, 'annualized', TZ))).toEqual(['$365,000', '$255,500', '$219,000']);
  });

  it('property: annualized paid ÷ saved and would-have-paid ÷ saved equal the run rate days\' own ratios', () => {
    const dayArb = fc.record({
      whpM: fc.integer({ min: 1_000_000, max: 900_000_000_000 }),
      savedShare: fc.double({ min: 0, max: 1, noNaN: true }),
      noneM: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 400_000_000_000 })),
    });
    fc.assert(
      fc.property(fc.array(dayArb, { minLength: 1, maxLength: 30 }), fc.double({ min: 0.5, max: 400, noNaN: true }), (raw, factor) => {
        const last = localDayKey(Date.parse(SWEEP), TZ);
        const trend: TrendPoint[] = raw.map((r, i) => {
          const savedM = Math.round(r.whpM * r.savedShare);
          return { day: addDaysToKey(last, i - (raw.length - 1)), whpM: r.whpM, savedM, paidM: r.whpM - savedM + r.noneM };
        });
        const sumSaved = trend.reduce((a, d) => a + d.savedM, 0);
        fc.pre(sumSaved > 0);
        const annualizedM = Math.round(sumSaved * factor);
        fc.pre(annualizedM > 0);
        const s = snapshotOf(trend, { annualizedM, annualizedFromDays: trend.length, whp30dM: 1, d30M: 1, paid30dM: 1, todayM: 0, whpTodayM: 0, paidTodayM: 0, mtdM: 0, whpMtdM: 0, paidMtdM: 0, ratioMtd: 0 });
        const within = annualizedDays(s, TZ);
        expect(within).toHaveLength(trend.length);
        const f = periodFigures(s, 'annualized', TZ);
        expect(f.derivedFrom).toBe('trend');
        expect(f.savedM).toBe(annualizedM);
        const sumPaid = within.reduce((a, d) => a + d.paidM, 0);
        const sumWhp = within.reduce((a, d) => a + d.whpM, 0);
        // Each part is the exact scaled value rounded to the millicent.
        expect(Math.abs(f.paidM - (annualizedM * sumPaid) / sumSaved)).toBeLessThanOrEqual(0.5 + 1e-6 * f.paidM);
        expect(Math.abs(f.whpM - (annualizedM * sumWhp) / sumSaved)).toBeLessThanOrEqual(0.5 + 1e-6 * f.whpM);
        // Paid never hides spend: it is at least would have paid − saved (spend that saves nothing only adds to it).
        expect(f.paidM).toBeGreaterThanOrEqual(f.whpM - f.savedM - 1);
      }),
      { numRuns: 400, seed: 20260928 },
    );
  });

  it('the tour\'s annualized triple is unchanged: $23,126,756 / $14,990,334 / $8,136,422 (ledger SM-WHP-PAID / SM-ANNUAL)', () => {
    const f = periodFigures(TOUR_FIXTURE.snapshot, 'annualized', TOUR_FIXTURE.settings.displayTimezone);
    expect(printed(f)).toEqual(['$23,126,756', '$14,990,334', '$8,136,422']);
    // Every sample day foots (whp − paid = saved), so the footed paid is the printed difference.
    const p = footMoney(f);
    expect(p.whpM - p.paidM).toBe(p.savedM);
  });
});
