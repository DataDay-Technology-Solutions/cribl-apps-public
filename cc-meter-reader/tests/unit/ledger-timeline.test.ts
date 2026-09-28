// Change timeline logic (src/components/ChangeTimeline/model.ts), the rail's ordering and the sparkline path.

import { describe, expect, it } from 'vitest';
import type { Commit, FlowFigures, Incident, Snapshot } from '../../core/types.ts';
import {
  buildMarkers,
  buildSeries,
  dayTicks,
  fileLabel,
  niceRatioDomain,
  parseRange,
  segmentize,
  spreadMarkers,
  timeTicks,
  tzOffsetMs,
  whatMoved,
} from '../../src/components/ChangeTimeline/model.ts';
import { partitionIncidents } from '../../src/components/IncidentsRail/model.ts';
import { sparkEnds, sparkPath } from '../../src/components/Sparkline/path.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const END = Date.parse('2026-09-26T06:00:00.000Z'); // 1:00 AM in Chicago (CDT, UTC−5)
const iso = (ms: number) => new Date(ms).toISOString();

function commit(hash: string, atMs: number, over: Partial<Commit> = {}): Commit {
  return {
    hash,
    message: `commit ${hash}`,
    author: 's.koelpin',
    committedAt: iso(atMs),
    groupId: 'default',
    files: [],
    source: 'demo',
    ...over,
  };
}

function flow(inputId: string, pipelineId: string, sparkline: number[], over: Partial<FlowFigures> = {}): FlowFigures {
  return {
    key: `default|${inputId}|${inputId}|${pipelineId}|mrd_siem_prod`,
    groupId: 'default',
    inputId,
    routeId: inputId,
    pipelineId,
    outputId: 'mrd_siem_prod',
    inB: 1,
    outB: 1,
    whpM: 1,
    paidM: 1,
    savedM: 1,
    ratio: sparkline.at(-1) ?? 0,
    ratePerHourM: 1,
    savedPerDayM: 1,
    whpPerDayM: 1,
    paidPerDayM: 1,
    inBPerDay: 1,
    outBPerDay: 1,
    attribution: 'route',
    sparkline,
    state: 'ok',
    ...over,
  };
}

function snap(over: Partial<Snapshot>): Snapshot {
  return {
    schemaVersion: 1,
    sweepAt: iso(END + 20_000),
    windowStart: iso(END - MIN),
    windowEnd: iso(END),
    mode: 'ui',
    headline: {} as Snapshot['headline'],
    ratePerSecM: 0,
    flows: [],
    destinations: [],
    topSavers: [],
    unpricedOutputIds: [],
    openIncidents: 0,
    incidents: [],
    trend: [],
    ratioSeries: [],
    timeline: [],
    deliveries: [],
    calls: 0,
    collectingSince: iso(END - 7 * DAY),
    metricsSource: 'metrics-query',
    attributionSummary: 'route',
    ...over,
  };
}

