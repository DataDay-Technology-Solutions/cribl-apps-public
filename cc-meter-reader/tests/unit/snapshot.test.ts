import { describe, expect, it } from 'vitest';
import type { Commit, DeliveryLog, Flow, FlowFigures, Incident, InventoryDoc, MinuteRow, Snapshot, TopSaver, TotalsDoc } from '../../core/types.ts';
import {
  COMPACT_FLOWS,
  OTHER_FLOW_KEY,
  buildSnapshot,
  compactSnapshot,
  distinctLabels,
  flowCounts,
  routeHistoryKeys,
  routeIdentity,
  snapshotBytes,
  summarizeAttribution,
  utf8Length,
  type SnapshotParts,
} from '../../core/snapshot.ts';
import { appendPriceVersion, emptyPrices, priceMinute } from '../../core/pricing.ts';
import { addMinuteToTotals, addOutputMinuteToTotals, emptyTotals } from '../../core/rollups.ts';
import { makeFlowKey } from '../../core/flows.ts';
import { defaultSettings } from '../../core/settings.ts';
import { emptyBaselines } from '../../core/detector.ts';
import { mergeCommits } from '../../core/timeline.ts';

const MIN = 60_000;
const SWEEP = Date.parse('2026-09-26T17:00:05Z');
const WINDOW_END = Date.parse('2026-09-26T17:00:00Z');
const WINDOW_START = WINDOW_END - MIN;
const TZ = 'UTC';

const flow = (inputId: string, routeId: string, pipelineId: string, outputId: string): Flow => ({
  key: makeFlowKey('default', inputId, routeId, pipelineId, outputId),
  groupId: 'default',
  inputId,
  routeId,
  pipelineId,
  outputId,
  attribution: 'route',
});
const PAY = flow('mrd_payments_api', 'r_pay', 'mrd_pay_sample', 'mrd_siem_prod');
const K8S = flow('mrd_k8s_prod', 'r_k8s', 'mrd_k8s_noise', 'mrd_analytics');
const VPC = flow('mrd_vpc_flow', 'r_vpc', 'mrd_vpc_pack', 'mrd_archive_s3');
const HOOK = flow('in_http', 'r_hook', 'main', 'webhook_out');

const inventory: InventoryDoc = {
  schemaVersion: 1,
  updatedAt: '',
  hash: 'h',
  byGroup: {
    default: {
      inputs: [],
      outputs: [
        { id: 'default', type: 'default', defaultId: 'devnull' },
        { id: 'mrd_siem_prod', type: 'devnull' },
        { id: 'mrd_analytics', type: 'devnull' },
        { id: 'mrd_archive_s3', type: 'devnull' },
        { id: 'webhook_out', type: 'webhook' },
        { id: 'idle_hec', type: 'splunk_hec' },
        { id: 'off', type: 'splunk_hec', disabled: true },
        { id: 'metrics', type: 'cribl_metrics' },
      ],
      pipelines: [],
      routes: [],
    },
  },
};

let prices = emptyPrices('x');
prices = appendPriceVersion(
  prices,
  {
    mrd_siem_prod: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' },
    mrd_analytics: { milliCentsPerGb: 150_000, preset: 'datadog' },
    mrd_archive_s3: { milliCentsPerGb: 3_000, preset: 's3' },
    webhook_out: { milliCentsPerGb: 0, preset: 'internal' },
  },
  Date.parse('2026-09-01T00:00:00Z'),
);

/** GB/day → bytes per minute */
const perMin = (gbPerDay: number) => (gbPerDay * 1e9) / 1440;

function rowsFor(inGbDay: number, ratioOut: number, price: number, minutes: number, lastRatioOut = ratioOut): MinuteRow[] {
  const rows: MinuteRow[] = [];
  for (let i = minutes; i >= 1; i--) {
    const t = WINDOW_END - i * MIN;
    const inB = Math.round(perMin(inGbDay));
    const outB = Math.round(inB * (i === 1 ? lastRatioOut : ratioOut));
    const m = priceMinute({ inB, outB }, price, price);
    rows.push({ t: new Date(t).toISOString(), inB, outB, inE: 100, outE: 50, ...m });
  }
  return rows;
}

