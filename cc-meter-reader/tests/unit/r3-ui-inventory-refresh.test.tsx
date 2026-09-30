// @vitest-environment jsdom
// founder-build r3 ui-3 (FINDINGS_R3 #8): before the first sweep, the destination list re-reads the Leader about every
// minute and when the window gains focus; every mounted section shares one timer (one Leader walk per move, not one per
// section); once a sweep is known the read follows the sweeps again and the clock stops.

import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { InventoryDoc, Meta } from '../../core/types.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import { createAppStore } from '../../src/state/store.ts';
import { createAppServices } from '../../src/state/services.ts';
import type { AppDocs } from '../../src/state/ports.ts';
import { UNSWEPT_INVENTORY_REFRESH_MS, useInventory } from '../../src/views/Settings/hooks.ts';

const NOW_ISO = '2026-09-28T23:10:00.000Z';

function inventory(n: number): InventoryDoc {
  return {
    schemaVersion: 1,
    updatedAt: NOW_ISO,
    hash: `h${n}`,
    byGroup: { default: { inputs: [], pipelines: [], routes: [], outputs: Array.from({ length: n }, (_, i) => ({ id: `out_${i}`, type: 'splunk_hec' })) } },
  };
}

function world() {
  let outputs = 4;
  const docs: AppDocs = {
    readSettings: async () => null,
    readPrices: async () => null,
    readSnapshot: async () => null,
    readMeta: async () => null,
    readDemoState: async () => null,
    readInventory: vi.fn(async () => null),
    readLeaderInventory: vi.fn(async () => inventory(outputs)),
    writeSettings: async () => {},
    writePrices: async () => {},
  };
  const store = createAppStore(defaultSettings(NOW_ISO, 'UTC'), { hasHydrated: true, source: 'live' });
  const services = createAppServices({ store, docs, mergeSettings: (s) => s, engine: { runLocal: vi.fn(), invokeBackend: vi.fn() } });
  const wrapper = ({ children }: { children: ReactNode }) => <AppProviders services={services}>{children}</AppProviders>;
  return { docs, store, wrapper, grow: (n: number) => (outputs = n) };
}

const outputsOf = (inv: InventoryDoc | null): number => inv?.byGroup.default?.outputs.length ?? 0;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('r3 ui-3: a never-swept workspace re-reads its destinations', () => {
  it('about every minute, once for every mounted section', async () => {
    vi.useFakeTimers();
    const w = world();
    const a = renderHook(() => useInventory(), { wrapper: w.wrapper });
    const b = renderHook(() => useInventory(), { wrapper: w.wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(outputsOf(a.result.current.inventory)).toBe(4);
    expect(w.docs.readLeaderInventory).toHaveBeenCalledTimes(1);
    w.grow(12);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSWEPT_INVENTORY_REFRESH_MS + 10);
    });
    expect(outputsOf(a.result.current.inventory)).toBe(12);
    expect(outputsOf(b.result.current.inventory)).toBe(12);
    expect(w.docs.readLeaderInventory).toHaveBeenCalledTimes(2);
    // The list is kept while a re-read is in flight (no loading flash).
    expect(a.result.current.phase).toBe('ready');
  });

  it('when the window gains focus (not twice within a few seconds)', async () => {
    vi.useFakeTimers();
    const w = world();
    const a = renderHook(() => useInventory(), { wrapper: w.wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    w.grow(9);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(outputsOf(a.result.current.inventory)).toBe(9);
    expect(w.docs.readLeaderInventory).toHaveBeenCalledTimes(2);
  });

  it('stops once a sweep is known (the read follows the sweeps again)', async () => {
    vi.useFakeTimers();
    const w = world();
    renderHook(() => useInventory(), { wrapper: w.wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    act(() => w.store.setState({ meta: { lastSweepAt: NOW_ISO } as Meta }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    const calls = (w.docs.readInventory as ReturnType<typeof vi.fn>).mock.calls.length + (w.docs.readLeaderInventory as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * UNSWEPT_INVENTORY_REFRESH_MS);
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect((w.docs.readInventory as ReturnType<typeof vi.fn>).mock.calls.length + (w.docs.readLeaderInventory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
  });

  it('sample data never reads the Leader', async () => {
    vi.useFakeTimers();
    const w = world();
    act(() => w.store.setState({ source: 'sample' }));
    renderHook(() => useInventory(), { wrapper: w.wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * UNSWEPT_INVENTORY_REFRESH_MS);
    });
    expect(w.docs.readLeaderInventory).not.toHaveBeenCalled();
  });
});
