// @vitest-environment jsdom
// The open tab's meter and poll against the Leader budget and its own failures (EPIC_AUDIT P0-07, P1-D05):
//   • every sweep this tab runs updates a failure streak the chrome reads; a lock refusal leaves it alone;
//   • the tab yields to a runner that swept in the last 90 s, answers the cheap check from the meta it holds,
//     re-reads documents only after a sweep that ran and did not hand them back;
//   • polls skip what a sweep just handed back, read prices once a minute, meta every third presenter poll and
//     demo/state every poll only while a scene or lever runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { DemoState, Meta, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import { createLiveController, demoIsActive, metaMoved, PRICES_REFRESH_MS } from '../../src/state/live.ts';
import { createMeterLoop, isFailedSweep, minuteIsCurrent } from '../../src/state/meterLoop.ts';
import type { AppDocs, SweepEngine, VisibilitySource } from '../../src/state/ports.ts';
import { meterBlocker, meteringFailure, RUNNER_FRESH_MS } from '../../src/state/selectors.ts';
import { createAppStore, type AppStore, type SweepSummary } from '../../src/state/store.ts';

const NOW = Date.parse('2026-09-26T18:00:30.000Z');
const DEFAULTS: Settings = defaultSettings('2026-09-26T00:00:00.000Z', 'UTC');
const iso = (ms: number) => new Date(ms).toISOString();
const PRICES: PricesDoc = {
  schemaVersion: 1,
  updatedAt: '2026-09-25T00:00:00.000Z',
  versions: [{ effectiveFrom: '2026-09-25T00:00:00.000Z', byOutputId: { mrd_siem_prod: { milliCentsPerGb: 225_000 } } }],
};
const snapshot = (sweepAt: number): Snapshot => ({ sweepAt: iso(sweepAt), destinations: [] }) as unknown as Snapshot;
function meta(patch: Partial<Meta> = {}): Meta {
  return {
    schemaVersion: 1,
    installedAt: '2026-09-25T00:00:00.000Z',
    collectingSince: '2026-09-25T00:00:00.000Z',
    appVersion: '1.0.0',
    build: 'release',
    metricsSource: 'metrics-query',
    lastSweepAt: iso(NOW - 25_000),
    lastSweepOwner: 'ui:tab-a',
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: 3,
    ...patch,
  };
}

function engine(results: (() => SweepSummary)[] = []) {
  let i = 0;
  const runLocal = vi.fn(async (mode: 'ui' | 'manual'): Promise<SweepSummary> => {
    const next = results[Math.min(i++, results.length - 1)];
    return next ? { ...next(), mode } : { ok: true, mode, calls: 20 };
  });
  const eng: SweepEngine & { runLocal: typeof runLocal } = { runLocal, invokeBackend: vi.fn(async () => ({ ok: true, mode: 'manual' as const })), ownerId: 'ui:tab-a' };
  return eng;
}

const fail = (error: string) => (): SweepSummary => ({ ok: false, mode: 'ui', error });
const ok = (): SweepSummary => ({ ok: true, mode: 'ui', calls: 22 });

function meteringStore(patch: Parameters<typeof createAppStore>[1] = {}): AppStore {
  return createAppStore(DEFAULTS, { hasHydrated: true, prices: PRICES, ...patch });
}

