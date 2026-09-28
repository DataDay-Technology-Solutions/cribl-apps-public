// P1-F07 — a deliberate change stops alerting. Before: a regression on a flow worth > $5/day stayed open forever
// and re-notified every cooldown; the release had no accept, mute or exclude. Now a member can:
//   accept  → the incident closes ('accepted', by whom), the object's baseline re-seats at the level it holds, and
//             the next sweep's detector opens nothing there — while a NEW drop from that level still alerts;
//   mute    → settings.mutes: the incident closes ('muted') and nothing opens until the mute ends;
//   exclude → settings.excludedObjectKeys: an open incident on an excluded object closes ('excluded') — before, the
//             detector skipped the object and its open incident re-notified forever.
// runIncidentAction does it under the sweep lock over App KV (the same documents the sweep reads).

import { describe, expect, it } from 'vitest';
import { detect, emptyBaselines } from '../../core/detector.ts';
import {
  ACTION_LOCK_TRIES,
  acceptIntoBaselines,
  closeByMember,
  closeInSnapshot,
  currentReading,
  incidentActions,
  incidentsDocKey,
  runIncidentAction,
} from '../../core/incidents.ts';
import { reseedBaseline, updateBaseline } from '../../core/baseline.ts';
import { defaultSettings, mergeSettings } from '../../core/settings.ts';
import { canonicalPayload, incidentPlainText, slackPayload } from '../../core/payloads.ts';
import { renderAlert } from '../../core/delivery.ts';
import { createKvDocs, createMemoryKvStore } from '../../core/kv.ts';
import { identityCodec } from '../../core/codec.ts';
import type { BaselinesDoc, FlowFigures, Incident, Settings, Snapshot } from '../../core/types.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 28, 14, 0, 0);
const KEY = 'pipe:default:mrd_pay_sample';
const WHP_PER_DAY = 5_000 * 100_000; // $5,000 a day would-have-paid: any 15-point drop is worth far more than $5/day
const iso = (ms: number): string => new Date(ms).toISOString();

function settings(over: Partial<Settings> = {}): Settings {
  const s = defaultSettings(iso(T0), 'UTC');
  s.demo = { enabled: false, replayMode: false, profile: false };
  return { ...s, ...over };
}

/** A baseline learned at `level` over a day, warm. */
function learned(level: number): BaselinesDoc {
  let b = undefined as ReturnType<typeof updateBaseline> | undefined;
  for (let i = 0; i < 60; i++) b = updateBaseline(b, level + (i % 2 ? 0.005 : -0.005), 0.0014, 10);
  return { ...emptyBaselines(iso(T0)), byObject: { [KEY]: b! } };
}

interface Run {
  opened: Incident[];
  closed: Incident[];
  open: Incident[];
  baselines: BaselinesDoc;
}

/** One ratio reading per minute through the detector, as the sweep feeds it. */
function run(readings: number[], start: { baselines: BaselinesDoc; open?: Incident[]; settings?: Settings; startMs?: number; muted?: Record<string, string> }): Run {
  let baselines = start.baselines;
  let open = [...(start.open ?? [])];
  const out: Run = { opened: [], closed: [], open, baselines };
  const t0 = start.startMs ?? T0;
  readings.forEach((x, i) => {
    const minuteStart = t0 + i * MIN;
    const res = detect({
      nowMs: minuteStart + MIN + 25_000,
      minuteStartMs: minuteStart,
      settings: start.settings ?? settings(),
      baselines,
      openIncidents: open,
      ratioSeries: { [KEY]: { x, whpPerDayM: WHP_PER_DAY, label: 'Payments API sampling', outputId: 'mrd_siem_apps' } },
      costSeries: {},
      budgetSeries: {},
      muted: start.muted ?? {},
      commits: [],
      evaluateBudget: false,
    });
    baselines = res.baselines;
    out.opened.push(...res.opened);
    out.closed.push(...res.closed);
    const closedIds = new Set(res.closed.map((c) => c.id));
    const byId = new Map(open.map((o) => [o.id, o]));
    for (const u of [...res.opened, ...res.updated]) if (!u.closedAt) byId.set(u.id, u);
    open = [...byId.values()].filter((o) => !closedIds.has(o.id));
  });
  out.open = open;
  out.baselines = baselines;
  return out;
}