describe('series', () => {
  it('24 h uses the ratio series; a late start is captioned "since" and the domain hugs the data', () => {
    const ratioSeries = Array.from({ length: 13 }, (_, i) => ({
      t: iso(END - 2 * HOUR + i * 5 * MIN),
      ratio: 0.3,
    }));
    const s = buildSeries('24h', snap({ ratioSeries }), 'America/Chicago');
    expect(s.points).toHaveLength(13);
    expect(s.domain[1]).toBe(END);
    expect(s.domain[0]).toBe(END - 2 * HOUR - 10 * MIN);
    expect(s.since).toBe(END - 2 * HOUR);
    expect(s.segments).toHaveLength(1);
  });

  it('a full day has no "since"; points older than 24 h are dropped', () => {
    const ratioSeries = Array.from({ length: 300 }, (_, i) => ({
      t: iso(END - 25 * HOUR + i * 5 * MIN),
      ratio: 0.3,
    }));
    const s = buildSeries('24h', snap({ ratioSeries }), 'UTC');
    expect(s.domain).toEqual([END - DAY, END]);
    expect(s.since).toBeUndefined();
    expect(s.points.every((p) => p.t >= END - DAY)).toBe(true);
  });

  it('a gap in the data breaks the line instead of bridging it', () => {
    const pts = [0, 5, 10, 40, 45].map((m) => ({
      t: END - HOUR + m * MIN,
      ratio: 0.3,
    }));
    expect(segmentize(pts, 16 * MIN).map((s) => s.length)).toEqual([3, 2]);
  });

  it('7 d plots one point per local day at noon from the daily trend, skipping days with nothing priced', () => {
    const trend = [
      { day: '2026-09-19', savedM: 10, whpM: 40, paidM: 30 },
      { day: '2026-09-20', savedM: 10, whpM: 40, paidM: 30 },
      { day: '2026-09-24', savedM: 0, whpM: 0, paidM: 0 },
      { day: '2026-09-25', savedM: 20, whpM: 40, paidM: 20 },
      { day: '2026-09-26', savedM: 1, whpM: 4, paidM: 3 },
    ];
    const s = buildSeries('7d', snap({ trend }), 'America/Chicago');
    // Chicago "today" at END (1:00 AM CDT) is Sep 26 → the window is Sep 20 … now (P1-K03: it ends at now, like 24 h).
    expect(s.points.map((p) => p.ratio)).toEqual([0.25, 0.5, 0.25]);
    expect(new Date(s.points[0].t).toISOString()).toBe('2026-09-20T17:00:00.000Z');
    // Today's point is "today so far": at noon, or now when noon is still ahead.
    expect(s.points[2].t).toBe(END);
    expect(s.domain).toEqual([Date.parse('2026-09-20T05:00:00.000Z'), END]);
    expect(s.segments.map((x) => x.length)).toEqual([1, 2]);
  });

  it("7 d runs to now: the 24 h series' latest sample joins the line after today's point (P1-K03)", () => {
    // 6:00 PM in Chicago: today's noon point, then the live ratio at 5:55 PM, which ends the line at the right edge.
    const end = Date.parse('2026-09-26T23:00:00.000Z');
    const trend = [
      { day: '2026-09-25', savedM: 1, whpM: 4, paidM: 3 },
      { day: '2026-09-26', savedM: 3, whpM: 10, paidM: 7 },
    ];
    const ratioSeries = [
      { t: iso(end - 10 * MIN), ratio: 0.31 },
      { t: iso(end - 5 * MIN), ratio: 0.33 },
      { t: iso(end + 5 * MIN), ratio: 0.9 }, // after the window: ignored
    ];
    const s = buildSeries('7d', snap({ trend, ratioSeries, windowEnd: iso(end) }), 'America/Chicago');
    expect(s.points.map((p) => p.ratio)).toEqual([0.25, 0.3, 0.33]);
    expect(s.points[1].t).toBe(Date.parse('2026-09-26T17:00:00.000Z'));
    expect(s.points[2]).toEqual({ t: end - 5 * MIN, ratio: 0.33, live: true });
    expect(s.domain[1]).toBe(end);
    expect(s.segments).toHaveLength(1);
    // A live sample within half an hour of today's point adds nothing, and none at all leaves the daily points.
    const early = buildSeries('7d', snap({ trend, ratioSeries: [{ t: iso(END - 20 * MIN), ratio: 0.4 }] }), 'America/Chicago');
    expect(early.points.some((p) => p.live)).toBe(false);
    expect(buildSeries('7d', snap({ trend }), 'America/Chicago').points.some((p) => p.live)).toBe(false);
  });

  it('zooms the y range to the data on a 10-point grid', () => {
    expect(niceRatioDomain([0.28, 0.33])).toEqual([0.2, 0.4]);
    expect(niceRatioDomain([0.5, 0.52])).toEqual([0.4, 0.6]);
    expect(niceRatioDomain([0.01, 0.99])).toEqual([0, 1]);
    expect(niceRatioDomain([0.95])).toEqual([0.8, 1]);
    expect(niceRatioDomain([])).toEqual([0, 1]);
  });

  it('parses ?timeline=', () => {
    expect(parseRange('7d')).toBe('7d');
    expect(parseRange('1y')).toBe('24h');
    expect(parseRange(null)).toBe('24h');
  });
});

