// @vitest-environment jsdom
// What hydration and live polling tell the status dot (EPIC_AUDIT P1-D01, P1-D02): a failed read at boot reaches
// the chip (Offline, Signed out, Rate limited — never "Waiting for the first sweep"), and "the last good data" is
// only ever data that loaded.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, mergeSettings } from '../../core/settings.ts';
import type { Meta, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import { dataUpdatedAt, deriveDataStatus, meteredByLine } from '../../src/components/Shell/status.ts';
import { meteredBy } from '../../src/state/selectors.ts';
import { hydrate, hydrateError } from '../../src/state/hydrate.ts';
import { BACKOFF_WINDOW_MS, createLiveController } from '../../src/state/live.ts';
import type { AppDocs, VisibilitySource } from '../../src/state/ports.ts';
import { createAppStore, type ApiErrorInfo, type AppStore } from '../../src/state/store.ts';

const NOW = Date.parse('2026-09-26T18:00:00.000Z');
const DEFAULTS: Settings = defaultSettings('2026-09-26T00:00:00.000Z', 'UTC');
const merge = (stored: Settings) => mergeSettings(stored, DEFAULTS);

const httpError = (status: number) => Object.assign(new Error(`KV GET failed: HTTP ${status}`), { status });
const snapshot = (sweepAt: string): Snapshot => ({ sweepAt, destinations: [] }) as unknown as Snapshot;
const META: Meta = {
  schemaVersion: 1,
  installedAt: '2026-09-25T00:00:00.000Z',
  collectingSince: '2026-09-25T00:00:00.000Z',
  appVersion: '1.0.0',
  build: 'release',
  metricsSource: 'metrics-query',
  lastSweepAt: '2026-09-26T17:59:40.000Z',
  lastSweepOwner: 'runner:workhorse:1',
  sweepErrors: 0,
  consecutiveRateLimited: 0,
  sweepCount: 3,
};
const PRICES: PricesDoc = { schemaVersion: 1, updatedAt: '2026-09-25T00:00:00.000Z', versions: [] };

type Doc = 'settings' | 'prices' | 'snapshot' | 'meta';
function docsWith(values: Partial<Record<Doc, unknown>>) {
  const state: Record<Doc, unknown> = { settings: null, prices: null, snapshot: null, meta: null, ...values };
  const read = (key: Doc) => async () => {
    const v = state[key];
    if (v instanceof Error) throw v;
    return v as never;
  };
  const docs: AppDocs = {
    readSettings: read('settings'),
    readPrices: read('prices'),
    readSnapshot: read('snapshot'),
    readMeta: read('meta'),
    readDemoState: async () => null,
    readInventory: async () => null,
    writeSettings: async () => undefined,
    writePrices: async () => undefined,
  };
  return { docs, state };
}

const visible: VisibilitySource = { hidden: false, addEventListener: () => undefined, removeEventListener: () => undefined };

async function hydrated(values: Partial<Record<Doc, unknown>>): Promise<{ store: AppStore; state: Record<Doc, unknown>; docs: AppDocs }> {
  const { docs, state } = docsWith(values);
  const store = createAppStore(DEFAULTS);
  await hydrate({ store, docs, mergeSettings: merge, now: () => Date.now() });
  return { store, state, docs };
}

describe('hydrateError: which failed read the status line reports', () => {
  const at = NOW;
  const e = (kind: ApiErrorInfo['kind'], status: number): ApiErrorInfo => ({ kind, status, at });
  it('an expired session first, then a 429, then the first failure in read order; 404 is never an error', () => {
    expect(hydrateError({})).toBeUndefined();
    expect(hydrateError({ snapshot: e('not-found', 404) })).toBeUndefined();
    expect(hydrateError({ snapshot: e('server', 500), prices: e('unauthorized', 401) })?.kind).toBe('unauthorized');
    expect(hydrateError({ snapshot: e('server', 500), meta: e('rate-limited', 429) })?.kind).toBe('rate-limited');
    expect(hydrateError({ prices: e('forbidden', 403), meta: e('server', 502) })?.status).toBe(502);
  });
});

describe('hydration reaches the status dot (P1-D01)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('first run without prices reads "Not metering yet"', async () => {
    const { store } = await hydrated({});
    expect(deriveDataStatus(store.getState(), NOW)).toBe('not-metering');
  });

  it('every KV read answering 500 reads Offline as soon as hydration ends', async () => {
    const { store } = await hydrated({ settings: httpError(500), prices: httpError(500), snapshot: httpError(500), meta: httpError(500) });
    const s = store.getState();
    expect(s.status.hydrate.phase).toBe('error');
    expect(s.status.live.lastError?.kind).toBe('server');
    expect(deriveDataStatus(s, NOW)).toBe('offline');
    expect(dataUpdatedAt(s)).toBeUndefined();
    // Nobody meters from here, and the footer says why instead of "Meters every 30 seconds while open".
    expect(meteredBy(s, NOW)).toBe('unreadable');
    expect(meteredByLine('unreadable', 'ui')).toBe('Metering starts once Meter Reader can read its settings');
  });

  it('a 401 at boot reads Signed out; a 403 on the App\'s own data reads No access', async () => {
    expect(deriveDataStatus((await hydrated({ settings: httpError(401), snapshot: httpError(401), meta: httpError(401), prices: httpError(401) })).store.getState(), NOW)).toBe('signed-out');
    expect(deriveDataStatus((await hydrated({ prices: PRICES, snapshot: httpError(403), meta: META })).store.getState(), NOW)).toBe('no-access');
  });

  it('a 429 at boot backs polling off exactly like the poll path and reads Rate limited', async () => {
    const { store } = await hydrated({ prices: PRICES, snapshot: httpError(429), meta: META });
    const s = store.getState();
    expect(s.status.live.backoffUntil).toBe(NOW + BACKOFF_WINDOW_MS);
    expect(deriveDataStatus(s, NOW)).toBe('rate-limited');
  });

  it('after a good load, a 401 on a poll turns the chip to Signed out, and a good poll turns it back', async () => {
    const { store, state, docs } = await hydrated({ settings: DEFAULTS, prices: PRICES, snapshot: snapshot('2026-09-26T17:59:40.000Z'), meta: META });
    expect(deriveDataStatus(store.getState(), Date.now())).toBe('live');
    const live = createLiveController({ store, docs, visibility: visible });
    live.start();
    state.snapshot = httpError(401);
    state.meta = httpError(401);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deriveDataStatus(store.getState(), Date.now())).toBe('signed-out');
    state.snapshot = snapshot('2026-09-26T18:00:05.000Z');
    state.meta = META;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deriveDataStatus(store.getState(), Date.now())).toBe('live');
    live.stop();
  });
});