describe('the failure streak (P0-07)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('counts failed sweeps, dates the streak, keeps the code; one that runs clears it', async () => {
    const store = meteringStore();
    const eng = engine([fail('metrics outputs query failed: HTTP 403'), fail('metrics outputs query failed: HTTP 403'), ok]);
    const loop = createMeterLoop({ store, engine: eng, firstDelayMs: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    let sweep = store.getState().status.sweep;
    expect(sweep.failures).toBe(1);
    expect(sweep.failingSince).toBe(NOW);
    expect(sweep.lastFailure).toEqual({ code: 'metrics outputs query failed: HTTP 403', at: NOW });
    expect(sweep.nextAt).toBe(NOW + 30_000);
    expect(meteringFailure(store.getState(), Date.now())?.kind).toBe('metrics-forbidden');

    await vi.advanceTimersByTimeAsync(30_000);
    sweep = store.getState().status.sweep;
    expect(sweep.failures).toBe(2);
    expect(sweep.failingSince).toBe(NOW);

    await vi.advanceTimersByTimeAsync(30_000);
    sweep = store.getState().status.sweep;
    expect(sweep.failures).toBe(0);
    expect(sweep.lastFailure).toBeUndefined();
    expect(meteringFailure(store.getState(), Date.now())).toBeNull();
    loop.stop();
  });

  it('a 429 or a budget stop is a failed sweep; a lock refusal or a current minute is not', () => {
    expect(isFailedSweep({ ok: false, mode: 'ui', skipped: 'rate_limited', error: 'rate_limited' })).toBe(true);
    expect(isFailedSweep({ ok: false, mode: 'ui', skipped: 'budget', error: 'budget' })).toBe(true);
    expect(isFailedSweep({ ok: true, mode: 'ui', skipped: 'locked' })).toBe(false);
    expect(isFailedSweep({ ok: true, mode: 'ui', skipped: 'current' })).toBe(false);
  });

  it('a lock refusal leaves the streak as it was', async () => {
    const store = meteringStore();
    const eng = engine([fail('KV PUT snapshot failed: HTTP 500'), () => ({ ok: true, mode: 'ui', skipped: 'locked' }), fail('KV PUT snapshot failed: HTTP 500')]);
    const loop = createMeterLoop({ store, engine: eng, firstDelayMs: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(meteringFailure(store.getState(), Date.now())).toBeNull(); // one 5xx is a blip
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getState().status.sweep.failures).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getState().status.sweep.failures).toBe(2);
    expect(meteringFailure(store.getState(), Date.now())).toMatchObject({ kind: 'server', status: 500 });
    loop.stop();
  });

  it('a backend Sweep now that fails does not start a streak (the backend\'s own schedule meters)', async () => {
    const store = meteringStore({ settings: { ...DEFAULTS, runtime: 'backend' } });
    const eng = engine();
    eng.invokeBackend = vi.fn(async () => ({ ok: false, mode: 'manual' as const, error: 'HTTP 500', status: 500 }));
    const loop = createMeterLoop({ store, engine: eng });
    await loop.sweepNow();
    expect(store.getState().status.sweep.failures).toBeUndefined();
  });
});

