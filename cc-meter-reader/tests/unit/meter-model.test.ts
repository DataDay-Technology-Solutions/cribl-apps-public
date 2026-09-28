// @vitest-environment jsdom
// The Receipt view's model (src/views/Receipt/model.ts) and hero caption: per-period figures, the derived
// annualized would-have-paid / paid, net and payback, destination rows with counterfactual prices, open
// alerts, and deep links.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeHeadline } from '../../core/pricing.ts';
import { DAY_MS, addDaysToKey, localDayKey, localDayStartMs } from '../../core/time.ts';
import type { DestinationFigures, FlowFigures, Incident, PricesDoc, Snapshot, TotalsDoc, TrendPoint } from '../../core/types.ts';
import {
  annualizedDays,
  annualizedParts,
  bytesInPerDay,
  collectingAfterStart,
  destinationRows,
  landingPeriod,
  mathDestinations,
  mtdReconciliation,
  netFigures,
  openIncidents,
  periodFigures,
  periodStartMs,
  pipelineHref,
  savedPerDayNowM,
  saverTotals,
} from '../../src/views/Receipt/model.ts';
import { heroCaption, heroIsProjection, saverTotalLines, topSaverLines } from '../../src/views/Receipt/text.ts';

const TZ = 'America/Chicago';
const NOW = Date.parse('2026-09-26T17:30:00.000Z'); // 12:30 PM Chicago

/** A snapshot whose headline comes from core computeHeadline over `days` whole days + today. */
function snapshotFor(days: number, opts: { collectingSinceMs?: number; costCents?: number } = {}): Snapshot {
  const today = localDayKey(NOW, TZ);
  const since = opts.collectingSinceMs ?? localDayStartMs(addDaysToKey(today, -days), TZ);
  const byDay: TotalsDoc['byDay'] = {};
  for (let i = days; i >= 0; i--) {
    const day = addDaysToKey(today, -i);
    const whpM = 1_000_000_000 + i * 7_654_321;
    const savedM = Math.round(whpM * (0.55 + (i % 5) * 0.03));
    byDay[day] = { whpM, paidM: whpM - savedM, savedM, minutes: i === 0 ? 750 : 1440 };
  }
  const totals: TotalsDoc = { schemaVersion: 1, updatedAt: new Date(NOW).toISOString(), byDay };
  const headline = computeHeadline(totals, NOW, TZ, since, opts.costCents);
  const trend: TrendPoint[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = addDaysToKey(today, -i);
    if (!byDay[day]) continue;
    trend.push({ day, ...byDay[day] });
  }
  return {
    schemaVersion: 1,
    sweepAt: new Date(NOW).toISOString(),
    windowStart: new Date(NOW - 60_000).toISOString(),
    windowEnd: new Date(NOW).toISOString(),
    mode: 'ui',
    headline,
    ratePerSecM: 1234,
    flows: [],
    destinations: [],
    topSavers: [],
    unpricedOutputIds: [],
    openIncidents: 0,
    incidents: [],
    trend,
    ratioSeries: [],
    timeline: [],
    deliveries: [],
    calls: 20,
    collectingSince: new Date(since).toISOString(),
    metricsSource: 'metrics-query',
    attributionSummary: 'route',
  };
}

