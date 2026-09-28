// P1-F02 — measured vs assumed dollars. A destination whose counterfactual names another ("without Cribl this data
// would go to Splunk Cloud") earns a diversion credit, not a byte reduction: before, the Ledger showed a 0 % reduction
// flow saving $2,502/day, the weekly receipt listed it beside measured trims, and nothing said which dollars were
// measured. Now the snapshot's headline splits month to date into reducedMtdM + divertedMtdM = mtdM, flows and top
// savers carry `diverted`, and every receipt tags the line '(diverted)' and prints "Saved by reduction · by diversion".
//
// P1-F03 — a pipeline that grows bytes (enrichment, GeoIP) was $0 saved and nothing else: now the cost it adds is
// recorded beside the clipped saving — 1 GB in, 1.3 GB out at $2.25/GB → saved 0, added 67,500 mc ($0.675; the
// audit's "675 mc" misplaces the unit: $1 = 100,000 mc) — per flow, per day, and summed on the headline.

import { describe, expect, it } from 'vitest';
import type { DestinationFigures, Flow, InventoryDoc, MinuteRow, PricesDoc, Snapshot, TotalsDoc } from '../../core/types.ts';
import { buildSnapshot, costAddedFigures, diversionTarget, headlineSplit, savingsSplit, type SnapshotParts } from '../../core/snapshot.ts';
import { buildRows, byteReduction, totals } from '../../src/components/LedgerTable/model.ts';
import { INFLATION_NOISE, addedCost, appendPriceVersion, emptyPrices, isDiversion, priceMinute } from '../../core/pricing.ts';
import { addMinuteToTotals, addOutputMinuteToTotals, emptyTotals } from '../../core/rollups.ts';
import { makeFlowKey } from '../../core/flows.ts';
import { defaultSettings } from '../../core/settings.ts';
import { DIVERTED_TAG, buildWeeklyReceipt, receiptText, receiptTextForPeriod } from '../../core/receipt.ts';
import { humanize } from '../../core/humanize.ts';

const MIN = 60_000;
const SWEEP = Date.parse('2026-09-26T17:00:05Z');
const WINDOW_END = Date.parse('2026-09-26T17:00:00Z');
const MC = 100_000; // millicents per dollar

const flow = (inputId: string, routeId: string, pipelineId: string, outputId: string): Flow => ({
  key: makeFlowKey('default', inputId, routeId, pipelineId, outputId),
  groupId: 'default',
  inputId,
  routeId,
  pipelineId,
  outputId,
  attribution: 'reconciled',
});
// Windows trimmed 40 % into Splunk Cloud: a measured reduction.
const WIN = flow('win', 'r_win', 'win_trim', 'splunk');
// DNS logs sent whole to S3 instead of Splunk: 0 % fewer bytes, credited at Splunk's price — a diversion.
const DNS = flow('dns', 'r_dns', 'passthru', 's3');
const DNS_LABEL = humanize('passthru'); // the pipeline's words: "Passthru"
// Web logs enriched with GeoIP into Splunk: 30 % more bytes out than in.
const GEO = flow('web', 'r_web', 'geoip', 'splunk');

const inventory: InventoryDoc = {
  schemaVersion: 1,
  updatedAt: '',
  hash: 'h',
  byGroup: { default: { inputs: [], outputs: [{ id: 'splunk', type: 'splunk_hec' }, { id: 's3', type: 's3' }], pipelines: [], routes: [] } },
};

const SPLUNK = 225_000; // $2.25/GB
const S3 = 2_300; // $0.023/GB
function pricesDoc(): PricesDoc {
  return appendPriceVersion(
    emptyPrices('x'),
    {
      splunk: { milliCentsPerGb: SPLUNK, preset: 'splunk_cloud' },
      s3: { milliCentsPerGb: S3, preset: 's3', counterfactual: { kind: 'other', outputId: 'splunk' } },
    },
    Date.parse('2026-09-01T00:00:00Z'),
  );
}

/** 60 one-minute rows at `inGbMin` GB in and `outShare` of it out, priced as the sweep prices them. */
function rows(inGbMin: number, outShare: number, paid: number, whp: number): MinuteRow[] {
  const out: MinuteRow[] = [];
  for (let i = 60; i >= 1; i--) {
    const inB = inGbMin * 1e9;
    const outB = Math.round(inB * outShare);
    out.push({ t: new Date(WINDOW_END - i * MIN).toISOString(), inB, outB, inE: 1, outE: 1, ...priceMinute({ inB, outB }, paid, whp, 'same') });
  }
  return out;
}

