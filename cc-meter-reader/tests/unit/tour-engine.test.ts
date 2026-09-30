// @vitest-environment jsdom
// The tour engine (src/tour/engine.ts): plays the bundled fixture on a timer through the store's sample
// path, never meters or writes KV while it owns the screen, and stops itself when anything clears it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, mergeSettings } from '../../core/settings.ts';
import type { Commit, DeliveryLog, Incident, Settings, Snapshot } from '../../core/types.ts';
import { localDayKey, localMonthStartMs, toIso } from '../../core/time.ts';
import { sampleRollups } from '../../core/sampleRollups.ts';
import type { AppDocs, SweepEngine } from '../../src/state/ports.ts';
import { createAppServices, type AppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';
import type { SweepSummary } from '../../src/state/store.ts';
import { createTourEngine, markFlowStates, weeklyReceiptAt, withCommit, withDelivery, withIncident, type TourEngine } from '../../src/tour/engine.ts';
import type { TourEvent, TourFixture, TourStopReason } from '../../src/tour/types.ts';

const DOC = JSON.parse(readFileSync(resolve(__dirname, '../../demo/sample/tour.json'), 'utf8')) as TourFixture;
/** A day nothing like the fixture's anchor: a Tuesday in another month and year. */
const WALL = Date.parse('2027-03-09T20:15:07.000Z');
const VIEWER_TZ = 'Europe/Berlin';
const DEFAULTS: Settings = defaultSettings('2027-03-01T00:00:00.000Z', VIEWER_TZ);

function fakeDocs(prices: TourFixture['prices'] | null = null) {
  const writes: string[] = [];
  const docs: AppDocs = {
    readSettings: async () => null,
    readPrices: async () => prices,
    readSnapshot: async () => null,
    readMeta: async () => null,
    readDemoState: async () => null,
    readInventory: async () => null,
    writeSettings: async () => {
      writes.push('settings');
    },
    writePrices: async () => {
      writes.push('prices');
    },
  };
  return { docs, writes };
}

interface Rig {
  services: AppServices;
  sweep: SweepEngine & { runLocal: ReturnType<typeof vi.fn> };
  writes: string[];
  events: TourEvent[];
  stops: TourStopReason[];
  engine: TourEngine;
}

async function rig(opts: { loop?: boolean; priced?: boolean } = {}): Promise<Rig> {
  const store = createAppStore(DEFAULTS);
  // REVIEW-3a #3: a tab meters only once a prices document exists, so tests that need live metering price the workspace.
  const { docs, writes } = fakeDocs(opts.priced ? DOC.prices : null);
  const summary = (mode: 'ui' | 'manual'): SweepSummary => ({ ok: true, mode, calls: 12, durationMs: 800 });
  const sweep = {
    runLocal: vi.fn(async (mode: 'ui' | 'manual') => summary(mode)),
    invokeBackend: vi.fn(async () => summary('manual')),
  };
  const services = createAppServices({ store, docs, engine: sweep, mergeSettings: (s) => mergeSettings(s, DEFAULTS) });
  await services.start();
  const events: TourEvent[] = [];
  const stops: TourStopReason[] = [];
  const engine = createTourEngine({
    store,
    actions: services.actions,
    doc: DOC,
    loop: opts.loop,
    onEvent: (e) => events.push(e),
    onStop: (r) => stops.push(r),
  });
  return { services, sweep, writes, events, stops, engine };
}

const state = (r: Rig) => r.services.store.getState();
const snap = (r: Rig): Snapshot => state(r).snapshot!;
const open = (r: Rig) => snap(r).incidents.filter((i) => !i.closedAt);

describe('createTourEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(WALL);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the fixture as sample data, moved onto the wall clock and the member’s timezone', async () => {
    const r = await rig();
    r.engine.start();
    const s = state(r);
    expect(s.source).toBe('sample');
    expect(s.snapshot?.sweepAt).toBe(toIso(WALL));
    expect(s.snapshot?.mode).toBe('sample');
    // Money per day never moves; month to date follows the moved days (March 1–9 here).
    expect(s.snapshot?.headline.todayM).toBe(DOC.snapshot.headline.todayM);
    expect(s.snapshot?.headline.d30M).toBe(DOC.snapshot.headline.d30M);
    expect(s.snapshot?.headline.annualizedM).toBe(DOC.snapshot.headline.annualizedM);
    expect(s.snapshot?.headline.mtdM).toBe(s.snapshot!.trend.filter((p) => p.day.startsWith('2027-03')).reduce((sum, p) => sum + p.savedM, 0));
    expect(s.snapshot?.trend.at(-1)?.day).toBe(localDayKey(WALL, DOC.timezone));
    expect(s.meta?.lastSweepAt).toBe(toIso(WALL));
    expect(s.settings.displayTimezone).toBe(VIEWER_TZ);
    expect(s.prices).not.toBeNull();
    expect(s.inventory?.counts.inputs).toBe(DOC.workspace.sources);
    // Every gap the detector produced is preserved: the breaking commit is 2:51 − 0:25 before now.
    const breaking = s.snapshot!.timeline[0];
    expect(Date.parse(breaking.deployedAt!)).toBe(WALL - 146_000);
    expect(r.engine.status()).toMatchObject({ phase: 'running', durationSec: DOC.durationSec, loop: false });
    r.engine.stop();
  });

  it('plays the SPEC 15 beats: regression at 25 s, Slack at 31 s, spike at 70 s, recovery at 110 s, receipt at 130 s', async () => {
    const r = await rig();
    r.engine.start();

    await vi.advanceTimersByTimeAsync(24_900);
    expect(open(r)).toHaveLength(0);
    expect(r.events).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(open(r)).toHaveLength(1);
    const reg = open(r)[0];
    expect(reg).toMatchObject({ type: 'regression', label: 'Payments API sampling', cause: 'commit', caughtInSec: 171 });
    expect(reg.openedAt).toBe(toIso(WALL + 25_000));
    expect(reg.deliveries).toEqual([]);
    expect(snap(r).flows.find((f) => f.routeId === 'r_payments')?.state).toBe('regression');
    expect(r.events.map((e) => e.step.action)).toEqual(['snapshot', 'incident.open']);

    await vi.advanceTimersByTimeAsync(6_000);
    const delivered = open(r)[0];
    expect(delivered.deliveries).toEqual([{ endpointId: 'slack-finops', status: 200, at: toIso(WALL + 31_000) }]);
    expect(delivered.lastNotifiedAt).toBe(toIso(WALL + 31_000));
    expect(snap(r).deliveries[0]).toMatchObject({ event: 'incident.opened', incidentId: reg.id });

    await vi.advanceTimersByTimeAsync(19_000); // 50 s: the restore commit
    expect(snap(r).timeline[0].message).toMatch(/^Revert/);

    await vi.advanceTimersByTimeAsync(20_000); // 70 s
    expect(open(r).map((i) => i.type).sort()).toEqual(['regression', 'spike']);
    expect(snap(r).openIncidents).toBe(2);
    // The scripted snapshot kept the Slack delivery recorded at 31 s.
    expect(open(r).find((i) => i.type === 'regression')?.deliveries).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(40_000); // 110 s
    expect(open(r).map((i) => i.type)).toEqual(['spike']);
    const closed = snap(r).incidents.find((i) => i.id === reg.id)!;
    expect(closed.closedAt).toBeDefined();
    expect(closed.after).toBeCloseTo(0.5, 1); // the drop it keeps (D47)
    expect(closed.recoveredTo).toBeCloseTo(0.75, 2);
    expect(snap(r).flows.find((f) => f.routeId === 'r_payments')?.state).toBe('ok');

    await vi.advanceTimersByTimeAsync(20_000); // 130 s
    expect(r.events.at(-1)?.step).toMatchObject({ at: 130, action: 'caption', payload: { id: 'weekly-receipt' } });
    expect(r.events.every((e) => !e.silent)).toBe(true);
    const receipt = r.engine.weeklyReceipt()!;
    // Founder-build r1 ui-7 (M3): its money is the sample's own hour rows over its week — what a Custom range over the
    // same week sums on the snapshot on screen — not the recording's week relabelled.
    const rollups = sampleRollups(snap(r), state(r).settings.displayTimezone);
    let weekSaved = 0;
    for (const key of rollups.keys().hour) {
      for (const rows of Object.values(rollups.hourDoc(key)?.flows ?? {})) {
        for (const row of rows) if (row.t >= receipt.periodStart && row.t < receipt.periodEnd) weekSaved += row.savedM;
      }
    }
    expect(weekSaved).toBeGreaterThan(0);
    expect(receipt.savedM).toBe(weekSaved);
    expect(receipt.label).toMatch(/^Mar 1–7, 2027$/);

    await vi.advanceTimersByTimeAsync(DOC.durationSec * 1000);
    expect(r.engine.status().phase).toBe('finished');
    expect(state(r).source).toBe('sample'); // the finished tour stays on screen until cleared
    r.engine.stop();
  });

  it('never meters, polls or writes KV while it owns the screen; metering resumes after it', async () => {
    const r = await rig({ priced: true });
    await vi.advanceTimersByTimeAsync(5_000);
    const before = r.sweep.runLocal.mock.calls.length;
    expect(before).toBeGreaterThan(0); // the 'ui' runtime was metering the (priced, empty) workspace
    // Founder-build r2 ui-3: that first live sweep stored the settings-less workspace's zone once, before the tour.
    const writesBefore = [...r.writes];
    expect(writesBefore).toEqual(['settings']);

    r.engine.start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(r.sweep.runLocal.mock.calls.length).toBe(before);
    expect(state(r).status.sweep.metering).toBe(false);
    expect(await r.services.actions.saveSettings(DEFAULTS)).toEqual({ ok: false, reason: 'not-live' });
    expect(r.writes).toEqual(writesBefore); // nothing written while the tour owns the screen

    r.engine.stop();
    expect(state(r).source).toBe('live');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(r.sweep.runLocal.mock.calls.length).toBeGreaterThan(before);
  });

  it('stops itself when the sample band clears the data, and writes nothing afterwards', async () => {
    const r = await rig();
    r.engine.start();
    await vi.advanceTimersByTimeAsync(10_000);
    r.services.actions.clearSample(); // what SampleBand's "Clear sample data" does
    expect(r.engine.status().phase).toBe('stopped');
    expect(r.engine.isActive()).toBe(false);
    expect(r.stops).toEqual(['cleared']);
    expect(state(r).source).toBe('live');
    expect(state(r).snapshot).toBeNull(); // the live (empty) workspace is back
    expect(state(r).inventory).toBeNull();

    await vi.advanceTimersByTimeAsync(200_000);
    expect(state(r).source).toBe('live');
    expect(r.events).toHaveLength(0);
  });

  it('stop() restores the live documents', async () => {
    const r = await rig();
    r.engine.start();
    await vi.advanceTimersByTimeAsync(30_000);
    r.engine.stop();
    expect(r.stops).toEqual(['user']);
    expect(state(r)).toMatchObject({ source: 'live', snapshot: null, prices: null, liveStash: null });
    expect(state(r).settings.displayTimezone).toBe(VIEWER_TZ);
  });

  it('pauses and resumes', async () => {
    const r = await rig();
    r.engine.start();
    await vi.advanceTimersByTimeAsync(20_000);
    r.engine.pause();
    expect(r.engine.status()).toMatchObject({ phase: 'paused' });
    expect(r.engine.status().elapsedSec).toBeCloseTo(20, 5);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(open(r)).toHaveLength(0);
    r.engine.resume();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(open(r)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(open(r)).toHaveLength(1);
    r.engine.stop();
  });

  it('seeks silently, rebuilding the state up to the target second', async () => {
    const r = await rig();
    r.engine.start();
    r.engine.seek(80);
    expect(r.events.map((e) => [e.step.at, e.silent])).toEqual([
      [25, true],
      [25, true],
      [31, true],
      [50, true],
      [70, true],
      [70, true],
      [76, true],
    ]);
    expect(open(r).map((i) => i.type).sort()).toEqual(['regression', 'spike']);
    expect(open(r).find((i) => i.type === 'spike')?.deliveries).toHaveLength(1);
    // Script second 80 reads as now; the 70 s snapshot was taken at virtual second 85 (5 s ahead).
    expect(snap(r).sweepAt).toBe(toIso(WALL + 5_000));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.events.at(-1)).toMatchObject({ silent: false, step: { at: 110, action: 'incident.close' } });
    r.engine.stop();
  });

  it('loops for Story mode', async () => {
    const r = await rig({ loop: true });
    r.engine.start();
    await vi.advanceTimersByTimeAsync(DOC.durationSec * 1000 + 100);
    expect(r.engine.status()).toMatchObject({ phase: 'running', iteration: 1 });
    expect(open(r)).toHaveLength(0);
    expect(snap(r).sweepAt).toBe(toIso(WALL + DOC.durationSec * 1000));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(open(r)).toHaveLength(1);
    r.engine.stop();
  });

  it('month to date and its net follow the moved days, in the base snapshot and every scripted one', async () => {
    // Recorded on Sep 24, played on Sep 26: month to date covers Sep 1–26, and the cost covers the minutes from the
    // first of the month to the moved sweep (D49; collecting began in August).
    vi.setSystemTime(Date.parse(DOC.snapshot.sweepAt) + 2 * 86_400_000);
    const r = await rig();
    r.engine.start();
    const cost = DOC.settings.criblCostCentsPerMonth ?? 0;
    expect(cost).toBeGreaterThan(0);
    const check = (s: Snapshot) => {
      const sep = s.trend.filter((p) => p.day.startsWith('2026-09'));
      expect(sep.at(-1)?.day).toBe('2026-09-26');
      const sum = (k: 'savedM' | 'whpM' | 'paidM') => sep.reduce((acc, p) => acc + p[k], 0);
      expect([s.headline.mtdM, s.headline.whpMtdM, s.headline.paidMtdM]).toEqual([sum('savedM'), sum('whpM'), sum('paidM')]);
      const sweepMs = Date.parse(s.sweepAt);
      const zone = DOC.timezone;
      expect(Date.parse(s.collectingSince)).toBeLessThan(localMonthStartMs(sweepMs, zone));
      const prorated = (cost * 1000 * 12 * ((sweepMs - localMonthStartMs(sweepMs, zone)) / 60_000)) / 525_600;
      expect(s.headline.netMtdM).toBe(sum('savedM') - Math.round(prorated));
      expect(s.headline.paybackX).toBeCloseTo(sum('savedM') / prorated, 12);
      expect(s.headline.mtdM).toBeGreaterThan(DOC.snapshot.headline.mtdM);
    };
    check(snap(r));
    await vi.advanceTimersByTimeAsync(26_000); // past the first scripted snapshot
    expect(r.events.some((e) => e.step.action === 'snapshot')).toBe(true);
    check(snap(r));
    r.engine.stop();
  });

  it('a second start while active is ignored', async () => {
    const r = await rig();
    r.engine.start();
    await vi.advanceTimersByTimeAsync(26_000);
    r.engine.start();
    expect(open(r)).toHaveLength(1);
    r.engine.stop();
  });
});