describe('periodFigures', () => {
  it('reads today / MTD / 30 days straight from the headline; they accrue', () => {
    const s = snapshotFor(40);
    const h = s.headline;
    expect(periodFigures(s, 'mtd', TZ)).toMatchObject({ savedM: h.mtdM, whpM: h.whpMtdM, paidM: h.paidMtdM, accrues: true });
    expect(periodFigures(s, 'today', TZ)).toMatchObject({ savedM: h.todayM, whpM: h.whpTodayM, paidM: h.paidTodayM, accrues: true });
    expect(periodFigures(s, '30d', TZ)).toMatchObject({ savedM: h.d30M, whpM: h.whp30dM, paidM: h.paid30dM, accrues: true });
    for (const p of ['mtd', 'today', '30d'] as const) {
      const f = periodFigures(s, p, TZ);
      expect(f.whpM - f.paidM).toBe(f.savedM);
      expect(f.ratio).toBeGreaterThan(0);
      expect(f.ratio).toBeLessThanOrEqual(1);
    }
  });

  // The run rate is Σ saved ÷ Σ metered minutes × 525,600 over the last 30 local days, today included (core
  // computeHeadline, REVIEW-3a #6); would-have-paid over the same days and minutes scales by the same factor.
  it('annualized: exact from the trend (same days, same minutes), and it does not tick', () => {
    const s = snapshotFor(20);
    const f = periodFigures(s, 'annualized', TZ);
    expect(f.accrues).toBe(false);
    expect(f.derivedFrom).toBe('trend');
    expect(f.savedM).toBe(s.headline.annualizedM);
    expect(f.whpM - f.paidM).toBe(f.savedM);
    const days = annualizedDays(s, TZ);
    expect(days).toHaveLength(21); // 20 whole days + today
    expect(days.some((d) => d.day === localDayKey(NOW, TZ))).toBe(true);
    const whp = days.reduce((a, d) => a + d.whpM, 0);
    const saved = days.reduce((a, d) => a + d.savedM, 0);
    expect(f.whpM).toBe(Math.round((s.headline.annualizedM * whp) / saved));
  });

  it('annualized over 30 days: the trend holds exactly the rate\'s 30 days', () => {
    const s = snapshotFor(40);
    expect(s.headline.annualizedFromDays).toBe(30);
    const days = annualizedDays(s, TZ);
    expect(days).toHaveLength(30); // the trend's 30 entries, today included
    const f = periodFigures(s, 'annualized', TZ);
    expect(f.derivedFrom).toBe('trend');
    expect(f.savedM).toBe(s.headline.annualizedM);
    expect(f.whpM - f.paidM).toBe(f.savedM);
    const r = days.reduce((a, d) => a + d.savedM, 0) / days.reduce((a, d) => a + d.whpM, 0);
    expect(f.ratio).toBeCloseTo(r, 6);
    expect(f.ratio).toBeCloseTo(s.headline.d30M / s.headline.whp30dM, 6);
  });

  it('annualized with a few days: the days since collecting began, today included', () => {
    const s = snapshotFor(5, { collectingSinceMs: localDayStartMs(addDaysToKey(localDayKey(NOW, TZ), -5), TZ) + 3_600_000 });
    expect(s.headline.annualizedFromDays).toBe(4); // collecting began 1 AM five days ago → 4 whole days
    const parts = annualizedParts(s, TZ);
    expect(parts.derivedFrom).toBe('trend');
    expect(annualizedDays(s, TZ)).toHaveLength(6); // the partial first day, 4 whole days, today
  });

  it('annualized under one day uses today\'s ratio', () => {
    const since = NOW - 3 * 3_600_000;
    const s = snapshotFor(0, { collectingSinceMs: since });
    expect(s.headline.annualizedFromDays).toBeLessThan(1);
    const f = periodFigures(s, 'annualized', TZ);
    expect(f.whpM).toBeGreaterThan(f.savedM);
    expect(f.ratio).toBeCloseTo(s.headline.todayM / s.headline.whpTodayM, 3);
  });

  it('annualized without a trend falls back to the headline\'s 30-day ratio', () => {
    const s = { ...snapshotFor(10), trend: [] };
    const f = periodFigures(s, 'annualized', TZ);
    expect(f.derivedFrom).toBe('ratio');
    expect(f.whpM - f.paidM).toBe(f.savedM);
    expect(f.ratio).toBeCloseTo(s.headline.d30M / s.headline.whp30dM, 3);
  });
});