function parts(over: Partial<SnapshotParts> = {}): SnapshotParts {
  const minuteRows = {
    [PAY.key]: rowsFor(40, 0.25, 250_000, 90, 0.5), // 0.75 steady; last minute broken to 0.50
    [K8S.key]: rowsFor(60, 0.3, 150_000, 90),
    [VPC.key]: rowsFor(60, 1, 3_000, 90),
    [HOOK.key]: rowsFor(1, 1, 0, 90),
  };
  let totals: TotalsDoc = emptyTotals('x');
  for (const [day, saved] of [['2026-09-24', 26_200_000], ['2026-09-25', 26_000_000], ['2026-09-26', 15_000_000]] as const) {
    totals = addMinuteToTotals(totals, day, { whpM: saved * 3, paidM: saved * 2, savedM: saved });
  }
  totals = addOutputMinuteToTotals(totals, '2026-09', 'default:mrd_siem_prod', { whpM: 900_000_000, paidM: 600_000_000, savedM: 300_000_000 });
  const incidents: Incident[] = [
    { id: 'i1', type: 'regression', severity: 'high', objectKey: 'route:default:r_pay', label: 'Payments API sampling', openedAt: '2026-09-26T16:59:05.000Z', before: 0.75, after: 0.5, impactPerDayM: 2_500_000, notes: [], deliveries: [] },
    { id: 'i2', type: 'spike', severity: 'high', objectKey: 'in:default:mrd_k8s_prod', label: 'k8s', openedAt: '2026-09-26T10:00:00.000Z', before: 1, after: 2, impactPerDayM: 1, notes: [], deliveries: [] },
    { id: 'i3', type: 'spike', severity: 'high', objectKey: 'in:default:x', label: 'old', openedAt: '2026-09-20T10:00:00.000Z', closedAt: '2026-09-20T11:00:00.000Z', before: 1, after: 2, impactPerDayM: 1, notes: [], deliveries: [] },
    { id: 'i4', type: 'spike', severity: 'high', objectKey: 'in:default:y', label: 'recent', openedAt: '2026-09-26T12:00:00.000Z', closedAt: '2026-09-26T13:00:00.000Z', before: 1, after: 2, impactPerDayM: 1, notes: [], deliveries: [] },
  ];
  const settings = defaultSettings('x', TZ);
  settings.budgets = { mrd_siem_prod: { centsPerMonth: 1_000_000 } };
  const baselines = emptyBaselines('x');
  baselines.byObject['route:default:r_k8s'] = { mean: 0.7, variance: 0, samples: 500, warm: [] };
  return {
    sweepAtMs: SWEEP,
    windowStartMs: WINDOW_START,
    windowEndMs: WINDOW_END,
    mode: 'ui',
    settings,
    prices,
    inventory,
    flows: [PAY, K8S, VPC, HOOK],
    minuteRows,
    attribution: { [PAY.key]: 'route', [K8S.key]: 'route', [VPC.key]: 'proportional' },
    totals,
    collectingSinceMs: Date.parse('2026-09-23T12:00:00Z'),
    incidents,
    timeline: [],
    deliveries: [],
    muted: {},
    baselines,
    calls: 17,
    metricsSource: 'metrics-query',
    ...over,
  };
}

