// tests/unit/report.test.ts — the report card model (core/report.ts): it reconciles to the Receipt for the same
// period to the millicent (src/views/Receipt/model.ts), its ROI and net follow the Receipt's rules, the two
// percentages keep their bases (dollars vs volume), top-N counts, sample marking, unpriced destinations, the
// protection section, and nothing divides by zero.

import { describe, expect, it } from 'vitest';
import { alertLine, buildReportCard, fill, fmtMultiple, fmtPricePerGb, formatStamp, formatUtcStamp, meteredByWords, plural, reportPeriodFigures, slugify, volumeReduction } from '../../core/report.ts';
import { MC_PER_DOLLAR, fmtDollars, fmtDollarsCents, fmtPct, fmtPlainDollars, fmtPlainGb, roundToDollarsM } from '../../core/format.ts';
import { planRebase, rebaseHeadline, rebaseValue } from '../../src/tour/rebase.ts';
import { rangeSpanLabel, sumRange, type RangeFigures } from '../../core/range.ts';
import type { PricesDoc, RollMinuteDoc, Snapshot } from '../../core/types.ts';
import { destinationRows, moneyDestinations, netFigures, periodFigures, printedNetM } from '../../src/views/Receipt/model.ts';
import { en } from '../../src/copy/en.ts';
import { meteredSpan } from '../../core/net.ts';
import { localMidnightMs, localMonthStartMs } from '../../core/time.ts';
import { COPY, LIVE_NOW, LIVE_TZ, TOUR, TOUR_TZ, liveCard, liveInput, liveWorkspace, sampleCard, sampleInput } from './report-fixture.ts';

const PERIODS = ['mtd', 'today', '30d'] as const;