describe('captions', () => {
  it('month to date, with "collecting since" only when metering began after the period', () => {
    const s = snapshotFor(40);
    expect(heroCaption(s, 'mtd', TZ)).toBe('month to date');
    expect(heroCaption(s, 'annualized', TZ)).toBe('annualized run rate, from the last 30 days');
    const today = localDayKey(NOW, TZ);
    const fresh = snapshotFor(0, { collectingSinceMs: localDayStartMs(today, TZ) + (9 * 60 + 41) * 60_000 });
    expect(collectingAfterStart('mtd', fresh, TZ)).toBe(true);
    // P0-23: the caption says how much of the month the figure covers when that is not all of it.
    expect(heroCaption(fresh, 'mtd', TZ)).toBe('month to date · collecting since 9:41 AM · 750 of 36,750 minutes metered (2%)');
    // Under a day: a projection, and how little it rests on (craft review, round 1).
    expect(heroCaption(fresh, 'annualized', TZ)).toBe('annualized run rate, projected from the last 12 hours of traffic · settles after the first full day');
    expect(heroCaption({ ...fresh, headline: { ...fresh.headline, annualizedFromDays: 0 } }, 'annualized', TZ)).toBe(
      'annualized run rate, projected from today so far · settles after the first full day',
    );
    const minutes = (n: number) => ({ ...fresh, headline: { ...fresh.headline, annualizedFromDays: n / 1440 } });
    expect(heroCaption(minutes(60), 'annualized', TZ)).toBe('annualized run rate, projected from the last 1 hour of traffic · settles after the first full day');
    expect(heroCaption(minutes(45), 'annualized', TZ)).toBe('annualized run rate, projected from the last 45 minutes of traffic · settles after the first full day');
    expect(heroCaption(minutes(1), 'annualized', TZ)).toBe('annualized run rate, projected from the last 1 minute of traffic · settles after the first full day');
    expect(heroCaption(minutes(1439), 'annualized', TZ)).toBe('annualized run rate, projected from the last 23 hours of traffic · settles after the first full day');
    expect(heroIsProjection(minutes(1439), 'annualized')).toBe(true);
    expect(heroIsProjection(minutes(1440), 'annualized')).toBe(false);
    expect(heroIsProjection(minutes(60), 'mtd')).toBe(false);
    const older = snapshotFor(3, { collectingSinceMs: localDayStartMs(addDaysToKey(today, -3), TZ) + 3_600_000 });
    expect(heroCaption(older, '30d', TZ)).toBe('last 30 days · collecting since Sep 23 · 5,070 of 42,510 minutes metered (11%)');
    expect(heroCaption(older, 'annualized', TZ)).toBe('annualized run rate, from the last 2 days');
  });

  it('period starts are local', () => {
    expect(new Date(periodStartMs('today', NOW, TZ) ?? 0).toISOString()).toBe('2026-09-26T05:00:00.000Z');
    expect(new Date(periodStartMs('mtd', NOW, TZ) ?? 0).toISOString()).toBe('2026-09-01T05:00:00.000Z');
    expect(periodStartMs('30d', NOW, TZ)).toBe(localDayStartMs('2026-08-28', TZ));
    expect(periodStartMs('annualized', NOW, TZ)).toBeUndefined();
  });
});

