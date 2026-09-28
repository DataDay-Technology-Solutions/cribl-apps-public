// @vitest-environment jsdom
// tests/unit/demo-console-lever.test.tsx — the Demo Console's remote cues (EPIC_AUDIT P2-W18, day-1 slice):
// the page lever's phase (Break → countdown → Restore), the phone's projector line, and the one-shot cue
// (vibration + 1.2 s flash) when an alert lands while the console is open.

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DemoState, Incident, Snapshot } from '../../core/types.ts';
import { emptyDemoState } from '../../core/demo/levers.ts';
import { newlyOpenedIncidents, projectorLine, trimLever } from '../../src/demo/derive.ts';
import { CUE_FLASH_MS, CUE_VIBRATION, useIncidentCue, vibrate } from '../../src/views/Demo/useIncidentCue.ts';

const T0 = Date.UTC(2026, 8, 28, 15, 0, 20);
const iso = (ms: number) => new Date(ms).toISOString();

const demo = (partial: Partial<DemoState> = {}): DemoState => ({ ...emptyDemoState(), ...partial });
const broken = (extra: Partial<DemoState> = {}) =>
  demo({ measuredLagSec: 127, trim: { mrd_pay_sample: { functionIndex: 2, previous: {}, brokenAt: iso(T0) } }, ...extra });

function incident(partial: Partial<Incident> = {}): Incident {
  return {
    id: 'i1',
    type: 'regression',
    severity: 'high',
    objectKey: 'route:default:mrd_payments_api',
    label: 'Payments API sampling',
    openedAt: iso(T0 + 120_000),
    before: 0.75,
    after: 0.5,
    impactPerDayM: 2_500_000,
    notes: [],
    deliveries: [],
    ...partial,
  };
}

function snapshot(partial: Partial<Snapshot> = {}): Snapshot {
  return {
    schemaVersion: 1,
    sweepAt: iso(T0),
    windowStart: iso(T0 - 60_000),
    windowEnd: iso(T0),
    mode: 'ui',
    headline: {
      todayM: 1_000_000,
      mtdM: 50_000_000,
      d30M: 60_000_000,
      annualizedM: 811_234_500_000,
      annualizedFromDays: 5,
      whpMtdM: 0,
      paidMtdM: 0,
      ratioMtd: 0,
      whpTodayM: 0,
      paidTodayM: 0,
      whp30dM: 0,
      paid30dM: 0,
    },
    ratePerSecM: 1_000,
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
    collectingSince: iso(T0 - 86_400_000),
    metricsSource: 'metrics-query',
    attributionSummary: 'route',
    ...partial,
  } as Snapshot;
}

describe('trimLever: Break → countdown → Restore', () => {
  it('is armed while the trim is intact', () => {
    expect(trimLever(demo(), snapshot(), T0)).toEqual({ phase: 'intact' });
    expect(trimLever(null, null, T0)).toEqual({ phase: 'intact' });
  });

  it('counts down from the break plus the measured lag, and goes due (≤ 0) past it', () => {
    expect(trimLever(broken(), snapshot(), T0 + 27_000)).toEqual({ phase: 'waiting', inMs: 100_000 });
    const due = trimLever(broken(), snapshot(), T0 + 200_000);
    expect(due.phase).toBe('waiting');
    expect(due.phase === 'waiting' && due.inMs).toBeLessThan(0);
  });

  it('flips to Restore when the regression the break caused is open', () => {
    expect(trimLever(broken(), snapshot({ incidents: [incident()] }), T0 + 130_000)).toEqual({ phase: 'open' });
    // An incident from before the break is not this break's alert.
    expect(trimLever(broken(), snapshot({ incidents: [incident({ openedAt: iso(T0 - 5 * 60_000) })] }), T0 + 10_000).phase).toBe('waiting');
  });

  it('stays broken (no timer) when its alert already closed or there is no deploy time', () => {
    const closed = snapshot({ incidents: [incident({ closedAt: iso(T0 + 300_000) })] });
    expect(trimLever(broken(), closed, T0 + 400_000)).toEqual({ phase: 'broken' });
    const noTime = demo({ trim: { mrd_pay_sample: { functionIndex: 2, previous: {} } as DemoState['trim'][string] } });
    expect(trimLever(noTime, snapshot(), T0)).toEqual({ phase: 'broken' });
  });
});

