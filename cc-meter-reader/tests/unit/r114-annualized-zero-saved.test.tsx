// @vitest-environment jsdom
// 1.1.4, judge path (g): an untagged Datagen through the stock route with no Drop saves nothing, so the annualized run
// rate is $0 — and the Receipt's Annualized bar read "You would have paid $0 · You paid $0" while Flow and the Ledger
// showed $22 a day paid. src/views/Receipt/model.ts annualizedParts scales would-have-paid and paid by saved's own
// factor, and a saved figure of 0 left it nothing to scale by. core computeHeadline now records, only in that case,
// would-have-paid and paid as their own run rates over the rate's own metered minutes (annualizedWhpM /
// annualizedPaidM), and annualizedParts reads them ('rate'). A rate that saved anything reads exactly as before.
// Evidence: judge-validate/bundle-scenarios/out/1.1.3/g/06-receipt-70s.png (JUDGE_PATH_VALIDATION.md §1.2, §6).

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fmtDollars, footMoney } from '../../core/format.ts';
import { MINUTES_PER_YEAR, computeHeadline } from '../../core/pricing.ts';
import { addDaysToKey, localDayKey } from '../../core/time.ts';
import type { Headline, Snapshot, TotalsDoc, TrendPoint } from '../../core/types.ts';
import { MathDrawer } from '../../src/components/MathDrawer/MathDrawer.tsx';
import { ReceiptBar } from '../../src/components/ReceiptBar/ReceiptBar.tsx';
import { en } from '../../src/copy/en.ts';
import { TOUR_FIXTURE } from '../../src/tour/fixture.ts';
import { annualizedParts, periodFigures } from '../../src/views/Receipt/model.ts';

afterEach(cleanup);

// Capra's Drawer measures itself; jsdom has no ResizeObserver (it never fires here — no layout).
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

const TZ = 'America/New_York';
const NOW = Date.parse('2026-09-29T18:00:00.000Z'); // Tue 2:00 PM ET, the scenario's pinned clock
const MIN = 60_000;
const TODAY = localDayKey(NOW, TZ); // 2026-09-29
const YESTERDAY = addDaysToKey(TODAY, -1);
/** Scenario (g)'s truth over its 120 metered minutes of traffic: would have paid = paid = $1.8681, saved $0. */
const G_WHP_M = 186_810;

type Day = TotalsDoc['byDay'][string];

function totalsOf(byDay: Record<string, Day>): TotalsDoc {
  return { schemaVersion: 1, updatedAt: new Date(NOW).toISOString(), byDay };
}