describe('buildSnapshot', () => {
  it('computes per-flow figures from the last minute and the last hour', () => {
    const s = buildSnapshot(parts());
    const pay = s.flows.find((f) => f.key === PAY.key)!;
    const inB = Math.round(perMin(40));
    expect(pay).toMatchObject({ inB, outB: Math.round(inB * 0.5), attribution: 'route', state: 'regression' });
    expect(pay.ratio).toBeCloseTo(0.5, 6);
    // 40 GB/day × $2.50 = $100/day (per-minute rounding: 6,944 mc × 1,440 = 9,999,360)
    expect(pay.whpPerDayM).toBe(6_944 * 1_440);
    expect(Math.abs(pay.savedPerDayM - (10_000_000 * (59 * 0.75 + 0.5)) / 60)).toBeLessThan(2_000);
    expect(pay.inBPerDay).toBeCloseTo(40e9, -3);
    expect(pay.ratePerHourM).toBe(pay.paidM * 60);
    expect(pay.sparkline).toHaveLength(30);
    expect(pay.sparkline[29]).toBeCloseTo(0.5, 6);
    const k8s = s.flows.find((f) => f.key === K8S.key)!;
    expect(k8s.state).toBe('spike');
    expect(s.flows.find((f) => f.key === VPC.key)!).toMatchObject({ state: 'learning', attribution: 'proportional', savedPerDayM: 0 });
    expect(s.flows.find((f) => f.key === HOOK.key)!.state).toBe('unpriced');
    expect(s.ratePerSecM).toBeCloseTo(s.flows.reduce((a, f) => a + f.savedM, 0) / 60, 10);
  });

  it("carries a route's own Cribl name on its flows, never an empty or id-only one (wave 1 review: 'R VPC')", () => {
    const named: InventoryDoc = {
      ...inventory,
      byGroup: {
        default: {
          ...inventory.byGroup.default,
          routes: [
            { id: 'r_vpc', name: 'VPC Flow', filter: 'true', pipeline: 'mrd_vpc_pack' },
            { id: 'r_pay', name: 'r_pay', filter: 'true', pipeline: 'mrd_pay_sample' },
          ],
        },
      },
    };
    const s = buildSnapshot(parts({ inventory: named }));
    expect(s.flows.find((f) => f.key === VPC.key)?.routeName).toBe('VPC Flow');
    expect(s.flows.find((f) => f.key === PAY.key)).not.toHaveProperty('routeName');
    expect(s.flows.find((f) => f.key === K8S.key)).not.toHaveProperty('routeName');
  });

  it('extrapolates per-day figures when metering began less than an hour ago', () => {
    const p = parts({ collectingSinceMs: WINDOW_END - 15 * MIN });
    p.minuteRows = { [PAY.key]: rowsFor(40, 0.25, 250_000, 15) };
    p.flows = [PAY];
    const s = buildSnapshot(p);
    expect(s.flows[0].whpPerDayM).toBe(6_944 * 1_440);
  });

  it('builds destinations with prices, MTD and budget pace; lists unpriced ones', () => {
    const p = parts();
    // P0-17: metering began Sep 23 12:00 (collectingSince), so the month's paid covers 720 + 1,440 + 1,440 + 1,020
    // = 4,620 metered minutes, not the 37,020 since Sep 1 that the old projection divided by (25× low).
    const minutes: Record<string, number> = { '2026-09-23': 720, '2026-09-24': 1_440, '2026-09-25': 1_440, '2026-09-26': 1_020 };
    const byDay = { ...p.totals!.byDay };
    for (const [day, n] of Object.entries(minutes)) byDay[day] = { ...(byDay[day] ?? { whpM: 0, paidM: 0, savedM: 0 }), minutes: n };
    p.totals = { ...p.totals!, byDay };
    const s = buildSnapshot(p);
    expect(s.destinations.map((d) => d.outputId)).toEqual(['idle_hec', 'mrd_analytics', 'mrd_archive_s3', 'mrd_siem_prod', 'webhook_out']);
    const siem = s.destinations.find((d) => d.outputId === 'mrd_siem_prod')!;
    expect(siem).toMatchObject({ type: 'devnull', milliCentsPerGb: 250_000, counterfactual: { kind: 'same' }, unpriced: false, mtdPaidM: 600_000_000, mtdSavedM: 300_000_000, mtdWhpM: 900_000_000, mtdMinutes: 4_620 });
    // projection = 600M / 4,620 metered min × 43,200 min in September
    const projected = Math.round((600_000_000 / 4_620) * 43_200);
    expect(siem.budget).toEqual({ centsPerMonth: 1_000_000, projectedM: projected, pct: (projected / 1_000_000_000) * 100 });
    expect(s.destinations.find((d) => d.outputId === 'mrd_analytics')!.budget).toBeUndefined();
    expect(s.unpricedOutputIds).toEqual(['idle_hec', 'webhook_out']);
    // Totals with no metered minutes this month fall back to the time since collecting began (Sep 23 12:00 → the sweep).
    const bare = buildSnapshot({ ...p, totals: { ...p.totals!, byDay: {} } });
    const sinceMin = (SWEEP - Date.parse('2026-09-23T12:00:00Z')) / MIN;
    expect(bare.destinations.find((d) => d.outputId === 'mrd_siem_prod')!.budget!.projectedM).toBe(Math.round((600_000_000 / sinceMin) * 43_200));
  });

  it('P1-F01: a destination crediting diverted data at an unpriced destination is flagged and counted', () => {
    // archive-s3 diverts to 'analytics', which has no price: its flows' credit is unknown, not $0.
    let p2 = emptyPrices('x');
    p2 = appendPriceVersion(
      p2,
      {
        mrd_siem_prod: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' },
        mrd_archive_s3: { milliCentsPerGb: 3_000, preset: 's3', counterfactual: { kind: 'other', outputId: 'mrd_analytics' } },
        webhook_out: { milliCentsPerGb: 0, preset: 'internal' },
      },
      Date.parse('2026-09-01T00:00:00Z'),
    );
    const s = buildSnapshot(parts({ prices: p2 }));
    const archive = s.destinations.find((d) => d.outputId === 'mrd_archive_s3')!;
    expect(archive).toMatchObject({ unpriced: true, counterfactualUnpriced: true, milliCentsPerGb: 3_000, counterfactual: { kind: 'other', outputId: 'mrd_analytics' } });
    // The banner counts the destination whose credit is unknown. The DevNull target stands in for a paid
    // destination (its id names one), so with no price of its own it is unpriced too, not free (P0-04).
    expect(s.destinations.find((d) => d.outputId === 'mrd_analytics')!.unpriced).toBe(true);
    expect(s.unpricedOutputIds).toEqual(['idle_hec', 'mrd_analytics', 'mrd_archive_s3', 'webhook_out']);
    expect(s.flows.find((f) => f.key === VPC.key)!.state).toBe('unpriced');
    // A destination priced in full carries no flag at all (the snapshot stays small).
    expect('counterfactualUnpriced' in s.destinations.find((d) => d.outputId === 'mrd_siem_prod')!).toBe(false);
  });

  it('ranks top savers by route, labelled by pipeline', () => {
    const s = buildSnapshot(parts());
    expect(s.topSavers.map((t) => t.label)).toEqual(['Payments API sampling', 'Kubernetes noise filter']);
    expect(s.topSavers[0]).toMatchObject({ objectKey: 'route:default:r_pay', groupId: 'default', pipelineId: 'mrd_pay_sample' });
    expect(s.topSavers[0].ratio).toBeGreaterThan(0.7);
  });

  it('tells two routes through one pipeline apart by their route, and across groups by the group', () => {
    const saver = (objectKey: string, label: string, groupId = 'default'): TopSaver => ({ objectKey, label, savedPerDayM: 1, ratio: 0.5, groupId, pipelineId: 'mrd_win_xml_pack' });
    // The demo rig: both Windows routes run the XML pack, so "Windows XML pack" would list twice.
    const rig = distinctLabels([saver('route:default:mrd_windows_dc', 'Windows XML pack'), saver('route:default:mrd_windows_workstations', 'Windows XML pack'), saver('route:default:r_pay', 'Payments API sampling')]);
    expect(rig.map((t) => t.label)).toEqual(['Windows DC security events · Windows XML pack', 'Windows workstation events · Windows XML pack', 'Payments API sampling']);
    // A member's own name for the route wins, as everywhere.
    expect(distinctLabels([saver('route:default:mrd_windows_dc', 'Windows XML pack'), saver('route:default:r_ws', 'Windows XML pack')], { mrd_windows_dc: 'DCs' })[0].label).toBe('DCs · Windows XML pack');
    // The same route id in two worker groups through the same pipeline: the group tells them apart.
    const groups = distinctLabels([saver('route:east:r_win', 'Windows XML pack', 'east'), saver('route:west:r_win', 'Windows XML pack', 'west')]);
    expect(groups.map((t) => t.label)).toEqual(['R Windows · Windows XML pack · east', 'R Windows · Windows XML pack · west']);
    // Distinct labels are returned as they came, the same objects.
    const distinct = [saver('route:default:r_a', 'A'), saver('route:default:r_b', 'B')];
    expect(distinctLabels(distinct)).toBe(distinct);
  });

  it('computes the headline, trend since collecting began, incidents, and metadata', () => {
    const s = buildSnapshot(parts());
    expect(s.headline).toMatchObject({ todayM: 15_000_000, mtdM: 67_200_000, annualizedFromDays: 2 });
    // Σ saved ÷ Σ metered minutes × 525,600 over the last 30 local days, today included (REVIEW-3a #6): one minute a day here.
    expect(s.headline.annualizedM).toBe(Math.round(((26_200_000 + 26_000_000 + 15_000_000) / 3) * 525_600));
    expect(s.trend.map((t) => t.day)).toEqual(['2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']);
    expect(s.trend[0]).toEqual({ day: '2026-09-23', savedM: 0, whpM: 0, paidM: 0 });
    expect(s.incidents.map((i) => i.id)).toEqual(['i1', 'i4', 'i2']);
    expect(s.openIncidents).toBe(2);
    expect(s).toMatchObject({
      schemaVersion: 1,
      sweepAt: '2026-09-26T17:00:05.000Z',
      windowStart: '2026-09-26T16:59:00.000Z',
      windowEnd: '2026-09-26T17:00:00.000Z',
      mode: 'ui',
      calls: 17,
      collectingSince: '2026-09-23T12:00:00.000Z',
      metricsSource: 'metrics-query',
      attributionSummary: 'proportional',
    });
  });

  it('marks muted flows ok with the chip data', () => {
    const until = new Date(SWEEP + 6 * MIN).toISOString();
    const s = buildSnapshot(parts({ muted: { 'route:default:r_pay': until, 'route:default:r_k8s': new Date(SWEEP - MIN).toISOString() } }));
    const pay = s.flows.find((f) => f.key === PAY.key)!;
    expect(pay).toMatchObject({ state: 'ok', muted: true, mutedUntil: until });
    expect(s.flows.find((f) => f.key === K8S.key)!.muted).toBeUndefined();
  });

  it('keeps a 24 h, 5-minute ratio series: recomputed where rows cover it, carried forward otherwise', () => {
    const s1 = buildSnapshot(parts());
    expect(s1.ratioSeries.length).toBe(18); // 90 minutes of rows → 18 buckets
    expect(s1.ratioSeries.every((p) => p.ratio >= 0 && p.ratio <= 1)).toBe(true);
    const old = { t: '2026-09-26T10:00:00.000Z', ratio: 0.42 };
    const stale = { t: '2026-09-25T10:00:00.000Z', ratio: 0.1 };
    const overlap = { t: s1.ratioSeries[5].t, ratio: 0.99 };
    const s2 = buildSnapshot(parts({ previous: { ...s1, ratioSeries: [stale, old, overlap] } as Snapshot }));
    expect(s2.ratioSeries[0]).toEqual(old);
    expect(s2.ratioSeries.find((p) => p.t === overlap.t)?.ratio).not.toBe(0.99);
    expect(s2.ratioSeries.find((p) => p.t === stale.t)).toBeUndefined();
  });

  it('caps timeline and deliveries newest first and accepts a TimelineDoc', () => {
    const commits: Commit[] = Array.from({ length: 40 }, (_, i) => ({
      hash: `h${String(i).padStart(7, '0')}`,
      message: 'm',
      author: 'a',
      committedAt: new Date(SWEEP - i * MIN).toISOString(),
      groupId: 'default',
      files: [],
      source: 'api',
    }));
    const deliveries: DeliveryLog[] = Array.from({ length: 30 }, (_, i) => ({ endpointId: 'e', event: 'test', status: 200, attempt: 1, at: new Date(SWEEP - i * 1000).toISOString() }));
    const a = buildSnapshot(parts({ timeline: [...commits].reverse(), deliveries: [...deliveries].reverse() }));
    expect(a.timeline).toHaveLength(30);
    expect(a.timeline[0].hash).toBe('h0000000');
    expect(a.deliveries).toHaveLength(20);
    expect(a.deliveries[0].at).toBe(new Date(SWEEP).toISOString());
    const b = buildSnapshot(parts({ timeline: mergeCommits(null, 'default', commits, 'x') }));
    expect(b.timeline[0].hash).toBe('h0000000');
  });

  it('survives empty parts', () => {
    const s = buildSnapshot(
      parts({ flows: [], minuteRows: {}, incidents: undefined as unknown as Incident[], deliveries: undefined as unknown as DeliveryLog[], inventory: undefined, baselines: undefined, collectingSinceMs: Number.NaN, attribution: undefined }),
    );
    expect(s.flows).toEqual([]);
    expect(s.ratioSeries).toEqual([]);
    expect(s.destinations).toEqual([]);
    expect(s.attributionSummary).toBe('route');
    expect(s.collectingSince).toBe(s.sweepAt);
  });
});

