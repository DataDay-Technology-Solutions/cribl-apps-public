// @vitest-environment jsdom
// UI foundation: store, hydration merge, live polling cadence and the 'ui' runtime meter loop.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, mergeSettings } from '../../core/settings.ts';
import type { Meta, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import { hydrate, retrySettings, summarizeInventory } from '../../src/state/hydrate.ts';
import { BACKOFF_WINDOW_MS, computePollDelayMs, createLiveController, HIDDEN_POLL_MS } from '../../src/state/live.ts';
import { createMeterLoop, shouldMeter } from '../../src/state/meterLoop.ts';
import type { AppDocs, SweepEngine, VisibilitySource, WeeklyOutcome } from '../../src/state/ports.ts';
import { createAppServices } from '../../src/state/services.ts';
import { toSummary } from '../../src/state/sweepSummary.ts';
import { homeTarget, meterBlocker, meteredBy, pricesAbsent } from '../../src/state/selectors.ts';
import { classifyError, createAppStore, createStore, type AppStore, type SweepSummary } from '../../src/state/store.ts';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const DEFAULTS: Settings = defaultSettings('2026-09-26T00:00:00.000Z', 'America/Chicago');
const merge = (stored: Settings) => mergeSettings(stored, DEFAULTS);

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`KV GET failed: HTTP ${status}`), { status });
}

function snapshotAt(iso: string): Snapshot {
  return {
    schemaVersion: 1,
    sweepAt: iso,
    windowStart: iso,
    windowEnd: iso,
    mode: 'ui',
    headline: {
      todayM: 0, mtdM: 0, d30M: 0, annualizedM: 0, annualizedFromDays: 0, whpMtdM: 0, paidMtdM: 0, ratioMtd: 0,
      whpTodayM: 0, paidTodayM: 0, whp30dM: 0, paid30dM: 0,
    },
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
    calls: 12,
    collectingSince: iso,
    metricsSource: 'metrics-query',
    attributionSummary: 'route',
  };
}

const META: Meta = {
  schemaVersion: 1,
  installedAt: '2026-09-25T00:00:00.000Z',
  collectingSince: '2026-09-25T00:00:00.000Z',
  appVersion: '1.0.0',
  build: 'release',
  metricsSource: 'metrics-query',
  lastSweepAt: '2026-09-26T11:59:30.000Z',
  lastSweepMs: 4100,
  lastSweepCalls: 23,
  sweepErrors: 0,
  consecutiveRateLimited: 0,
  sweepCount: 42,
};

const PRICES: PricesDoc = {
  schemaVersion: 1,
  updatedAt: '2026-09-25T00:00:00.000Z',
  versions: [{ effectiveFrom: '2026-09-25T00:00:00.000Z', byOutputId: { mrd_siem_prod: { milliCentsPerGb: 250_000 } } }],
};

interface FakeDocsOptions {
  settings?: Settings | null | Error;
  prices?: PricesDoc | null | Error;
  snapshot?: Snapshot | null | Error;
  meta?: Meta | null | Error;
}

function fakeDocs(initial: FakeDocsOptions = {}) {
  const state = { settings: null, prices: null, snapshot: null, meta: null, ...initial } as Required<FakeDocsOptions>;
  const calls: string[] = [];
  const writes: { key: string; doc: unknown }[] = [];
  const read = <T>(key: keyof FakeDocsOptions) => async (): Promise<T> => {
    calls.push(key);
    const value = state[key];
    if (value instanceof Error) throw value;
    return value as T;
  };
  const docs: AppDocs = {
    readSettings: read('settings'),
    readPrices: read('prices'),
    readSnapshot: read('snapshot'),
    readMeta: read('meta'),
    readDemoState: async () => {
      calls.push('demoState');
      return null;
    },
    readInventory: async () => {
      calls.push('inventory');
      return null;
    },
    writeSettings: async (doc) => {
      writes.push({ key: 'settings', doc });
    },
    writePrices: async (doc) => {
      writes.push({ key: 'prices', doc });
    },
  };
  return { docs, state, calls, writes };
}