describe('netFigures', () => {
  // $10,000 a month is $10,000 × 12 ÷ 525,600 a minute: the same year the annualized run rate uses (core/net.ts).
  const COST = 1_000_000;
  const perMinute = (COST * 1000 * 12) / 525_600;

  it('MTD: saved minus Cribl for the minutes metered since the month began, and the payback multiple', () => {
    const s = snapshotFor(40, { costCents: COST });
    const n = netFigures(s, 'mtd', COST, TZ)!;
    const minutes = (NOW - Date.parse('2026-09-01T05:00:00.000Z')) / 60_000; // Sep 1 local midnight → 12:30 PM Sep 26
    expect(minutes).toBe(36_750);
    expect(n.minutes).toBe(minutes);
    expect(n.costM).toBe(Math.round(perMinute * minutes)); // $8,390.41
    expect(n.costM).toBe(839_041_096);
    expect(n.netM).toBe(s.headline.mtdM - n.costM);
    expect(n.paybackX).toBeCloseTo(s.headline.mtdM / (perMinute * minutes), 10);
    expect(n.fromMs).toBe(Date.parse('2026-09-01T05:00:00.000Z'));
    expect(n.sinceCollecting).toBe(false);
    expect(n.per).toBeUndefined();
    expect(n.monthlyCostCents).toBe(COST);
  });

  it('a workspace metering since mid-month is charged only for the days it was metered', () => {
    // Collecting began 3 days ago at 1 AM: the month's first 22 days saved nothing because nothing was counted.
    const since = localDayStartMs(addDaysToKey(localDayKey(NOW, TZ), -3), TZ) + 3_600_000;
    const s = snapshotFor(3, { collectingSinceMs: since, costCents: COST });
    const n = netFigures(s, 'mtd', COST, TZ)!;
    expect(n.fromMs).toBe(since);
    expect(n.sinceCollecting).toBe(true);
    expect(n.minutes).toBeCloseTo((NOW - since) / 60_000, 6);
    expect(n.costM).toBe(Math.round(perMinute * ((NOW - since) / 60_000)));
    // Calendar-day proration (26 of 30 days of Cribl against 3.5 days of savings) would read as a loss.
    expect(n.paybackX).toBeGreaterThan(s.headline.mtdM / ((COST * 1000 * 26) / 30));
  });

  it('every period has a net: today and 30 days are prorated too; the run rate is a year of Cribl', () => {
    const s = snapshotFor(40, { costCents: COST });
    const today = netFigures(s, 'today', COST, TZ)!;
    expect(today.minutes).toBe(750);
    expect(today.netM).toBe(s.headline.todayM - Math.round(perMinute * 750));
    const d30 = netFigures(s, '30d', COST, TZ)!;
    expect(d30.minutes).toBe(29 * 1440 + 750);
    expect(d30.netM).toBe(s.headline.d30M - Math.round(perMinute * (29 * 1440 + 750)));
    const yearly = netFigures(s, 'annualized', COST, TZ)!;
    expect(yearly.per).toBe('year');
    expect(yearly.costM).toBe(COST * 1000 * 12);
    expect(yearly.netM).toBe(s.headline.annualizedM - COST * 1000 * 12);
    expect(yearly.paybackX).toBeCloseTo(s.headline.annualizedM / (COST * 1000 * 12));
  });

  it('no Cribl cost, no net line', () => {
    const s = snapshotFor(40);
    expect(netFigures(s, 'mtd', undefined, TZ)).toBeNull();
    expect(netFigures(s, 'mtd', 0, TZ)).toBeNull();
    expect(netFigures(s, 'annualized', -5, TZ)).toBeNull();
    expect(netFigures(s, 'today', Number.NaN, TZ)).toBeNull();
  });
});

describe('landingPeriod (P1-H08)', () => {
  it('a workspace metering for under a day lands on the annualized run rate', () => {
    const s = snapshotFor(0, { collectingSinceMs: NOW - 3_600_000 });
    expect(s.headline.annualizedM).toBeGreaterThan(0);
    expect(landingPeriod(s, 'mtd')).toBe('annualized');
    expect(landingPeriod(s, undefined)).toBe('annualized');
  });

  it('after a day of metering the default is month to date again; a non-MTD default always stands', () => {
    expect(landingPeriod(snapshotFor(1, { collectingSinceMs: NOW - DAY_MS - 60_000 }), 'mtd')).toBe('mtd');
    expect(landingPeriod(snapshotFor(40), undefined)).toBe('mtd');
    expect(landingPeriod(snapshotFor(0, { collectingSinceMs: NOW - 3_600_000 }), 'today')).toBe('today');
    expect(landingPeriod(snapshotFor(0, { collectingSinceMs: NOW - 3_600_000 }), '30d')).toBe('30d');
  });

  it('nothing saved yet: no run rate to land on, so month to date', () => {
    const s = snapshotFor(0, { collectingSinceMs: NOW - 3_600_000 });
    expect(landingPeriod({ ...s, headline: { ...s.headline, annualizedM: 0 } }, 'mtd')).toBe('mtd');
    expect(landingPeriod({ ...s, collectingSince: undefined as unknown as string }, 'mtd')).toBe('mtd');
  });
});

