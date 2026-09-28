// The live pulse's memory (EPIC_AUDIT P2-W21): only sweeps this tab saw, an hour at most, and an honest
// countdown — this tab's own timer when it meters, "expected" from the cadence when someone else does.

import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { Meta } from '../../core/types.ts';
import {
  HISTORY_WINDOW_MS,
  countdownLine,
  emptyHistory,
  entriesFrom,
  historyCaption,
  nextSweep,
  observedCadenceMs,
  recordSweep,
  stripCountdown,
  windowEntries,
  type SweepEntry,
} from '../../src/components/Shell/sweepHistory.ts';
import { createAppState } from '../../src/state/store.ts';

const NOW = Date.parse('2026-09-30T16:42:03.000Z');
const ok = (secAgo: number, over: Partial<SweepEntry> = {}): SweepEntry => ({ at: NOW - secAgo * 1000, kind: 'ok', calls: 23, durationMs: 800, by: 'runner', ...over });

function meta(over: Partial<Meta> = {}): Meta {
  return {
    schemaVersion: 1,
    installedAt: '2026-09-29T00:00:00.000Z',
    collectingSince: '2026-09-29T00:00:00.000Z',
    appVersion: 'runner',
    build: 'release',
    metricsSource: 'metrics-query',
    lastSweepAt: new Date(NOW - 20_000).toISOString(),
    lastSweepCalls: 23,
    lastSweepMs: 812,
    lastSweepOwner: 'runner:workhorse:4242',
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: 10,
    ...over,
  } as Meta;
}

describe('recordSweep / windowEntries', () => {
  it('dedupes, keeps time order, drops what left the hour, counts what landed', () => {
    let h = emptyHistory(NOW - 2 * HISTORY_WINDOW_MS);
    h = recordSweep(h, ok(30), NOW);
    h = recordSweep(h, ok(90), NOW);
    h = recordSweep(h, ok(30), NOW);
    h = recordSweep(h, { at: NOW - 60_000, kind: 'failed', by: 'this-tab' }, NOW);
    expect(h.entries.map((e) => (NOW - e.at) / 1000)).toEqual([90, 60, 30]);
    expect(h.landed).toBe(2);
    h = recordSweep(h, ok(4000), NOW); // older than the hour: kept only until the next record prunes
    expect(windowEntries(h, NOW)).toHaveLength(3);
    h = recordSweep(h, ok(10), NOW);
    expect(h.entries.some((e) => e.at === NOW - 4_000_000)).toBe(false);
  });

  it('entriesFrom reads meta and this tab’s failure, on live data only', () => {
    const base = createAppState(defaultSettings('2026-09-29T00:00:00.000Z', 'UTC'), { meta: meta() });
    expect(entriesFrom(base)).toEqual([{ at: NOW - 20_000, kind: 'ok', calls: 23, durationMs: 812, by: 'runner' }]);
    expect(entriesFrom({ ...base, source: 'sample' })).toEqual([]);
    const failing = { ...base, status: { ...base.status, sweep: { ...base.status.sweep, lastFailure: { code: 'rate_limited', at: NOW - 5_000 } } } };
    expect(entriesFrom(failing).map((e) => e.kind)).toEqual(['ok', 'failed']);
  });
});

describe('nextSweep and the countdown', () => {
  const settings = defaultSettings('2026-09-29T00:00:00.000Z', 'UTC');

  it('this tab meters: its own timer, not expected; a tick before the next minute settles is skipped', () => {
    const s = createAppState(settings, { meta: meta() });
    const mine = { ...s, status: { ...s.status, sweep: { ...s.status.sweep, metering: true, nextAt: NOW + 42_000 } } };
    const next = nextSweep(mine, emptyHistory(NOW), NOW);
    expect(next).toEqual({ at: NOW + 42_000, expected: false });
    expect(countdownLine(next, NOW)).toBe('Next sweep in 0:42');
    expect(stripCountdown(next, NOW)).toBe('next 0:42');
    // Metered through 16:42:00: 16:42 settles at 16:43:20, so the ticks at +12 s, +42 s and +72 s find the
    // minute current and the one at +102 s meters it.
    const fresh = {
      ...mine,
      meta: meta({ meteredThrough: '2026-09-30T16:42:00.000Z' }),
      status: { ...mine.status, sweep: { ...mine.status.sweep, nextAt: NOW + 12_000 } },
    };
    expect(nextSweep(fresh, emptyHistory(NOW), NOW)).toEqual({ at: NOW + 102_000, expected: false });
  });

  it('the runner meters: last sweep + the observed cadence (else a minute), expected', () => {
    const s = createAppState(settings, { meta: meta() });
    expect(nextSweep(s, emptyHistory(NOW), NOW)).toEqual({ at: NOW + 40_000, expected: true });
    let h = emptyHistory(NOW - HISTORY_WINDOW_MS);
    for (const sec of [140, 110, 80, 50, 20]) h = recordSweep(h, ok(sec), NOW);
    expect(observedCadenceMs(h.entries)).toBe(30_000);
    const next = nextSweep(s, h, NOW);
    expect(next).toEqual({ at: NOW + 10_000, expected: true });
    expect(countdownLine(next, NOW)).toBe('Next sweep expected in 0:10');
    expect(stripCountdown(next, NOW)).toBe('next ≈ 0:10');
  });

  it('due, late, and nothing off live data', () => {
    expect(countdownLine({ at: NOW - 10_000, expected: true }, NOW)).toBe('Next sweep due now');
    expect(countdownLine({ at: NOW - 70_000, expected: true }, NOW)).toBe('Next sweep is 1:10 late');
    expect(stripCountdown({ at: NOW - 1_000, expected: true }, NOW)).toBeNull();
    const sample = createAppState(settings, { meta: meta(), source: 'sample' });
    expect(nextSweep(sample, emptyHistory(NOW), NOW)).toBeNull();
    expect(countdownLine(null, NOW)).toBeNull();
  });
});

describe('historyCaption', () => {
  it('says how many, since when (a tab under an hour old), the median duration and calls, and failures', () => {
    let h = emptyHistory(NOW - 12 * 60_000);
    h = recordSweep(h, ok(90, { durationMs: 700, calls: 21 }), NOW);
    h = recordSweep(h, ok(30, { durationMs: 900, calls: 23 }), NOW);
    h = recordSweep(h, { at: NOW - 60_000, kind: 'failed', by: 'this-tab' }, NOW);
    expect(historyCaption(h, NOW, 'UTC')).toBe('2 sweeps seen · since 4:30 PM · median 900 ms · 23 Leader calls a sweep · 1 failed');
    expect(historyCaption(emptyHistory(NOW), NOW, 'UTC')).toBe('No sweep has landed since this tab opened.');
  });
});