/** Every number anywhere in a value is finite (no NaN / Infinity slipped through a division). */
function allFinite(value: unknown, path = 'card'): string[] {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => allFinite(v, `${path}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => allFinite(v, `${path}.${k}`));
  return [];
}

/** Every string in the card (minus the copy it carries). */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => (k === 'copy' ? [] : strings(v)));
  return [];
}

describe('copy contract', () => {
  it('en.ts report.doc satisfies ReportCopy and has no empty string', () => {
    expect(COPY).toBe(en.report.doc);
    const empties = strings(COPY).filter((s) => s.trim() === '');
    expect(empties).toEqual([]);
    expect(COPY.csv.headers).toHaveLength(15);
  });

  it('fill leaves unknown placeholders visible; plural picks one/other', () => {
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}');
    expect(plural({ one: '{n} alert', other: '{n} alerts' }, 1)).toBe('1 alert');
    expect(plural({ one: '{n} alert', other: '{n} alerts' }, 3)).toBe('3 alerts');
  });
});

describe('reconciles to the Receipt for the same period', () => {
  for (const period of PERIODS) {
    it(`sample workspace, ${period}: saved / would have paid / paid / ratio to the millicent`, () => {
      const card = sampleCard({ kind: period });
      const receipt = periodFigures(TOUR.snapshot, period, TOUR_TZ);
      expect(card.headline.savedM).toBe(receipt.savedM);
      expect(card.headline.whpM).toBe(receipt.whpM);
      expect(card.headline.paidM).toBe(receipt.paidM);
      expect(card.headline.dollarRatio).toBe(receipt.ratio);
      expect(card.headline.label).toContain(COPY.periodCaption[period]);
    });

    it(`live workspace, ${period}: saved / would have paid / paid / ratio to the millicent`, () => {
      const input = liveInput({ kind: period }, { criblCostCentsPerMonth: 3_500_000 });
      const card = buildReportCard(input);
      const receipt = periodFigures(input.snapshot, period, LIVE_TZ);
      expect([card.headline.savedM, card.headline.whpM, card.headline.paidM, card.headline.dollarRatio]).toEqual([receipt.savedM, receipt.whpM, receipt.paidM, receipt.ratio]);
      expect(reportPeriodFigures(input.snapshot, { kind: period })).toEqual({ savedM: receipt.savedM, whpM: receipt.whpM, paidM: receipt.paidM, ratio: receipt.ratio });
    });
  }

  it('net after Cribl and payback: month to date exactly as the Receipt, the run rate as its annualized net', () => {
    const cost = TOUR.settings.criblCostCentsPerMonth;
    expect(cost).toBeGreaterThan(0);
    const card = sampleCard({ kind: 'mtd' });
    // The Receipt's call for the sample (src/views/Receipt/index.tsx: `{ frozen: source === 'sample' }`, r2 ui-12; the
    // Report follows it since r3 core-6).
    const mtd = netFigures(TOUR.snapshot, 'mtd', cost, TOUR_TZ, { frozen: true });
    const annual = netFigures(TOUR.snapshot, 'annualized', cost, TOUR_TZ);
    // R2 core-7 (FINDINGS_R2 #8): the net prints as the Receipt prints it (r1 ui-8, D53): printed saved − printed cost.
    expect(card.cribl?.period?.netM).toBe(printedNetM(mtd!.netM, mtd!.costM));
    expect(card.cribl?.period?.paybackX).toBe(mtd?.paybackX);
    expect(card.cribl?.runRate.netM).toBe(printedNetM(annual!.netM, annual!.costM));
    expect(card.cribl?.runRate.paybackX).toBe(annual?.paybackX);
  });

  it('destinations: the Receipt rows, same order, same per-day money, bytes and prices', () => {
    for (const input of [sampleInput(), liveInput()]) {
      const card = buildReportCard(input);
      const receiptRows = moneyDestinations(destinationRows(input.snapshot, input.prices, input.settings.humanize));
      expect(card.destinations.rows.map((r) => r.key)).toEqual(receiptRows.map((r) => r.key));
      card.destinations.rows.forEach((r, i) => {
        const x = receiptRows[i];
        expect([r.whpPerDayM, r.paidPerDayM, r.savedPerDayM, r.inBPerDay, r.outBPerDay, r.mcPerGb, r.unpriced, r.label]).toEqual([
          x.whpPerDayM,
          x.paidPerDayM,
          x.savedPerDayM,
          x.inBPerDay,
          x.outBPerDay,
          x.paidMcPerGb,
          x.unpriced,
          x.label,
        ]);
        if (x.presetLabel && !x.unpriced) expect(r.pricedAs).toBe(r.isPresetPrice ? x.presetLabel : fill(COPY.pricedAsYourRate, { preset: x.presetLabel }));
      });
    }
  });

  it('top savers: the Receipt list (at most five), same per-day money', () => {
    const card = sampleCard();
    expect(card.topSavers.rows.map((r) => [r.key, r.label, r.savedPerDayM])).toEqual(TOUR.snapshot.topSavers.slice(0, 5).map((s) => [s.objectKey, s.label, s.savedPerDayM]));
    // One annual figure on the card (the run rate): a saver carries its per-day money only.
    for (const r of card.topSavers.rows) expect(Object.keys(r)).not.toContain('savedPerYearM');
  });

  it('a custom range reports the range figures, its words and its caption', () => {
    const w = liveWorkspace();
    const t0 = Date.UTC(2026, 8, 25, 15, 0);
    const doc: RollMinuteDoc = {
      schemaVersion: 1,
      bucketStart: new Date(t0).toISOString(),
      flows: {
        [w.snapshot.flows[0].key]: [0, 1, 2].map((i) => ({ t: new Date(t0 + i * 60_000).toISOString(), inB: 1e9, outB: 4e8, inE: 1, outE: 1, whpM: 225_000, paidM: 90_000, savedM: 135_000 })),
      },
    };
    const figures: RangeFigures = sumRange({ 'roll/min/2026-09-25T15': doc }, 'minute', t0, t0 + 3 * 60_000);
    const card = buildReportCard(liveInput({ kind: 'range', figures, caption: 'minute-exact' }));
    expect([card.headline.savedM, card.headline.whpM, card.headline.paidM, card.headline.dollarRatio]).toEqual([405_000, 675_000, 270_000, 0.6]);
    expect(card.period.kind).toBe('range');
    expect(card.period.span).toBe(rangeSpanLabel(figures.fromMs, figures.toMs, LIVE_TZ));
    expect(card.period.caption).toBe('minute-exact');
    // The file name describes the window in the display timezone, as the title prints it (OQ-15): 15:00Z is 10:00 in
    // America/Chicago.
    expect(card.period.slug).toBe('range-20260925t1000-20260925t1003');
    expect(card.fileBase).toBe('meter-reader-report-acme-prod-range-20260925t1000-20260925t1003-2026-09-25');
    expect(card.headline.label).toBe(fill(COPY.heroLabel, { period: card.period.span }));
    // Inside the last 24 hours the alert history covers the whole window.
    expect(card.protection.coverage).toBe('period');
    // No net for a range: only the run rate carries Cribl's cost (no cost set here).
    expect(card.cribl).toBeUndefined();
  });
});

describe('ROI and net after Cribl', () => {
  it('month to date: the prorated cost, the net and the payback in the KPI tile', () => {
    const input = liveInput({ kind: 'mtd' }, { criblCostCentsPerMonth: 3_500_000 });
    const card = buildReportCard(input);
    const h = input.snapshot.headline;
    // The cost for the minutes metered this month (core/net.ts), from the later of Sep 1 and when collecting began
    // to the sweep — the Receipt's net, not SPEC 8's day-of-month share.
    const sweep = Date.parse(input.snapshot.sweepAt);
    const span = meteredSpan(localMonthStartMs(sweep, LIVE_TZ), sweep, Date.parse(input.snapshot.collectingSince));
    const prorated = ((3_500_000 * 1000 * 12) / 525_600) * span.minutes;
    expect(card.cribl?.period?.costM).toBe(Math.round(prorated));
    // R2 core-7 (#8): whole dollars, printed saved − printed cost.
    const footed = roundToDollarsM(h.mtdM) - roundToDollarsM(Math.round(prorated));
    expect(card.cribl?.period?.netM).toBe(footed);
    expect(card.cribl?.period?.paybackX).toBeCloseTo(h.mtdM / prorated, 12);
    const payback = h.mtdM / prorated;
    const tile = card.kpis[1];
    expect(tile.label).toBe(COPY.kpi.roi);
    expect(tile.value).toBe(fill(COPY.kpi.roiValue, { multiple: fmtMultiple(payback) }));
    expect(tile.lines[0]).toBe(fill(COPY.kpi.roiEvery, { amount: fmtDollarsCents(Math.round(payback * 100_000)) }));
    // ROI as a CFO computes it: net savings ÷ cost = payback − 1.
    expect(tile.lines[1]).toBe(fill(COPY.kpi.roiPct, { pct: fmtPct(payback - 1) }));
    expect(tile.lines[2]).toBe(fill(COPY.kpi.netPeriod, { amount: fmtDollars(footed), period: COPY.periodCaption.mtd }));
  });

  it('rules round 2: a cost saved from "Use this estimate" is marked as an estimate; a contract cost is not', () => {
    const input = liveInput({ kind: 'mtd' }, { criblCostCentsPerMonth: 3_500_000 });
    expect(buildReportCard({ ...input, settings: { ...input.settings, criblCostEstimate: true } }).cribl?.estimate).toBe(true);
    expect(buildReportCard(liveInput({ kind: 'mtd' }, { criblCostCentsPerMonth: 3_500_000 })).cribl?.estimate).toBeUndefined();
  });

  it('other periods: the run rate against twelve months of the cost', () => {
    const input = liveInput({ kind: '30d' }, { criblCostCentsPerMonth: 3_500_000 });
    const card = buildReportCard(input);
    const annual = input.snapshot.headline.annualizedM;
    const yearCost = 3_500_000 * 1000 * 12;
    expect(card.cribl?.period).toBeUndefined();
    // R2 core-7 (#8): the nets in whole dollars, printed saved − printed cost.
    const net = roundToDollarsM(annual) - roundToDollarsM(yearCost);
    expect(card.cribl?.runRate).toEqual({ costM: yearCost, netM: net, paybackX: annual / yearCost, monthlyNetM: roundToDollarsM(Math.round(annual / 12)) - 3_500_000 * 1000 });
    expect(card.kpis[1].lines[1]).toBe(fill(COPY.kpi.roiPct, { pct: fmtPct(annual / yearCost - 1) }));
    expect(card.kpis[1].lines[2]).toBe(fill(COPY.kpi.netRunRate, { amount: fmtDollars(net) }));
    expect(card.methodology).toContain(fill(COPY.methodology.criblCost, { amount: '$35,000' }));
  });

  it('no cost set: no net, the tile says so, the methodology says why', () => {
    const card = liveCard({ kind: 'mtd' });
    expect(card.cribl).toBeUndefined();
    expect(card.kpis[1]).toMatchObject({ value: COPY.kpi.roiUnset, lines: [COPY.kpi.roiUnsetHint], tone: 'muted' });
    expect(card.methodology).toContain(COPY.methodology.criblCostUnset);
  });

  it('a cost with nothing saved yet reads 0.0×, never NaN', () => {
    const w = liveWorkspace({ criblCostCentsPerMonth: 100_000 });
    const snapshot: Snapshot = { ...w.snapshot, headline: { ...w.snapshot.headline, annualizedM: 0, mtdM: 0, netMtdM: -1000, paybackX: 0 } };
    const card = buildReportCard({ ...liveInput({ kind: '30d' }), snapshot, settings: w.settings });
    expect(card.cribl?.runRate.paybackX).toBe(0);
    expect(card.kpis[1].value).toBe('0.0×');
  });
});

describe('dollars and volume are two labelled percentages', () => {
  it('the hero says "of dollars saved", the volume tile says "less data", and they differ', () => {
    const card = sampleCard();
    expect(card.headline.subline[2]).toBe(fill(COPY.heroDollarPct, { pct: fmtPct(card.headline.dollarRatio) }));
    const volume = card.kpis[2];
    expect(volume.unit).toBe(COPY.kpi.volumeUnit);
    const expected = 1 - card.volume.outBPerDay / card.volume.inBPerDay;
    expect(card.volume.ratio).toBeCloseTo(expected, 12);
    expect(volume.value).toBe(fmtPct(expected));
    expect(volume.lines).toContain(COPY.kpi.volumeBasis);
    expect(fmtPct(card.headline.dollarRatio)).not.toBe(volume.value);
    // Per saver: the volume reduction from the route's own bytes, next to its dollar ratio.
    for (const r of card.topSavers.rows) {
      const flows = TOUR.snapshot.flows.filter((f) => `route:${f.groupId}:${f.routeId}` === r.key);
      const inB = flows.reduce((s, f) => s + f.inBPerDay, 0);
      const outB = flows.reduce((s, f) => s + f.outBPerDay, 0);
      expect(r.volumeRatio).toBeCloseTo(1 - outB / inB, 12);
    }
  });

  it('volumeReduction clamps and refuses to divide by zero', () => {
    expect(volumeReduction(0, 0)).toBeUndefined();
    expect(volumeReduction(100, 150)).toBe(0);
    expect(volumeReduction(100, 25)).toBe(0.75);
  });
});

describe('top savers', () => {
  it('shows at most five and says of how many', () => {
    const card = sampleCard();
    expect(card.topSavers.shown).toBe(5);
    expect(card.topSavers.total).toBe(30);
    expect(card.topSavers.caption).toBe(fill(COPY.top.captionOf, { n: 5, total: 30 }));
  });

  it('counts every saving route; says "the top N" when all are shown and "the top saver" for one', () => {
    const live = liveCard();
    // r_cdn passes everything through and r_dns goes nowhere (would have paid $0): four routes save.
    expect(live.topSavers.total).toBe(4);
    expect(live.topSavers.caption).toBe(plural(COPY.top.caption, 4));
    const w = liveWorkspace();
    const one: Snapshot = { ...w.snapshot, flows: w.snapshot.flows.slice(0, 2), topSavers: w.snapshot.topSavers.filter((s) => s.objectKey === 'route:default:r_win') };
    const card = buildReportCard({ ...liveInput(), snapshot: one });
    expect(card.topSavers.shown).toBe(1);
    expect(card.topSavers.caption).toBe(plural(COPY.top.caption, 1));
    expect(card.topSavers.rows[0].flow).toBe(fill(COPY.flowArrow, { from: fill(COPY.flowMore, { first: 'Windows DC', n: 1 }), to: 'SIEM' }));
  });
});

describe('sample data', () => {
  it('is marked as a sample and never claims a meter', () => {
    const card = sampleCard();
    expect(card.sample).toBe(true);
    expect(card.about.find((a) => a.label === COPY.about.data)?.value).toBe(COPY.about.dataSample);
    expect(card.about.some((a) => a.label === COPY.about.meteredBy)).toBe(false);
    expect(card.fileBase).toBe('meter-reader-report-sample-enterprise-mtd-2026-09-24');
  });

  it('live data says who metered it', () => {
    const card = liveCard();
    expect(card.sample).toBe(false);
    expect(card.about.find((a) => a.label === COPY.about.meteredBy)?.value).toBe(fill(COPY.meteredBy.runnerHost, { host: 'workhorse' }));
    expect(card.about.find((a) => a.label === COPY.about.data)?.value).toBe(COPY.about.dataLive);
  });
});

describe('prices and unpriced destinations', () => {
  it('flags unpriced destinations, keeps them out of the money, and names them', () => {
    const card = liveCard();
    const edge = card.destinations.rows.find((r) => r.outputId === 'edge_cdn');
    expect(edge).toMatchObject({ unpriced: true, pricedAs: COPY.unpriced });
    expect(card.destinations.rows[card.destinations.rows.length - 1].unpriced).toBe(true);
    expect(card.destinations.unpricedLabels).toEqual(['Edge CDN, "public"']);
    expect(card.destinations.unpricedNote).toBe(plural(COPY.destinations.unpricedNote, 1, { names: 'Edge CDN, "public"' }));
  });

  it('describes each counterfactual and lists every price once, preset or custom', () => {
    const card = liveCard();
    // Priced elsewhere: the row names the price its would-have-paid uses, so the row can be recomputed.
    const archive = card.destinations.rows.find((r) => r.outputId === 'archive');
    expect(archive?.whpMcPerGb).toBe(225_000);
    expect(archive?.counterfactualNote).toBe(fill(COPY.counterfactualOther, { destination: 'SIEM', price: '$2.25' }));
    expect(card.destinations.rows.find((r) => r.outputId === 'devnull_copy')?.counterfactualNote).toBe(COPY.counterfactualNone);
    const labels = card.prices.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    const splunk = card.prices.find((p) => p.key === 'preset:splunk_cloud');
    expect(splunk).toMatchObject({ mcPerGb: 225_000, range: '$1.47–$4.85', basis: COPY.methodology.confidence.reported, custom: false });
    // The publisher's name, not a host a CFO can't read; the link still goes to the document.
    expect(splunk?.source).toBe('UK G-Cloud filing');
    expect(splunk?.sourceUrl).toMatch(/applytosupply/);
    // Datadog was entered at $1.50 against a $1.80 preset: the admin's rate, not the typical one, named the
    // same way in both tables.
    const yours = fill(COPY.pricedAsYourRate, { preset: 'Datadog Logs' });
    expect(card.prices.find((p) => p.label === yours)).toMatchObject({ custom: true, basis: fill(COPY.methodology.customBasis, { destination: 'Analytics' }), mcPerGb: 150_000 });
    expect(card.destinations.rows.find((r) => r.outputId === 'analytics')).toMatchObject({ pricedAs: yours, isPresetPrice: false, hasPriceEntry: true });
    // A rate with no preset at all.
    expect(card.destinations.rows.find((r) => r.outputId === 'devnull_copy')?.pricedAs).toBe(COPY.yourRate);
  });

  it('works with no prices document at all (every destination as the snapshot has it)', () => {
    const card = liveCard({ kind: 'mtd' }, { prices: null });
    expect(card.destinations.rows.length).toBeGreaterThan(0);
    expect(card.destinations.rows.find((r) => r.outputId === 'siem')?.mcPerGb).toBe(225_000);
    expect(card.destinations.rows.every((r) => r.presetId === undefined)).toBe(true);
    expect(card.prices.every((p) => p.custom)).toBe(true);
    // Nothing says where the prices came from, so the card makes no claim about them.
    expect(card.priceMix).toEqual({ list: 0, custom: 0 });
    expect(card.headline.basis).toBeUndefined();
    expect(card.prices.every((p) => !p.basis.startsWith('Entered by an admin'))).toBe(true);
  });

  it('page 1 says what the prices are: typical list prices, an admin’s rates, or both', () => {
    const sample = sampleCard();
    expect(sample.priceMix).toEqual({ list: 8, custom: 0 });
    expect(sample.headline.basis).toBe(plural(COPY.heroBasis.list, 8));
    const live = liveCard();
    expect(live.priceMix).toEqual({ list: 2, custom: 2 });
    expect(live.headline.basis).toBe(plural(COPY.heroBasis.mixed, 4, { list: 2 }));
    const w = liveWorkspace();
    const custom: PricesDoc = {
      ...w.prices!,
      versions: w.prices!.versions.map((v) => ({ ...v, byOutputId: Object.fromEntries(Object.entries(v.byOutputId).map(([k, { preset: _preset, ...e }]) => [k, e])) })),
    };
    const card = buildReportCard(liveInput({ kind: 'mtd' }, { prices: custom }));
    expect(card.priceMix).toEqual({ list: 0, custom: 4 });
    expect(card.headline.basis).toBe(COPY.heroBasis.custom);
  });

  it('fmtPricePerGb keeps the entered precision', () => {
    expect(fmtPricePerGb(225_000)).toBe('$2.25');
    expect(fmtPricePerGb(2_300)).toBe('$0.023');
    expect(fmtPricePerGb(0)).toBe('$0.00');
  });
});

describe('protection', () => {
  it('lists regressions and spikes opened in the period, newest first, with how fast and what moved', () => {
    const card = liveCard({ kind: 'today' });
    expect(card.protection.rows.map((r) => r.id)).toEqual(['spike-open', 'reg-open', 'reg-recovered', 'spike-closed']);
    expect(card.protection.count).toBe(4);
    // At risk counts only what is still open; the recovered ones are history, not exposure.
    expect(card.protection.openCount).toBe(2);
    // Founder-build r1 core-10 (M4, #18): "until fixed" is a regression's; an open spike is a day while it lasts.
    expect(card.protection.atRiskPerDayM).toBe(250 * 100_000);
    expect(card.protection.totalPerDayM).toBe((792 + 250 + 90 + 400) * 100_000);
    expect(card.protection.fastestSec).toBe(95);
    expect(card.protection.medianSec).toBe(120);
    expect(card.protection.coverage).toBe('period');
    const byId = Object.fromEntries(card.protection.rows.map((r) => [r.id, r]));
    expect(byId['reg-open']).toMatchObject({
      title: fill(COPY.alert.regression, { label: 'Windows trimming' }),
      measure: fill(COPY.measure.ratio, { before: '75%', after: '50%' }),
      status: 'open',
      caughtText: '2\u00a0min 51\u00a0s',
      // C5 (founder-build r1 core-4): the channels' and the cards' one author rule — 'Zx9QgE@clients' → '··9QgE'.
      commit: { hash: 'a1f3c9e', message: 'break the trim', author: 'API client ··9QgE' },
    });
    expect(byId['reg-open'].causeText).toBe(fill(COPY.commit, { hash: 'a1f3c9e', message: 'break the trim', author: 'API client ··9QgE' }));
    expect(byId['reg-recovered'].measure).toBe(fill(COPY.measure.ratioRecovered, { before: '30%', after: '12%', recovered: '31%' }));
    expect(byId['spike-closed'].measure).toBe(fill(COPY.measure.spikeBackTo, { recovered: '$19' }));
    expect(byId['spike-open'].measure).toBe(fill(COPY.measure.spike, { before: '$15', after: '$48' }));
    expect(byId['spike-open'].caughtText).toBeUndefined();
    expect(byId['reg-recovered'].causeText).toBe(COPY.noCommit);
    // Open: the daily figure and, only there, what a year of it would cost if left. Recovered: how long it lasted.
    expect(byId['reg-open'].impactText).toBe(fill(COPY.impact.open, { perDay: '$250', perYear: '$91.3k' }));
    expect(byId['reg-recovered'].impactText).toBe(fill(COPY.impact.closed, { perDay: '$90', duration: '1\u00a0h' }));
    expect(byId['reg-recovered'].durationSec).toBe(3600);
    expect(byId['spike-closed'].impactText).not.toMatch(/year/);
    expect(card.kpis[3]).toMatchObject({ value: '4', unit: plural(COPY.kpi.protectionUnit, 4) });
    expect(card.kpis[3].lines).toEqual([fill(COPY.kpi.protectionAtRisk, { amount: '$250' }), fill(COPY.kpi.protectionCaught, { time: '1\u00a0min 35\u00a0s' })]);
    expect(card.protection.summary).toBe(
      fill(COPY.protection.summaryOpen, { alerts: plural(COPY.kpi.protectionValue, 4), amount: '$250' }) + fill(COPY.protection.fastest, { fastest: '1\u00a0min 35\u00a0s', median: '2\u00a0min' }),
    );
  });

  it('M4 (#18): an open cost spike reads "while it lasts", never a year, and stays out of the "until fixed" sum', () => {
    const card = liveCard({ kind: 'today' });
    const spike = card.protection.rows.find((r) => r.id === 'spike-open')!;
    // The channels' and the card's spike wording (core/strings.ts, the same words as en.ts incidents.impact.spike).
    expect(spike.impactText).toBe(fill(en.incidents.impact.spike, { perDay: '$792' }));
    expect(spike.impactText).toContain('while it lasts');
    expect(spike.impactText).not.toMatch(/year/);
    expect(strings(card).join('\n')).not.toMatch(/\$792[^\n]*a year/);
    // Only spikes open: the KPI and summary say "while it lasts", never "at risk until fixed".
    const w = liveWorkspace();
    const onlySpike = buildReportCard({ ...liveInput({ kind: 'today' }), snapshot: { ...w.snapshot, incidents: w.snapshot.incidents.filter((i) => i.id === 'spike-open') } });
    expect(onlySpike.protection.atRiskPerDayM).toBe(0);
    expect(onlySpike.kpis[3].lines[0]).toBe(fill(en.incidents.impact.spike, { perDay: '$792' }));
    expect(onlySpike.protection.summary).not.toMatch(/until fixed|a year/);
    expect(onlySpike.protection.summary).toContain('while it lasts');
  });

  it('a regression closed before recoveredTo existed reads its close as the recovery', () => {
    const w = liveWorkspace();
    const legacy = { ...w.snapshot.incidents[1], recoveredTo: undefined, after: 0.31 };
    const card = buildReportCard({ ...liveInput({ kind: 'today' }), snapshot: { ...w.snapshot, incidents: [legacy] } });
    expect(card.protection.rows[0].measure).toBe(fill(COPY.measure.recoveredOnly, { before: '30%', recovered: '31%' }));
  });

  it('a regression closed on the wrong side with no recoveredTo keeps its drop and claims no recovery (D47)', () => {
    const w = liveWorkspace();
    const belowFloor = { ...w.snapshot.incidents[1], before: 0.75, after: 0.5, recoveredTo: undefined };
    const card = buildReportCard({ ...liveInput({ kind: 'today' }), snapshot: { ...w.snapshot, incidents: [belowFloor] } });
    expect(card.protection.rows[0].measure).toBe(fill(COPY.measure.ratio, { before: '75%', after: '50%' }));
  });

  it('a spike closed before recoveredTo existed, still above its baseline, keeps its rise and claims no recovery (D47)', () => {
    const w = liveWorkspace();
    const reset = { ...w.snapshot.incidents[2], after: 4_000_000, recoveredTo: undefined };
    const card = buildReportCard({ ...liveInput({ kind: 'today' }), snapshot: { ...w.snapshot, incidents: [reset] } });
    expect(card.protection.rows[0].measure).toBe(fill(COPY.measure.spike, { before: '$20', after: '$40' }));
  });

  it('a spike closed with recoveredTo shows the whole story', () => {
    const w = liveWorkspace();
    const spike = { ...w.snapshot.incidents[2], after: 4_000_000, recoveredTo: 2_100_000 };
    const card = buildReportCard({ ...liveInput({ kind: 'today' }), snapshot: { ...w.snapshot, incidents: [spike] } });
    expect(card.protection.rows[0].measure).toBe(fill(COPY.measure.spikeRecovered, { before: '$20', after: '$40', recovered: '$21' }));
  });

  it('a period longer than the alert history on hand says so', () => {
    const card = liveCard({ kind: '30d' });
    expect(card.protection.coverage).toBe('last24h');
    expect(card.protection.caption).toBe(COPY.protection.captionLast24h);
    expect(card.protection.rows.map((r) => r.id)).not.toContain('old-regression');
    // Page 1's tile says it too, not just page 2.
    expect(card.kpis[3].lines[0]).toBe(COPY.kpi.protectionWindow);
  });

  it('only recovered alerts: the tile and the summary say "now recovered", never "at risk"', () => {
    const w = liveWorkspace();
    const closed = w.snapshot.incidents.filter((i) => i.closedAt && (i.type === 'regression' || i.type === 'spike'));
    const card = buildReportCard({ ...liveInput({ kind: 'today' }), snapshot: { ...w.snapshot, incidents: closed } });
    expect(card.protection).toMatchObject({ count: 2, openCount: 0, atRiskPerDayM: 0, totalPerDayM: (90 + 400) * 100_000 });
    expect(card.kpis[3].lines[0]).toBe(fill(COPY.kpi.protectionRecovered, { amount: '$490' }));
    expect(card.protection.summary.startsWith(fill(COPY.protection.summaryRecovered, { alerts: plural(COPY.kpi.protectionValue, 2) }))).toBe(true);
    expect(strings(card.protection).join(' ')).not.toMatch(/at risk/);
  });

  it('with nothing caught, the tile and the summary say so', () => {
    const card = liveCard({ kind: 'mtd' }, { withIncidents: false });
    expect(card.protection).toMatchObject({ count: 0, atRiskPerDayM: 0, summary: COPY.protection.none });
    expect(card.kpis[3]).toMatchObject({ value: COPY.kpi.protectionNone, tone: 'muted' });
  });
});

describe('an empty workspace never divides by zero', () => {
  const empty = (): Snapshot => {
    const w = liveWorkspace({ withIncidents: false });
    return {
      ...w.snapshot,
      headline: { todayM: 0, mtdM: 0, d30M: 0, annualizedM: 0, annualizedFromDays: 0, whpMtdM: 0, paidMtdM: 0, ratioMtd: 0, whpTodayM: 0, paidTodayM: 0, whp30dM: 0, paid30dM: 0 },
      flows: [],
      destinations: [],
      topSavers: [],
      unpricedOutputIds: [],
      trend: [],
      incidents: [],
      collectingSince: w.snapshot.sweepAt,
    };
  };

  for (const period of PERIODS) {
    it(`${period}: every figure finite, every section in its empty state`, () => {
      const card = buildReportCard({ ...liveInput({ kind: period }), snapshot: empty(), prices: null, workspace: '' });
      expect(allFinite({ ...card, copy: undefined })).toEqual([]);
      expect(strings(card).filter((s) => /NaN|Infinity|undefined/.test(s))).toEqual([]);
      expect(card.headline.dollarRatio).toBe(0);
      expect(card.volume.ratio).toBeUndefined();
      expect(card.kpis[2]).toMatchObject({ value: COPY.kpi.volumeNone, tone: 'muted' });
      expect(card.runRate.basis).toBe(COPY.kpi.runRateToday);
      expect(card.topSavers).toMatchObject({ rows: [], shown: 0, total: 0 });
      expect(card.destinations.rows).toEqual([]);
      expect(card.trend.points).toEqual([]);
      expect(card.trend.empty).toBe(COPY.trend.empty);
      expect(card.fileBase).toMatch(/^meter-reader-report-workspace-/);
      expect(card.footer).toBe(fill(COPY.footerNoWorkspace, { brand: COPY.brand, version: 'v1.0.0', time: formatUtcStamp(LIVE_NOW + 30_000) }));
    });
  }

  it('a snapshot with an unreadable sweep time falls back to the clock', () => {
    const card = buildReportCard({ ...liveInput({ kind: 'mtd' }), snapshot: { ...empty(), sweepAt: 'not a date', collectingSince: 'nope' } });
    expect(allFinite({ ...card, copy: undefined })).toEqual([]);
  });
});

describe('words and names', () => {
  it('meteredByWords names the runtime', () => {
    expect(meteredByWords('runner:workhorse:4242', COPY)).toBe(fill(COPY.meteredBy.runnerHost, { host: 'workhorse' }));
    expect(meteredByWords('runner:4242', COPY)).toBe(COPY.meteredBy.runner);
    expect(meteredByWords('runner:laptop', COPY)).toBe(fill(COPY.meteredBy.runnerHost, { host: 'laptop' }));
    expect(meteredByWords('ui:1234', COPY)).toBe(COPY.meteredBy.tab);
    expect(meteredByWords('backend:meter', COPY)).toBe(COPY.meteredBy.backend);
    expect(meteredByWords('mystery', COPY)).toBe(COPY.meteredBy.unknown);
    expect(meteredByWords(undefined, COPY)).toBe(COPY.meteredBy.unknown);
  });

  it('slugify keeps file names portable', () => {
    expect(slugify('Acme Corp (Prod) — Zoë')).toBe('acme-corp-prod-zoe');
    expect(slugify('---')).toBe('');
    expect(slugify('x'.repeat(80))).toHaveLength(48);
  });

  it('stamps carry the zone, and the UTC one is unambiguous', () => {
    expect(formatStamp(LIVE_NOW, LIVE_TZ)).toBe('Sep 25, 2026, 3:30 PM CDT');
    expect(formatUtcStamp(LIVE_NOW)).toBe('2026-09-25 20:30 UTC');
    const card = liveCard();
    expect(card.about.find((a) => a.label === COPY.about.generated)?.value).toBe(`${formatStamp(LIVE_NOW + 30_000, LIVE_TZ)} · ${formatUtcStamp(LIVE_NOW + 30_000)}`);
    expect(card.byline).toEqual([fill(COPY.preparedBy, { name: 'Sam Rivera' }), fill(COPY.generated, { time: formatStamp(LIVE_NOW + 30_000, LIVE_TZ) })]);
  });

  it('prepared for and the note are trimmed and optional', () => {
    const card = liveCard({ kind: 'mtd' }, {}, { preparedFor: '  CFO office ', note: '  Q3 renewal.  ', viewer: '   ' });
    expect(card.preparedFor).toBe('CFO office');
    expect(card.note).toBe('Q3 renewal.');
    expect(card.preparedBy).toBeUndefined();
    expect(card.byline[0]).toBe(fill(COPY.preparedFor, { name: 'CFO office' }));
  });

  it('a demo build says so in the version line; collecting since shows when metering began mid-period', () => {
    const card = liveCard({ kind: '30d' }, { historyDays: 10 }, { build: 'demo' });
    expect(card.about.find((a) => a.label === COPY.about.version)?.value).toBe(fill(COPY.about.versionDemo, { brand: COPY.brand, version: 'v1.0.0' }));
    expect(card.period.caption).toBe(fill(COPY.collectingSince, { date: 'Sep 15, 2026' }));
    expect(card.runRate.basis).toBe(plural(COPY.kpi.runRateFrom, 9));
  });

  it('the trend holds only the days inside the period', () => {
    const card = liveCard({ kind: 'mtd' });
    expect(card.trend.points.map((p) => p.day)).toEqual(Array.from({ length: 25 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`));
    const today = liveCard({ kind: 'today' });
    expect(today.trend.points).toHaveLength(1);
    expect(today.trend.empty).toBe(COPY.trend.oneDay);
    expect(liveCard({ kind: 'mtd' }).trend.empty).toBeUndefined();
  });
});