describe('destinationRows', () => {
  const dest = (outputId: string, over: Partial<DestinationFigures> = {}): DestinationFigures => ({
    groupId: 'default',
    outputId,
    type: 'splunk_hec',
    whpPerDayM: 0,
    paidPerDayM: 0,
    savedPerDayM: 0,
    mtdPaidM: 0,
    mtdSavedM: 0,
    mtdWhpM: 0,
    milliCentsPerGb: 0,
    counterfactual: { kind: 'same' },
    unpriced: false,
    ...over,
  });
  const flow = (outputId: string, inB: number, outB: number): FlowFigures =>
    ({ key: outputId, groupId: 'default', outputId, inBPerDay: inB, outBPerDay: outB }) as FlowFigures;

  it('prices from the prices document, the counterfactual target price, presets, bytes, and ordering', () => {
    const s = snapshotFor(1);
    s.destinations = [
      dest('mrd_archive_s3', { type: 's3', whpPerDayM: 375_000_000, paidPerDayM: 900_000, savedPerDayM: 374_100_000, milliCentsPerGb: 3_000 }),
      dest('mrd_siem_prod', { whpPerDayM: 600_000_000, paidPerDayM: 255_000_000, savedPerDayM: 345_000_000, milliCentsPerGb: 250_000 }),
      dest('edge', { type: 'webhook', unpriced: true }),
    ];
    s.flows = [flow('mrd_siem_prod', 2.4e12, 1.02e12), flow('mrd_archive_s3', 1.5e12, 0.3e12), flow('mrd_siem_prod', 1e9, 1e9)];
    const prices: PricesDoc = {
      schemaVersion: 1,
      updatedAt: '2026-09-01T00:00:00.000Z',
      versions: [
        {
          effectiveFrom: '2026-09-01T00:00:00.000Z',
          byOutputId: {
            mrd_siem_prod: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' },
            mrd_archive_s3: { milliCentsPerGb: 3_000, preset: 's3', counterfactual: { kind: 'other', outputId: 'mrd_siem_prod' } },
          },
        },
      ],
    };
    const rows = destinationRows(s, prices, { edge: 'edge-cdn-logs' });
    expect(rows.map((r) => r.outputId)).toEqual(['mrd_siem_prod', 'mrd_archive_s3', 'edge']);
    const archive = rows[1];
    expect(archive.whpMcPerGb).toBe(250_000);
    expect(archive.paidMcPerGb).toBe(3_000);
    expect(archive.counterfactualLabel).toBe('SIEM (prod)');
    expect(archive.presetLabel).toBe('Amazon S3');
    expect(archive.inBPerDay).toBe(1.5e12);
    expect(rows[0].inBPerDay).toBe(2.4e12 + 1e9);
    expect(rows[2].label).toBe('edge-cdn-logs');
    expect(rows[2].unpriced).toBe(true);

    // Without a prices document the snapshot's own figures (and the other destination's price) are used.
    s.destinations[0].counterfactual = { kind: 'other', outputId: 'mrd_siem_prod' };
    const bare = destinationRows(s, null);
    expect(bare.find((r) => r.outputId === 'mrd_archive_s3')?.whpMcPerGb).toBe(250_000);
    s.destinations[0].counterfactual = { kind: 'none' };
    expect(destinationRows(s, null).find((r) => r.outputId === 'mrd_archive_s3')?.whpMcPerGb).toBe(0);
  });
});

describe('bytes received for the implied Cribl $/GB (D48)', () => {
  const load = (file: string): Snapshot => (JSON.parse(readFileSync(resolve(__dirname, '../../demo/sample', file), 'utf8')) as { snapshot: Snapshot }).snapshot;

  it('the live recording: every Source on one flow, so the sum is exact — 449.9 GB a day, as the rig runs', () => {
    expect((bytesInPerDay(load('replay.json')) ?? 0) / 1e9).toBeCloseTo(449.9, 1);
  });

  it('the tour clones its datacenter Sources to an archive route: a sum would count them twice, so no figure', () => {
    const tour = load('tour.json');
    const naive = (tour.flows ?? []).reduce((a, f) => a + f.inBPerDay, 0);
    expect(naive / 1e12).toBeGreaterThan(60); // 63.9 TB "received", about 23 TB of it counted twice
    expect(bytesInPerDay(tour)).toBeUndefined();
    expect(bytesInPerDay({ ...tour, flows: [] })).toBe(0);
  });
});