describe('ticks', () => {
  it('knows the zone offset', () => {
    expect(tzOffsetMs(END, 'America/Chicago')).toBe(-5 * HOUR);
    expect(tzOffsetMs(END, 'UTC')).toBe(0);
    expect(tzOffsetMs(END, 'Not/AZone')).toBe(0);
  });
  it('aligns 24 h ticks to local wall-clock boundaries', () => {
    const ticks = timeTicks([END - DAY, END], 'America/Chicago', 8);
    expect(ticks.length).toBeLessThanOrEqual(8);
    const hours = ticks.map((t) =>
      new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        hourCycle: 'h23',
        timeZone: 'America/Chicago',
      }).format(t),
    );
    // 24 h / 8 ticks → every 3 hours, on the local hour (12 AM, 3 AM, 6 AM …).
    expect(hours.every((h) => Number(h) % 3 === 0)).toBe(true);
    expect(ticks.every((t) => new Date(t).getUTCMinutes() === 0)).toBe(true);
    expect(timeTicks([END - DAY, END], 'America/Chicago', 6).length).toBeLessThanOrEqual(6);
    expect(timeTicks([END, END], 'UTC', 5)).toEqual([]);
  });
  it('7 d ticks sit at local noon', () => {
    const ticks = dayTicks([Date.parse('2026-09-20T05:00:00.000Z'), Date.parse('2026-09-27T05:00:00.000Z')], 'America/Chicago');
    expect(ticks).toHaveLength(7);
    expect(new Date(ticks[0]).toISOString()).toBe('2026-09-20T17:00:00.000Z');
  });
  it('7 d thins its day labels to fit, counted back from the newest day (P1-K03)', () => {
    const week: [number, number] = [Date.parse('2026-09-20T05:00:00.000Z'), Date.parse('2026-09-27T05:00:00.000Z')];
    const day = (ms: number) => new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'America/Chicago' }).format(ms);
    expect(dayTicks(week, 'America/Chicago', 11).map(day)).toEqual(['20', '21', '22', '23', '24', '25', '26']);
    // A 390 px phone: 264 px of plot ÷ 64 px → 4 labels, every 2nd day, ending on the 26th.
    expect(dayTicks(week, 'America/Chicago', 4).map(day)).toEqual(['20', '22', '24', '26']);
    expect(dayTicks(week, 'America/Chicago', 3).map(day)).toEqual(['20', '23', '26']);
    expect(dayTicks(week, 'America/Chicago', 1).map(day)).toEqual(['26']);
  });
  it('fans crowded markers out sideways, in time order, centred on their run and inside the plot (P1-K03)', () => {
    // Apart already: untouched.
    expect(spreadMarkers([100, 140, 200], 14, [44, 400])).toEqual([100, 140, 200]);
    // Four commits of the last hour on a 7 d phone chart sit within 3 px: one run, 14 px apart, centred on their mean.
    const four = spreadMarkers([329, 329.5, 330, 331], 14, [44, 341]);
    expect(four[1] - four[0]).toBeCloseTo(14);
    expect(four[3] - four[2]).toBeCloseTo(14);
    // …and kept inside the plot: the run's mean is 329.9, so it would end at 350.9; it ends at the right edge.
    expect(four[3]).toBeCloseTo(341);
    expect(four[0]).toBeCloseTo(299);
    // Order follows time even when the input is not sorted; a run that grows into its neighbour merges with it.
    const mixed = spreadMarkers([210, 100, 200, 205], 14, [0, 1000]);
    expect(mixed[1]).toBe(100);
    expect(mixed[2]).toBeLessThan(mixed[3]);
    expect(mixed[3]).toBeLessThan(mixed[0]);
    const sorted = [...mixed].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(14 - 1e-9);
    expect((mixed[2] + mixed[3] + mixed[0]) / 3).toBeCloseTo(205);
    const chain = spreadMarkers([100, 110, 124, 130], 14, [0, 1000]);
    for (let i = 1; i < chain.length; i++) expect(chain[i] - chain[i - 1]).toBeCloseTo(14);
    // More markers than the plot can hold at the gap: evenly spread across it, still in order.
    const packed = spreadMarkers([50, 50, 50, 50, 50], 14, [0, 40]);
    expect(packed).toEqual([0, 10, 20, 30, 40]);
    expect(spreadMarkers([], 14, [0, 10])).toEqual([]);
  });
});