/** The trim breaks: 76% → 30% for ten minutes. Returns the open regression and the detector's state. */
function brokenTrim(): Run {
  return run([...Array(5).fill(0.76), ...Array(10).fill(0.3)], { baselines: learned(0.76) });
}

function flow(over: Partial<FlowFigures>): FlowFigures {
  return {
    key: 'default|pay|pay_route|mrd_pay_sample|mrd_siem_apps',
    groupId: 'default',
    inputId: 'pay',
    routeId: 'pay_route',
    pipelineId: 'mrd_pay_sample',
    outputId: 'mrd_siem_apps',
    inB: 1e9,
    outB: 0.7e9,
    whpM: 225_000,
    paidM: 157_500,
    savedM: 67_500,
    ratio: 0.3,
    ratePerHourM: 157_500 * 60,
    savedPerDayM: 0,
    whpPerDayM: 0,
    paidPerDayM: 0,
    inBPerDay: 0,
    outBPerDay: 0,
    attribution: 'reconciled',
    sparkline: [],
    state: 'regression',
    ...over,
  };
}

function snapshotWith(incidents: Incident[], flows: FlowFigures[] = [flow({})]): Snapshot {
  return {
    schemaVersion: 1,
    sweepAt: iso(T0 + 20 * MIN),
    windowStart: iso(T0 + 19 * MIN),
    windowEnd: iso(T0 + 20 * MIN),
    mode: 'ui',
    headline: { todayM: 0, mtdM: 0, d30M: 0, annualizedM: 0, annualizedFromDays: 0, whpMtdM: 0, paidMtdM: 0, ratioMtd: 0, whpTodayM: 0, paidTodayM: 0, whp30dM: 0, paid30dM: 0 },
    ratePerSecM: 0,
    flows,
    destinations: [],
    topSavers: [],
    unpricedOutputIds: [],
    openIncidents: incidents.filter((i) => !i.closedAt).length,
    incidents,
    trend: [],
    ratioSeries: [],
    timeline: [],
    deliveries: [],
    calls: 0,
    collectingSince: iso(T0 - 86_400_000),
    metricsSource: 'metrics-query',
    attributionSummary: 'reconciled',
  };
}