describe('Show the math, month to date (P1-F09)', () => {
  // A generated workspace (the tour) and a live recording (replay.json, the real org on Sep 26): the drawer's
  // month-to-date rows are core's per-destination month totals, so they add up to the hero, not the last hour × 24.
  const sample = (file: string): { snapshot: Snapshot; prices: PricesDoc | null } => {
    const doc = JSON.parse(readFileSync(resolve(__dirname, '../../demo/sample', file), 'utf8')) as { snapshot: Snapshot; prices?: PricesDoc };
    return { snapshot: doc.snapshot, prices: doc.prices ?? null };
  };

  for (const file of ['tour.json', 'replay.json']) {
    it(`${file}: the MTD rows sum to the hero's month to date within rounding`, () => {
      const { snapshot, prices } = sample(file);
      const rows = mathDestinations(destinationRows(snapshot, prices), 'mtd');
      const sum = (k: 'mtdSavedM' | 'mtdWhpM' | 'mtdPaidM') => rows.reduce((acc, r) => acc + (r[k] ?? 0), 0);
      expect(Math.abs(sum('mtdSavedM') - snapshot.headline.mtdM)).toBeLessThan(100_000);
      expect(Math.abs(sum('mtdWhpM') - snapshot.headline.whpMtdM)).toBeLessThan(100_000);
      expect(Math.abs(sum('mtdPaidM') - snapshot.headline.paidMtdM)).toBeLessThan(100_000);
      const r = mtdReconciliation(rows, snapshot.headline.mtdM);
      expect(r.matches).toBe(true);
      expect(r.savedM).toBe(sum('mtdSavedM'));
      // The per-day rows (last hour × 24) do NOT add up to the month: the reason the drawer says which it shows.
      const perDay = rows.reduce((acc, row) => acc + row.savedPerDayM, 0);
      expect(perDay).not.toBe(snapshot.headline.mtdM);
    });
  }

  it('lists a destination idle now that still carries part of the month, heaviest month first', () => {
    const base = snapshotFor(10);
    const d = (outputId: string, over: Partial<DestinationFigures>): DestinationFigures => ({
      groupId: 'default',
      outputId,
      type: 'splunk_hec',
      whpPerDayM: 0,
      paidPerDayM: 0,
      savedPerDayM: 0,
      mtdWhpM: 0,
      mtdPaidM: 0,
      mtdSavedM: 0,
      milliCentsPerGb: 250_000,
      counterfactual: { kind: 'same' },
      unpriced: false,
      ...over,
    });
    const s: Snapshot = {
      ...base,
      destinations: [
        d('now_only', { whpPerDayM: 900, paidPerDayM: 100, savedPerDayM: 800, mtdWhpM: 1_000, mtdPaidM: 200, mtdSavedM: 800 }),
        d('retired', { mtdWhpM: 50_000_000, mtdPaidM: 10_000_000, mtdSavedM: 40_000_000 }),
        d('free', {}),
      ],
    };
    const rows = destinationRows(s, null);
    expect(mathDestinations(rows, 'mtd').map((r) => r.outputId)).toEqual(['retired', 'now_only']);
    // Other periods list what carries money now, like Where the money goes.
    expect(mathDestinations(rows, 'today').map((r) => r.outputId)).toEqual(['now_only']);
    expect(mathDestinations(rows, 'custom').map((r) => r.outputId)).toEqual(['now_only']);
    // A hero that holds $400 the listed rows don't: the drawer says so instead of claiming they add up.
    const gap = mtdReconciliation(mathDestinations(rows, 'mtd').slice(1), 40_000_800);
    expect(gap).toMatchObject({ savedM: 800, gapM: 40_000_000, matches: false });
    // Under a dollar apart is rounding.
    expect(mtdReconciliation(mathDestinations(rows, 'mtd'), 40_000_800 + 99_999).matches).toBe(true);
  });
});