const hiddenVisibility = (hidden: boolean): VisibilitySource & { fire(): void; hidden: boolean } => {
  const listeners = new Set<() => void>();
  return {
    hidden,
    addEventListener: (_type, l) => listeners.add(l),
    removeEventListener: (_type, l) => listeners.delete(l),
    fire: () => listeners.forEach((l) => l()),
  };
};

// ─── store ───────────────────────────────────────────────────────────────────

describe('createStore', () => {
  it('notifies once per effective change and skips no-op patches', () => {
    const store = createStore({ a: 1, b: 'x' });
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ a: 1 });
    expect(listener).not.toHaveBeenCalled();
    store.setState({ a: 2, b: 'y' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).toEqual({ a: 2, b: 'y' });
  });

  it('classifies thrown KV errors by status', () => {
    expect(classifyError(httpError(403)).kind).toBe('forbidden');
    expect(classifyError(httpError(429)).kind).toBe('rate-limited');
    expect(classifyError(new Error('KV GET snapshot failed: HTTP 503')).kind).toBe('server');
    expect(classifyError(new TypeError('Failed to fetch')).kind).toBe('network');
  });
});

// ─── hydration ───────────────────────────────────────────────────────────────

describe('hydrate', () => {
  it('reads meta, settings, snapshot and prices in one batch and applies them in one update', async () => {
    const stored: Settings = { ...DEFAULTS, headlinePeriodDefault: 'annualized', live: { pollSeconds: 30, presenterPollSeconds: 5 } };
    const { docs, calls } = fakeDocs({ settings: stored, prices: PRICES, snapshot: snapshotAt('2026-09-26T11:59:30.000Z'), meta: META });
    const store = createAppStore(DEFAULTS);
    const listener = vi.fn();
    store.subscribe(listener);

    const result = await hydrate({ store, docs, mergeSettings: merge, now: () => NOW });

    expect(result.hydrated).toBe(true);
    expect(calls.sort()).toEqual(['meta', 'prices', 'settings', 'snapshot']);
    // loading phase + the single data update
    expect(listener).toHaveBeenCalledTimes(2);
    const s = store.getState();
    expect(s.hasHydrated).toBe(true);
    expect(s.settingsStored).toBe(true);
    expect(s.snapshot?.sweepAt).toBe('2026-09-26T11:59:30.000Z');
    expect(s.meta?.lastSweepCalls).toBe(23);
    expect(s.prices).toEqual(PRICES);
    expect(s.status.hydrate.phase).toBe('done');
  });

  it('never lets defaults overwrite stored values', async () => {
    // A partial stored document (older build): stored fields win, only missing ones are filled.
    const partial = { schemaVersion: 1, displayTimezone: 'Europe/Berlin', live: { pollSeconds: 45 }, runtime: 'backend' } as unknown as Settings;
    const { docs } = fakeDocs({ settings: partial });
    const store = createAppStore(DEFAULTS);
    await hydrate({ store, docs, mergeSettings: merge, now: () => NOW });
    const { settings } = store.getState();
    expect(settings.displayTimezone).toBe('Europe/Berlin');
    expect(settings.live.pollSeconds).toBe(45);
    expect(settings.live.presenterPollSeconds).toBe(DEFAULTS.live.presenterPollSeconds);
    expect(settings.runtime).toBe('backend');
    expect(settings.thresholds).toEqual(DEFAULTS.thresholds);
  });

  it('treats a missing settings key (404) as first run: defaults shown, writes allowed', async () => {
    const { docs } = fakeDocs({ settings: null });
    const store = createAppStore(DEFAULTS);
    await hydrate({ store, docs, mergeSettings: merge, now: () => NOW });
    const s = store.getState();
    expect(s.hasHydrated).toBe(true);
    expect(s.settingsStored).toBe(false);
    expect(s.settings).toBe(DEFAULTS);
    expect(homeTarget(s)).toBe('first-run');
  });

  it('keeps writes gated when settings are unreadable, then recovers on retry', async () => {
    const { docs, state, writes } = fakeDocs({ settings: httpError(503), snapshot: snapshotAt('2026-09-26T11:59:30.000Z') });
    const store = createAppStore(DEFAULTS);
    const services = createAppServices({
      store,
      docs,
      mergeSettings: merge,
      engine: { runLocal: vi.fn(), invokeBackend: vi.fn() },
      now: () => NOW,
    });
    const result = await hydrate({ store, docs, mergeSettings: merge, now: () => NOW });
    expect(result.hydrated).toBe(false);
    expect(store.getState().hasHydrated).toBe(false);
    expect(store.getState().errors.settings?.kind).toBe('server');
    // The snapshot still rendered (render from snapshot immediately).
    expect(store.getState().snapshot).not.toBeNull();

    const refused = await services.actions.saveSettings({ ...DEFAULTS, goodNewsEnabled: true });
    expect(refused).toEqual({ ok: false, reason: 'not-hydrated' });
    expect(writes).toHaveLength(0);

    state.settings = { ...DEFAULTS, goodNewsEnabled: true };
    expect(await retrySettings({ store, docs, mergeSettings: merge, now: () => NOW })).toBe(true);
    expect(store.getState().settings.goodNewsEnabled).toBe(true);
    expect(store.getState().errors.settings).toBeUndefined();

    const saved = await services.actions.saveSettings({ ...store.getState().settings, goodNewsEnabled: false });
    expect(saved).toEqual({ ok: true });
    expect(writes).toHaveLength(1);
    expect((writes[0].doc as Settings).updatedAt).toBe(new Date(NOW).toISOString());
  });

  it('puts live values in the stash when a tour is already showing', async () => {
    const { docs } = fakeDocs({ settings: DEFAULTS, snapshot: snapshotAt('2026-09-26T11:59:30.000Z'), meta: META });
    const store = createAppStore(DEFAULTS);
    const services = createAppServices({ store, docs, mergeSettings: merge, engine: { runLocal: vi.fn(), invokeBackend: vi.fn() } });
    const sample = snapshotAt('2026-01-01T00:00:00.000Z');
    services.actions.enterSample({ source: 'sample', snapshot: sample });
    await hydrate({ store, docs, mergeSettings: merge, now: () => NOW });
    expect(store.getState().snapshot).toBe(sample);
    services.actions.clearSample();
    expect(store.getState().source).toBe('live');
    expect(store.getState().snapshot?.sweepAt).toBe('2026-09-26T11:59:30.000Z');
  });

  it('summarizes inventory for the chrome', () => {
    const summary = summarizeInventory({
      schemaVersion: 1,
      updatedAt: 'x',
      hash: 'h',
      byGroup: {
        default: { inputs: [{ id: 'a', type: 'datagen' }], outputs: [{ id: 'o', type: 'devnull' }], pipelines: [], routes: [] },
      },
    });
    expect(summary).toEqual({ updatedAt: 'x', groups: ['default'], counts: { inputs: 1, outputs: 1, pipelines: 0, routes: 0 } });
  });
});