describe('markers', () => {
  const commits = [commit('c3', END - 10 * MIN), commit('c2', END - 30 * MIN), commit('c1', END - 3 * DAY)];
  const blame = {
    ...baseIncident(),
    commit: {
      hash: 'c3',
      message: '',
      author: 's.koelpin',
      committedAt: iso(END - 10 * MIN),
      groupId: 'default',
      match: 'files' as const,
    },
  };
  it('keeps commits in the domain, oldest first; the newest is the callout; blamed commits are marked', () => {
    const m = buildMarkers(commits, [blame], [END - DAY, END]);
    expect(m.map((x) => x.commit.hash)).toEqual(['c2', 'c3']);
    expect(m.map((x) => x.newest)).toEqual([false, true]);
    expect(m.map((x) => x.cause)).toEqual([false, true]);
  });
  it('a closed alert blames nothing', () => {
    const m = buildMarkers(commits, [{ ...blame, closedAt: iso(END) }], [END - DAY, END]);
    expect(m.some((x) => x.cause)).toBe(false);
  });
  it('uses the deploy time when there is one', () => {
    const m = buildMarkers([commit('d', END - 2 * DAY, { deployedAt: iso(END - HOUR) })], [], [END - DAY, END]);
    expect(m[0].t).toBe(END - HOUR);
  });
});

function baseIncident(): Incident {
  return {
    id: 'inc_1',
    type: 'regression',
    severity: 'high',
    objectKey: 'route:default:mrd_payments_api',
    label: 'Payments API sampling',
    openedAt: iso(END - 8 * MIN),
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    notes: [],
    deliveries: [],
  };
}