describe('plain formatters for the CSV', () => {
  it('fmtPlainDollars: two decimals, no symbol, ASCII minus', () => {
    expect(fmtPlainDollars(123_456_789)).toBe('1234.57');
    expect(fmtPlainDollars(-150_000)).toBe('-1.50');
    expect(fmtPlainDollars(0)).toBe('0.00');
    expect(fmtPlainDollars(-1)).toBe('0.00');
    expect(fmtPlainDollars(Number.NaN)).toBe('0.00');
  });

  it('fmtPlainGb: decimal GB with three decimals', () => {
    expect(fmtPlainGb(12_345_678_901)).toBe('12.346');
    expect(fmtPlainGb(999_999)).toBe('0.001');
    expect(fmtPlainGb(0)).toBe('0.000');
    expect(fmtPlainGb(Number.POSITIVE_INFINITY)).toBe('0.000');
  });
});

describe('printed money adds up', () => {
  const foots = (m: { whpM: number; paidM: number; savedM: number }) => m.whpM - m.paidM === m.savedM;

  for (const period of PERIODS) {
    it(`sample, ${period}: the hero's would have paid − paid is its saved, in whole dollars`, () => {
      const card = sampleCard({ kind: period });
      const { shown } = card.headline;
      expect(foots(shown)).toBe(true);
      expect(shown.savedM % MC_PER_DOLLAR).toBe(0);
      expect(fmtDollars(shown.savedM)).toBe(fmtDollars(card.headline.savedM));
      expect(card.headline.subline.slice(0, 2)).toEqual([fill(COPY.heroWhp, { amount: fmtDollars(shown.whpM) }), fill(COPY.heroPaid, { amount: fmtDollars(shown.paidM) })]);
    });
  }

  it('the review’s cases: $1,503,380 − $958,406 = $544,974 and $84,435 − $51,479 = $32,956', () => {
    const card = sampleCard();
    expect([fmtDollars(card.headline.shown.whpM), fmtDollars(card.headline.shown.paidM), fmtDollars(card.headline.shown.savedM)]).toEqual(['$1,503,380', '$958,406', '$544,974']);
    const t = card.destinations.totals;
    expect([fmtDollars(t.whpM), fmtDollars(t.paidM), fmtDollars(t.savedM)]).toEqual(['$84,435', '$51,479', '$32,956']);
    const newRelic = card.destinations.rows.find((r) => r.label === 'New Relic');
    expect(newRelic && foots(newRelic.shown)).toBe(true);
    expect(card.destinations.gapNote).toBeUndefined();
  });

  it('every destination row foots, and the totals are the sums of the printed rows', () => {
    for (const card of [sampleCard(), liveCard({ kind: 'mtd' }, { withIncidents: true })]) {
      const priced = card.destinations.rows.filter((r) => !r.unpriced);
      for (const r of priced) {
        const exact = Math.abs(r.whpPerDayM - r.paidPerDayM - r.savedPerDayM) < MC_PER_DOLLAR / 2;
        if (exact) expect(foots(r.shown), r.label).toBe(true);
      }
      const sum = (k: 'whpM' | 'paidM' | 'savedM') => priced.reduce((s, r) => s + r.shown[k], 0);
      expect(card.destinations.totals).toEqual({ whpM: sum('whpM'), paidM: sum('paidM'), savedM: sum('savedM') });
    }
  });

  it('a destination paid for but saving nothing is not hidden: the gap is named under the totals', () => {
    const card = liveCard();
    const devnull = card.destinations.rows.find((r) => r.outputId === 'devnull_copy');
    expect(devnull?.shown).toEqual({ whpM: 0, paidM: 3 * MC_PER_DOLLAR, savedM: 0 });
    const t = card.destinations.totals;
    expect(t.savedM - (t.whpM - t.paidM)).toBe(3 * MC_PER_DOLLAR);
    expect(card.destinations.gapNote).toBe(plural(COPY.destinations.gap, 1, { amount: '$3', names: 'DevNull copy' }));
  });
});