// ─── live polling ────────────────────────────────────────────────────────────

describe('live polling cadence', () => {
  const live = { pollSeconds: 10, presenterPollSeconds: 5 };
  it('uses 10 s visible, 5 s presenter, 60 s hidden and 60 s in 429 backoff', () => {
    expect(computePollDelayMs({ hidden: false, presenter: false, live, now: NOW })).toBe(10_000);
    expect(computePollDelayMs({ hidden: false, presenter: true, live, now: NOW })).toBe(5_000);
    expect(computePollDelayMs({ hidden: true, presenter: true, live, now: NOW })).toBe(HIDDEN_POLL_MS);
    expect(computePollDelayMs({ hidden: false, presenter: true, live, now: NOW, backoffUntil: NOW + 1 })).toBe(60_000);
    expect(computePollDelayMs({ hidden: false, presenter: false, live, now: NOW, backoffUntil: NOW - 1 })).toBe(10_000);
  });

  it('clamps out-of-range stored intervals to the SPEC 5 ranges', () => {
    expect(computePollDelayMs({ hidden: false, presenter: false, live: { pollSeconds: 1, presenterPollSeconds: 99 }, now: NOW })).toBe(5_000);
    expect(computePollDelayMs({ hidden: false, presenter: true, live: { pollSeconds: 1, presenterPollSeconds: 99 }, now: NOW })).toBe(30_000);
  });
});