function parts(): SnapshotParts {
  const settings = defaultSettings('2026-09-26T00:00:00Z', 'UTC');
  const minuteRows = {
    [WIN.key]: rows(1, 0.6, SPLUNK, SPLUNK),
    [DNS.key]: rows(1, 1, S3, SPLUNK),
    [GEO.key]: rows(1, 1.3, SPLUNK, SPLUNK),
  };
  // Month-to-date totals, per day and per destination, from the same rows (as the sweep adds them).
  let totals: TotalsDoc = emptyTotals('x');
  for (const [key, rs] of Object.entries(minuteRows)) {
    const out = key.split('|')[4];
    for (const r of rs) {
      totals = addMinuteToTotals(totals, '2026-09-26', r);
      totals = addOutputMinuteToTotals(totals, '2026-09', `default:${out}`, r);
    }
  }
  return {
    sweepAtMs: SWEEP,
    windowStartMs: WINDOW_END - MIN,
    windowEndMs: WINDOW_END,
    mode: 'ui',
    settings,
    prices: pricesDoc(),
    inventory,
    flows: [WIN, DNS, GEO],
    minuteRows,
    totals,
    collectingSinceMs: Date.parse('2026-09-20T00:00:00Z'),
    incidents: [],
    timeline: [],
    deliveries: [],
    calls: 0,
    metricsSource: 'metrics-query',
  };
}

describe('P1-F03 · a pipeline that grows bytes', () => {
  it('1 GB in, 1.3 GB out at $2.25 → saved 0, added 67,500 mc', () => {
    const m = priceMinute({ inB: 1e9, outB: 1.3e9 }, SPLUNK, SPLUNK);
    expect(m.savedM).toBe(0);
    expect(addedCost(m)).toBe(67_500); // $0.675
    expect(addedCost(priceMinute({ inB: 1e9, outB: 0.7e9 }, SPLUNK, SPLUNK))).toBe(0);
    expect(addedCost({ whpM: 0, paidM: 5 })).toBe(0); // nothing would have been paid: nothing to add to
  });

  it('the snapshot records it per flow and per day, and sums it on the headline', () => {
    const s = buildSnapshot(parts());
    const geo = s.flows.find((f) => f.key === GEO.key)!;
    expect(geo.savedPerDayM).toBe(0);
    // 60 minutes × 67,500 mc added, × 24 → $972 a day.
    expect(geo.addedPerDayM).toBe(60 * 67_500 * 24);
    expect(s.flows.find((f) => f.key === WIN.key)!.addedPerDayM).toBeUndefined();
    expect(s.headline).toMatchObject({ addedPerDayM: 60 * 67_500 * 24, addedFlows: 1 });
  });

  it('a few bytes high on a passthrough is counting noise, not cost added', () => {
    const p = parts();
    p.minuteRows[WIN.key] = rows(1, 1 + INFLATION_NOISE / 2, SPLUNK, SPLUNK);
    p.minuteRows[GEO.key] = rows(1, 0.9, SPLUNK, SPLUNK);
    const s = buildSnapshot(p);
    expect(s.flows.every((f) => f.addedPerDayM === undefined)).toBe(true);
    expect(s.headline.addedPerDayM).toBeUndefined();
    expect(costAddedFigures(s.flows)).toEqual({});
  });
});