describe('P1-F07 · accept as the new normal', () => {
  it('the broken trim opens one regression that, left alone, stays open', () => {
    const r = brokenTrim();
    expect(r.opened).toHaveLength(1);
    expect(r.opened[0]).toMatchObject({ type: 'regression', objectKey: KEY, before: expect.closeTo(0.76, 2), after: 0.3 });
    const later = run(Array(30).fill(0.3), { baselines: r.baselines, open: r.open, startMs: T0 + 15 * MIN });
    expect(later.closed).toHaveLength(0);
    expect(later.open).toHaveLength(1);
  });

  it('accepting closes it, re-seeds the baseline to the current ratio, and the next sweep opens nothing on that object', () => {
    const r = brokenTrim();
    const inc = r.open[0];
    const nowIso = iso(T0 + 16 * MIN);
    const reading = currentReading(snapshotWith([inc]), inc);
    expect(reading).toBeCloseTo(0.3, 6); // Σ saved ÷ Σ would-have-paid of the object's flows, last minute

    const closed = closeByMember(inc, 'accept', 'Steve Koelpin', nowIso);
    expect(closed).toMatchObject({ closedAt: nowIso, closedReason: 'accepted', closedBy: 'Steve Koelpin', before: inc.before, after: 0.3 });
    expect(closed.recoveredTo).toBeUndefined();

    const baselines = acceptIntoBaselines(r.baselines, closed, reading, 10, nowIso);
    expect(baselines.byObject[KEY].mean).toBeCloseTo(0.3, 6);
    expect(baselines.byObject[KEY].samples).toBeGreaterThanOrEqual(10);
    expect(baselines.rules[`regression|${KEY}`]).toBeUndefined();

    // The next sweeps: the same level, with its usual wobble, for two hours — nothing opens.
    const wobble = Array.from({ length: 120 }, (_, i) => 0.3 + (i % 3 === 0 ? 0.02 : i % 3 === 1 ? -0.02 : 0));
    const next = run(wobble, { baselines, open: [], startMs: T0 + 16 * MIN });
    expect(next.opened).toEqual([]);
  });

  it('without accepting, the same readings re-open the drop at once (the frozen baseline is still 76%)', () => {
    const r = brokenTrim();
    const next = run(Array(5).fill(0.3), { baselines: r.baselines, open: [], startMs: T0 + 16 * MIN });
    expect(next.opened).toHaveLength(1);
  });

  it('a new drop from the accepted level still alerts', () => {
    const r = brokenTrim();
    const baselines = acceptIntoBaselines(r.baselines, r.open[0], 0.3, 10, iso(T0 + 16 * MIN));
    const next = run([0.3, 0.3, 0.08, 0.08, 0.08, 0.08], { baselines, open: [], startMs: T0 + 16 * MIN });
    expect(next.opened).toHaveLength(1);
    expect(next.opened[0].before).toBeCloseTo(0.3, 2);
  });

  it('a spike is accepted at its $/hour level and keeps its once-a-day memory; a budget pace offers mute and leave-out only', () => {
    const spike: Incident = {
      id: 'inc_spike1',
      type: 'spike',
      severity: 'high',
      objectKey: 'in:default:pay',
      label: 'Payments API',
      openedAt: iso(T0),
      before: 2_000_000,
      after: 9_000_000,
      impactPerDayM: 168_000_000,
      notes: [],
      deliveries: [],
    };
    expect(currentReading(snapshotWith([spike]), spike)).toBe(157_500 * 60);
    const b = acceptIntoBaselines(emptyBaselines(iso(T0)), spike, 9_450_000, 10, iso(T0 + MIN));
    expect(b.byObject['in:default:pay'].mean).toBe(9_450_000);
    expect(b.rules['spike|in:default:pay']).toEqual({ streak: 0, recoveryStreak: 0, lastOpenedAt: spike.openedAt });
    expect(incidentActions(spike)).toEqual(['accept', 'mute', 'exclude']);
    expect(incidentActions({ type: 'budget' })).toEqual(['mute', 'exclude']);
    expect(incidentActions({ type: 'regression', closedAt: iso(T0) })).toEqual([]);
    expect(incidentActions({ type: 'goodnews' })).toEqual([]);
  });

  it('reseedBaseline keeps the learned wobble and is warm at once', () => {
    const prev = { mean: 0.76, variance: 0.0004, samples: 900, warm: [] };
    expect(reseedBaseline(0.3, 10, prev)).toEqual({ mean: 0.3, variance: 0.0004, samples: 900, warm: [] });
    expect(reseedBaseline(0.3, 10)).toEqual({ mean: 0.3, variance: 0, samples: 10, warm: [] });
  });
});