describe('createLiveController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  async function hydratedStore(docs: AppDocs): Promise<AppStore> {
    const store = createAppStore(DEFAULTS);
    await hydrate({ store, docs, mergeSettings: merge });
    return store;
  }

  it('reads meta every poll interval, and the snapshot only once meta says a sweep wrote a new one (P1-D05)', async () => {
    const fake = fakeDocs({ settings: DEFAULTS, prices: PRICES, snapshot: snapshotAt('2026-09-26T11:59:00.000Z'), meta: META });
    const store = await hydratedStore(fake.docs);
    fake.calls.length = 0;
    const controller = createLiveController({ store, docs: fake.docs, visibility: hiddenVisibility(false) });
    controller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.calls).toEqual(['meta']);
    // A sweep writes the snapshot, then meta: the next poll sees meta move and reads the snapshot right after.
    fake.state.snapshot = snapshotAt('2026-09-26T12:00:05.000Z');
    fake.state.meta = { ...META, lastSweepAt: '2026-09-26T12:00:05.000Z' };
    fake.calls.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.calls).toEqual(['meta', 'snapshot']);
    expect(store.getState().snapshot?.sweepAt).toBe('2026-09-26T12:00:05.000Z');
    controller.stop();
  });

  it('backs off to 60 s for 5 minutes on a KV 429', async () => {
    const fake = fakeDocs({ settings: DEFAULTS, snapshot: snapshotAt('2026-09-26T11:59:00.000Z'), meta: META });
    const store = await hydratedStore(fake.docs);
    const controller = createLiveController({ store, docs: fake.docs, visibility: hiddenVisibility(false) });
    controller.start();
    fake.state.meta = httpError(429);
    await vi.advanceTimersByTimeAsync(10_000);
    const status = store.getState().status.live;
    expect(status.backoffUntil).toBe(Date.now() + BACKOFF_WINDOW_MS);
    expect(status.nextPollAt! - Date.now()).toBe(60_000);
    // The last good snapshot is kept.
    expect(store.getState().snapshot?.sweepAt).toBe('2026-09-26T11:59:00.000Z');
    controller.stop();
  });

  it('reads nothing while a tour is showing and polls immediately when it is cleared', async () => {
    const fake = fakeDocs({ settings: DEFAULTS, prices: PRICES, snapshot: snapshotAt('2026-09-26T11:59:00.000Z'), meta: META });
    const store = await hydratedStore(fake.docs);
    const services = createAppServices({ store, docs: fake.docs, mergeSettings: merge, engine: { runLocal: vi.fn(), invokeBackend: vi.fn() } });
    services.live.start();
    services.actions.enterSample({ source: 'sample', snapshot: snapshotAt('2026-01-01T00:00:00.000Z') });
    fake.calls.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.calls).toEqual([]);
    services.actions.clearSample();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.sort()).toEqual(['meta', 'snapshot']);
    services.live.stop();
  });

  it('polls immediately when the tab becomes visible', async () => {
    const fake = fakeDocs({ settings: DEFAULTS, prices: PRICES, snapshot: snapshotAt('2026-09-26T11:59:00.000Z'), meta: META });
    const store = await hydratedStore(fake.docs);
    const visibility = hiddenVisibility(true);
    const controller = createLiveController({ store, docs: fake.docs, visibility });
    controller.start();
    expect(store.getState().status.live.nextPollAt! - Date.now()).toBe(HIDDEN_POLL_MS);
    fake.calls.length = 0;
    visibility.hidden = false;
    visibility.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.sort()).toEqual(['meta', 'snapshot']);
    controller.stop();
  });

  it('re-reads prices every 20 s while none exist and once a minute after, adopts them once saved elsewhere, and adopts a newer save from another tab (P1-D04, P1-D05)', async () => {
    const fake = fakeDocs({ settings: DEFAULTS, prices: null, snapshot: null, meta: null });
    const store = await hydratedStore(fake.docs);
    expect(pricesAbsent(store.getState())).toBe(true);
    fake.calls.length = 0;
    const controller = createLiveController({ store, docs: fake.docs, visibility: hiddenVisibility(false) });
    controller.start();
    // Hydration read prices a moment ago: while none exist, the 10 s polls read them every 20 s (not every poll),
    // and meta each poll (no sweep has written meta yet, so there is no snapshot to read either).
    await vi.advanceTimersByTimeAsync(50_000);
    expect(fake.calls.filter((c) => c === 'prices')).toHaveLength(2);
    expect(fake.calls.filter((c) => c === 'meta')).toHaveLength(5);
    expect(fake.calls.filter((c) => c === 'snapshot')).toEqual([]);

    fake.state.prices = PRICES; // another tab saved prices
    fake.calls.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.calls.sort()).toEqual(['meta', 'prices']);
    expect(store.getState().prices).toEqual(PRICES);

    // Held prices are still re-read once a minute; a NEWER document from another tab replaces them.
    const newer: PricesDoc = { ...PRICES, updatedAt: '2026-09-26T12:01:00.000Z' };
    fake.state.prices = newer;
    fake.calls.length = 0;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(fake.calls.filter((c) => c === 'prices')).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.calls.filter((c) => c === 'prices')).toEqual(['prices']);
    expect(store.getState().prices).toEqual(newer);
    controller.stop();
  });

  it('never replaces prices this tab already holds', async () => {
    const fake = fakeDocs({ settings: DEFAULTS, prices: null, snapshot: null, meta: null });
    const store = await hydratedStore(fake.docs);
    const controller = createLiveController({ store, docs: fake.docs, visibility: hiddenVisibility(false) });
    controller.start();
    const mine: PricesDoc = { ...PRICES, updatedAt: '2026-09-26T11:59:59.000Z' };
    // The poll's read goes out while prices are absent; this tab saves before it answers.
    fake.state.prices = PRICES;
    const poll = controller.pollNow();
    store.setState({ prices: mine });
    await poll;
    expect(store.getState().prices).toBe(mine);
    controller.stop();
  });
});