describe('"the last good data" is data that loaded (P1-D02)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('a cold load whose snapshot answers 500 has no last good data, even when meta read fine', async () => {
    const { store } = await hydrated({ settings: DEFAULTS, prices: PRICES, snapshot: httpError(500), meta: META });
    const s = store.getState();
    expect(s.status.live.lastOkAt).toBeUndefined();
    expect(dataUpdatedAt(s)).toBeUndefined();
    expect(deriveDataStatus(s, NOW)).toBe('offline');
  });

  it('a poll that reads "no snapshot yet" is not good data either; the first real snapshot is', async () => {
    const { store, state, docs } = await hydrated({ settings: DEFAULTS, prices: PRICES, meta: META });
    expect(store.getState().status.live.lastOkAt).toBeUndefined();
    const live = createLiveController({ store, docs, visibility: visible });
    live.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getState().status.live.lastOkAt).toBeUndefined();
    // The first sweep writes the snapshot, then meta; the poll that sees meta move reads it.
    state.snapshot = snapshot('2026-09-26T18:00:05.000Z');
    state.meta = { ...META, lastSweepAt: '2026-09-26T18:00:05.000Z' };
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getState().status.live.lastOkAt).toBe(Date.now());
    live.stop();
  });

  it('keeps the last good time through a later 5xx, so the notice can quote it', async () => {
    const { store, state, docs } = await hydrated({ settings: DEFAULTS, prices: PRICES, snapshot: snapshot('2026-09-26T17:59:40.000Z'), meta: META });
    const goodAt = store.getState().status.live.lastOkAt;
    expect(goodAt).toBe(NOW);
    const live = createLiveController({ store, docs, visibility: visible });
    live.start();
    state.meta = { ...META, lastSweepAt: '2026-09-26T18:00:05.000Z' }; // a sweep ran; its snapshot won't read
    state.snapshot = httpError(503);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getState().status.live.lastOkAt).toBe(goodAt);
    expect(store.getState().status.live.lastError?.kind).toBe('server');
    live.stop();
  });
});