describe('P1-F07 · mute and leave out close an open alert, and keep new ones from opening', () => {
  it('an object left out of metering closes its open incident (before, it re-notified forever)', () => {
    const r = brokenTrim();
    const next = run([0.3], { baselines: r.baselines, open: r.open, settings: settings({ excludedObjectKeys: [KEY] }), startMs: T0 + 15 * MIN });
    expect(next.closed).toHaveLength(1);
    expect(next.closed[0]).toMatchObject({ closedReason: 'excluded' });
    expect(next.closed[0].closedBy).toBeUndefined();
    expect(next.open).toEqual([]);
  });

  it("a member's mute closes the open incident with their name, and nothing opens until it ends", () => {
    const r = brokenTrim();
    const until = iso(T0 + 15 * MIN + 24 * 60 * MIN);
    const muted = settings({ mutes: { [KEY]: { until, by: 'Steve Koelpin' } } });
    const next = run(Array(60).fill(0.3), { baselines: r.baselines, open: r.open, settings: muted, startMs: T0 + 15 * MIN });
    expect(next.closed).toHaveLength(1);
    expect(next.closed[0]).toMatchObject({ closedReason: 'muted', closedBy: 'Steve Koelpin' });
    expect(next.opened).toEqual([]);
    // After the mute ends the drop is still a drop (a mute is not an accept): it opens again.
    const after = run(Array(5).fill(0.3), { baselines: next.baselines, open: [], settings: muted, startMs: T0 + 15 * MIN + 24 * 60 * MIN + MIN });
    expect(after.opened).toHaveLength(1);
  });

  it("a demo mute is not a member's: an open regression on a demo-muted object stays open until it recovers", () => {
    const r = brokenTrim();
    const demoMuted = { [KEY]: iso(T0 + 60 * MIN) };
    const still = run([0.3, 0.3], { baselines: r.baselines, open: r.open, muted: demoMuted, startMs: T0 + 15 * MIN });
    expect(still.closed).toEqual([]);
    const back = run(Array(5).fill(0.76), { baselines: r.baselines, open: r.open, muted: demoMuted, startMs: T0 + 15 * MIN });
    expect(back.closed).toHaveLength(1);
    expect(back.closed[0].closedReason).toBeUndefined();
    expect(back.closed[0].recoveredTo).toBe(0.76);
  });

  it('stored mutes survive mergeSettings (the sweep merges stored settings with the defaults)', () => {
    const defaults = defaultSettings(iso(T0), 'UTC');
    const merged = mergeSettings({ ...defaults, mutes: { [KEY]: { until: iso(T0), by: 'Steve Koelpin' }, bad: { until: 3 } } }, defaults);
    expect(merged.mutes).toEqual({ [KEY]: { until: iso(T0), by: 'Steve Koelpin' } });
    expect(mergeSettings(defaults, defaults).mutes).toBeUndefined();
  });
});

describe('P1-F07 · what the bell, Slack and ServiceNow say about a member close', () => {
  const r = brokenTrim();
  const accepted = closeByMember(r.open[0], 'accept', 'Steve Koelpin', iso(T0 + 16 * MIN));

  it('Slack: "Accepted as the new normal", by whom, in the neutral glyph, the loss in the present tense', () => {
    const c = canonicalPayload('incident.closed', { incident: accepted, workspace: 'main', linkBase: 'https://x.cribl.cloud/apps/a/meter-reader' });
    expect(c.incident).toMatchObject({ closedReason: 'accepted', closedBy: 'Steve Koelpin' });
    const slack = slackPayload(c, { tz: 'UTC' });
    const header = slack.blocks[0] as { text: { text: string } };
    expect(header.text.text).toBe(':large_blue_circle: Accepted as the new normal: Savings dropped: Payments API sampling');
    const context = JSON.stringify(slack.blocks[2]);
    expect(context).toContain('by Steve Koelpin');
    const fields = JSON.stringify(slack.blocks[1]);
    expect(fields).toContain('Lost per day');
    expect(fields).not.toContain('Was losing');
    expect(fields).not.toContain('Recovered to');
    expect(incidentPlainText(c.incident!)).toContain('Accepted as the new normal by Steve Koelpin');
  });

  it('the bell title carries the same prefix', () => {
    const alert = renderAlert(canonicalPayload('incident.closed', { incident: accepted, workspace: 'main', linkBase: '' }));
    expect(alert.title).toBe('Accepted as the new normal: Savings dropped: Payments API sampling');
    const muted = renderAlert(canonicalPayload('incident.closed', { incident: closeByMember(r.open[0], 'mute', '', iso(T0)), workspace: 'main', linkBase: '' }));
    expect(muted.title).toBe('Muted: Savings dropped: Payments API sampling');
  });
});

