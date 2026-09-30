// r1 ui-3 (FINDINGS_EXTRA (b), round-1.md §0.2 and §1): the Receipt's "at your scale" line, from the workspace's own
// measured rate: saved per GB received × 1 / 5 / 10 TB a day × 365, two significant figures. The ladder the numbers
// ledger fixes for a 34 % cut at $2.25/GB is $280K · $1.4M · $2.8M, never "$283K" (that is 34.5 %).

import { describe, expect, it } from 'vitest';
import { atScale, atScaleAmount, atScaleFromSnapshot, roundToSignificant, AT_SCALE_RUNGS_GB } from '../../src/views/Receipt/atScale.ts';
import type { FlowFigures, DestinationFigures, Snapshot } from '../../core/types.ts';

const GB = 1e9;
const MC = 100_000; // millicents per dollar

/** Saved a day for `gbPerDay` received, cut `cut` of the way, at `price` $/GB. */
const savedPerDayM = (gbPerDay: number, cut: number, price: number): number => Math.round(gbPerDay * cut * price * MC);

describe('roundToSignificant and the amount', () => {
  it('rounds to two significant figures, half away from zero', () => {
    expect(roundToSignificant(279_225)).toBe(280_000);
    expect(roundToSignificant(1_396_125)).toBe(1_400_000);
    expect(roundToSignificant(2_792_250)).toBe(2_800_000);
    expect(roundToSignificant(2_134_000)).toBe(2_100_000);
    expect(roundToSignificant(995_000)).toBe(1_000_000);
    expect(roundToSignificant(9_449)).toBe(9_400);
    expect(roundToSignificant(0)).toBe(0);
  });

  it('prints $280K, $1.4M, $2.8M', () => {
    expect(atScaleAmount(280_000 * MC)).toBe('$280K');
    expect(atScaleAmount(1_400_000 * MC)).toBe('$1.4M');
    expect(atScaleAmount(2_800_000 * MC)).toBe('$2.8M');
    expect(atScaleAmount(1_000_000 * MC)).toBe('$1M');
    expect(atScaleAmount(9_400 * MC)).toBe('$9.4K');
    expect(atScaleAmount(950 * MC)).toBe('$950');
  });
});

describe('atScale', () => {
  it('34 % × $2.25/GB → $280K · $1.4M · $2.8M a year exactly, never 283', () => {
    const r = atScale({ savedPerDayM: savedPerDayM(450, 0.34, 2.25), bytesInPerDay: 450 * GB, priced: true, basisMinutes: 1_440 });
    expect(r).toBeDefined();
    expect(r!.savedPerGbM).toBe(76_500); // $0.765 saved per GB received
    expect(r!.rungs.map((x) => x.gbPerDay)).toEqual([1_000, 5_000, 10_000]);
    expect(r!.rungs.map((x) => x.exactPerYearM)).toEqual([279_225 * MC, 1_396_125 * MC, 2_792_250 * MC]);
    expect(r!.rungs.map((x) => x.amount)).toEqual(['$280K', '$1.4M', '$2.8M']);
    expect(JSON.stringify(r)).not.toMatch(/283/);
  });

  it('the rate is the whole workspace\'s: the demo org at ≈ $263 a day on 450 GB reads ≈ $2.1M at 10 TB a day', () => {
    const r = atScale({ savedPerDayM: 263 * MC, bytesInPerDay: 450 * GB, priced: true, basisMinutes: 1_440 });
    expect(r!.rungs.at(-1)!.amount).toBe('$2.1M');
  });

  it('shows only the rungs above what the workspace already receives', () => {
    const at3tb = atScale({ savedPerDayM: savedPerDayM(3_000, 0.34, 2.25), bytesInPerDay: 3_000 * GB, priced: true, basisMinutes: 1_440 });
    expect(at3tb!.rungs.map((x) => x.gbPerDay)).toEqual([5_000, 10_000]);
    const at1tb = atScale({ savedPerDayM: savedPerDayM(1_000, 0.34, 2.25), bytesInPerDay: 1_000 * GB, priced: true, basisMinutes: 1_440 });
    expect(at1tb!.rungs.map((x) => x.gbPerDay)).toEqual([5_000, 10_000]);
  });

  it('hides at 10 TB a day and above (the sample tour), with no priced destination, and on under an hour of traffic', () => {
    const base = { savedPerDayM: savedPerDayM(450, 0.34, 2.25), bytesInPerDay: 450 * GB, priced: true, basisMinutes: 1_440 };
    expect(atScale({ ...base, bytesInPerDay: 10_000 * GB, savedPerDayM: savedPerDayM(10_000, 0.34, 2.25) })).toBeUndefined();
    expect(atScale({ ...base, bytesInPerDay: 31_000 * GB, savedPerDayM: savedPerDayM(31_000, 0.34, 2.25) })).toBeUndefined();
    expect(atScale({ ...base, priced: false })).toBeUndefined();
    expect(atScale({ ...base, basisMinutes: 59 })).toBeUndefined();
    expect(atScale({ ...base, basisMinutes: 60 })).toBeDefined();
    // Nothing to project: no exact bytes-received figure, no traffic, no savings.
    expect(atScale({ ...base, bytesInPerDay: undefined })).toBeUndefined();
    expect(atScale({ ...base, bytesInPerDay: 0 })).toBeUndefined();
    expect(atScale({ ...base, savedPerDayM: 0 })).toBeUndefined();
  });

  it('the rungs are 1, 5 and 10 TB a day', () => {
    expect([...AT_SCALE_RUNGS_GB]).toEqual([1_000, 5_000, 10_000]);
  });
});