describe('P1-F02 · measured vs assumed dollars', () => {
  it('a destination credited at another destination\'s price is a diversion; one at its own is not', () => {
    expect(isDiversion({ kind: 'other', outputId: 'splunk' }, 's3')).toBe(true);
    expect(isDiversion({ kind: 'other', outputId: 's3' }, 's3')).toBe(false);
    expect(isDiversion({ kind: 'same' }, 's3')).toBe(false);
    expect(isDiversion({ kind: 'none' }, 's3')).toBe(false);
    expect(isDiversion(undefined, 's3')).toBe(false);
  });

  it('snapshot.headline carries reducedMtdM + divertedMtdM = mtdM', () => {
    const s = buildSnapshot(parts());
    const h = s.headline;
    expect(h.divertedMtdM).toBeGreaterThan(0);
    expect(h.reducedMtdM).toBeGreaterThan(0);
    expect(h.reducedMtdM! + h.divertedMtdM!).toBe(h.mtdM);
    // DNS: 60 GB credited at $2.25 and paid at $0.023 → $133.62 of diversion; the trim: 24 GB × $2.25 = $54.
    expect(h.divertedMtdM).toBe(60 * (SPLUNK - S3));
    expect(h.reducedMtdM).toBe(60 * Math.round(0.4e9 * SPLUNK / 1e9));
  });

  it('the diverted flow and its top-saver line say so, with where it is credited', () => {
    const s = buildSnapshot(parts());
    expect(s.flows.find((f) => f.key === DNS.key)).toMatchObject({ diverted: true, divertedTo: 'splunk' });
    expect(s.flows.find((f) => f.key === WIN.key)!.diverted).toBeUndefined();
    const dns = s.topSavers.find((t) => t.pipelineId === 'passthru')!;
    expect(dns.diverted).toBe(true);
    expect(s.topSavers.find((t) => t.pipelineId === 'win_trim')!.diverted).toBeUndefined();
  });

  it('no per-destination month totals (an older totals document): no split, rather than a guessed one', () => {
    const d = [{ outputId: 's3', counterfactual: { kind: 'other' as const, outputId: 'splunk' }, mtdSavedM: 5 }];
    expect(savingsSplit(10, d, { ...emptyTotals('x') }, '2026-09')).toEqual({});
  });

  it('the weekly receipt tags the DNS line "(diverted)" and splits the total', () => {
    const p = parts();
    const snapshot = buildSnapshot(p);
    const flowSums: Record<string, { whpM: number; paidM: number; savedM: number }> = {};
    for (const [key, rs] of Object.entries(p.minuteRows)) {
      flowSums[key] = rs.reduce((a, r) => ({ whpM: a.whpM + r.whpM, paidM: a.paidM + r.paidM, savedM: a.savedM + r.savedM }), { whpM: 0, paidM: 0, savedM: 0 });
    }
    const r = buildWeeklyReceipt({
      periodStartMs: Date.parse('2026-09-21T00:00:00Z'),
      periodEndMs: Date.parse('2026-09-28T00:00:00Z'),
      tz: 'UTC',
      flowSums,
      basis: { prices: p.prices, destinations: snapshot.destinations },
    });
    expect(r.lines.find((l) => l.label === DNS_LABEL)).toMatchObject({ diverted: true });
    expect(r.lines.find((l) => l.label !== DNS_LABEL && l.savedM > 0)!.diverted).toBeUndefined();
    expect(r.divertedM).toBe(60 * (SPLUNK - S3));
    const text = receiptText(r);
    expect(text).toMatch(new RegExp(`^${DNS_LABEL} \\(diverted\\) \\.+ +\\$134$`, 'm'));
    expect(text).toContain(`Saved by reduction ${'$54'} · by diversion $134`);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(48);
  });

  it('Copy receipt, month to date: the split line and the tagged top saver', () => {
    const s: Snapshot = buildSnapshot(parts());
    const text = receiptTextForPeriod('month to date', s, { period: 'mtd', tz: 'UTC' });
    expect(text).toContain(`${DNS_LABEL}${DIVERTED_TAG} `);
    expect(text).toMatch(/Saved by reduction \$54 · by diversion \$134/);
    // Other periods have no exact split: no line rather than a guessed one.
    expect(receiptTextForPeriod('today', s, { period: 'today', tz: 'UTC' })).not.toContain('by diversion');
  });

  it('a long diverted label keeps its tag inside 48 columns', () => {
    const r = buildWeeklyReceipt({
      periodStartMs: 0,
      periodEndMs: 7 * 86_400_000,
      tz: 'UTC',
      flowSums: { [makeFlowKey('default', 'dns', 'r', 'a_really_long_pipeline_name_for_dns_logs_to_archive', 's3')]: { whpM: 9 * MC, paidM: MC, savedM: 8 * MC } },
      basis: { prices: pricesDoc(), destinations: [] as DestinationFigures[] },
    });
    const line = receiptText(r).split('\n').find((l) => l.includes('(diverted)'))!;
    expect(line.length).toBe(48);
    expect(line).toMatch(/… \(diverted\) \.{4,} +\$8$/);
  });
});

describe('P1-F02 / P1-F03 · the Ledger reads it, on snapshots from before too', () => {
  it('a snapshot written before P1-F02 (the bundled sample) still reads diverted flows from its destinations, and the split', () => {
    const s = buildSnapshot(parts());
    const old: Snapshot = {
      ...s,
      flows: s.flows.map(({ diverted: _d, divertedTo: _t, ...f }) => f),
      headline: { ...s.headline, reducedMtdM: undefined, divertedMtdM: undefined },
    };
    const dns = old.flows.find((f) => f.key === DNS.key)!;
    expect(diversionTarget(dns, old.destinations)).toBe('splunk');
    expect(diversionTarget(old.flows.find((f) => f.key === WIN.key)!, old.destinations)).toBeUndefined();
    expect(headlineSplit(old)).toEqual({ reducedM: s.headline.reducedMtdM, divertedM: s.headline.divertedMtdM });
    expect(headlineSplit(s)).toEqual({ reducedM: s.headline.reducedMtdM, divertedM: s.headline.divertedMtdM });
  });

  it('Ledger rows: the diverted flow names where it would have gone; the enriched one reads −30%; totals carry the cost added', () => {
    const s = buildSnapshot(parts());
    const rows = buildRows(s);
    expect(rows.find((r) => r.id === DNS.key)!.divertedTo).toBe('Splunk');
    expect(rows.find((r) => r.id === WIN.key)!.divertedTo).toBeUndefined();
    expect(rows.find((r) => r.id === GEO.key)!.reduction).toBeCloseTo(-0.3, 6);
    const t = totals(rows);
    expect(t.addedFlows).toBe(1);
    expect(t.addedPerDayM).toBe(60 * 67_500 * 24);
    // A passthrough's few extra bytes read 0%, never −0%.
    expect(byteReduction(1e9, 1e9 * (1 + INFLATION_NOISE / 2))).toBe(0);
    expect(byteReduction(0, 5)).toBeNull();
  });
});