describe('the sample as the tour plays it on a later day', () => {
  it('two days after the recording: month to date, the trend and the prorated cost all cover Sep 1–26', () => {
    const zone = TOUR.timezone || TOUR_TZ;
    const anchor = Date.parse(TOUR.anchor ?? TOUR.generatedAt);
    const plan = planRebase(anchor, anchor + 2 * 86_400_000, zone);
    const cost = TOUR.settings.criblCostCentsPerMonth ?? 0;
    const moved = rebaseHeadline(rebaseValue(TOUR.snapshot, plan), zone, cost);
    const card = buildReportCard(sampleInput({ kind: 'mtd' }, { snapshot: moved, nowMs: Date.parse(moved.sweepAt) + 60_000 }));
    expect(card.period.span).toBe('Sep 1–26, 2026');
    expect(card.trend.points.map((p) => p.day)[card.trend.points.length - 1]).toBe('2026-09-26');
    expect(card.trend.points).toHaveLength(26);
    expect(card.headline.savedM).toBe(card.trend.points.reduce((s, p) => s + p.savedM, 0));
    // Cribl's cost for the minutes the recording's savings cover — Sep 1 → local midnight + today's recorded minutes
    // (core/net.ts; r3 core-6: the sample's frozen span), as the Receipt prorates it on the tour (netFigures frozen).
    const sweep = Date.parse(moved.sweepAt);
    const spanEnd = localMidnightMs(sweep, zone) + (moved.headline.minutesToday ?? 0) * 60_000;
    const minutes = meteredSpan(localMonthStartMs(sweep, zone), spanEnd, Date.parse(moved.collectingSince)).minutes;
    expect(minutes).toBeCloseTo(netFigures(moved, 'mtd', cost, zone, { frozen: true })!.costM / ((cost * 1000 * 12) / 525_600), 6);
    const prorated = ((cost * 1000 * 12) / 525_600) * minutes;
    expect(card.cribl?.period?.costM).toBe(Math.round(prorated));
    expect(card.cribl?.period?.netM).toBe(roundToDollarsM(card.headline.savedM) - roundToDollarsM(Math.round(prorated)));
    expect(card.cribl?.period?.paybackX).toBeCloseTo(card.headline.savedM / prorated, 12);
  });
});