describe('buildSnapshot edge cases', () => {
  it('handles connection flows, route-labelled savers, missing rows, ties and a blank zone', () => {
    const qc = flow('qc', '-', 'passthru', 'mrd_archive_s3');
    const noPipe = flow('np', 'r_np', '-', 'mrd_siem_prod');
    const tieA = flow('ta', 'r_a', 'p_same', 'mrd_siem_prod');
    const tieB = flow('tb', 'r_b', 'p_same', 'mrd_siem_prod');
    const silent = flow('silent', 'r_silent', 'p', '-');
    const p = parts({ flows: [qc, noPipe, tieA, tieB, silent] });
    p.settings = { ...p.settings, displayTimezone: '' };
    p.minuteRows = {
      [qc.key]: rowsFor(10, 0.5, 3_000, 5),
      [noPipe.key]: rowsFor(10, 0.5, 250_000, 5),
      [tieA.key]: rowsFor(20, 0.5, 250_000, 5),
      [tieB.key]: rowsFor(20, 0.5, 250_000, 5),
    };
    const twin = (id: string): Incident => ({ id, type: 'spike', severity: 'high', objectKey: `in:default:${id}`, label: id, openedAt: '2026-09-26T16:00:00.000Z', before: 1, after: 2, impactPerDayM: 1, notes: [], deliveries: [] });
    p.incidents = [twin('z'), twin('a')];
    const s = buildSnapshot(p);
    expect(s.topSavers.map((t) => t.objectKey)).toEqual(['route:default:r_a', 'route:default:r_b', 'route:default:r_np']);
    expect(s.topSavers[2].label).toBe('R np');
    expect(s.flows.find((f) => f.key === silent.key)).toMatchObject({ inB: 0, savedPerDayM: 0, sparkline: [] });
    expect(s.destinations.some((d) => d.outputId === '-')).toBe(false);
    expect(s.incidents.map((i) => i.id)).toEqual(['a', 'z']);
    const unknownType = buildSnapshot(parts({ inventory: { ...inventory, byGroup: { default: { ...inventory.byGroup.default, outputs: undefined as never } } } }));
    expect(unknownType.destinations.every((d) => d.type === 'unknown')).toBe(true);
  });
});

