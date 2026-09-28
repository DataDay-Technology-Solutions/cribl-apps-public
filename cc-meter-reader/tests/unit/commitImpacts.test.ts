// tests/unit/commitImpacts.test.ts — every commit priced (P2-W07): by its alert, by the flows that moved, by the
// workspace's 5-minute ratio, or by the same-kind days either side; flat under a point; unpriced when nothing
// measures it on its own. And the tour fixture's sampling commit reads −$1,250 a day.

import { describe, expect, it } from 'vitest';
import tour from '../../demo/sample/tour.json' with { type: 'json' };
import { commitImpacts, isAttributedImpact, largestImpact, movedAfter, priceCommit, workspaceWhpPerDayM, type CommitImpact } from '../../core/commitImpacts.ts';
import type { Commit, FlowFigures, Incident, Snapshot } from '../../core/types.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const END = Date.parse('2026-09-26T06:00:00.000Z'); // Sat 1:00 AM in Chicago
const TZ = 'America/Chicago';
const iso = (ms: number) => new Date(ms).toISOString();
const DOLLAR = 100_000;

function commit(hash: string, atMs: number, over: Partial<Commit> = {}): Commit {
  return { hash, message: `commit ${hash}`, author: 'Steve Koelpin', committedAt: iso(atMs), groupId: 'default', files: [], source: 'demo', ...over };
}

function flow(id: string, sparkline: number[], whpPerDayM: number, over: Partial<FlowFigures> = {}): FlowFigures {
  return {
    key: `default|${id}|${id}|${id}_pipe|siem`,
    groupId: 'default',
    inputId: id,
    routeId: id,
    pipelineId: `${id}_pipe`,
    outputId: 'siem',
    inB: 1,
    outB: 1,
    whpM: 1,
    paidM: 1,
    savedM: 1,
    ratio: sparkline.at(-1) ?? 0,
    ratePerHourM: 1,
    savedPerDayM: 1,
    whpPerDayM,
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
    collectingSince: iso(END - 30 * DAY),
    metricsSource: 'metrics-query',
    attributionSummary: 'route',
    ...over,
  };
}

function regression(c: Commit, over: Partial<Incident> = {}): Incident {
  return {
    id: 'inc1',
    type: 'regression',
    severity: 'high',
    objectKey: 'route:default:pay',
    label: 'Payments API sampling',
    openedAt: iso(END - 5 * MIN),
    before: 0.75,
    after: 0.5,
    impactPerDayM: 1_250 * DOLLAR,
    notes: [],
    deliveries: [],
    commit: { ...c, match: 'files' },
    ...over,
  };
}

/** 5-minute buckets from `fromMs` to END at `ratio(t)`. */
function series(fromMs: number, ratio: (t: number) => number): Snapshot['ratioSeries'] {
  const out: Snapshot['ratioSeries'] = [];
  for (let t = fromMs; t + 5 * MIN <= END; t += 5 * MIN) out.push({ t: iso(t), ratio: ratio(t) });
  return out;
}

describe('commitImpacts on the tour fixture (P2-W07 acceptance)', () => {
  it('prices the sampling commit at −$1,250 a day, by the alert that names it', () => {
    const snapshot = (tour as unknown as { script: { payload: Snapshot }[] }).script[0].payload;
    const impacts = commitImpacts(snapshot, { timeZone: (tour as unknown as { timezone: string }).timezone });
    const sampling = impacts.find((i) => i.commit.hash.startsWith('22d0a5e'));
    expect(sampling).toMatchObject({ status: 'priced', basis: 'alert', perDayM: -124_999_959 });
    expect(sampling?.perYearM).toBe(-124_999_959 * 365);
    // Every commit of the last 7 days is listed once, the priced ones first.
    const end = Date.parse(snapshot.windowEnd);
    const inWeek = snapshot.timeline.filter((c) => Date.parse(c.deployedAt ?? c.committedAt) >= end - 7 * DAY);
    expect(impacts.map((i) => i.commit.hash).sort()).toEqual(inWeek.map((c) => c.hash).sort());
    expect(impacts[0].commit.hash.startsWith('22d0a5e')).toBe(true);
  });

  it('never prices a weekend: Friday → Saturday and Sunday → Tuesday are not a commit’s doing', () => {
    const snapshot = (tour as unknown as { script: { payload: Snapshot }[] }).script[0].payload;
    const impacts = commitImpacts(snapshot, { timeZone: TZ });
    // "Drop Kubernetes debug noise" shipped Friday; "Raise Splunk HEC batch size" Monday after a weekend.
    for (const hash of ['4d1a70c', 'ab935f7']) expect(impacts.find((i) => i.commit.hash.startsWith(hash))?.status).toBe('unpriced');
  });
});