describe('provenance and alert lines', () => {
  it('a live card with no workspace from Cribl says so rather than leaving it out', () => {
    const card = liveCard({ kind: 'mtd' }, {}, { workspace: '' });
    expect(card.workspace).toBeUndefined();
    expect(card.about[0]).toEqual({ label: COPY.about.workspace, value: COPY.about.workspaceUnknown });
    expect(card.about.find((a) => a.label === COPY.about.data)?.value).toBe(COPY.about.dataLive);
    expect(card.fileBase.startsWith('meter-reader-report-workspace-mtd-')).toBe(true);
    // "Metered by an open Meter Reader tab": no stray capital mid-sentence.
    expect(meteredByWords('ui:1', COPY)).toBe('an open Meter Reader tab');
  });

  it('alertLine leads with the money, then what moved, then how fast', () => {
    const card = liveCard({ kind: 'today' });
    const r = card.protection.rows.find((x) => x.id === 'reg-open')!;
    expect(alertLine(r, COPY.cols.caught, ' · ')).toBe(`${r.impactText} · ${r.measure} · ${COPY.cols.caught} 2\u00a0min 51\u00a0s`);
    const spike = card.protection.rows.find((x) => x.id === 'spike-open')!;
    expect(alertLine(spike, COPY.cols.caught, ' · ')).toBe(`${spike.impactText} · ${spike.measure}`);
  });
});
