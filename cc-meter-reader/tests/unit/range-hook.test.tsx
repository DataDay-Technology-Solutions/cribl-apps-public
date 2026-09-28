// @vitest-environment jsdom
// The Receipt's range hook (src/views/Receipt/useRange.ts) against the API budget (api-budget F2): a range
// replaced mid-read aborts it and the next one waits out the settle time, StrictMode's discarded mount reads
// nothing, an equal but re-created spec is the same range, and a 429 keeps the last figures on screen and
// retries by itself at the time the reader gives (or, with nothing on screen yet, is an error that says when).

import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RangeFigures, RangeSpec } from '../../core/range.ts';
import { defaultSettings } from '../../core/settings.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import type { RangeReadOk, RangeReadResult } from '../../src/state/rangeReader.ts';
import type { AppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';
import { SPEC_SETTLE_MS, useRange } from '../../src/views/Receipt/useRange.ts';

const NOW = Date.parse('2026-09-26T17:34:56.000Z');
const SIX: RangeSpec = { kind: 'relative', hours: 6 };
const DAY: RangeSpec = { kind: 'relative', hours: 24 };

interface Call {
  spec: RangeSpec;
  signal?: AbortSignal;
  resolve: (r: RangeReadResult) => void;
}

function harness() {
  const calls: Call[] = [];
  const readRange = vi.fn((spec: RangeSpec, signal?: AbortSignal) => new Promise<RangeReadResult>((resolve) => calls.push({ spec, signal, resolve })));
  const store = createAppStore(defaultSettings('2026-09-26T12:00:00.000Z', 'UTC'));
  const services = { store, actions: { readRange } } as unknown as AppServices;
  const wrapper = ({ children }: { children: ReactNode }) => <AppProviders services={services}>{children}</AppProviders>;
  const strictWrapper = ({ children }: { children: ReactNode }) => (
    <StrictMode>
      <AppProviders services={services}>{children}</AppProviders>
    </StrictMode>
  );
  return { calls, readRange, wrapper, strictWrapper };
}

function ok(spec: RangeSpec, savedM: number): RangeReadOk {
  const figures = { savedM, whpM: savedM * 2, paidM: savedM, fromMs: NOW - 6 * 3_600_000, toMs: NOW, granularity: 'minute', rows: 1 } as unknown as RangeFigures;
  return { ok: true, spec, resolved: { fromMs: figures.fromMs, toMs: figures.toMs, clippedStart: false, clippedEnd: false, clippedRetention: false, future: false }, figures, planned: 3, cached: 0 };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = () => act(async () => {
  await vi.advanceTimersByTimeAsync(0);
});

describe('useRange and the API budget', () => {
  it('StrictMode: the discarded first mount reads nothing — one read, not two', async () => {
    const h = harness();
    renderHook(() => useRange(SIX, true, 'sweep-1'), { wrapper: h.strictWrapper });
    await flush();
    expect(h.readRange).toHaveBeenCalledTimes(1);
    expect(h.calls[0].signal?.aborted).toBe(false);
  });

  it('an equal but re-created spec is the same range: no new read', async () => {
    const h = harness();
    const { rerender } = renderHook(({ spec }) => useRange(spec, true, 'sweep-1'), { wrapper: h.wrapper, initialProps: { spec: { ...SIX } } });
    await flush();
    rerender({ spec: { ...SIX } });
    await flush();
    expect(h.readRange).toHaveBeenCalledTimes(1);
  });

  it('a new range right after another aborts the read in flight and waits out the settle time; the last one wins', async () => {
    const h = harness();
    const { rerender, result } = renderHook(({ spec }) => useRange(spec, true, 'sweep-1'), { wrapper: h.wrapper, initialProps: { spec: SIX } });
    await flush();
    expect(h.calls).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    rerender({ spec: DAY });
    await flush();
    expect(h.calls[0].signal?.aborted).toBe(true);
    expect(h.calls).toHaveLength(1); // held: 100 ms after the last start
    rerender({ spec: { kind: 'relative', hours: 168 } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPEC_SETTLE_MS - 100 - 1);
    });
    expect(h.calls).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(h.calls.map((c) => c.spec)).toEqual([SIX, { kind: 'relative', hours: 168 }]);
    // The aborted read's answer never lands.
    await act(async () => h.calls[0].resolve(ok(SIX, 100)));
    expect(result.current.state.status).toBe('loading');
    await act(async () => h.calls[1].resolve(ok({ kind: 'relative', hours: 168 }, 700)));
    expect(result.current.result?.figures.savedM).toBe(700);
  });

  it('a refresh of the same range and a retry start at once (no settle wait)', async () => {
    const h = harness();
    const { rerender, result } = renderHook(({ key }) => useRange(SIX, true, key), { wrapper: h.wrapper, initialProps: { key: 'sweep-1' } });
    await flush();
    await act(async () => h.calls[0].resolve(ok(SIX, 100)));
    rerender({ key: 'sweep-2' });
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(result.current.state).toMatchObject({ status: 'loading', previous: { figures: { savedM: 100 } } });
    expect(result.current.result?.figures.savedM).toBe(100); // the old figures stay while the refresh reads
    await act(async () => h.calls[1].resolve({ ok: false, reason: 'error', error: { kind: 'server', status: 503, at: NOW } }));
    expect(result.current.state.status).toBe('error');
    act(() => result.current.retry());
    await flush();
    expect(h.calls).toHaveLength(3);
  });

  it('a 429 on a refresh keeps the last figures on screen and retries by itself when the reader says', async () => {
    const h = harness();
    const { rerender, result } = renderHook(({ key }) => useRange(SIX, true, key), { wrapper: h.wrapper, initialProps: { key: 'sweep-1' } });
    await flush();
    await act(async () => h.calls[0].resolve(ok(SIX, 100)));
    rerender({ key: 'sweep-2' });
    await flush();
    const retryAtMs = NOW + 30_000;
    await act(async () => h.calls[1].resolve({ ok: false, reason: 'rate-limited', error: { kind: 'rate-limited', status: 429, at: NOW }, retryAtMs }));
    expect(result.current.state).toMatchObject({ status: 'ready', retryAtMs, result: { figures: { savedM: 100 } } });
    expect(result.current.result?.figures.savedM).toBe(100);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(h.calls).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    await flush(); // the retry re-renders; its read starts on the next tick
    expect(h.calls).toHaveLength(3);
    await act(async () => h.calls[2].resolve(ok(SIX, 160)));
    expect(result.current.state).toMatchObject({ status: 'ready', result: { figures: { savedM: 160 } } });
    expect(result.current.state).not.toHaveProperty('retryAtMs');
  });

  it('a 429 before any figures is an error that says when it retries, and it does', async () => {
    const h = harness();
    const { result } = renderHook(() => useRange(DAY, true, 'sweep-1'), { wrapper: h.wrapper });
    await flush();
    const retryAtMs = NOW + 60_000;
    await act(async () => h.calls[0].resolve({ ok: false, reason: 'rate-limited', error: { kind: 'rate-limited', status: 429, at: NOW }, retryAtMs }));
    expect(result.current.state).toMatchObject({ status: 'error', reason: 'rate-limited', retryAtMs });
    expect(result.current.result).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_100);
    });
    await flush();
    expect(h.calls).toHaveLength(2);
    expect(result.current.state.status).toBe('loading');
  });

  it('disabled or absent is idle and reads nothing; disabling aborts the read in flight', async () => {
    const h = harness();
    const { rerender, result } = renderHook(({ on }) => useRange(SIX, on, 'sweep-1'), { wrapper: h.wrapper, initialProps: { on: true } });
    await flush();
    expect(h.calls).toHaveLength(1);
    rerender({ on: false });
    await flush();
    expect(h.calls[0].signal?.aborted).toBe(true);
    expect(result.current.state).toEqual({ status: 'idle' });
    const idle = renderHook(() => useRange(undefined, true, 'sweep-1'), { wrapper: h.wrapper });
    await flush();
    expect(idle.result.current.state).toEqual({ status: 'idle' });
    expect(h.calls).toHaveLength(1);
  });
});