describe('alerts and links', () => {
  it('open incidents, most severe first, then newest', () => {
    const s = snapshotFor(1);
    const inc = (id: string, severity: Incident['severity'], openedAt: string, closedAt?: string): Incident =>
      ({ id, severity, openedAt, closedAt, type: 'spike', objectKey: 'in:default:x', label: 'x', before: 0, after: 0, impactPerDayM: 0, notes: [], deliveries: [] }) as Incident;
    s.incidents = [
      inc('a', 'medium', '2026-09-26T10:00:00Z'),
      inc('b', 'high', '2026-09-26T09:00:00Z'),
      inc('c', 'high', '2026-09-26T11:00:00Z'),
      inc('d', 'high', '2026-09-26T12:00:00Z', '2026-09-26T12:30:00Z'),
    ];
    expect(openIncidents(s).map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });

  it('deep links to a pipeline in the Cribl UI, never for a missing pipeline', () => {
    expect(pipelineHref('default', 'mrd_pay_sample', 'https://leader.example.com/')).toBe(
      'https://leader.example.com/stream/m/default/pipelines/mrd_pay_sample',
    );
    expect(pipelineHref('g 1', 'a/b', '')).toBe('/stream/m/g%201/pipelines/a%2Fb');
    expect(pipelineHref('default', '-', 'https://x')).toBeUndefined();
    expect(pipelineHref('-', 'p', 'https://x')).toBeUndefined();
  });

  it('topSaverLines: no deep link on sample data (origin null, OQ-01)', () => {
    const lines = topSaverLines([{ objectKey: 'pipe:dc:pan', label: 'Palo Alto', groupId: 'dc', pipelineId: 'pan', savedPerDayM: 5_000_000, ratio: 0.8 } as never], null);
    expect(lines[0].href).toBeUndefined();
    expect(lines[0].hrefLabel).toBeUndefined();
    expect(topSaverLines([{ objectKey: 'pipe:dc:pan', label: 'Palo Alto', groupId: 'dc', pipelineId: 'pan', savedPerDayM: 5_000_000, ratio: 0.8 } as never], 'https://leader.example.com')[0].href).toBe(
      'https://leader.example.com/stream/m/dc/pipelines/pan',
    );
  });

  it('top savers become receipt lines with deep links and the saved share (dollars) as a tooltip', () => {
    const lines = topSaverLines(
      [
        { objectKey: 'route:default:r1', label: 'Windows XML pack', savedPerDayM: 241_000_000, ratio: 0.6, groupId: 'default', pipelineId: 'mrd_win_xml_pack' },
        { objectKey: 'route:default:r2', label: 'Route only', savedPerDayM: 1_000_000, ratio: 0.1, groupId: 'default', pipelineId: '-' },
      ],
      'https://leader.example.com',
    );
    expect(lines[0]).toMatchObject({
      label: 'Windows XML pack',
      amountM: 241_000_000,
      href: 'https://leader.example.com/stream/m/default/pipelines/mrd_win_xml_pack',
      hrefLabel: 'Open Windows XML pack in Cribl',
      title: 'Windows XML pack · 60% saved at current rates',
    });
    expect(lines[1].href).toBeUndefined();
    expect(lines[1].hrefLabel).toBeUndefined();
    // The unit lives in the card's caption ("Top 5 by savings per day"), not on every line (P1-H02).
    expect(lines[0].per).toBeUndefined();
  });

  it('with totals, the savers end with the flows left out and every flow under the rule (P1-H04)', () => {
    const savers = [
      { objectKey: 'route:default:r1', label: 'A', savedPerDayM: 300_000_000, ratio: 0.6, groupId: 'default', pipelineId: 'p1' },
      { objectKey: 'route:default:r2', label: 'B', savedPerDayM: 100_000_000, ratio: 0.3, groupId: 'default', pipelineId: 'p2' },
    ];
    const lines = [...topSaverLines(savers, ''), ...saverTotalLines(savers, { allM: 450_000_000, count: 5 })];
    expect(lines.map((l) => [l.label, l.amountM, Boolean(l.total), Boolean(l.muted)])).toEqual([
      ['A', 300_000_000, false, false],
      ['B', 100_000_000, false, false],
      ['3 other flows', 50_000_000, false, true],
      ['All flows', 450_000_000, true, false],
    ]);
    // Every flow is in the list: the total alone; a single saver on its own gets no total at all.
    expect(saverTotalLines(savers, { allM: 400_000_000, count: 2 }).map((l) => l.label)).toEqual(['All flows']);
    expect(saverTotalLines(savers.slice(0, 1), { allM: 300_000_000, count: 1 })).toEqual([]);
  });

  it('saverTotals groups flows by route like the snapshot and counts only the ones that save', () => {
    const flow = (key: string, routeId: string, savedPerDayM: number) => ({ key, groupId: 'default', routeId, savedPerDayM }) as unknown as Snapshot['flows'][number];
    const snap = { flows: [flow('a', 'r1', 100), flow('b', 'r1', 50), flow('c', 'r2', 0), flow('d', '-', 25), flow('e', 'r3', -5)] } as unknown as Snapshot;
    expect(saverTotals(snap)).toEqual({ allM: 175, count: 2 });
    expect(savedPerDayNowM(snap)).toBe(175);
  });

  it('DAY_MS sanity for the fixtures above', () => {
    expect(DAY_MS).toBe(86_400_000);
  });
});
