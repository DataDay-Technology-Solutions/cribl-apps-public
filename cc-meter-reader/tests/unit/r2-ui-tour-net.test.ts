// r2 ui-12 (FINDINGS_EXTRA BO-12): under the tour, Net after Cribl drifted minute by minute while the sample's savings
// stayed frozen ($392,889 → $392,872 → $392,775 at +0 / +3 / +20 min on month to date): the tour moves snapshot.sweepAt
// to the wall clock (src/tour/engine.ts enterBase), and the net prorated the Cribl cost from the month's start to it,
// while month to date is re-summed from whole trend days. Under the tour the cost now covers the span the savings cover:
// the whole days before today plus today's recorded minutes (headline.minutesToday, D49's rule, as Today's net since M2).
// Replicates enterBase with the fixture's own rebase (app-assurance extra/skeptic1-tour-net/harness.mts).

import { describe, expect, it } from 'vitest';
import { fromIso } from '../../core/time.ts';
import type { Snapshot } from '../../core/types.ts';
import { TOUR_FIXTURE } from '../../src/tour/fixture.ts';
import { planRebase, rebaseHeadline, rebaseValue } from '../../src/tour/rebase.ts';
import { netFigures, periodFigures } from '../../src/views/Receipt/model.ts';

const doc = TOUR_FIXTURE;
const zone = doc.timezone || 'UTC';
const cost = doc.settings.criblCostCentsPerMonth;
const anchor = fromIso(doc.anchor ?? doc.generatedAt);
const BASE = Date.parse('2026-09-28T14:00:00Z');

function tourSnapshotAt(wallMs: number): Snapshot {
  const plan = planRebase(anchor, wallMs, zone);
  const moved = rebaseValue(doc.snapshot, plan);
  return plan.dayShift === 0 ? moved : rebaseHeadline(moved, zone, cost);
}

describe('r2 ui-12: the tour\'s Net after Cribl holds while its savings do', () => {
  for (const period of ['mtd', '30d'] as const) {
    it(`${period}: +0, +3 and +20 min read one net (and one cost)`, () => {
      const nets = [0, 3, 20].map((m) => {
        const snap = tourSnapshotAt(BASE + m * 60_000);
        return { saved: periodFigures(snap, period, zone).savedM, net: netFigures(snap, period, cost, zone, { frozen: true })! };
      });
      expect(new Set(nets.map((n) => n.saved)).size, 'the savings are frozen').toBe(1);
      expect(new Set(nets.map((n) => n.net.netM)).size).toBe(1);
      expect(new Set(nets.map((n) => n.net.costM)).size).toBe(1);
      expect(new Set(nets.map((n) => n.net.minutes)).size).toBe(1);
    });
  }

  it('the live workspace keeps prorating to its sweep (it accrues minute by minute); the bug it fixes, for the record', () => {
    const a = netFigures(tourSnapshotAt(BASE), 'mtd', cost, zone)!;
    const b = netFigures(tourSnapshotAt(BASE + 20 * 60_000), 'mtd', cost, zone)!;
    expect(b.costM).toBeGreaterThan(a.costM);
  });

  it('the frozen span is whole days before today plus today\'s recorded minutes', () => {
    const snap = tourSnapshotAt(BASE);
    const frozen = netFigures(snap, 'mtd', cost, zone, { frozen: true })!;
    const minutesToday = snap.headline.minutesToday!;
    expect(minutesToday).toBeGreaterThan(0);
    expect((frozen.minutes - minutesToday) % 1440).toBe(0);
    // Today's net keeps D49's rule (its own recorded minutes) either way.
    expect(netFigures(snap, 'today', cost, zone, { frozen: true })!.minutes).toBe(minutesToday);
    // The run rate is a year of Cribl whatever the clock.
    expect(netFigures(snap, 'annualized', cost, zone, { frozen: true })!.costM).toBe(netFigures(snap, 'annualized', cost, zone)!.costM);
  });
});
