// @vitest-environment jsdom
// founder-build r3 ui-9 (FT-R111-2 = FT-R110-2): after services.stop() (test hooks only: the stage's and the shell's)
// a spec holds the store still and patches in a status (stale, rate limited, offline) — but a sweep or an automatic
// weekly receipt that was already running finished after stop(), and its refresh (live.pollNow) re-read meta and the
// snapshot, restamped lastOkAt and cleared lastError: the chip snapped back to Live. A poll already in flight at
// stop() did the same. Now a stopped meter neither refreshes nor adopts a late sweep's documents, and a poll that was
// in flight when live polling stopped writes nothing. pollNow itself is not gated: a running tab's refreshes (a
// sweep's, sample data cleared, Refresh) still read.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { Meta, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import { createLiveController } from '../../src/state/live.ts';
import { createMeterLoop } from '../../src/state/meterLoop.ts';
import type { AppDocs, SweepEngine, VisibilitySource, WeeklyOutcome } from '../../src/state/ports.ts';
import { createAppStore, type AppStore, type SweepSummary } from '../../src/state/store.ts';

// A Monday after 12:00 UTC: the automatic weekly receipt is due.
const NOW = Date.parse('2026-09-28T15:10:00.000Z');
const DEFAULTS: Settings = defaultSettings('2026-09-01T00:00:00.000Z', 'UTC');
const iso = (ms: number) => new Date(ms).toISOString();
const PRICES: PricesDoc = {
  schemaVersion: 1,
  updatedAt: '2026-09-25T00:00:00.000Z',
  versions: [{ effectiveFrom: '2026-09-25T00:00:00.000Z', byOutputId: { mrd_siem_prod: { milliCentsPerGb: 225_000 } } }],
};
const snapshot = (sweepAt: number): Snapshot => ({ sweepAt: iso(sweepAt), destinations: [] }) as unknown as Snapshot;
const META: Meta = {
  schemaVersion: 1,
  installedAt: '2026-09-01T00:00:00.000Z',
  collectingSince: '2026-09-01T00:00:00.000Z',
  appVersion: '1.1.3',
  build: 'release',
  metricsSource: 'metrics-query',
  lastSweepAt: iso(NOW - 45_000),
  lastSweepOwner: 'ui:tab-a',
  sweepErrors: 0,
  consecutiveRateLimited: 0,
  sweepCount: 3,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const visible: VisibilitySource = { hidden: false, addEventListener: () => undefined, removeEventListener: () => undefined };

function store(): AppStore {
  return createAppStore(DEFAULTS, { hasHydrated: true, prices: PRICES, snapshot: snapshot(NOW - 45_000), meta: META });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('r3 ui-9: a stopped meter touches nothing', () => {
  it('a sweep that finishes after stop() neither refreshes nor replaces the documents', async () => {
    const s = store();
    const gate = deferred<SweepSummary>();
    const engine: SweepEngine = { runLocal: vi.fn(() => gate.promise), invokeBackend: vi.fn(async () => ({ ok: true, mode: 'manual' as const })), ownerId: 'ui:tab-a' };
    const refresh = vi.fn(async () => undefined);
    const loop = createMeterLoop({ store: s, engine, refresh, firstDelayMs: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.runLocal).toHaveBeenCalledTimes(1);
    loop.stop();
    const held = s.getState().snapshot;
    // The sweep ran and wrote documents it did not hand back (the case that refreshes), and one it did.
    gate.resolve({ ok: true, mode: 'ui', calls: 20, snapshot: snapshot(NOW) });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(s.getState().snapshot).toBe(held);
    expect(s.getState().status.sweep.running).toBe(false);
  });

  it('an automatic weekly receipt that finishes after stop() does not refresh', async () => {
    const s = store();
    const weekly = deferred<WeeklyOutcome>();
    const engine: SweepEngine = {
      runLocal: vi.fn(async (mode: 'ui' | 'manual'): Promise<SweepSummary> => ({ ok: true, mode, calls: 20, snapshot: snapshot(NOW), meta: { ...META, lastSweepAt: iso(NOW) } })),
      invokeBackend: vi.fn(async () => ({ ok: true, mode: 'manual' as const })),
      runWeekly: vi.fn(() => weekly.promise),
      ownerId: 'ui:tab-a',
    };
    const refresh = vi.fn(async () => undefined);
    const loop = createMeterLoop({ store: s, engine, refresh, firstDelayMs: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.runWeekly).toHaveBeenCalledTimes(1);
    loop.stop();
    weekly.resolve({ sent: 1, endpoints: 1, deliveries: [], calls: 6 });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('while running, both still refresh (the sweep that wrote documents it did not hand back; the weekly send)', async () => {
    const s = store();
    const engine: SweepEngine = {
      runLocal: vi.fn(async (mode: 'ui' | 'manual'): Promise<SweepSummary> => ({ ok: true, mode, calls: 20 })),
      invokeBackend: vi.fn(async () => ({ ok: true, mode: 'manual' as const })),
      runWeekly: vi.fn(async (): Promise<WeeklyOutcome> => ({ sent: 1, endpoints: 1, deliveries: [], calls: 6 })),
      ownerId: 'ui:tab-a',
    };
    const refresh = vi.fn(async () => undefined);
    const loop = createMeterLoop({ store: s, engine, refresh, firstDelayMs: 0 });
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    loop.stop();
  });
});

describe('r3 ui-9: a poll in flight when live polling stops writes nothing', () => {
  function docsWith(metaGate: Promise<Meta | null>): AppDocs {
    return {
      readSettings: async () => DEFAULTS,
      readPrices: async () => PRICES,
      readSnapshot: async () => snapshot(NOW),
      readMeta: () => metaGate,
      readDemoState: async () => null,
      readInventory: async () => null,
      writeSettings: async () => undefined,
      writePrices: async () => undefined,
    };
  }

  it('stop() while a pollNow is out: the patched status holds', async () => {
    const s = store();
    const gate = deferred<Meta | null>();
    const live = createLiveController({ store: s, docs: docsWith(gate.promise), visibility: visible });
    live.start();
    const pending = live.pollNow();
    live.stop();
    // A spec holds the store still and patches in an error.
    const error = { kind: 'server' as const, status: 503, at: NOW };
    s.setState((st) => ({ status: { ...st.status, live: { ...st.status.live, lastError: error, lastOkAt: NOW - 600_000 } } }));
    gate.resolve({ ...META, lastSweepAt: iso(NOW) });
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(s.getState().status.live.lastError).toEqual(error);
    expect(s.getState().status.live.lastOkAt).toBe(NOW - 600_000);
    expect(s.getState().meta).toEqual(META);
  });

  it('a running tab’s pollNow still reads and applies (the sweep refresh, sample data cleared, Refresh)', async () => {
    const s = store();
    const live = createLiveController({ store: s, docs: docsWith(Promise.resolve({ ...META, lastSweepAt: iso(NOW) })), visibility: visible });
    live.start();
    await live.pollNow();
    expect(s.getState().meta?.lastSweepAt).toBe(iso(NOW));
    expect(s.getState().snapshot?.sweepAt).toBe(iso(NOW));
    expect(s.getState().status.live.lastOkAt).toBe(NOW);
    live.stop();
  });
});