describe('the tab yields to the runner and skips work it need not do (P1-D05)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('does not meter while the runner swept within 90 s, and sweeps at once when it goes quiet', async () => {
    const runnerAt = NOW - 20_000;
    const store = meteringStore({ meta: meta({ lastSweepOwner: 'runner:workhorse:9', lastSweepAt: iso(runnerAt), meteredThrough: iso(runnerAt - 5_000) }) });
    const eng = engine();
    const loop = createMeterLoop({ store, engine: eng, firstDelayMs: 3_000 });
    loop.start();
    expect(meterBlocker(store.getState(), Date.now())).toBe('runner');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(eng.runLocal).not.toHaveBeenCalled();
    expect(store.getState().status.sweep.metering).toBe(false);

    // Live polling re-evaluates the gate: once the runner's last sweep is 90 s old, this tab meters right away.
    await vi.advanceTimersByTimeAsync(runnerAt + RUNNER_FRESH_MS - Date.now());
    store.setState({ status: { ...store.getState().status, live: { ...store.getState().status.live, lastPollAt: Date.now() } } });
    expect(store.getState().status.sweep.metering).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(eng.runLocal).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('answers the cheap check from the meta it holds: no sweep call until a new minute settles', async () => {
    // Metered through 18:00:00; the minute 18:00 settles at 18:01:20.
    const store = meteringStore({ meta: meta({ meteredThrough: '2026-09-26T18:00:00.000Z' }) });
    expect(minuteIsCurrent(store.getState(), NOW)).toBe(true);
    const eng = engine();
    const loop = createMeterLoop({ store, engine: eng, firstDelayMs: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(30_000); // 18:01:00: still current
    expect(eng.runLocal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000); // 18:01:30: 18:00 has settled
    expect(minuteIsCurrent(store.getState(), Date.now())).toBe(false);
    expect(eng.runLocal).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('re-reads documents only after a sweep that ran and did not hand them back', async () => {
    const refresh = vi.fn(async () => undefined);
    const store = meteringStore();
    const eng = engine([
      () => ({ ok: true, mode: 'ui', skipped: 'current' }),
      () => ({ ok: true, mode: 'ui', skipped: 'locked' }),
      fail('rate_limited'),
      () => ({ ok: true, mode: 'ui', calls: 22, snapshot: snapshot(Date.now()), meta: meta({ lastSweepAt: iso(Date.now()) }) }),
      () => ({ ok: true, mode: 'ui', calls: 22 }),
    ]);
    const loop = createMeterLoop({ store, engine: eng, refresh, firstDelayMs: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).not.toHaveBeenCalled(); // current, locked, failed
    // Minute 4 hands back both documents (the poll can skip them); minute 5 ran without them.
    store.setState({ meta: null });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(store.getState().status.live.docsAt).toBe(Date.now());
    store.setState({ meta: null });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    loop.stop();
  });
});

// ─── Polling budget ──────────────────────────────────────────────────────────

function countingDocs(initial: { snapshot?: Snapshot | null; meta?: Meta | null; prices?: PricesDoc | null; demo?: DemoState | null } = {}) {
  const state = { snapshot: null, meta: null, prices: PRICES, demo: null, ...initial };
  const calls: string[] = [];
  const docs: AppDocs = {
    readSettings: async () => DEFAULTS,
    readPrices: async () => (calls.push('prices'), state.prices),
    readSnapshot: async () => (calls.push('snapshot'), state.snapshot),
    readMeta: async () => (calls.push('meta'), state.meta),
    readDemoState: async () => (calls.push('demoState'), state.demo),
    readInventory: async () => null,
    writeSettings: async () => undefined,
    writePrices: async () => undefined,
  };
  const count = (key: string) => calls.filter((c) => c === key).length;
  return { docs, state, calls, count };
}

const visible: VisibilitySource = { hidden: false, addEventListener: () => undefined, removeEventListener: () => undefined };

describe('what each poll reads (P1-D05)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('reads meta every 10 s and the snapshot only after meta moved: 9 reads a minute beside a runner that swept once', async () => {
    const heldMeta = meta({ lastSweepOwner: 'runner:workhorse:9' });
    const fake = countingDocs({ snapshot: snapshot(NOW - 25_000), meta: heldMeta });
    const store = meteringStore({ snapshot: snapshot(NOW - 25_000), meta: heldMeta });
    store.setState({ status: { ...store.getState().status, live: { phase: 'waiting', pricesReadAt: NOW } } });
    const live = createLiveController({ store, docs: fake.docs, visibility: visible });
    live.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.count('meta')).toBe(3);
    expect(fake.count('snapshot')).toBe(0); // meta unchanged: the snapshot on screen is the newest
    // The runner sweeps: snapshot first, then meta. The next poll sees meta move and reads the snapshot once.
    fake.state.snapshot = snapshot(NOW + 28_000);
    fake.state.meta = meta({ lastSweepOwner: 'runner:workhorse:9', lastSweepAt: iso(NOW + 28_000) });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.count('meta')).toBe(6);
    expect(fake.count('snapshot')).toBe(1);
    expect(store.getState().snapshot?.sweepAt).toBe(iso(NOW + 28_000));
    expect(fake.count('prices')).toBe(1);
    expect(fake.calls.length).toBe(8);
    expect(metaMoved(heldMeta, heldMeta)).toBe(false);
    expect(metaMoved(heldMeta, null)).toBe(false);
    expect(metaMoved(null, heldMeta)).toBe(true);
    live.stop();
  });

  it('a snapshot read that failed is retried with the next poll, whether or not meta moved', async () => {
    const heldMeta = meta();
    const fake = countingDocs({ snapshot: snapshot(NOW - 25_000), meta: heldMeta });
    const store = meteringStore({ meta: heldMeta, errors: { snapshot: { kind: 'server', status: 500, at: NOW } } });
    store.setState({ status: { ...store.getState().status, live: { phase: 'waiting', pricesReadAt: NOW } } });
    const live = createLiveController({ store, docs: fake.docs, visibility: visible });
    live.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.count('snapshot')).toBe(1);
    expect(store.getState().errors.snapshot).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.count('snapshot')).toBe(1);
    live.stop();
  });

  it('skips even meta on the poll right after a sweep handed both documents back', async () => {
    const fake = countingDocs({ snapshot: snapshot(NOW - 20_000), meta: meta() });
    const store = meteringStore({ snapshot: snapshot(NOW - 20_000), meta: meta() });
    const live = createLiveController({ store, docs: fake.docs, visibility: visible });
    live.start();
    await vi.advanceTimersByTimeAsync(5_000);
    store.setState({ status: { ...store.getState().status, live: { ...store.getState().status.live, docsAt: Date.now() } } });
    await vi.advanceTimersByTimeAsync(5_000); // the poll at +10 s: the sweep's hand-back is 5 s old
    expect(fake.count('snapshot')).toBe(0);
    expect(fake.count('meta')).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.count('meta')).toBe(1);
    expect(fake.count('snapshot')).toBe(0);
    // A poll asked for explicitly (Refresh, a visible tab again, a sweep's refresh) reads both together.
    store.setState({ status: { ...store.getState().status, live: { ...store.getState().status.live, docsAt: Date.now() } } });
    await live.pollNow();
    expect(fake.count('snapshot')).toBe(1);
    expect(fake.count('meta')).toBe(2);
    live.stop();
  });

  it('presenter mode: meta every 5 s, the snapshot as soon as it moves', async () => {
    const fake = countingDocs({ snapshot: snapshot(NOW - 20_000), meta: meta() });
    const store = meteringStore({ presenter: true, snapshot: snapshot(NOW - 20_000), meta: meta() });
    store.setState({ status: { ...store.getState().status, live: { phase: 'waiting', pricesReadAt: NOW } } });
    const live = createLiveController({ store, docs: fake.docs, visibility: visible });
    live.start();
    await vi.advanceTimersByTimeAsync(55_000);
    fake.state.snapshot = snapshot(NOW + 57_000);
    fake.state.meta = meta({ lastSweepAt: iso(NOW + 57_000) });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.count('meta')).toBe(12);
    expect(fake.count('snapshot')).toBe(1);
    expect(store.getState().snapshot?.sweepAt).toBe(iso(NOW + 57_000)); // within one 5 s poll of the sweep
    expect(fake.calls.length).toBeLessThanOrEqual(14);
    live.stop();
  });

  it('prices: re-read once a minute, a newer document from another tab is adopted, an older one never', async () => {
    const fake = countingDocs({ snapshot: snapshot(NOW - 20_000), meta: meta() });
    const store = meteringStore();
    store.setState({ status: { ...store.getState().status, live: { phase: 'waiting', pricesReadAt: NOW } } });
    const live = createLiveController({ store, docs: fake.docs, visibility: visible });
    live.start();
    const newer: PricesDoc = { ...PRICES, updatedAt: '2026-09-26T17:00:00.000Z' };
    fake.state.prices = newer;
    await vi.advanceTimersByTimeAsync(PRICES_REFRESH_MS - 10_000);
    expect(fake.count('prices')).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.count('prices')).toBe(1);
    expect(store.getState().prices).toBe(newer);
    fake.state.prices = PRICES; // an older document read back (e.g. a read that left before this tab's save)
    await vi.advanceTimersByTimeAsync(PRICES_REFRESH_MS);
    expect(fake.count('prices')).toBe(2);
    expect(store.getState().prices).toBe(newer);
    live.stop();
  });

  it('demo/state: every poll while a scene or lever runs, every 30 s otherwise', async () => {
    expect(demoIsActive(null)).toBe(false);
    expect(demoIsActive({ scene: { id: 'x' } } as unknown as DemoState)).toBe(true);
    const fake = countingDocs({ snapshot: snapshot(NOW - 20_000), meta: meta() });
    const store = meteringStore();
    store.setState({ status: { ...store.getState().status, live: { phase: 'waiting', pricesReadAt: NOW, demoReadAt: NOW } } });
    const live = createLiveController({ store, docs: fake.docs, visibility: visible, includeDemoState: () => true });
    live.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.count('demoState')).toBe(2);
    const running = { inFlight: { lever: 'break' } } as unknown as DemoState;
    fake.state.demo = running;
    store.setState({ demoState: running });
    fake.calls.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.count('demoState')).toBe(3);
    live.stop();
  });
});