// ─── meter loop ('ui' runtime) ───────────────────────────────────────────────

describe('createMeterLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const okSummary = (mode: 'ui' | 'manual'): SweepSummary => ({ ok: true, mode, calls: 16, durationMs: 900 });

  function engine(): SweepEngine & { runLocal: ReturnType<typeof vi.fn>; invokeBackend: ReturnType<typeof vi.fn> } {
    return {
      runLocal: vi.fn(async (mode: 'ui' | 'manual') => okSummary(mode)),
      invokeBackend: vi.fn(async () => okSummary('manual')),
    };
  }

  it('meters every 30 s only when hydrated, live and runtime is ui', async () => {
    const store = createAppStore(DEFAULTS, { prices: PRICES });
    const eng = engine();
    const loop = createMeterLoop({ store, engine: eng, firstDelayMs: 1_000 });
    loop.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(eng.runLocal).not.toHaveBeenCalled(); // not hydrated

    store.setState({ hasHydrated: true });
    expect(shouldMeter(store.getState())).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(eng.runLocal).toHaveBeenCalledTimes(1);
    expect(eng.runLocal).toHaveBeenLastCalledWith('ui');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(eng.runLocal).toHaveBeenCalledTimes(2);

    store.setState({ source: 'sample' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(eng.runLocal).toHaveBeenCalledTimes(2);
    expect(eng.invokeBackend).not.toHaveBeenCalled(); // never on a timer
    loop.stop();
  });

  it('does not meter on the backend runtime or in replay mode', () => {
    const store = createAppStore({ ...DEFAULTS, runtime: 'backend' }, { hasHydrated: true });
    expect(shouldMeter(store.getState())).toBe(false);
    store.setState({ settings: { ...DEFAULTS, demo: { ...DEFAULTS.demo, replayMode: true } } });
    expect(shouldMeter(store.getState())).toBe(false);
  });

  it('throttles Sweep now to once per 30 s and routes it by runtime', async () => {
    const store = createAppStore(DEFAULTS, { hasHydrated: true, prices: PRICES });
    const eng = engine();
    const refresh = vi.fn(async () => undefined);
    const loop = createMeterLoop({ store, engine: eng, refresh });

    const first = await loop.sweepNow();
    expect(first.status).toBe('done');
    expect(eng.runLocal).toHaveBeenLastCalledWith('manual');
    expect(refresh).toHaveBeenCalledTimes(1); // the summary carried no snapshot → re-read KV

    const second = await loop.sweepNow();
    expect(second).toEqual({ status: 'throttled', retryInMs: 30_000 });

    await vi.advanceTimersByTimeAsync(30_000);
    store.setState({ settings: { ...DEFAULTS, runtime: 'backend' } });
    const third = await loop.sweepNow();
    expect(third.status).toBe('done');
    expect(eng.invokeBackend).toHaveBeenCalledTimes(1);
    expect(store.getState().status.sweep.lastResult?.calls).toBe(16);
  });

  it('refuses Sweep now before hydration and during a tour', async () => {
    const store = createAppStore(DEFAULTS);
    const loop = createMeterLoop({ store, engine: engine() });
    expect(await loop.sweepNow()).toEqual({ status: 'blocked', reason: 'not-hydrated' });
    store.setState({ hasHydrated: true, source: 'replay' });
    expect(await loop.sweepNow()).toEqual({ status: 'blocked', reason: 'not-live' });
  });

  // REVIEW-3a #3: a sweep before prices exist meters the seed hour (and every minute after) at $0 for good.
  it('does not meter in the ui runtime until a prices document exists, then sweeps at once', async () => {
    const store = createAppStore(DEFAULTS, { hasHydrated: true });
    const eng = engine();
    const loop = createMeterLoop({ store, engine: eng, firstDelayMs: 3_000 });
    loop.start();
    expect(meterBlocker(store.getState())).toBe('no-prices');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(eng.runLocal).not.toHaveBeenCalled();
    expect(store.getState().status.sweep.metering).toBe(false);
    expect(await loop.sweepNow()).toEqual({ status: 'blocked', reason: 'no-prices' });
    expect(eng.runLocal).not.toHaveBeenCalled();

    // "Save changes" on Prices: the first sweep runs now, not after the 3 s first-paint delay.
    store.setState({ prices: PRICES });
    expect(store.getState().status.sweep.metering).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(eng.runLocal).toHaveBeenCalledTimes(1);
    expect(eng.runLocal).toHaveBeenLastCalledWith('ui');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(eng.runLocal).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('keeps the first-paint delay when prices were there at hydration', async () => {
    const store = createAppStore(DEFAULTS, { prices: PRICES });
    const eng = engine();
    const loop = createMeterLoop({ store, engine: eng, firstDelayMs: 3_000 });
    loop.start();
    store.setState({ hasHydrated: true });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(eng.runLocal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(eng.runLocal).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('treats an unreadable prices document as unknown, not absent: it keeps metering', () => {
    const store = createAppStore(DEFAULTS, { hasHydrated: true, errors: { prices: { kind: 'server', status: 503, at: NOW } } });
    expect(pricesAbsent(store.getState())).toBe(false);
    expect(shouldMeter(store.getState())).toBe(true);
    store.setState({ errors: { prices: { kind: 'not-found', status: 404, at: NOW } } });
    expect(meterBlocker(store.getState())).toBe('no-prices');
    // The backend runtime has no tab gate: Sweep now invokes the endpoint with or without prices.
    store.setState({ settings: { ...DEFAULTS, runtime: 'backend' } });
    expect(meterBlocker(store.getState())).toBe('not-ui');
  });

  it('records this tab\'s lock owner and remembers the newest runner sweep across a minute a tab won', () => {
    const store = createAppStore(DEFAULTS, { hasHydrated: true, prices: PRICES });
    const loop = createMeterLoop({ store, engine: { ...engine(), ownerId: 'ui:tab-1' } });
    loop.start();
    expect(store.getState().status.sweep.ownerId).toBe('ui:tab-1');
    store.setState({ meta: { ...META, lastSweepOwner: 'runner:mac:42', lastSweepAt: '2026-09-26T11:59:08.000Z' } });
    expect(store.getState().status.sweep.runnerSeenAt).toBe(Date.parse('2026-09-26T11:59:08.000Z'));
    store.setState({ meta: { ...META, lastSweepOwner: 'ui:tab-1', lastSweepAt: '2026-09-26T11:59:40.000Z' } });
    expect(store.getState().status.sweep.runnerSeenAt).toBe(Date.parse('2026-09-26T11:59:08.000Z'));
    expect(meteredBy(store.getState(), NOW)).toBe('runner');
    expect(meteredBy(store.getState(), NOW + 120_000)).toBe('this-tab');
    loop.stop();
  });
});

// ─── weekly receipt (SPEC 11, D12b; REVIEW-3a #4) ────────────────────────────

describe('weekly receipt from the meter loop', () => {
  /** Monday 28 Sep 2026, 12:05 UTC: just past the send time. */
  const MONDAY = Date.parse('2026-09-28T12:05:00.000Z');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(MONDAY);
  });
  afterEach(() => vi.useRealTimers());

  const okSweep = (mode: 'ui' | 'manual'): SweepSummary => ({ ok: true, mode, calls: 16, durationMs: 900 });
  const sent = (n: number): WeeklyOutcome => ({ sent: n, endpoints: n, deliveries: [], calls: 6 });
  const weeklyMeta: Meta = { ...META, collectingSince: '2026-09-20T00:00:00.000Z', lastSweepAt: '2026-09-28T12:04:40.000Z' };

  function weeklyEngine(results: WeeklyOutcome[]) {
    const queue = [...results];
    return {
      runLocal: vi.fn(async (mode: 'ui' | 'manual') => okSweep(mode)),
      invokeBackend: vi.fn(async () => okSweep('manual')),
      runWeekly: vi.fn(async (_mode: 'manual' | 'ui', _runtime: Settings['runtime']) => queue.shift() ?? sent(1)),
    };
  }

  it('sends once when an open tab crosses Monday 12:00 UTC, after the sweep, and not again that week', async () => {
    const store = createAppStore(DEFAULTS, { hasHydrated: true, prices: PRICES, meta: weeklyMeta });
    const eng = weeklyEngine([sent(2)]);
    const loop = createMeterLoop({ store, engine: eng, firstDelayMs: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(eng.runLocal).toHaveBeenCalledTimes(1);
    expect(eng.runWeekly).toHaveBeenCalledTimes(1);
    expect(eng.runWeekly).toHaveBeenLastCalledWith('ui', 'ui');
    expect(eng.runLocal.mock.invocationCallOrder[0]).toBeLessThan(eng.runWeekly.mock.invocationCallOrder[0]);
    expect(store.getState().status.sweep.lastWeekly).toMatchObject({ mode: 'ui', outcome: { sent: 2 } });
    // The next ticks of the same Monday do not send again, even before meta.lastWeeklySentAt is read back.
    await vi.advanceTimersByTimeAsync(5 * 30_000);
    expect(eng.runWeekly).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it('settles a week with nothing to send, and retries when another sweep held the lock', async () => {
    const store = createAppStore(DEFAULTS, { hasHydrated: true, prices: PRICES, meta: weeklyMeta });
    const eng = weeklyEngine([
      { ...sent(0), skipped: 'locked' },
      { ...sent(0), skipped: 'no_endpoints' },
    ]);
    const loop = createMeterLoop({ store, engine: eng, firstDelayMs: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(eng.runWeekly).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(eng.runWeekly).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 30_000);
    expect(eng.runWeekly).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('leaves the Monday send to the runner while it is metering; a tab first open later in the week sends it late, once', async () => {
    const runnerMeta: Meta = { ...weeklyMeta, lastSweepOwner: 'runner:mac:42', lastSweepAt: '2026-09-28T12:04:08.000Z' };
    const store = createAppStore(DEFAULTS, { hasHydrated: true, prices: PRICES, meta: runnerMeta });
    const eng = weeklyEngine([]);
    const loop = createMeterLoop({ store, engine: eng, firstDelayMs: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    // The runner swept 52 s ago: the tab yields to it entirely (P1-D05) — no sweep, and no Monday send.
    expect(eng.runLocal).not.toHaveBeenCalled();
    expect(eng.runWeekly).not.toHaveBeenCalled();
    expect(store.getState().status.sweep.metering).toBe(false);
    loop.stop();

    // Tuesday 13:00 UTC: more than a day after the send time. The week's receipt was never sent, so the first open
    // tab sends it (core/weekly.ts WEEKLY_AUTO_WINDOW_MS is the whole week; the receipt says it was sent late).
    vi.setSystemTime(Date.parse('2026-09-29T13:00:00.000Z'));
    const late = createAppStore(DEFAULTS, { hasHydrated: true, prices: PRICES, meta: weeklyMeta });
    const eng2 = weeklyEngine([]);
    const loop2 = createMeterLoop({ store: late, engine: eng2, firstDelayMs: 0 });
    loop2.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(eng2.runLocal).toHaveBeenCalledTimes(1);
    expect(eng2.runWeekly).toHaveBeenCalledTimes(1);
    expect(eng2.runWeekly).toHaveBeenLastCalledWith('ui', 'ui');
    loop2.stop();

    // Already sent this week (Monday 12:30 UTC): Thursday's tab sends nothing.
    vi.setSystemTime(Date.parse('2026-10-01T13:00:00.000Z'));
    const sentMeta: Meta = { ...weeklyMeta, lastWeeklySentAt: '2026-09-28T12:30:00.000Z' };
    const done = createAppStore(DEFAULTS, { hasHydrated: true, prices: PRICES, meta: sentMeta });
    const eng3 = weeklyEngine([]);
    const loop3 = createMeterLoop({ store: done, engine: eng3, firstDelayMs: 0 });
    loop3.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(eng3.runWeekly).not.toHaveBeenCalled();
    loop3.stop();
  });

  it('"Send this week\'s receipt" sends every press in the member\'s runtime, and refuses on sample data', async () => {
    const store = createAppStore({ ...DEFAULTS, runtime: 'backend' }, { hasHydrated: true, prices: PRICES, meta: weeklyMeta });
    const eng = weeklyEngine([sent(1), { ...sent(0), endpoints: 1 }]);
    const loop = createMeterLoop({ store, engine: eng });
    expect(await loop.sendWeekly()).toEqual({ status: 'done', outcome: sent(1) });
    expect(eng.runWeekly).toHaveBeenLastCalledWith('manual', 'backend');
    const second = await loop.sendWeekly();
    expect(second).toMatchObject({ status: 'done', outcome: { sent: 0, endpoints: 1 } });
    expect(store.getState().status.sweep.lastWeekly?.mode).toBe('manual');
    store.setState({ source: 'sample' });
    expect(await loop.sendWeekly()).toEqual({ status: 'blocked', reason: 'not-live' });
    const bare = createMeterLoop({ store: createAppStore(DEFAULTS, { hasHydrated: true }), engine: { runLocal: vi.fn(), invokeBackend: vi.fn() } });
    expect(await bare.sendWeekly()).toEqual({ status: 'blocked', reason: 'unavailable' });
    expect(eng.runWeekly).toHaveBeenCalledTimes(2);
  });
});

describe('toSummary', () => {
  it('maps an arbitrary sweep result defensively', () => {
    expect(toSummary({ calls: 23, durationMs: 4100, snapshot: { sweepAt: 'x' } }, 'ui', 5)).toMatchObject({
      ok: true,
      mode: 'ui',
      calls: 23,
      durationMs: 4100,
      snapshot: { sweepAt: 'x' },
    });
    expect(toSummary({ skipped: 'locked' }, 'manual', 7)).toMatchObject({ ok: true, skipped: 'locked', durationMs: 7 });
    expect(toSummary(undefined, 'ui', 3)).toMatchObject({ ok: true, durationMs: 3 });
    expect(toSummary({ error: 'rate_limited' }, 'ui', 3)).toMatchObject({ ok: false, error: 'rate_limited' });
  });
});
