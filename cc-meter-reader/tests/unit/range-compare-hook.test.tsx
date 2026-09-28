// @vitest-environment jsdom
// "Compare with…" in the Receipt's range hook (P2-W13, src/views/Receipt/useRange.ts): the two windows are read
// one after the other through the same action and signal — the aligned current window first, the baseline only
// once it landed — a 429 on the first starts no second GET, a refused comparison reads the range alone, a 429 on
// the baseline keeps the last comparison on screen and retries by itself, and switching the comparison on never
// shows the plain range's figures as its own.

import type { ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComparisonPlan, ComparisonRefusal, RangeFigures, RangeSpec } from '../../core/range.ts';
import { defaultSettings } from '../../core/settings.ts';
import { AppProviders } from '../../src/state/providers.tsx';
import type { RangeReadOk, RangeReadResult } from '../../src/state/rangeReader.ts';
import type { AppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';
import { useRange, type CompareRequest } from '../../src/views/Receipt/useRange.ts';

const NOW = Date.parse('2026-09-26T17:34:56.000Z');
const H = 3_600_000;
const DAY: RangeSpec = { kind: 'relative', hours: 24 };
const END = Date.parse('2026-09-26T17:00:00.000Z');
const PLAN: ComparisonPlan = {
  ok: true,
  vs: { kind: 'prev' },
  current: { fromMs: END - 24 * H, toMs: END },
  baseline: { fromMs: END - 48 * H, toMs: END - 24 * H },
  alignedTo: 'hour',
  realigned: true,
  baselineClipped: false,
  reads: 6,
};
const REFUSED: ComparisonRefusal = { ok: false, vs: { kind: 'week' }, reason: 'week-too-long' };

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
  return { calls, readRange, wrapper };
}

function ok(spec: RangeSpec, savedM: number): RangeReadOk {
  const w = spec.kind === 'absolute' ? spec : { fromMs: NOW - 24 * H, toMs: NOW };
  const figures = { savedM, whpM: savedM * 2, paidM: savedM, fromMs: w.fromMs, toMs: w.toMs, granularity: 'hour', rows: 1 } as unknown as RangeFigures;
  return { ok: true, spec, resolved: { fromMs: w.fromMs, toMs: w.toMs, clippedStart: false, clippedEnd: false, clippedRetention: false, future: false }, figures, planned: 3, cached: 0 };
}
const limited = (retryAtMs: number): RangeReadResult => ({ ok: false, reason: 'rate-limited', error: { kind: 'rate-limited', status: 429, at: NOW }, retryAtMs });

const request = (plan: ComparisonPlan | ComparisonRefusal = PLAN, key = 'prev'): CompareRequest => ({ key, plan: () => plan });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

describe('useRange with a comparison', () => {
  it('reads the aligned current window, then the baseline, under one signal; both land together', async () => {
    const h = harness();
    const { result } = renderHook(() => useRange(DAY, true, 'sweep-1', request()), { wrapper: h.wrapper });
    await flush();
    expect(h.calls.map((c) => c.spec)).toEqual([{ kind: 'absolute', ...PLAN.current }]);
    expect(result.current.compare).toEqual({ status: 'loading' });
    await act(async () => h.calls[0].resolve(ok(h.calls[0].spec, 900)));
    expect(h.calls.map((c) => c.spec)).toEqual([
      { kind: 'absolute', ...PLAN.current },
      { kind: 'absolute', ...PLAN.baseline },
    ]);
    expect(h.calls[1].signal).toBe(h.calls[0].signal);
    expect(result.current.state.status).toBe('loading'); // one state: the comparison is part of the read
    await act(async () => h.calls[1].resolve(ok(h.calls[1].spec, 700)));
    expect(result.current.state.status).toBe('ready');
    expect(result.current.result?.figures.savedM).toBe(900);
    expect(result.current.compare).toMatchObject({ status: 'ready', plan: PLAN, baseline: { figures: { savedM: 700 } } });
  });

  it('a 429 on the current window starts no second read', async () => {
    const h = harness();
    const { result } = renderHook(() => useRange(DAY, true, 'sweep-1', request()), { wrapper: h.wrapper });
    await flush();
    await act(async () => h.calls[0].resolve(limited(NOW + 30_000)));
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(result.current.state).toMatchObject({ status: 'error', reason: 'rate-limited' });
  });

  it('a refused comparison reads the range itself, once, and says why', async () => {
    const h = harness();
    const { result } = renderHook(() => useRange(DAY, true, 'sweep-1', request(REFUSED, 'week')), { wrapper: h.wrapper });
    await flush();
    expect(h.calls.map((c) => c.spec)).toEqual([DAY]);
    await act(async () => h.calls[0].resolve(ok(DAY, 900)));
    expect(h.calls).toHaveLength(1);
    expect(result.current.compare).toEqual({ status: 'refused', refusal: REFUSED });
    expect(result.current.result?.figures.savedM).toBe(900);
  });

  it('a 429 on the baseline of a refresh keeps the last comparison and retries by itself', async () => {
    const h = harness();
    const { rerender, result } = renderHook(({ key }) => useRange(DAY, true, key, request()), { wrapper: h.wrapper, initialProps: { key: 'sweep-1' } });
    await flush();
    await act(async () => h.calls[0].resolve(ok(h.calls[0].spec, 900)));
    await act(async () => h.calls[1].resolve(ok(h.calls[1].spec, 700)));
    rerender({ key: 'sweep-2' });
    await flush();
    // While the refresh reads, the last comparison stays on screen.
    expect(result.current.compare).toMatchObject({ status: 'ready', baseline: { figures: { savedM: 700 } } });
    await act(async () => h.calls[2].resolve(ok(h.calls[2].spec, 950)));
    const retryAtMs = NOW + 30_000;
    await act(async () => h.calls[3].resolve(limited(retryAtMs)));
    expect(result.current.result?.figures.savedM).toBe(950);
    expect(result.current.compare).toMatchObject({ status: 'ready', retryAtMs, baseline: { figures: { savedM: 700 } } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100);
    });
    await flush();
    expect(h.calls).toHaveLength(5);
  });

  it('a failed baseline with nothing to hold is an error beside the range figures', async () => {
    const h = harness();
    const { result } = renderHook(() => useRange(DAY, true, 'sweep-1', request()), { wrapper: h.wrapper });
    await flush();
    await act(async () => h.calls[0].resolve(ok(h.calls[0].spec, 900)));
    await act(async () => h.calls[1].resolve({ ok: false, reason: 'error', error: { kind: 'server', status: 503, at: NOW } }));
    expect(result.current.state.status).toBe('ready');
    expect(result.current.compare).toMatchObject({ status: 'error', reason: 'error', plan: PLAN });
    act(() => result.current.retry());
    await flush();
    expect(h.calls).toHaveLength(3);
  });

  it('switching the comparison on is a new request: the plain range figures are not shown as its own', async () => {
    const h = harness();
    const { rerender, result } = renderHook(({ cmp }) => useRange(DAY, true, 'sweep-1', cmp), { wrapper: h.wrapper, initialProps: { cmp: undefined as CompareRequest | undefined } });
    await flush();
    await act(async () => h.calls[0].resolve(ok(DAY, 1000)));
    expect(result.current.compare).toBeUndefined();
    rerender({ cmp: request() });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(result.current.state.status).toBe('loading');
    expect(result.current.result).toBeUndefined();
    expect(result.current.compare).toEqual({ status: 'loading' });
  });
});