function snapshotOf(headline: Headline, byDay: Record<string, Day>, collectingSinceMs: number): Snapshot {
  const trend: TrendPoint[] = Object.keys(byDay)
    .sort()
    .map((day) => ({ day, whpM: byDay[day].whpM, paidM: byDay[day].paidM, savedM: byDay[day].savedM }));
  return {
    schemaVersion: 1,
    sweepAt: new Date(NOW).toISOString(),
    windowStart: new Date(NOW - MIN).toISOString(),
    windowEnd: new Date(NOW).toISOString(),
    collectingSince: new Date(collectingSinceMs).toISOString(),
    headline,
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

describe('1.1.4 (g): the annualized run rate when nothing was saved', () => {
  it('saved 0 with traffic: would have paid and paid are their own run rates, never $0 / $0', () => {
    // Collecting began two hours ago with the traffic: 120 minutes, all priced, nothing saved.
    const since = NOW - 120 * MIN;
    const byDay = { [TODAY]: { whpM: G_WHP_M, paidM: G_WHP_M, savedM: 0, minutes: 120 } };
    const h = computeHeadline(totalsOf(byDay), NOW, TZ, since);
    expect(h.annualizedM).toBe(0);
    const rate = Math.round((G_WHP_M / 120) * MINUTES_PER_YEAR);
    expect(h.annualizedWhpM).toBe(rate);
    expect(h.annualizedPaidM).toBe(rate);

    const s = snapshotOf(h, byDay, since);
    const f = periodFigures(s, 'annualized', TZ);
    expect(f).toMatchObject({ savedM: 0, whpM: rate, paidM: rate, ratio: 0, accrues: false, derivedFrom: 'rate' });
    // $1.8681 over 120 minutes is $8,182 a year paid, as Flow and the Ledger's $22 a day say.
    expect(printed(f)).toEqual(['$8,182', '$8,182', '$0']);

    // The hero bar says so in words, not "You would have paid $0: paid $0, saved $0".
    render(<ReceiptBar whpM={f.whpM} paidM={f.paidM} savedM={f.savedM} ratio={f.ratio} />);
    expect(screen.getAllByText('$8,182').length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).toContain('0%');
    cleanup();

    // Show the math says how they were derived: their own run rates, not a scale of saved.
    render(
      <MathDrawer
        isOpen
        onClose={() => {}}
        periodCaption="annualized run rate"
        figures={f}
        destinations={[]}
        attribution="route"
        sweepAtMs={NOW}
        ratePerSecM={0}
        tz={TZ}
      />,
    );
    expect(document.body.textContent).toContain(en.receiptView.math.annualizedRateNote);
    expect(document.body.textContent).not.toContain(en.receiptView.math.annualizedTrendNote);
  });

  it('saved 0 with traffic after a first run that metered empty history: the basis is the priced minutes only', () => {
    // As scenario (g) ran it: the first run metered back to 1:59 PM yesterday (1,441 minutes, 3% of the month), but the
    // Datagen began at noon today, so 720 of today's 840 minutes carried nothing (the sweep recorded them). The rate
    // rests on the 120 priced minutes, exactly as saved's own rate does — never on the month's 1,441 (12× low).
    const collectingSince = NOW - 1441 * MIN;
    const pricedSinceMs = NOW - 120 * MIN;
    const byDay = {
      [YESTERDAY]: { whpM: 0, paidM: 0, savedM: 0, minutes: 601 },
      [TODAY]: { whpM: G_WHP_M, paidM: G_WHP_M, savedM: 0, minutes: 840 },
    };
    const h = computeHeadline(totalsOf(byDay), NOW, TZ, collectingSince, undefined, NOW, { pricedSinceMs, emptyMinutesBeforePriced: 720 });
    expect(h.annualizedM).toBe(0);
    expect(h.minutes30d).toBe(1441);
    const rate = Math.round((G_WHP_M / 120) * MINUTES_PER_YEAR);
    expect(h.annualizedWhpM).toBe(rate);
    expect(h.annualizedPaidM).toBe(rate);
    expect(h.annualizedWhpM).not.toBe(Math.round((G_WHP_M / 1441) * MINUTES_PER_YEAR));

    const f = periodFigures(snapshotOf(h, byDay, collectingSince), 'annualized', TZ);
    expect(f.derivedFrom).toBe('rate');
    expect(printed(f)).toEqual(['$8,182', '$8,182', '$0']);
  });

  it('saved 0 where the spend saves nothing by design (counterfactual "none"): paid is still its run rate', () => {
    const since = NOW - 60 * MIN;
    const byDay = { [TODAY]: { whpM: 0, paidM: 50_000, savedM: 0, minutes: 60 } };
    const h = computeHeadline(totalsOf(byDay), NOW, TZ, since);
    const f = periodFigures(snapshotOf(h, byDay, since), 'annualized', TZ);
    expect(f).toMatchObject({ savedM: 0, whpM: 0, paidM: Math.round((50_000 / 60) * MINUTES_PER_YEAR), ratio: 0, derivedFrom: 'rate' });
  });

  it('saved 0 with no traffic: $0 / $0 / $0 and 0%, with no NaN', () => {
    const since = NOW - 120 * MIN;
    const idle = { [TODAY]: { whpM: 0, paidM: 0, savedM: 0, minutes: 120 } };
    const h = computeHeadline(totalsOf(idle), NOW, TZ, since);
    expect(h).toMatchObject({ annualizedM: 0, annualizedWhpM: 0, annualizedPaidM: 0 });
    const f = periodFigures(snapshotOf(h, idle, since), 'annualized', TZ);
    expect(f).toMatchObject({ savedM: 0, whpM: 0, paidM: 0, ratio: 0, derivedFrom: 'rate' });
    expect(printed(f)).toEqual(['$0', '$0', '$0']);

    // Nothing metered at all (a first open): no rates are recorded, and the figures stay finite zeros.
    const empty = computeHeadline(totalsOf({}), NOW, TZ, NOW);
    expect(empty).not.toHaveProperty('annualizedWhpM');
    expect(empty).not.toHaveProperty('annualizedPaidM');
    const e = periodFigures(snapshotOf(empty, {}, NOW), 'annualized', TZ);
    for (const v of [e.savedM, e.whpM, e.paidM, e.ratio]) expect(v).toBe(0);
  });

  it('a snapshot written before 1.1.4 (no recorded rates) guesses nothing: the old arithmetic until the next sweep', () => {
    const since = NOW - 120 * MIN;
    const byDay = { [TODAY]: { whpM: G_WHP_M, paidM: G_WHP_M, savedM: 0, minutes: 120 } };
    const { annualizedWhpM: _w, annualizedPaidM: _p, ...older } = computeHeadline(totalsOf(byDay), NOW, TZ, since);
    const parts = annualizedParts(snapshotOf(older, byDay, since), TZ);
    expect(parts).toEqual({ whpM: 0, paidM: 0, derivedFrom: 'ratio' });
  });
});

describe('1.1.4 (g): a rate that saved anything is unchanged', () => {
  it('records no zero-saved rates, and still scales by saved over the trend', () => {
    const since = NOW - 120 * MIN;
    const byDay = { [TODAY]: { whpM: 2 * G_WHP_M, paidM: G_WHP_M, savedM: G_WHP_M, minutes: 120 } };
    const h = computeHeadline(totalsOf(byDay), NOW, TZ, since);
    expect(h.annualizedM).toBe(Math.round((G_WHP_M / 120) * MINUTES_PER_YEAR));
    expect(h).not.toHaveProperty('annualizedWhpM');
    expect(h).not.toHaveProperty('annualizedPaidM');
    const f = periodFigures(snapshotOf(h, byDay, since), 'annualized', TZ);
    expect(f.derivedFrom).toBe('trend');
    expect(f.savedM).toBe(h.annualizedM);
    expect(f.whpM).toBe(2 * h.annualizedM);
    expect(f.paidM).toBe(h.annualizedM);
    expect(f.ratio).toBeCloseTo(0.5, 9);
  });

  it('the recorded rates never override a saved rate, even when a snapshot carries both', () => {
    const since = NOW - 120 * MIN;
    const byDay = { [TODAY]: { whpM: 2 * G_WHP_M, paidM: G_WHP_M, savedM: G_WHP_M, minutes: 120 } };
    const h = computeHeadline(totalsOf(byDay), NOW, TZ, since);
    const forged = { ...h, annualizedWhpM: 1, annualizedPaidM: 1 };
    expect(annualizedParts(snapshotOf(forged, byDay, since), TZ)).toEqual(annualizedParts(snapshotOf(h, byDay, since), TZ));
  });

  it('the sample tour carries no zero-saved rates and keeps its trend derivation', () => {
    const tour = TOUR_FIXTURE.snapshot;
    expect(tour.headline.annualizedM).toBeGreaterThan(0);
    expect(tour.headline).not.toHaveProperty('annualizedWhpM');
    expect(tour.headline).not.toHaveProperty('annualizedPaidM');
    expect(periodFigures(tour, 'annualized', TOUR_FIXTURE.settings.displayTimezone).derivedFrom).toBe('trend');
  });
});
