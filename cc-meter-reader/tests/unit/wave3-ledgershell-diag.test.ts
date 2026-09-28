// W3-LS-3: the diagnostics panel shows the metering gaps (EPIC_AUDIT P1-E04) and the rate-limit back-off (P1-E01),
// only while there is something to say, and Copy diagnostics carries both.

import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { Meta, MeteringGap } from '../../core/types.ts';
import { backOffLine, diagRows, diagText, notMeteredLine } from '../../src/components/Shell/diagRows.ts';
import { createAppState } from '../../src/state/store.ts';

const NOW = Date.parse('2026-09-30T16:42:03.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 3_600_000;

function meta(over: Partial<Meta> = {}): Meta {
  return {
    schemaVersion: 1,
    installedAt: iso(3 * 86_400_000),
    collectingSince: iso(3 * 86_400_000),
    appVersion: 'runner',
    build: 'release',
    metricsSource: 'metrics-query',
    lastSweepAt: iso(40_000),
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: 1_402,
    ...over,
  } as Meta;
}

const state = (m: Meta) => createAppState(defaultSettings(iso(0), 'UTC'), { meta: m });
const row = (rows: ReturnType<typeof diagRows>, key: string) => rows.find((r) => r.key === key);

const fourHours: MeteringGap = { from: '2026-09-29T12:00:00.000Z', to: '2026-09-29T16:00:00.000Z', minutes: 240, recordedAt: '2026-09-29T16:05:00.000Z' };

describe('diag rows: not metered (P1-E04)', () => {
  it('a meta with one 4 h gap prints Not metered: 4 h, 240 minutes, and its date', () => {
    const rows = diagRows(state(meta({ gaps: [fourHours] })), NOW);
    const r = row(rows, 'not metered');
    expect(r?.value).toBe('4 h (240 min) · 2026-09-29 12:00–16:00Z');
    // It sits beside the meter's own position, and Copy diagnostics carries it.
    const keys = rows.map((x) => x.key);
    expect(keys.indexOf('not metered')).toBe(keys.indexOf('metered through') + 1);
    expect(diagText(rows, NOW)).toMatch(/\nnot metered +4 h \(240 min\) · 2026-09-29 12:00–16:00Z\n/);
  });

  it('adds several gaps up, lists the newest three with their dates, and says how many more', () => {
    const gap = (day: number, h: number, minutes: number): MeteringGap => {
      const from = Date.parse(`2026-09-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`);
      return { from: new Date(from).toISOString(), to: new Date(from + minutes * 60_000).toISOString(), minutes, recordedAt: new Date(from + minutes * 60_000).toISOString() };
    };
    const gaps = [gap(25, 1, 30), gap(26, 2, 60), gap(27, 3, 90), gap(28, 23, 120)];
    expect(notMeteredLine(gaps, NOW)).toBe('5 h (300 min) · 2026-09-28 23:00Z – 2026-09-29 01:00Z, 2026-09-27 03:00–04:30Z, 2026-09-26 02:00–03:00Z · 1 more');
    expect(notMeteredLine([gap(29, 10, 45)], NOW)).toBe('45 min · 2026-09-29 10:00–10:45Z');
  });

  it('prints no row without gaps', () => {
    expect(row(diagRows(state(meta()), NOW), 'not metered')).toBeUndefined();
    expect(row(diagRows(state(meta({ gaps: [] })), NOW), 'not metered')).toBeUndefined();
    expect(notMeteredLine(undefined, NOW)).toBeUndefined();
  });
});

describe('diag rows: the rate-limit back-off (P1-E01)', () => {
  it('a meta in back-off prints since, until and the streak', () => {
    const m = meta({ consecutiveRateLimited: 3, rateLimitedSince: iso(12 * 60_000), rateLimitedUntil: new Date(NOW + 6 * 60_000).toISOString(), lastError: 'rate_limited' });
    const rows = diagRows(state(m), NOW);
    expect(row(rows, 'back-off')?.value).toBe('sweeps skipped until 16:48:03Z (in 6 min) · limited since 16:30:03Z (12 min ago) · 3 rate-limited in a row');
    const keys = rows.map((x) => x.key);
    expect(keys.indexOf('back-off')).toBe(keys.indexOf('sweeps') + 1);
    expect(diagText(rows, NOW)).toContain('back-off         sweeps skipped until 16:48:03Z (in 6 min)');
  });

  it('says when the back-off window has passed while the streak stands', () => {
    expect(backOffLine({ rateLimitedSince: iso(20 * 60_000), rateLimitedUntil: iso(60_000), consecutiveRateLimited: 4 }, NOW)).toBe(
      'back-off ended 16:41:03Z · limited since 16:22:03Z (20 min ago) · 4 rate-limited in a row',
    );
  });

  it('a clean meta prints neither row', () => {
    const rows = diagRows(state(meta({ consecutiveRateLimited: 1 })), NOW);
    expect(row(rows, 'back-off')).toBeUndefined();
    expect(row(rows, 'not metered')).toBeUndefined();
    expect(backOffLine(undefined, NOW)).toBeUndefined();
    expect(diagText(rows, NOW)).not.toMatch(/back-off|not metered/);
  });

  it('keeps an old gap in the total (the whole history), never a negative one', () => {
    const old: MeteringGap = { from: iso(40 * 24 * HOUR), to: iso(40 * 24 * HOUR - 2 * HOUR), minutes: 120, recordedAt: iso(40 * 24 * HOUR - 2 * HOUR) };
    expect(notMeteredLine([old], NOW)).toMatch(/^2 h \(120 min\) · 2026-08-21 /);
  });
});