describe('priceCommit', () => {
  const at = END - 10 * MIN; // 20 of 30 sparkline minutes before
  const c = commit('c1', at, { files: ['groups/default/local/cribl/pipelines/win_pipe/conf.yml'] });

  it('by the alert that names it: the alert’s own impact, a loss for a regression, a gain for good news', () => {
    const s = snap({ flows: [flow('pay', Array(30).fill(0.5), 5_000 * DOLLAR)], incidents: [regression(c)], timeline: [c] });
    expect(priceCommit(c, s)).toMatchObject({ status: 'priced', basis: 'alert', perDayM: -1_250 * DOLLAR });
    const good = snap({ ...s, incidents: [regression(c, { type: 'goodnews', before: 0.3, after: 0.6, impactPerDayM: 900 * DOLLAR })] });
    expect(priceCommit(c, good).perDayM).toBe(900 * DOLLAR);
  });

  it('by the flows that moved: the ratio shift × the flow’s would-have-paid per day, summed', () => {
    const rise = [...Array(20).fill(0.1), ...Array(10).fill(0.43)];
    const s = snap({ flows: [flow('win', rise, 4_000 * DOLLAR), flow('calm', Array(30).fill(0.6), 9_000 * DOLLAR)], timeline: [c] });
    const p = priceCommit(c, s);
    expect(p).toMatchObject({ status: 'priced', basis: 'flows' });
    expect(p.perDayM).toBe(Math.round(0.33 * 4_000 * DOLLAR));
    expect(p.moved).toHaveLength(1);
  });

  it('a flow that moved after the NEXT commit is that commit’s, not this one’s', () => {
    const later = commit('c2', END - 4 * MIN);
    // Flat through c1 (at −10 min), then a drop at c2 (−4 min).
    const spark = [...Array(26).fill(0.7), ...Array(4).fill(0.4)];
    const s = snap({ flows: [flow('pay', spark, 3_000 * DOLLAR)], timeline: [later, c] });
    expect(movedAfter(c, s)).toEqual([]);
    expect(priceCommit(later, s).perDayM).toBe(Math.round(-0.3 * 3_000 * DOLLAR));
  });

  it('a flow into an unpriced destination moves but has no dollars: counted, and the commit stays unpriced', () => {
    const rise = [...Array(20).fill(0.1), ...Array(10).fill(0.43)];
    const s = snap({ flows: [flow('win', rise, 0, { state: 'unpriced' })], timeline: [c] });
    const p = priceCommit(c, s);
    expect(p.moved).toHaveLength(1);
    expect(p.moved[0].perDayM).toBeUndefined();
    expect(p.status).toBe('unpriced');
  });

  it('inside the per-minute history with nothing moving: flat ("no measurable change"), never $0 as a price', () => {
    const s = snap({ flows: [flow('calm', Array(30).fill(0.6), 9_000 * DOLLAR)], timeline: [c] });
    expect(priceCommit(c, s)).toMatchObject({ status: 'flat', basis: 'flows', perDayM: 0 });
  });

  it('older than the flows’ history: the workspace ratio either side, whole buckets, stopping at a neighbour', () => {
    const t = END - 3 * HOUR;
    const old = commit('w1', t);
    const neighbour = commit('w2', t + 20 * MIN);
    const flows = [flow('a', Array(30).fill(0.5), 6_000 * DOLLAR), flow('b', Array(30).fill(0.5), 4_000 * DOLLAR)];
    expect(workspaceWhpPerDayM(flows)).toBe(10_000 * DOLLAR);
    // 0.40 before, 0.45 after, and 0.90 after the neighbour — which must not leak into this commit's price.
    const ratioSeries = series(END - 6 * HOUR, (x) => (x < t ? 0.4 : x < t + 20 * MIN ? 0.45 : 0.9));
    const p = priceCommit(old, snap({ flows, ratioSeries, timeline: [neighbour, old] }));
    expect(p).toMatchObject({ status: 'priced', basis: 'workspace' });
    expect(p.ratioDelta).toBeCloseTo(0.05, 6);
    expect(p.perDayM).toBe(Math.round(0.05 * 10_000 * DOLLAR));
    // Under a point: measured, flat.
    const flat = series(END - 6 * HOUR, (x) => (x < t ? 0.4 : 0.404));
    expect(priceCommit(old, snap({ flows, ratioSeries: flat, timeline: [old] }))).toMatchObject({ status: 'flat', basis: 'workspace' });
  });

  it('older than 24 h: the first whole day after vs the nearest earlier day of the same kind, with no other commit between', () => {
    // Tue Sep 22 3 PM Chicago: after = Wed Sep 23, before = Mon Sep 21 (both weekdays).
    const tue = Date.parse('2026-09-22T20:00:00.000Z');
    const c3 = commit('d1', tue);
    const flows = [flow('a', Array(30).fill(0.5), 10_000 * DOLLAR)];
    const trend = [
      { day: '2026-09-21', savedM: 40, whpM: 100, paidM: 60 },
      { day: '2026-09-22', savedM: 45, whpM: 100, paidM: 55 },
      { day: '2026-09-23', savedM: 52, whpM: 100, paidM: 48 },
    ];
    const p = priceCommit(c3, snap({ flows, trend, timeline: [c3] }), { timeZone: TZ });
    expect(p).toMatchObject({ status: 'priced', basis: 'daily' });
    expect(p.perDayM).toBe(Math.round(0.12 * 10_000 * DOLLAR));
    // Another commit between the two days: not this one's alone.
    const other = commit('d2', Date.parse('2026-09-23T15:00:00.000Z'));
    expect(priceCommit(c3, snap({ flows, trend, timeline: [other, c3] }), { timeZone: TZ }).status).toBe('unpriced');
    // No zone, no day keys: unpriced rather than guessed.
    expect(priceCommit(c3, snap({ flows, trend, timeline: [c3] })).status).toBe('unpriced');
  });
});