describe('summarizeAttribution', () => {
  const f = (attribution: FlowFigures['attribution'], inB = 1) => ({ attribution, inB, whpPerDayM: 0 });
  it('reports the weakest method among flows with traffic', () => {
    expect(summarizeAttribution([f('route'), f('pipeline')])).toBe('pipeline');
    expect(summarizeAttribution([f('route'), f('proportional', 0)])).toBe('route');
    expect(summarizeAttribution([f('route-only'), f('route')])).toBe('route');
    expect(summarizeAttribution([f('route-only')])).toBe('route-only');
    expect(summarizeAttribution([f('proportional', 0)])).toBe('proportional');
    expect(summarizeAttribution([])).toBe('route');
  });
});

describe('compaction', () => {
  it('measures UTF-8 bytes', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('—')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
    expect(utf8Length('\ud800')).toBe(3); // lone surrogate at the end
  });

  const big = (n: number): Snapshot => {
    const base = buildSnapshot(parts());
    const template = base.flows[0];
    const flows: FlowFigures[] = Array.from({ length: n }, (_, i) => ({
      ...template,
      key: makeFlowKey('default', `in_${i}`, `r_${i}`, 'p', 'o'),
      inputId: `in_${i}`,
      routeId: `r_${i}`,
      whpPerDayM: 1_000_000 + i,
      savedPerDayM: i,
      savedM: 1,
      whpM: 2,
      sparkline: Array(30).fill(0.5),
    }));
    const ratioSeries = Array.from({ length: 288 }, (_, i) => ({ t: new Date(SWEEP - (288 - i) * 5 * MIN).toISOString(), ratio: (i % 10) / 10 }));
    return { ...base, flows, ratioSeries };
  };

  it('returns the snapshot untouched when it fits', () => {
    const s = buildSnapshot(parts());
    expect(compactSnapshot(s, 10_000_000)).toBe(s);
  });

  it('keeps the top 500 flows by would-have-paid, folds the rest, and shrinks sparklines', () => {
    const s = big(800);
    const c = compactSnapshot(s, snapshotBytes(s) - 1);
    expect(c.flows).toHaveLength(COMPACT_FLOWS + 1);
    expect(c.flows[0].inputId).toBe('in_799');
    const other = c.flows[c.flows.length - 1];
    expect(other.key).toBe(OTHER_FLOW_KEY);
    expect(other.inputId).toBe('other');
    expect(other.savedPerDayM).toBe((299 * 300) / 2); // i = 0..299 folded
    expect(other.savedM).toBe(300);
    expect(other.ratio).toBe(0.5);
    expect(c.flows.slice(0, -1).every((f) => f.sparkline.length === 12)).toBe(true);
    expect(snapshotBytes(c)).toBeLessThan(snapshotBytes(s));
  });

  it('fits a 90 KB cap deterministically, coarsening the ratio series and flows', () => {
    const s = big(2000);
    const a = compactSnapshot(s, 90_000);
    const b = compactSnapshot(s, 90_000);
    expect(a).toEqual(b);
    expect(snapshotBytes(a)).toBeLessThanOrEqual(90_000);
    expect(a.ratioSeries.length).toBeLessThan(288);
    expect(a.flows.length).toBeLessThanOrEqual(COMPACT_FLOWS + 1);
    // folding keeps money conserved
    const sum = (x: Snapshot) => x.flows.reduce((acc, f) => acc + f.whpPerDayM, 0);
    expect(sum(a)).toBe(sum(s));
  });

  it('rules round 2: the estate is counted before the fold, and Other says how many flows it holds', () => {
    const full = big(400);
    const s = { ...full, flowCounts: flowCounts(full.flows) };
    expect(s.flowCounts).toEqual({ flows: 400, routes: 400, sources: 400 });
    const c = compactSnapshot(s, 90_000);
    const other = c.flows.find((f) => f.key === OTHER_FLOW_KEY)!;
    const shown = c.flows.length - 1;
    expect(shown).toBeLessThan(400);
    expect(other.folded).toBe(400 - shown);
    // The snapshot still says 400 (a header reads "400 flows · the N largest shown"), and counting the folded list
    // again gives the same estate, Other included.
    expect(c.flowCounts).toEqual({ flows: 400, routes: 400, sources: 400 });
    expect(flowCounts(c.flows).flows).toBe(400);
    // A second fold adds to what Other already held.
    const again = compactSnapshot(c, 20_000);
    const shownAgain = again.flows.length - 1;
    expect(again.flows.find((f) => f.key === OTHER_FLOW_KEY)!.folded).toBe(400 - shownAgain);
    expect(buildSnapshot(parts()).flowCounts?.flows).toBe(buildSnapshot(parts()).flows.length);
  });

  it('skips steps that no longer apply and re-folds an existing other flow', () => {
    const s = { ...big(300), ratioSeries: [] as Snapshot['ratioSeries'] };
    const c = compactSnapshot(s, 30_000);
    expect(c.flows.length).toBeLessThanOrEqual(101);
    expect(c.flows[c.flows.length - 1].key).toBe(OTHER_FLOW_KEY);
    const again = compactSnapshot(c, 5_000);
    expect(again.flows.filter((f) => f.key === OTHER_FLOW_KEY)).toHaveLength(1);
    const otherBefore = c.flows.find((f) => f.key === OTHER_FLOW_KEY)!;
    const otherAfter = again.flows.find((f) => f.key === OTHER_FLOW_KEY)!;
    expect(otherAfter.whpPerDayM).toBeGreaterThanOrEqual(otherBefore.whpPerDayM);
    // few flows but a bloated incident list: the flow fold is a no-op
    const incidents = Array.from({ length: 200 }, (_, i) => ({ ...buildSnapshot(parts()).incidents[0], id: `x${i}`, label: 'y'.repeat(200) }));
    const bloated = { ...buildSnapshot(parts()), incidents };
    const small = compactSnapshot(bloated, 20_000);
    expect(small.flows).toHaveLength(4);
    expect(small.incidents.length).toBeLessThanOrEqual(20);
  });

  it('goes as far as it can for an impossible cap', () => {
    const s = big(600);
    const c = compactSnapshot(s, 1_000);
    expect(c.flows.length).toBe(51);
    expect(c.flows.every((f) => f.sparkline.length === 0)).toBe(true);
    expect(c.deliveries).toEqual([]);
    expect(c.ratioSeries.length).toBe(36);
  });
});

