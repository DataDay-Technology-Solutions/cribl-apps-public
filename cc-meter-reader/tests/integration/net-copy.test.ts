// tests/integration/net-copy.test.ts — DECISIONS D49: month to date, the Copy receipt's "Net after Cribl" and
// "Paid for itself" lines, the sweep's headline (netMtdM, paybackX) and the Receipt hero (netFigures) are one
// figure: the month's savings against Cribl's cost over the minutes metered this month, never the calendar days
// of the month. The review probe (tests/report/review-w1/correctness/net-copy-vs-hero.ts) found the copied line
// at −$4,656 and 0.0× while the hero read $4 and 1.6× on a workspace one hour old.

import { describe, expect, it } from 'vitest';
import { fmtDollars } from '../../core/format.ts';
import { computeHeadline } from '../../core/pricing.ts';
import { receiptTextForPeriod } from '../../core/receipt.ts';
import { DAY_MS, fromIso, toIso } from '../../core/time.ts';
import type { Snapshot, TotalsDoc } from '../../core/types.ts';
import { rebaseHeadline } from '../../src/tour/rebase.ts';
import { netFigures } from '../../src/views/Receipt/model.ts';
import { createWorld } from './harness.ts';

const COST = 500_000; // $5,000 a month

/** The Net line exactly as the hero's figures would print it in the Copy receipt. */
function heroLine(snapshot: Snapshot, cost: number): string {
  const hero = netFigures(snapshot, 'mtd', cost, 'UTC');
  expect(hero).not.toBeNull();
  const multiple = `${(Math.round((hero?.paybackX ?? 0) * 10) / 10).toFixed(1)}×`;
  return `Net after Cribl ${fmtDollars(hero?.netM ?? 0)} · Paid for itself ${multiple}`;
}

const netLine = (text: string): string | undefined => text.split('\n').find((l) => l.startsWith('Net after Cribl'));

/** The snapshot as if collecting had begun `days` before its sweep, its headline recomputed from the same totals. */
function collectingFor(snapshot: Snapshot, days: number, cost: number): Snapshot {
  const sweepMs = fromIso(snapshot.sweepAt);
  const sinceMs = sweepMs - days * DAY_MS;
  const totals: TotalsDoc = { schemaVersion: 1, updatedAt: snapshot.sweepAt, byDay: {} };
  for (const p of snapshot.trend) totals.byDay[p.day] = { savedM: p.savedM, whpM: p.whpM, paidM: p.paidM, minutes: 1440 };
  const headline = computeHeadline(totals, sweepMs, 'UTC', sinceMs, cost);
  return { ...snapshot, collectingSince: toIso(sinceMs), headline };
}

describe('D49 · month-to-date net of Cribl is one figure on every surface', () => {
  it('a workspace metering for one hour: the Copy receipt and the sweep headline match the hero', async () => {
    const w = await createWorld({ settings: (s) => void (s.criblCostCentsPerMonth = COST) });
    const snap = (await w.sweep()).snapshot as Snapshot;
    expect(fromIso(snap.sweepAt) - fromIso(snap.collectingSince)).toBeLessThan(2 * 3_600_000);
    const hero = netFigures(snap, 'mtd', COST, 'UTC');
    // The sweep's headline carries the hero's figure (it was −$4,656 and 0.0× under the calendar rule).
    expect(snap.headline.netMtdM).toBe(hero?.netM);
    expect(snap.headline.paybackX).toBeCloseTo(hero?.paybackX ?? Number.NaN, 12);
    expect(hero?.paybackX).toBeGreaterThan(1);
    // The Copy receipt, with the cost setting (the Receipt view) and without it (the headline's figure).
    const withCost = receiptTextForPeriod('month to date', snap, { period: 'mtd', tz: 'UTC', criblCostCentsPerMonth: COST });
    expect(netLine(withCost)).toBe(heroLine(snap, COST));
    expect(netLine(receiptTextForPeriod('month to date', snap, { period: 'mtd', tz: 'UTC' }))).toBe(heroLine(snap, COST));
  });

  it('a workspace metering for 30 days, mid-month: the Copy receipt matches the hero, and the cost covers only this month', async () => {
    const w = await createWorld({ settings: (s) => void (s.criblCostCentsPerMonth = COST) });
    const snap = collectingFor((await w.sweep()).snapshot as Snapshot, 30, COST);
    const hero = netFigures(snap, 'mtd', COST, 'UTC');
    expect(hero?.sinceCollecting).toBe(false);
    expect(snap.headline.netMtdM).toBe(hero?.netM);
    expect(netLine(receiptTextForPeriod('month to date', snap, { period: 'mtd', tz: 'UTC', criblCostCentsPerMonth: COST }))).toBe(heroLine(snap, COST));
    expect(netLine(receiptTextForPeriod('month to date', snap, { period: 'mtd', tz: 'UTC' }))).toBe(heroLine(snap, COST));
  });

  it('a cost edited since the sweep: the Copy receipt follows the setting, as the hero does', async () => {
    const w = await createWorld({ settings: (s) => void (s.criblCostCentsPerMonth = COST) });
    const snap = (await w.sweep()).snapshot as Snapshot;
    const doubled = COST * 2;
    expect(netLine(receiptTextForPeriod('month to date', snap, { period: 'mtd', tz: 'UTC', criblCostCentsPerMonth: doubled }))).toBe(heroLine(snap, doubled));
  });

  it('the tour rebase recomputes the same figure over the moved span', async () => {
    const w = await createWorld({ settings: (s) => void (s.criblCostCentsPerMonth = COST) });
    const snap = collectingFor((await w.sweep()).snapshot as Snapshot, 3, COST);
    const rebased = rebaseHeadline(snap, 'UTC', COST);
    const hero = netFigures(rebased, 'mtd', COST, 'UTC');
    expect(rebased.headline.netMtdM).toBe(hero?.netM);
    expect(rebased.headline.paybackX).toBeCloseTo(hero?.paybackX ?? Number.NaN, 12);
  });
});
