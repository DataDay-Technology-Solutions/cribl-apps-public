// r1 ui-7 (FINDINGS_R1 M2, #3; seeded from AA/r1/skeptic2-f3/probe-model.test.ts): the tour's Today prices Cribl's cost
// over the minutes its savings cover. The sample's Today holds the recording's own minutes (headline.minutesToday), but
// the cost was prorated from local midnight to the wall clock, so at 9 PM it paid for 21 hours against 11.7 hours of
// savings (1.8×) and at 12:30 AM for 30 minutes against 11.7 hours (74.6×). Now the cost span is the savings span, and
// Today's payback sits near month to date's.

import { describe, expect, it } from 'vitest';
import doc from '../../demo/sample/tour.json';
import type { Snapshot } from '../../core/types.ts';
import type { TourFixture } from '../../src/tour/types.ts';
import { planRebase, rebaseHeadline, rebaseValue } from '../../src/tour/rebase.ts';
import { netFigures, periodFigures } from '../../src/views/Receipt/model.ts';

const TOUR = doc as unknown as TourFixture;

/** The sample as the tour engine shows it at `wallIso` (src/tour/engine.ts enterBase: days moved in the fixture's zone). */
function shownAt(wallIso: string): Snapshot {
  const zone = TOUR.timezone || 'America/Chicago';
  const plan = planRebase(Date.parse(TOUR.anchor ?? TOUR.generatedAt), Date.parse(wallIso), zone);
  const moved = rebaseValue(TOUR.snapshot, plan);
  return plan.dayShift === 0 ? moved : rebaseHeadline(moved, zone, TOUR.settings.criblCostCentsPerMonth);
}

const CASES: [string, string][] = [
  ['2026-09-28T01:02:00Z', 'America/New_York'], // 9:02 PM ET
  ['2026-09-28T05:30:00Z', 'America/Chicago'], // 12:30 AM CT
  ['2026-09-28T13:00:00Z', 'America/New_York'], // 9:00 AM ET
];

describe('the tour: Today is net of Cribl over the minutes it covers (M2)', () => {
  for (const [at, tz] of CASES) {
    it(`${at} (${tz}): the cost span is the savings span, and the payback is within ±25% of month to date's`, () => {
      const snap = shownAt(at);
      const cost = TOUR.settings.criblCostCentsPerMonth;
      const today = netFigures(snap, 'today', cost, tz)!;
      const mtd = netFigures(snap, 'mtd', cost, tz)!;
      expect(today).not.toBeNull();
      expect(mtd).not.toBeNull();
      // Savings span: the minutes Today's savings were metered in (the recording's own, moved onto the clock).
      expect(today.minutes).toBe(snap.headline.minutesToday);
      expect(periodFigures(snap, 'today', tz).savedM).toBe(snap.headline.todayM);
      const ratio = today.paybackX! / mtd.paybackX!;
      expect(ratio, `today ${today.paybackX} × vs month to date ${mtd.paybackX} ×`).toBeGreaterThan(0.75);
      expect(ratio).toBeLessThan(1.25);
    });
  }

  it('a live workspace metering all day: its minutes today are its span since local midnight; without the field, the span', () => {
    const snap = shownAt('2026-09-28T13:00:00Z');
    const sweepMs = Date.parse(snap.sweepAt);
    const tz = 'America/Chicago';
    const wallMinutes = (sweepMs - Date.parse('2026-09-28T05:00:00Z')) / 60_000;
    const live: Snapshot = { ...snap, headline: { ...snap.headline, minutesToday: Math.floor(wallMinutes) } };
    expect(netFigures(live, 'today', TOUR.settings.criblCostCentsPerMonth, tz)!.minutes).toBe(Math.floor(wallMinutes));
    const older: Snapshot = { ...snap, headline: { ...snap.headline, minutesToday: undefined } };
    expect(netFigures(older, 'today', TOUR.settings.criblCostCentsPerMonth, tz)!.minutes).toBeCloseTo(wallMinutes, 6);
    // Month to date keeps its own span (D49), untouched.
    const mtd = netFigures(live, 'mtd', TOUR.settings.criblCostCentsPerMonth, tz)!;
    expect(mtd.minutes).toBeGreaterThan(wallMinutes);
  });
});