describe('snapshot patches', () => {
  const base = DOC.snapshot;
  const reg = DOC.script.find((s) => s.action === 'incident.open')!.payload as Incident;
  const log = DOC.script.find((s) => s.action === 'delivery')!.payload as DeliveryLog;
  const commit = DOC.script.find((s) => s.action === 'commit')!.payload as Commit;

  it('withIncident upserts by id, recounts open incidents and marks the flows', () => {
    const a = withIncident(base, reg);
    expect(a.openIncidents).toBe(1);
    expect(a.incidents[0].id).toBe(reg.id);
    expect(a.flows.filter((f) => f.state === 'regression').map((f) => f.routeId)).toEqual(['r_payments']);
    const again = withIncident(a, reg);
    expect(again.incidents.filter((i) => i.id === reg.id)).toHaveLength(1);
    const closed = withIncident(again, { ...reg, closedAt: reg.openedAt });
    expect(closed.openIncidents).toBe(0);
    expect(closed.flows.every((f) => f.state !== 'regression')).toBe(true);
    expect(base.openIncidents).toBe(0); // never mutates
  });

  it('withDelivery records once, on the log and on the incident', () => {
    const a = withDelivery(withIncident(base, reg), log);
    expect(a.deliveries[0]).toEqual(log);
    expect(a.incidents.find((i) => i.id === reg.id)?.deliveries).toHaveLength(1);
    const b = withDelivery(a, log);
    expect(b).toBe(a);
  });

  it('withIncident keeps delivery refs an older payload does not know about', () => {
    const delivered = withDelivery(withIncident(base, reg), log);
    const replaced = withIncident(delivered, reg);
    expect(replaced.incidents.find((i) => i.id === reg.id)?.deliveries).toHaveLength(1);
  });

  it('withCommit adds a commit once, newest first', () => {
    const a = withCommit(base, commit);
    expect(a.timeline[0].hash).toBe(commit.hash);
    expect(withCommit(a, commit)).toBe(a);
  });

  it('markFlowStates leaves muted and unpriced flows alone', () => {
    const flows = base.flows.map((f) => (f.routeId === 'r_payments' ? { ...f, muted: true } : f));
    expect(markFlowStates(flows, [reg]).find((f) => f.routeId === 'r_payments')?.state).toBe('ok');
  });

  it('weeklyReceiptAt relabels the receipt with the previous complete week', () => {
    const r = weeklyReceiptAt(DOC.weeklyReceipt, Date.parse('2026-10-14T15:00:00Z'), 'America/Chicago')!;
    expect(r.label).toBe('Oct 5–11, 2026');
    expect(r.savedM).toBe(DOC.weeklyReceipt!.savedM);
    expect(weeklyReceiptAt(undefined, 0, 'UTC')).toBeUndefined();
  });
});