// ─── Route history across a pipeline swap ('Thin ribbon after Apply') ─────────────────────────────
// Apply the pack points a route at another pipeline, which changes the FlowKey but not the traffic.
// The route's hourly projections and sparkline must keep reading its whole hour, not restart from the
// minute of the swap.
describe('buildSnapshot across a pipeline swap', () => {
  const WS_OLD = flow('mrd_windows_ws', 'r_ws', 'mrd_passthrough', 'mrd_siem_prod');
  const WS_PACK = flow('mrd_windows_ws', 'r_ws', 'mrd_windows_pack', 'mrd_siem_prod');
  /** rows `fromAgo`..`toAgo` minutes before WINDOW_END (inclusive, oldest first) */
  const rowsAgo = (gbDay: number, ratioOut: number, price: number, fromAgo: number, toAgo: number): MinuteRow[] =>
    rowsFor(gbDay, ratioOut, price, fromAgo).slice(0, fromAgo - toAgo + 1);
  const minuteOf = (r: MinuteRow) => r.t;
  const swapParts = (over: Partial<SnapshotParts> = {}): SnapshotParts =>
    parts({
      flows: [PAY, WS_PACK],
      minuteRows: {
        [PAY.key]: rowsFor(40, 0.25, 250_000, 90),
        // 80 GB/day passthrough for 58 minutes, then the pack (33 % out) for the last two
        [WS_OLD.key]: rowsAgo(80, 1, 250_000, 90, 3),
        [WS_PACK.key]: rowsAgo(80, 0.33, 250_000, 2, 1),
      },
      attribution: {},
      ...over,
    });
  const unswapped = (): SnapshotParts =>
    parts({ flows: [PAY, WS_OLD], minuteRows: { [PAY.key]: rowsFor(40, 0.25, 250_000, 90), [WS_OLD.key]: rowsFor(80, 1, 250_000, 90) }, attribution: {} });

  it('keeps the route\'s per-day volume and would-have-paid after the swap (no thin ribbon)', () => {
    const before = buildSnapshot(unswapped()).flows.find((f) => f.key === WS_OLD.key)!;
    const s = buildSnapshot(swapParts());
    const ws = s.flows.find((f) => f.key === WS_PACK.key)!;
    expect(s.flows.map((f) => f.key)).toEqual([PAY.key, WS_PACK.key]); // the old key is history, not a flow
    expect(ws.inBPerDay).toBeCloseTo(80e9, -7); // ≈ 80 GB/day, not 2 minutes × 24 ≈ 2.7 GB/day
    expect(ws.inBPerDay).toBe(before.inBPerDay);
    expect(ws.whpPerDayM).toBe(before.whpPerDayM);
    // out bytes and paid: 58 passthrough minutes + 2 pack minutes of the hour, × 24
    const inB = Math.round(perMin(80));
    expect(ws.outBPerDay).toBe(Math.round((58 * inB + 2 * Math.round(inB * 0.33)) * 24));
    expect(ws.paidPerDayM).toBeLessThan(before.paidPerDayM);
    expect(ws.savedPerDayM).toBeGreaterThan(0);
  });

  it('keeps the last minute (bytes, money, ratio, rate) the current pipeline\'s own', () => {
    const s = buildSnapshot(swapParts());
    const ws = s.flows.find((f) => f.key === WS_PACK.key)!;
    const last = rowsAgo(80, 0.33, 250_000, 1, 1)[0];
    expect(ws).toMatchObject({ inB: last.inB, outB: last.outB, whpM: last.whpM, paidM: last.paidM, savedM: last.savedM, ratePerHourM: last.paidM * 60, pipelineId: 'mrd_windows_pack' });
    expect(ws.ratio).toBeCloseTo(0.67, 2);
  });

  it('spans the route\'s history in the sparkline, so the Ledger shows the step change', () => {
    const ws = buildSnapshot(swapParts()).flows.find((f) => f.key === WS_PACK.key)!;
    expect(ws.sparkline).toHaveLength(30);
    expect(ws.sparkline.slice(0, 28).every((v) => v === 0)).toBe(true); // passthrough: nothing saved
    expect(ws.sparkline[28]).toBeCloseTo(0.67, 2);
    expect(ws.sparkline[29]).toBeCloseTo(0.67, 2);
  });

  it('keeps destination per-day figures and the route\'s top-saver entry stable', () => {
    const before = buildSnapshot(unswapped());
    const s = buildSnapshot(swapParts());
    const siem = (x: typeof s) => x.destinations.find((d) => d.outputId === 'mrd_siem_prod')!;
    expect(siem(s).whpPerDayM).toBe(siem(before).whpPerDayM);
    const saver = s.topSavers.find((t) => t.objectKey === 'route:default:r_ws')!;
    expect(saver).toMatchObject({ pipelineId: 'mrd_windows_pack', savedPerDayM: s.flows.find((f) => f.key === WS_PACK.key)!.savedPerDayM });
  });

  it('keeps a saving route\'s rank when it moves to a stronger pipeline (Go aggressive)', () => {
    // The route saved 50 % for 58 minutes, then 70 % for 2: its per-day savings stay an hour's worth.
    const PAN_PACK = flow('mrd_pan', 'r_pan', 'pan_pack', 'mrd_siem_prod');
    const PAN_AGGR = flow('mrd_pan', 'r_pan', 'pan_aggressive', 'mrd_siem_prod');
    const s = buildSnapshot(
      parts({
        flows: [PAY, PAN_AGGR],
        minuteRows: {
          [PAY.key]: rowsFor(40, 0.25, 250_000, 90), // 75 % of 40 GB/day ≈ $75/day saved
          [PAN_PACK.key]: rowsAgo(100, 0.5, 250_000, 90, 3), // 50 % of 100 GB/day ≈ $125/day saved
          [PAN_AGGR.key]: rowsAgo(100, 0.3, 250_000, 2, 1),
        },
        attribution: {},
      }),
    );
    expect(s.topSavers.map((t) => t.objectKey)).toEqual(['route:default:r_pan', 'route:default:r_pay']);
    expect(s.topSavers[0].savedPerDayM).toBeGreaterThan(s.topSavers[1].savedPerDayM);
    expect(s.topSavers[0].ratio).toBeCloseTo((58 * 0.5 + 2 * 0.7) / 60, 2);
  });

  it('pools both ways: a revert keeps the pack minutes in the restored pipeline\'s hour', () => {
    const s = buildSnapshot(
      swapParts({
        flows: [PAY, WS_OLD],
        minuteRows: {
          [PAY.key]: rowsFor(40, 0.25, 250_000, 90),
          [WS_OLD.key]: [...rowsAgo(80, 1, 250_000, 90, 10), ...rowsAgo(80, 1, 250_000, 2, 1)],
          [WS_PACK.key]: rowsAgo(80, 0.33, 250_000, 9, 3),
        },
      }),
    );
    const ws = s.flows.find((f) => f.key === WS_OLD.key)!;
    expect(ws.inBPerDay).toBeCloseTo(80e9, -7);
    expect(ws.ratio).toBe(0);
    expect(ws.sparkline.slice(21, 28).every((v) => Math.abs(v - 0.67) < 0.01)).toBe(true); // the pack's 7 minutes
    expect(ws.sparkline[29]).toBe(0);
  });

  it('never pools a route that now sends to another destination', () => {
    const moved = flow('mrd_windows_ws', 'r_ws', 'mrd_windows_pack', 'mrd_analytics');
    const s = buildSnapshot(swapParts({ flows: [PAY, moved], minuteRows: { [WS_OLD.key]: rowsAgo(80, 1, 250_000, 90, 3), [moved.key]: rowsAgo(80, 0.33, 150_000, 2, 1) } }));
    const f = s.flows.find((x) => x.key === moved.key)!;
    expect(f.inBPerDay).toBe(2 * Math.round(perMin(80)) * 24);
    expect(f.sparkline).toHaveLength(2);
  });

  it('gives a history key to one current flow only, so two current flows of one identity never double-count it', () => {
    const A = flow('mrd_windows_ws', 'r_ws', 'p_a', 'mrd_siem_prod');
    const B = flow('mrd_windows_ws', 'r_ws', 'p_b', 'mrd_siem_prod');
    const rows = {
      [A.key]: rowsAgo(10, 0.5, 250_000, 2, 1),
      [B.key]: rowsAgo(10, 0.5, 250_000, 2, 1),
      [WS_OLD.key]: rowsAgo(10, 1, 250_000, 60, 3),
    };
    const history = routeHistoryKeys([B, A], rows);
    expect([...history.entries()]).toEqual([[A.key < B.key ? A.key : B.key, [WS_OLD.key]]]);
    const s = buildSnapshot(swapParts({ flows: [A, B], minuteRows: rows }));
    const whpOf = (r: MinuteRow[]) => r.filter((x) => fromHourAgo(x)).reduce((a, x) => a + x.whpM, 0);
    const total = whpOf(rows[A.key]) + whpOf(rows[B.key]) + whpOf(rows[WS_OLD.key]);
    expect(s.destinations.find((d) => d.outputId === 'mrd_siem_prod')!.whpPerDayM).toBe(total * 24);
  });

  it('sums a minute two keys both hold (the pooled series equals the stored rows)', () => {
    const dup = rowsAgo(80, 0.33, 250_000, 1, 1);
    const s = buildSnapshot(swapParts({ minuteRows: { [WS_OLD.key]: rowsAgo(80, 1, 250_000, 1, 1), [WS_PACK.key]: dup } }));
    const ws = s.flows.find((f) => f.key === WS_PACK.key)!;
    expect(ws.inB).toBe(dup[0].inB); // the last minute stays the current pipeline's own
    expect(ws.inBPerDay).toBe(2 * dup[0].inB * 24);
    expect(ws.sparkline).toHaveLength(1);
    expect(minuteOf(dup[0])).toBe(new Date(WINDOW_START).toISOString());
  });

  it('keys route identities without the pipeline and ignores keys that do not parse', () => {
    expect(routeIdentity(WS_PACK.key)).toBe('default|mrd_windows_ws|r_ws|mrd_siem_prod');
    expect(routeIdentity(WS_OLD.key)).toBe(routeIdentity(WS_PACK.key));
    expect(routeIdentity('not-a-flow-key')).toBeUndefined();
    expect(routeHistoryKeys([WS_PACK, { key: 'bad' }], { bad: [], 'also|bad': [], [WS_OLD.key]: [] })).toEqual(new Map([[WS_PACK.key, [WS_OLD.key]]]));
    expect(routeHistoryKeys([PAY], { [WS_OLD.key]: [] }).size).toBe(0); // history of a route that no longer exists stays out
  });
});

function fromHourAgo(r: MinuteRow): boolean {
  const t = Date.parse(r.t);
  return t >= WINDOW_END - 60 * MIN && t < WINDOW_END;
}