describe('commitImpacts / largestImpact', () => {
  it('lists the last 7 days: priced by |$ / day|, then flat, then unpriced; the largest in a window annotates the chart', () => {
    const a = commit('a1', END - 10 * MIN, { files: ['groups/default/local/cribl/pipelines/win_pipe/conf.yml'] });
    const b = commit('b1', END - 25 * MIN);
    const old = commit('o1', END - 8 * DAY);
    const rise = [...Array(20).fill(0.1), ...Array(10).fill(0.2)];
    const drop = [...Array(5).fill(0.8), ...Array(25).fill(0.3)];
    const s = snap({
      flows: [flow('win', rise, 1_000 * DOLLAR), flow('pay', drop, 2_000 * DOLLAR)],
      timeline: [a, b, old],
    });
    const list = commitImpacts(s, { timeZone: TZ });
    expect(list.map((i) => i.commit.hash)).toEqual(['b1', 'a1']);
    expect(list[0].perDayM).toBe(Math.round(-0.5 * 2_000 * DOLLAR));
    expect(largestImpact(list, [END - HOUR, END])?.commit.hash).toBe('b1');
    expect(largestImpact(list, [END - 15 * MIN, END])?.commit.hash).toBe('a1');
    expect(commitImpacts(null)).toEqual([]);
  });

  it('never headlines a workspace or daily price: those give one commit the whole workspace shift (rules round, usefulness)', () => {
    const at = (hash: string, perDayM: number, basis: CommitImpact['basis'], t = END - HOUR): CommitImpact => ({
      commit: commit(hash, t),
      t,
      status: 'priced',
      basis,
      perDayM,
      perYearM: perDayM * 365,
      moved: [],
    });
    // The sample's case: a destination batch-size commit priced from the next day's workspace ratio, larger than the
    // one flow-attributed change. The headline is the attributed one, and nothing when only shifts are priced.
    const batch = at('hec0001', -2_208 * DOLLAR, 'daily');
    const near = at('wks0001', -3_000 * DOLLAR, 'workspace');
    const flows = at('flw0001', -1_219 * DOLLAR, 'flows');
    const alert = at('alr0001', -900 * DOLLAR, 'alert');
    expect(largestImpact([batch, near, flows, alert], [END - DAY, END])?.commit.hash).toBe('flw0001');
    expect(largestImpact([batch, near], [END - DAY, END])).toBeUndefined();
    expect(isAttributedImpact(alert)).toBe(true);
    expect(isAttributedImpact(batch)).toBe(false);
    expect(isAttributedImpact({ ...flows, status: 'flat' })).toBe(false);
  });
});