describe('what moved', () => {
  const at = END - 10 * MIN; // 20 of 30 sparkline minutes before the commit
  const breakTrim = commit('c9', at, {
    message: 'demo: break the trim on mrd_pay_sample',
    files: ['groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml'],
  });
  const drop = [...Array(20).fill(0.75), ...Array(10).fill(0.5)];
  const flat = Array(30).fill(0.4);

  it("an alert naming the commit wins, with the alert's own figures", () => {
    const s = snap({
      flows: [flow('mrd_payments_api', 'mrd_pay_sample', drop)],
      incidents: [{ ...baseIncident(), commit: { ...breakTrim, match: 'files' } }],
    });
    const moved = whatMoved(breakTrim, s);
    expect(moved).toEqual([
      {
        key: 'route:default:mrd_payments_api',
        label: 'Payments API sampling',
        before: 0.75,
        after: 0.5,
        delta: -0.25,
        source: 'alert',
        touched: true,
        // P2-W07: priced at the alert's own impact, a loss.
        perDayM: -s.incidents[0].impactPerDayM,
      },
    ]);
    // D47: a closed alert keeps its drop; one closed before D47 (its `after` the reading at close) kept none,
    // so the flow's own sparkline speaks for it instead of a made-up rise.
    const closed = snap({ ...s, incidents: [{ ...s.incidents[0], closedAt: iso(END), recoveredTo: 0.74 }] });
    expect(whatMoved(breakTrim, closed)[0]).toMatchObject({ before: 0.75, after: 0.5, source: 'alert' });
    const legacy = snap({ ...s, incidents: [{ ...s.incidents[0], closedAt: iso(END), after: 0.74 }] });
    expect(whatMoved(breakTrim, legacy)[0]).toMatchObject({ key: 'route:default:mrd_payments_api', source: 'flow' });
    expect(whatMoved(breakTrim, legacy)[0].after).toBeLessThan(0.75);
  });

  it('a touched flow that shifted across the commit is listed with before → after from its sparkline', () => {
    const s = snap({
      flows: [flow('mrd_payments_api', 'mrd_pay_sample', drop), flow('mrd_k8s_prod', 'mrd_k8s_noise', flat)],
    });
    const moved = whatMoved(breakTrim, s);
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      key: 'route:default:mrd_payments_api',
      label: 'Payments API sampling',
      source: 'flow',
      touched: true,
    });
    expect(moved[0].before).toBeCloseTo(0.75, 6);
    expect(moved[0].after).toBeCloseTo(0.5, 6);
  });

  it('an untouched flow needs a bigger shift to count', () => {
    const small = [...Array(20).fill(0.4), ...Array(10).fill(0.34)];
    const big = [...Array(20).fill(0.4), ...Array(10).fill(0.2)];
    const s = snap({ flows: [flow('a', 'pa', small), flow('b', 'pb', big)] });
    expect(whatMoved(breakTrim, s).map((m) => m.key)).toEqual(['route:default:b']);
  });

  it('a flow the commit created (a pack pipeline) is "now N %"', () => {
    const pack = commit('p1', END - 16 * MIN, {
      message: 'demo: apply the pack on mrd_windows_workstations',
      files: ['groups/default/local/cribl/pipelines/route.yml'],
    });
    const s = snap({
      flows: [flow('mrd_windows_workstations', 'mrd_win_xml_pack', Array(15).fill(0.33))],
    });
    const moved = whatMoved(pack, s);
    expect(moved).toHaveLength(1);
    expect(moved[0].before).toBeUndefined();
    expect(moved[0].after).toBeCloseTo(0.33, 6);
    expect(moved[0].label).toBe('Windows XML pack');
  });

  it('commits older than the sparkline window move nothing (unless an alert names them)', () => {
    const old = commit('o', END - 3 * HOUR, {
      message: 'demo: break the trim on mrd_pay_sample',
      files: breakTrim.files,
    });
    expect(whatMoved(old, snap({ flows: [flow('mrd_payments_api', 'mrd_pay_sample', drop)] }))).toEqual([]);
  });

  it('caps the list and orders alerts first, then the biggest move', () => {
    const flows = Array.from({ length: 8 }, (_, i) =>
      flow(`f${i}`, `p${i}`, [...Array(20).fill(0.6), ...Array(10).fill(0.6 - 0.11 - i * 0.01)]),
    );
    const moved = whatMoved(breakTrim, snap({ flows }), { limit: 5 });
    expect(moved).toHaveLength(5);
    expect(moved[0].key).toBe('route:default:f7');
  });

  it('shortens repo paths', () => {
    expect(fileLabel('groups/default/local/cribl/pipelines/mrd_pay_sample/conf.yml')).toBe('pipelines/mrd_pay_sample/conf.yml');
    expect(fileLabel('cribl.yml')).toBe('cribl.yml');
  });
});

describe('alerts rail ordering', () => {
  it('open: most severe first, then newest; recent: most recently closed first', () => {
    const a = {
      ...baseIncident(),
      id: 'a',
      severity: 'medium' as const,
      openedAt: iso(END - MIN),
    };
    const b = {
      ...baseIncident(),
      id: 'b',
      severity: 'high' as const,
      openedAt: iso(END - 20 * MIN),
    };
    const c = { ...baseIncident(), id: 'c', closedAt: iso(END - 30 * MIN) };
    const d = { ...baseIncident(), id: 'd', closedAt: iso(END - 5 * MIN) };
    const { open, recent } = partitionIncidents([a, b, c, d]);
    expect(open.map((i) => i.id)).toEqual(['b', 'a']);
    expect(recent.map((i) => i.id)).toEqual(['d', 'c']);
  });
});

describe('sparkline path', () => {
  const g = { width: 100, height: 20, domain: [0, 1] as const, inset: 2 };
  it('is empty with no finite values', () => {
    expect(sparkPath([], g)).toBe('');
    expect(sparkPath([Number.NaN], g)).toBe('');
  });
  it('draws one value as a flat line across the box', () => {
    expect(sparkPath([0.5], g)).toBe('M2,10L98,10');
  });
  it('maps the domain to the inset box and clamps outliers', () => {
    const d = sparkPath([0, 1, 2], g);
    expect(d.startsWith('M2,18')).toBe(true);
    expect(d).toContain('98,2');
  });
  it('summarizes its ends for the accessible label', () => {
    expect(sparkEnds([Number.NaN, 0.2, 0.5])).toEqual({
      first: 0.2,
      last: 0.5,
    });
    expect(sparkEnds([])).toBeNull();
  });
});
