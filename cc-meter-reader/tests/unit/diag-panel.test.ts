// The diagnostics panel's rows (EPIC_AUDIT P1-A08): what a 3 a.m. screenshot needs, as fields, and the plain
// text Copy diagnostics puts on the clipboard.

import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { Meta } from '../../core/types.ts';
import { DIAG_STALE_MS, ago, diagRows, diagText, sweepResultLine } from '../../src/components/Shell/diagRows.ts';
import { createAppState } from '../../src/state/store.ts';

const NOW = Date.parse('2026-09-30T16:42:03.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function meta(over: Partial<Meta> = {}): Meta {
  return {
    schemaVersion: 1,
    installedAt: iso(86_400_000),
    collectingSince: iso(86_400_000),
    appVersion: 'runner',
    build: 'release',
    metricsSource: 'metrics-query',
    lastSweepAt: iso(40_000),
    lastSweepMs: 812.4,
    lastSweepCalls: 23,
    lastSweepMode: 'scheduled',
    lastSweepOwner: 'runner:workhorse:4242',
    deliveryOwner: 'runner:workhorse:4242',
    deliveryOwnerAt: iso(40_000),
    lastError: 'rate_limited',
    sweepErrors: 2,
    consecutiveRateLimited: 1,
    sweepCount: 1_402,
    callsThisMinute: { minute: '2026-09-30T16:42:00.000Z', calls: 31 },
    meteredThrough: iso(3 * 60_000),
    kvDatedKeys: 188,
    lastExpiredAt: iso(20 * 60_000),
    groupsKnown: ['default', 'edge', 'pci'],
    groupsListedAt: iso(12 * 60_000),
    groupsMetered: ['default', 'pci'],
    ...over,
  } as Meta;
}

function state(over: Parameters<typeof createAppState>[1] = {}) {
  return createAppState(defaultSettings(iso(0), 'UTC'), over);
}

const row = (rows: ReturnType<typeof diagRows>, key: string) => rows.find((r) => r.key === key);

describe('diagRows', () => {
  it('names meteredThrough, the errors, the lock holder, groups known vs metered, KV keys and calls', () => {
    const base = state({ meta: meta() });
    const s = {
      ...base,
      status: { ...base.status, sweep: { ...base.status.sweep, ownerId: 'ui:tab1', lastRunAt: NOW - 30_000, lastResult: { ok: true, mode: 'ui' as const, calls: 9, durationMs: 640 }, runnerSeenAt: NOW - 40_000 } },
    };
    const rows = diagRows(s, NOW);
    expect(row(rows, 'metered through')?.value).toBe('16:39:03Z · 3 min behind now (includes the settle minute and any held empty minutes)');
    expect(row(rows, 'sweeps')?.value).toBe('1402 done · 2 errors · 1 rate-limited in a row');
    expect(row(rows, 'last error')?.value).toBe('rate_limited');
    expect(row(rows, 'lock holder')?.value).toMatch(/^runner:workhorse:4242 \(runner\)/);
    expect(row(rows, 'delivery')?.value).toBe('runner:workhorse:4242 (runner) · checked in 40 s ago');
    expect(row(rows, 'runner seen')?.value).toBe('40 s ago');
    expect(row(rows, 'groups')?.value).toBe('known 3 (listed 12 min ago) · metered 2 (default, pci)');
    expect(row(rows, 'kv')?.value).toBe('188 dated keys · expiry pass 20 min ago');
    expect(row(rows, 'calls')?.value).toBe('this tab 9 in the last minute · shared budget 31 in 16:42Z');
    expect(row(rows, 'this tab')?.value).toContain('ok · ui · 9 calls · 640 ms');
    expect(row(rows, 'last sweep')?.value).toBe('16:41:23Z · 40 s ago · scheduled · 23 calls · 812 ms');
    expect(row(rows, 'last sweep')?.state).toBeUndefined();
  });

  it('flags the last sweep row past 3 minutes on live data only; a sweep older than a minute adds no calls', () => {
    const old = state({ meta: meta({ lastSweepAt: iso(DIAG_STALE_MS + 1_000) }) });
    expect(row(diagRows(old, NOW), 'last sweep')?.state).toBe('stale');
    expect(row(diagRows({ ...old, source: 'sample' }, NOW), 'last sweep')?.state).toBeUndefined();
    const s = { ...old, status: { ...old.status, sweep: { ...old.status.sweep, lastRunAt: NOW - 61_000, lastResult: { ok: true, mode: 'ui' as const, calls: 9 } } } };
    expect(row(diagRows(s, NOW), 'calls')?.value).toMatch(/^this tab 0 in the last minute/);
  });

  it('says what it does not know instead of inventing it', () => {
    const rows = diagRows(state(), NOW);
    expect(row(rows, 'metered through')?.value).toBe('—');
    expect(row(rows, 'groups')?.value).toBe('—');
    expect(row(rows, 'last sweep')?.value).toBe('none');
    expect(row(rows, 'runner seen')?.value).toBe('not seen by this tab');
    expect(row(rows, 'lock holder')?.value).toMatch(/expiry is not read here/);
  });
});

describe('sweepResultLine and diagText', () => {
  it('renders a sweep result as fields, never sliced JSON', () => {
    expect(sweepResultLine(undefined)).toBe('none');
    expect(sweepResultLine({ ok: false, skipped: 'locked', mode: 'ui' })).toBe('skipped locked · ui');
    expect(sweepResultLine({ ok: false, mode: 'manual', error: 'rate_limited', status: 429, calls: 3 })).toBe('failed · manual · 3 calls · error rate_limited (429)');
    const long = 'x'.repeat(200);
    expect(sweepResultLine({ ok: false, mode: 'ui', error: long })).toHaveLength('failed · ui · error '.length + 80);
  });

  it('diagText is aligned plain text with a timestamp and the stale flag', () => {
    const text = diagText(
      [
        { key: 'build', value: '1.0.9 · demo' },
        { key: 'last sweep', value: '16:30:00Z', state: 'stale' },
      ],
      NOW,
    );
    expect(text).toBe('Meter Reader diagnostics · 2026-09-30T16:42:03.000Z\nbuild       1.0.9 · demo\nlast sweep  16:30:00Z  [over 3 min old]');
    expect(ago(NOW - 7_200_000, NOW)).toBe('2 h ago');
  });
});