describe('P1-F07 · runIncidentAction over App KV, under the sweep lock', () => {
  const clock = { now: () => T0 + 16 * MIN };
  function docsWith(): ReturnType<typeof createKvDocs> {
    return createKvDocs({ kv: createMemoryKvStore(), codec: identityCodec, clock });
  }

  it('accept: the doc of the day it opened holds the closed copy, baselines re-seat, the snapshot reads it at once, the lock is released', async () => {
    const docs = docsWith();
    const r = brokenTrim();
    const inc = { ...r.open[0], deliveries: [{ endpointId: 'bell', status: 200, at: iso(T0 + 12 * MIN) }], lastNotifiedAt: iso(T0 + 12 * MIN) };
    const key = incidentsDocKey(Date.parse(inc.openedAt));
    const other: Incident = { ...inc, id: 'inc_other', objectKey: 'route:default:other' };
    await docs.putIncidents(key, { schemaVersion: 1, items: [inc, other] });
    await docs.putBaselines(r.baselines);
    await docs.putSnapshot(snapshotWith([inc, other]));

    // The caller's copy is stale (no deliveries): the doc's copy wins.
    const res = await runIncidentAction(docs, { action: 'accept', incident: r.open[0], by: 'Steve Koelpin', owner: 'action:t1', nowMs: clock.now(), reading: 0.3, warmupSamples: 10 });
    expect(res.ok).toBe(true);

    const stored = (await docs.getIncidents(key))!.items;
    const mine = stored.find((i) => i.id === inc.id)!;
    expect(mine).toMatchObject({ closedReason: 'accepted', closedBy: 'Steve Koelpin', closedAt: iso(clock.now()), lastNotifiedAt: inc.lastNotifiedAt });
    expect(mine.deliveries).toHaveLength(1);
    expect(stored.find((i) => i.id === 'inc_other')!.closedAt).toBeUndefined();

    const b = (await docs.getBaselines())!;
    expect(b.byObject[KEY].mean).toBe(0.3);
    expect(b.rules[`regression|${KEY}`]).toBeUndefined();

    const snap = (await docs.getSnapshot())!;
    expect(snap.openIncidents).toBe(1);
    expect(snap.incidents.find((i) => i.id === inc.id)!.closedReason).toBe('accepted');
    expect(snap.flows[0].state).toBe('ok');

    const lock = await docs.getLock();
    expect(Date.parse(lock!.expiresAt)).toBeLessThanOrEqual(clock.now());
  });

  it('a sweep holding the lock through every try: nothing is written, the caller hears "locked"', async () => {
    const docs = docsWith();
    const r = brokenTrim();
    const key = incidentsDocKey(Date.parse(r.open[0].openedAt));
    await docs.putIncidents(key, { schemaVersion: 1, items: r.open });
    await docs.acquireLock('runner:host:1', 130_000);
    let slept = 0;
    const res = await runIncidentAction(docs, {
      action: 'accept',
      incident: r.open[0],
      by: 'Steve Koelpin',
      owner: 'action:t2',
      nowMs: clock.now(),
      sleep: async () => {
        slept++;
      },
    });
    expect(res).toEqual({ ok: false, reason: 'locked' });
    expect(slept).toBe(ACTION_LOCK_TRIES - 1);
    expect((await docs.getIncidents(key))!.items[0].closedAt).toBeUndefined();
    expect((await docs.getLock())!.owner).toBe('runner:host:1');
  });

  it('an incident that already closed (it recovered meanwhile) is left as it is', async () => {
    const docs = docsWith();
    const r = brokenTrim();
    const recovered = { ...r.open[0], closedAt: iso(T0 + 15 * MIN), recoveredTo: 0.76 };
    const key = incidentsDocKey(Date.parse(recovered.openedAt));
    await docs.putIncidents(key, { schemaVersion: 1, items: [recovered] });
    const res = await runIncidentAction(docs, { action: 'accept', incident: r.open[0], by: 'x', owner: 'action:t3', nowMs: clock.now() });
    expect(res).toMatchObject({ ok: false, reason: 'closed' });
    expect((await docs.getIncidents(key))!.items[0]).toEqual(recovered);
  });

  it('mute: the snapshot marks the object\'s flows muted until the mute ends', () => {
    const r = brokenTrim();
    const until = iso(T0 + 24 * 60 * MIN);
    const snap = closeInSnapshot(snapshotWith(r.open), closeByMember(r.open[0], 'mute', 'Steve Koelpin', iso(T0)), { mutedUntil: until });
    expect(snap.flows[0]).toMatchObject({ state: 'ok', muted: true, mutedUntil: until });
    expect(snap.openIncidents).toBe(0);
  });
});