describe('projectorLine: the number on the wall', () => {
  it('quotes the presenter period (annualized by default) and whether an alert is open', () => {
    expect(projectorLine(null, undefined, T0)).toBeUndefined();
    expect(projectorLine(snapshot(), undefined, T0)).toEqual({ valueM: 811_234_500_000, alertOpen: false });
    expect(projectorLine(snapshot({ incidents: [incident()] }), 'annualized', T0)!.alertOpen).toBe(true);
    expect(projectorLine(snapshot({ incidents: [incident({ closedAt: iso(T0) })] }), 'annualized', T0)!.alertOpen).toBe(false);
  });

  it('ticks an accruing period from the sweep like the stage meter does', () => {
    // MTD accrues ratePerSecM (1,000 m/s) for the 10 s since the sweep.
    expect(projectorLine(snapshot(), 'mtd', T0 + 10_000)!.valueM).toBe(50_000_000 + 10_000);
  });
});

describe('newlyOpenedIncidents', () => {
  it('returns open incidents not seen before, never closed ones', () => {
    const snap = snapshot({ incidents: [incident({ id: 'a' }), incident({ id: 'b' }), incident({ id: 'c', closedAt: iso(T0) })] });
    expect(newlyOpenedIncidents(new Set(['a']), snap).map((i) => i.id)).toEqual(['b']);
    expect(newlyOpenedIncidents(new Set(), null)).toEqual([]);
  });
});

describe('useIncidentCue: one buzz and a 1.2 s flash per alert that lands while the console is open', () => {
  let calls: number[][];
  const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'vibrate');
  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    Object.defineProperty(Navigator.prototype, 'vibrate', {
      configurable: true,
      value: (pattern: number[]) => {
        calls.push(pattern);
        return true;
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (original) Object.defineProperty(Navigator.prototype, 'vibrate', original);
    else delete (Navigator.prototype as { vibrate?: unknown }).vibrate;
  });

  it('treats what is already open on the first snapshot as old news', () => {
    const { result, rerender } = renderHook(({ s }: { s: Snapshot | null }) => useIncidentCue(s), { initialProps: { s: null as Snapshot | null } });
    rerender({ s: snapshot({ incidents: [incident({ id: 'old' })] }) });
    expect(result.current).toBe(false);
    expect(calls).toEqual([]);
  });

  it('buzzes [40, 60, 40] once and flashes for 1.2 s when a new incident opens', () => {
    const { result, rerender } = renderHook(({ s }: { s: Snapshot | null }) => useIncidentCue(s), { initialProps: { s: snapshot() } });
    expect(result.current).toBe(false);
    const opened = snapshot({ incidents: [incident({ id: 'new' })] });
    rerender({ s: opened });
    expect(result.current).toBe(true);
    expect(calls).toEqual([[...CUE_VIBRATION]]);
    expect(CUE_VIBRATION).toEqual([40, 60, 40]);
    // The same incident on the next snapshot: no second buzz.
    rerender({ s: snapshot({ incidents: [incident({ id: 'new' })] }) });
    expect(calls).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(CUE_FLASH_MS);
    });
    expect(result.current).toBe(false);
  });

  it('never throws where the platform has no vibration', () => {
    delete (Navigator.prototype as { vibrate?: unknown }).vibrate;
    expect(vibrate()).toBe(false);
    Object.defineProperty(Navigator.prototype, 'vibrate', {
      configurable: true,
      value: () => {
        throw new Error('blocked by the frame');
      },
    });
    expect(vibrate()).toBe(false);
  });
});
