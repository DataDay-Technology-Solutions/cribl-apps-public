// r2 ui-8 (FINDINGS_EXTRA BO-5, major): Show the math says where every Receipt figure comes from, but with no Cribl cost
// set the hero printed "Net after Cribl ≈ $831 · Paid for itself ≈1.8× at list price" while the drawer said "No Cribl cost
// is set". The drawer's net section now shows the same estimate: "Net after Cribl (estimate)", the GB/day × $/GB basis
// and the way to the contract cost — and its value is the hero's to the dollar.

import { describe, expect, it } from 'vitest';
import { fmtDollars } from '../../core/format.ts';
import { CRIBL_LIST_MC_PER_GB } from '../../core/net.ts';
import { bytesInPerDay, listPriceEstimate, netFigures, periodFigures } from '../../src/views/Receipt/model.ts';
import { mathNetFor } from '../../src/views/Receipt/mathNet.ts';
import { receiptNetLine } from '../../src/views/Receipt/text.ts';
import { LIVE_TZ, TOUR, TOUR_TZ, liveInput } from './report-fixture.ts';

describe('r2 ui-8: the drawer\'s net is the hero\'s net', () => {
  const live = liveInput().snapshot;

  for (const period of ['mtd', 'today', '30d', 'annualized'] as const) {
    it(`no Cribl cost set (${period}): the drawer shows the list-price estimate, its basis and the link, at the hero's figure`, () => {
      const estimate = listPriceEstimate(live, period, LIVE_TZ);
      expect(estimate, 'the live fixture has an exact ingest figure').toBeDefined();
      const hero = receiptNetLine(null, estimate, false)!;
      const math = mathNetFor({ netBreakdown: null, estimate, costIsEstimate: false, savedM: periodFigures(live, period, LIVE_TZ).savedM, bytesInPerDay: bytesInPerDay(live) })!;
      expect(math).toBeDefined();
      expect(math.estimate?.href).toBe('/settings?section=cost');
      expect(math.estimate?.basis).toMatch(/^Estimate at Cribl's list price: .+ a day × \$0\.32 per GB ≈ \$[\d,]+ a month\.$/);
      expect(math.listMcPerGb).toBe(CRIBL_LIST_MC_PER_GB);
      // The drawer prints printed saved − printed cost; the hero prints the same.
      expect(fmtDollars(math.printedNetM)).toBe(fmtDollars(hero.netM));
      expect(math.paybackX).toBe(hero.paybackX);
    });
  }

  it('a contract cost: no estimate label, the set cost\'s net', () => {
    const net = netFigures(live, 'mtd', 3_500_000, LIVE_TZ);
    const math = mathNetFor({ netBreakdown: net, estimate: undefined, costIsEstimate: false, savedM: periodFigures(live, 'mtd', LIVE_TZ).savedM, bytesInPerDay: bytesInPerDay(live) })!;
    expect(math.estimate).toBeUndefined();
    expect(fmtDollars(math.printedNetM)).toBe(fmtDollars(receiptNetLine(net, undefined, false)!.netM));
  });

  it('a cost saved from the estimate keeps reading as one (with the link, without a second basis line)', () => {
    const net = netFigures(live, 'mtd', 438_500, LIVE_TZ);
    const math = mathNetFor({ netBreakdown: net, estimate: undefined, costIsEstimate: true, savedM: periodFigures(live, 'mtd', LIVE_TZ).savedM, bytesInPerDay: bytesInPerDay(live) })!;
    expect(math.estimate).toEqual({ href: '/settings?section=cost' });
  });

  it('nothing to estimate from (no exact ingest figure): no net at all, so the drawer keeps its "No Cribl cost is set" line', () => {
    expect(mathNetFor({ netBreakdown: null, estimate: undefined, costIsEstimate: false, savedM: 1, bytesInPerDay: undefined })).toBeUndefined();
  });

  it('the tour (a cost set, 30 days): unchanged, no estimate', () => {
    const net = netFigures(TOUR.snapshot, '30d', TOUR.settings.criblCostCentsPerMonth, TOUR_TZ);
    const math = mathNetFor({ netBreakdown: net, estimate: undefined, costIsEstimate: false, savedM: periodFigures(TOUR.snapshot, '30d', TOUR_TZ).savedM, bytesInPerDay: bytesInPerDay(TOUR.snapshot) })!;
    expect(math.estimate).toBeUndefined();
    expect(math.spanWords).toMatch(/days?|hours?/);
  });
});