describe('P1-F07 · a member mute outlives the next sweep', () => {
  it('buildSnapshot marks the object\'s flows muted by a member until the mute ends, and the Ledger says how long is left', async () => {
    const { buildSnapshot } = await import('../../core/snapshot.ts');
    const { buildRows } = await import('../../src/components/LedgerTable/model.ts');
    const { statusText } = await import('../../src/components/LedgerTable/status.ts');
    const { makeFlowKey } = await import('../../core/flows.ts');
    const { emptyTotals } = await import('../../core/rollups.ts');
    const { emptyPrices } = await import('../../core/pricing.ts');
    const sweepAt = T0 + 20 * MIN;
    const until = iso(sweepAt + 23 * 60 * MIN + 30 * MIN);
    const f = { key: makeFlowKey('default', 'pay', 'pay_route', 'mrd_pay_sample', 'mrd_siem_apps'), groupId: 'default', inputId: 'pay', routeId: 'pay_route', pipelineId: 'mrd_pay_sample', outputId: 'mrd_siem_apps', attribution: 'reconciled' as const };
    const other = { ...f, key: makeFlowKey('default', 'k8s', 'k8s_route', 'k8s_noise', 'mrd_analytics'), inputId: 'k8s', routeId: 'k8s_route', pipelineId: 'k8s_noise', outputId: 'mrd_analytics' };
    const snap = buildSnapshot({
      sweepAtMs: sweepAt,
      windowStartMs: sweepAt - MIN,
      windowEndMs: sweepAt,
      mode: 'ui',
      settings: settings({ mutes: { [KEY]: { until, by: 'Steve Koelpin' } } }),
      prices: emptyPrices(iso(T0)),
      flows: [f, other],
      minuteRows: {},
      totals: emptyTotals(iso(T0)),
      collectingSinceMs: T0 - 86_400_000,
      incidents: [],
      timeline: [],
      deliveries: [],
      calls: 0,
      metricsSource: 'metrics-query',
    });
    expect(snap.flows.find((x) => x.key === f.key)).toMatchObject({ muted: true, mutedUntil: until, mutedByMember: true });
    expect(snap.flows.find((x) => x.key === other.key)!.muted).toBeUndefined();
    const row = buildRows(snap, { now: sweepAt }).find((r) => r.id === f.key)!;
    expect(row.status).toBe('muted');
    expect(statusText(row)).toBe('muted · 23 h left');
    // An expired mute is no mute.
    const later = buildSnapshot({ ...{ sweepAtMs: Date.parse(until) + MIN, windowStartMs: Date.parse(until), windowEndMs: Date.parse(until) + MIN }, mode: 'ui', settings: settings({ mutes: { [KEY]: { until } } }), prices: emptyPrices(iso(T0)), flows: [f], minuteRows: {}, totals: emptyTotals(iso(T0)), collectingSinceMs: T0, incidents: [], timeline: [], deliveries: [], calls: 0, metricsSource: 'metrics-query' });
    expect(later.flows[0].muted).toBeUndefined();
  });
});