// Rules round 2 (usefulness): the tour's Changes list read −$1,250 (the break, from its alert) and +$1,013 (its revert,
// from the flows that moved), "Net −$237/day" for a drop that recovered to where it was, and the Receipt's callout
// still headlined −$1,250 / day at the tour's last beat. A regression that recovered prices the commit it recovered
// after on the alert's own basis, and neither of the pair is ever the headline.
describe('a break and the revert it recovered after', () => {
  const PAY_FILE = 'groups/default/local/cribl/pipelines/pay_sample/conf.yml';
  const brk = commit('b1eak00', END - 20 * MIN, { message: 'Keep full payload on payments API errors', files: [PAY_FILE] });
  const rev = commit('5e7e5e0', END - 12 * MIN, { message: 'Revert "Keep full payload on payments API errors"', files: [PAY_FILE] });
  const other = commit('0f0f0f0', END - 14 * MIN, { message: 'Tune the VPC summaries', files: ['groups/default/local/cribl/pipelines/vpc_agg/conf.yml'] });
  const routeTable = commit('7ab1e00', END - 13 * MIN, { message: 'Rename a route', files: ['groups/default/local/cribl/pipelines/route.yml'] });
  const recovered = regression(brk, { openedAt: iso(END - 17 * MIN), closedAt: iso(END - 10 * MIN), recoveredTo: 0.75 });
  const s = snap({ flows: [flow('pay', Array(30).fill(0.75), 5_000 * DOLLAR)], incidents: [recovered], timeline: [rev, routeTable, other, brk] });

  it('prices the revert on the alert’s basis, so the pair nets to zero, and marks each side', () => {
    const impacts = commitImpacts(s, { timeZone: TZ });
    const b = impacts.find((i) => i.commit.hash === brk.hash)!;
    const r = impacts.find((i) => i.commit.hash === rev.hash)!;
    expect(b).toMatchObject({ status: 'priced', basis: 'alert', perDayM: -1_250 * DOLLAR, recovered: true, revertedBy: rev.hash });
    expect(r).toMatchObject({ status: 'priced', basis: 'alert', perDayM: 1_250 * DOLLAR, reverts: brk.hash });
    expect(r.recovered).toBeUndefined();
    expect(r.moved[0]).toMatchObject({ source: 'alert', before: 0.5, after: 0.75, pairedWith: brk.hash });
    expect(b.perDayM + r.perDayM).toBe(0);
    // Neither an unrelated commit in the window nor a route-table edit is the recovering commit.
    for (const h of [other.hash, routeTable.hash]) expect(impacts.find((i) => i.commit.hash === h)?.reverts).toBeUndefined();
    // Neither of the pair headlines the Receipt's trend or the Ledger's timeline.
    expect(largestImpact(impacts, [END - DAY, END])).toBeUndefined();
  });

  it('a revert that only quotes the message (no shared file) still pairs', () => {
    const quoted = commit('9a9a4c6', END - 12 * MIN, { message: 'Revert "Keep full payload on payments API errors"', files: ['groups/default/local/cribl/pipelines/pay_sample_v2/conf.yml'] });
    const impacts = commitImpacts({ ...s, timeline: [quoted, brk] }, { timeZone: TZ });
    expect(impacts.find((i) => i.commit.hash === quoted.hash)).toMatchObject({ perDayM: 1_250 * DOLLAR, reverts: brk.hash });
  });

  it('a regression that recovered by itself leaves the break priced but never headlined, with no revert named', () => {
    const impacts = commitImpacts({ ...s, timeline: [other, brk] }, { timeZone: TZ });
    const b = impacts.find((i) => i.commit.hash === brk.hash)!;
    expect(b).toMatchObject({ perDayM: -1_250 * DOLLAR, recovered: true });
    expect(b.revertedBy).toBeUndefined();
    expect(largestImpact(impacts, [END - DAY, END])).toBeUndefined();
  });

  it('an open regression, or one a member accepted, still headlines its commit', () => {
    for (const inc of [regression(brk, { openedAt: iso(END - 17 * MIN) }), regression(brk, { openedAt: iso(END - 17 * MIN), closedAt: iso(END - 10 * MIN), closedReason: 'accepted' })]) {
      const impacts = commitImpacts({ ...s, incidents: [inc] }, { timeZone: TZ });
      expect(impacts.find((i) => i.commit.hash === rev.hash)?.reverts).toBeUndefined();
      expect(largestImpact(impacts, [END - DAY, END])?.commit.hash).toBe(brk.hash);
    }
  });

  it('the tour’s last beat: the Changes net reads $0 and nothing headlines', () => {
    const t = tour as unknown as { script: { payload: Snapshot }[]; timezone: string };
    const last = t.script[7].payload;
    const impacts = commitImpacts(last, { timeZone: t.timezone });
    const attributed = impacts.filter(isAttributedImpact);
    expect(attributed.map((i) => i.commit.hash.slice(0, 7)).sort()).toEqual(['22d0a5e', '9a9a4c6']);
    expect(attributed.reduce((n, i) => n + i.perDayM, 0)).toBe(0);
    const end = Date.parse(last.windowEnd);
    expect(largestImpact(impacts, [end - 30 * DAY, end])).toBeUndefined();
  });
});