function flow(p: Partial<FlowFigures>): FlowFigures {
  return {
    key: 'k', groupId: 'default', inputId: 'in', routeId: 'r', pipelineId: 'p', outputId: 'siem',
    inB: 0, outB: 0, whpM: 0, paidM: 0, savedM: 0, ratio: 0, ratePerHourM: 0,
    savedPerDayM: 0, whpPerDayM: 0, paidPerDayM: 0, inBPerDay: 0, outBPerDay: 0,
    attribution: 'reconciled', sparkline: [], state: 'ok', ...p,
  } as FlowFigures;
}

function dest(p: Partial<DestinationFigures>): DestinationFigures {
  return {
    groupId: 'default', outputId: 'siem', type: 'splunk_hec', whpPerDayM: 0, paidPerDayM: 0, savedPerDayM: 0,
    mtdPaidM: 0, mtdSavedM: 0, mtdWhpM: 0, milliCentsPerGb: 225_000, counterfactual: { kind: 'same' }, unpriced: false, ...p,
  } as DestinationFigures;
}

function snapshotWith(flows: FlowFigures[], destinations: DestinationFigures[], opts: { days?: number; collectingMinutes?: number } = {}): Snapshot {
  const sweepAt = '2026-09-28T12:00:00.000Z';
  const since = new Date(Date.parse(sweepAt) - (opts.collectingMinutes ?? 30 * 1_440) * 60_000).toISOString();
  return {
    schemaVersion: 1, sweepAt, windowStart: sweepAt, windowEnd: sweepAt, mode: 'ui',
    headline: { todayM: 0, mtdM: 0, d30M: 0, annualizedM: 1, annualizedFromDays: opts.days ?? 30, whpMtdM: 0, paidMtdM: 0, ratioMtd: 0, whpTodayM: 0, paidTodayM: 0, whp30dM: 0, paid30dM: 0 },
    ratePerSecM: 0, flows, destinations, topSavers: [], unpricedOutputIds: [], openIncidents: 0, incidents: [], trend: [],
    ratioSeries: [], timeline: [], deliveries: [], calls: 0, collectingSince: since, metricsSource: 'metrics-query', attributionSummary: 'reconciled',
  };
}

describe('atScaleFromSnapshot', () => {
  const flows = [
    flow({ key: 'a', inputId: 'pan', savedPerDayM: savedPerDayM(300, 0.34, 2.25), inBPerDay: 300 * GB }),
    flow({ key: 'b', inputId: 'win', savedPerDayM: savedPerDayM(150, 0.34, 2.25), inBPerDay: 150 * GB }),
  ];

  it('sums the flows: saved a day at current rates over the bytes the workspace receives', () => {
    const r = atScaleFromSnapshot(snapshotWith(flows, [dest({})]));
    expect(r!.savedPerGbM).toBe(76_500);
    expect(r!.gbInPerDay).toBe(450);
    expect(r!.rungs.map((x) => x.amount)).toEqual(['$280K', '$1.4M', '$2.8M']);
  });

  it('hides when no destination carries a price (only free or unpriced ones)', () => {
    expect(atScaleFromSnapshot(snapshotWith(flows, [dest({ unpriced: true, milliCentsPerGb: 0 })]))).toBeUndefined();
    expect(atScaleFromSnapshot(snapshotWith(flows, [dest({ type: 'devnull', milliCentsPerGb: 0 })]))).toBeUndefined();
  });

  it('hides on under an hour of metered traffic, and when a Source feeds two flows (its bytes in are not exact)', () => {
    expect(atScaleFromSnapshot(snapshotWith(flows, [dest({})], { days: 0.03, collectingMinutes: 45 }))).toBeUndefined();
    const cloned = [...flows, flow({ key: 'c', inputId: 'pan', outputId: 'archive', savedPerDayM: 1, inBPerDay: 300 * GB })];
    expect(atScaleFromSnapshot(snapshotWith(cloned, [dest({})]))).toBeUndefined();
  });
});
