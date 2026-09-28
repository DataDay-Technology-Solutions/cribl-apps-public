// The chrome's metering truth (EPIC_AUDIT P0-07, P1-D01, P1-D02, P1-D03): what the status dot, its caption and
// the words under the hero say while sweeps fail, before anything can meter, after the session expires and when
// the meter went quiet. Pure functions over the store; no DOM.

import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { Meta, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import { dataUpdatedAt, deriveDataStatus, meteredByLine, meteringBackoff, sweepErrorCodeText, sweepErrorText } from '../../src/components/Shell/status.ts';
import {
  classifySweepError,
  META_FAILING_AFTER_MS,
  meteredBy,
  meteringFailure,
  STALE_AFTER_MS,
  sweepOwnerHost,
  type SweepErrorKind,
} from '../../src/state/selectors.ts';
import { createAppState, type AppState, type RuntimeStatus } from '../../src/state/store.ts';

const NOW = Date.parse('2026-09-26T18:00:00.000Z');
const DEFAULTS: Settings = defaultSettings('2026-09-26T00:00:00.000Z', 'UTC');
const iso = (ms: number) => new Date(ms).toISOString();

const PRICES: PricesDoc = {
  schemaVersion: 1,
  updatedAt: '2026-09-25T00:00:00.000Z',
  versions: [{ effectiveFrom: '2026-09-25T00:00:00.000Z', byOutputId: { mrd_siem_prod: { milliCentsPerGb: 225_000 } } }],
};

function meta(patch: Partial<Meta> = {}): Meta {
  return {
    schemaVersion: 1,
    installedAt: '2026-09-25T00:00:00.000Z',
    collectingSince: '2026-09-25T00:00:00.000Z',
    appVersion: '1.0.0',
    build: 'release',
    metricsSource: 'metrics-query',
    lastSweepAt: iso(NOW - 20_000),
    lastSweepOwner: 'ui:tab-a',
    sweepErrors: 0,
    consecutiveRateLimited: 0,
    sweepCount: 10,
    ...patch,
  };
}

const snapshot = (sweepAt: number): Snapshot => ({ sweepAt: iso(sweepAt), destinations: [] }) as unknown as Snapshot;

/** A hydrated, priced, live workspace whose last sweep (this tab's) ran 20 s ago. */
function healthy(patch: Partial<AppState> = {}, sweep: Partial<RuntimeStatus['sweep']> = {}): AppState {
  const base = createAppState(DEFAULTS, {
    hasHydrated: true,
    settingsStored: true,
    prices: PRICES,
    meta: meta(),
    snapshot: snapshot(NOW - 20_000),
  });
  return {
    ...base,
    ...patch,
    status: {
      ...base.status,
      hydrate: { phase: 'done' },
      live: { phase: 'waiting', lastOkAt: NOW - 5_000 },
      ...patch.status,
      sweep: { running: false, nextManualAt: 0, metering: true, ownerId: 'ui:tab-a', lastRunAt: NOW - 20_000, ...patch.status?.sweep, ...sweep },
    },
  };
}

/** This tab's failure streak: `failures` sweeps in a row failed with `code`, the last one 5 s ago. */
function failing(code: string, failures: number, extra: Partial<RuntimeStatus['sweep']> = {}): AppState {
  const at = NOW - 5_000;
  return healthy({}, { failures, failingSince: at - (failures - 1) * 30_000, lastFailure: { code, at }, lastRunAt: at, nextAt: NOW + 42_000, ...extra });
}

describe('classifySweepError: every code the sweep reports, in kinds (P0-07)', () => {
  const cases: [string | undefined, number | undefined, SweepErrorKind, number | undefined][] = [
    ['rate_limited', undefined, 'rate-limited', 429],
    ['Rate limited by the Leader (second 429 this sweep) on POST /system/metrics/query', undefined, 'rate-limited', 429],
    ['budget', undefined, 'budget', undefined],
    ['time_budget', undefined, 'time-budget', undefined],
    ['sweep exceeded its 100 s time budget (104 s); writes abandoned', undefined, 'time-budget', undefined],
    ['metrics outputs query failed: HTTP 403 {"status":"error","message":"Forbidden"}', undefined, 'metrics-forbidden', 403],
    ['metrics inputs query failed: HTTP 429', undefined, 'rate-limited', 429],
    ['metrics outputs query failed: HTTP 500 upstream', undefined, 'server', 500],
    ['config read /master/groups failed: HTTP 403', undefined, 'forbidden', 403],
    ['config read /master/groups failed: HTTP 401', undefined, 'unauthorized', 401],
    ['KV PUT snapshot failed: HTTP 413', undefined, 'storage', 413],
    ['KV PUT roll/min/2026-09-26T17 failed: HTTP 502', undefined, 'server', 502],
    ['TypeError: Failed to fetch', undefined, 'network', undefined],
    ['The operation was aborted', undefined, 'network', undefined],
    ['something odd', undefined, 'unknown', undefined],
    [undefined, 502, 'server', 502],
    [undefined, undefined, 'unknown', undefined],
  ];
  it.each(cases)('%s (status %s) → %s', (code, status, kind, httpStatus) => {
    const info = classifySweepError(code, status);
    expect(info.kind).toBe(kind);
    expect(info.status).toBe(httpStatus);
  });
});

describe('sweepErrorText: one human sentence, never the raw code', () => {
  const RAW = [
    'rate_limited',
    'budget',
    'time_budget',
    'metrics outputs query failed: HTTP 403 {"status":"error","message":"Forbidden"}',
    'config read /master/groups failed: HTTP 401',
    'KV PUT snapshot failed: HTTP 413',
    'KV PUT snapshot failed: HTTP 500',
    'TypeError: Failed to fetch',
    'weird',
  ];
  it.each(RAW)('%s', (code) => {
    const text = sweepErrorCodeText(code, undefined, { groups: ['default'] });
    expect(text).not.toMatch(/rate_limited|time_budget|\{|\}|query failed|KV PUT|TypeError/);
    expect(text).toMatch(/^[A-Z].*\.$/); // a sentence
  });

  it('names the worker groups the metrics query covers (errors.metricsForbidden)', () => {
    expect(sweepErrorText({ kind: 'metrics-forbidden', status: 403 }, { groups: ['default', 'edge'] })).toBe(
      "Couldn't read metrics for default, edge: your role can't view them. Ask an administrator for Monitoring access.",
    );
    expect(sweepErrorText({ kind: 'metrics-forbidden', status: 403 })).toMatch(/^Couldn't read Cribl's metrics/);
  });

  it('counts down to the next sweep when rate limited (DESIGN_BRIEF 6)', () => {
    expect(sweepErrorText({ kind: 'rate-limited', status: 429 }, { nextSweepInS: 41.2 })).toBe('Cribl is rate limiting Meter Reader. Next sweep in 0:42.');
    expect(sweepErrorText({ kind: 'rate-limited', status: 429 })).toBe('Cribl is rate limiting Meter Reader. The next sweep tries again.');
  });

  it('while the sweeps back off (P1-E01), names when metering resumes, in the past tense, never the next tick (review W2)', () => {
    expect(sweepErrorText({ kind: 'rate-limited', status: 429 }, { nextSweepInS: 29, backoff: { since: '2:14 AM', until: '2:16 AM' } })).toBe(
      'Cribl rate-limited Meter Reader at 2:14 AM. Metering resumes at 2:16 AM.',
    );
    const now = Date.parse('2026-09-27T07:14:30.000Z');
    const meta = { rateLimitedSince: '2026-09-27T07:14:00.000Z', rateLimitedUntil: '2026-09-27T07:16:00.000Z' } as Meta;
    expect(meteringBackoff(meta, now)).toEqual({ sinceMs: Date.parse(meta.rateLimitedSince!), untilMs: Date.parse(meta.rateLimitedUntil!) });
    expect(meteringBackoff(meta, Date.parse(meta.rateLimitedUntil!))).toBeUndefined(); // over: back to the countdown
    expect(meteringBackoff({ rateLimitedUntil: meta.rateLimitedUntil } as Meta, now, 123)).toEqual({ sinceMs: 123, untilMs: Date.parse(meta.rateLimitedUntil!) });
    expect(meteringBackoff(null, now)).toBeUndefined();
  });
});

describe('meteringFailure (P0-07)', () => {
  it('is null while sweeps run, and for sample or replay data', () => {
    expect(meteringFailure(healthy(), NOW)).toBeNull();
    expect(meteringFailure({ ...failing('rate_limited', 3), source: 'sample' }, NOW)).toBeNull();
  });

  it('shows a permission, session or rate-limit failure on the first failed sweep', () => {
    for (const code of ['metrics outputs query failed: HTTP 403', 'config read /master/groups failed: HTTP 401', 'rate_limited']) {
      const f = meteringFailure(failing(code, 1), NOW);
      expect(f?.source).toBe('this-tab');
    }
  });

  it('waits for a second failure in a row for anything else, so one blip never flips the chip', () => {
    expect(meteringFailure(failing('KV PUT snapshot failed: HTTP 500', 1), NOW)).toBeNull();
    const f = meteringFailure(failing('KV PUT snapshot failed: HTTP 500', 2), NOW);
    expect(f).toMatchObject({ kind: 'server', status: 500, source: 'this-tab' });
  });

  it('dates the failure from the last sweep that ran (nothing metered since)', () => {
    const lastGood = NOW - 10 * 60_000;
    const state = { ...failing('metrics outputs query failed: HTTP 403', 4), meta: meta({ lastSweepAt: iso(lastGood) }) };
    expect(meteringFailure(state, NOW)?.since).toBe(lastGood);
  });

  it('clears as soon as any meter completes a sweep after the failure', () => {
    const state = { ...failing('rate_limited', 3), meta: meta({ lastSweepAt: iso(NOW - 1_000) }) };
    expect(meteringFailure(state, NOW)).toBeNull();
  });

  it('reads another meter\'s failures from meta: an error recorded and no sweep for over two minutes', () => {
    const lastGood = NOW - META_FAILING_AFTER_MS - 1_000;
    const quiet = healthy({ meta: meta({ lastSweepAt: iso(lastGood), lastSweepOwner: 'runner:workhorse:4242', lastError: 'metrics outputs query failed: HTTP 403' }) }, { metering: false });
    expect(meteringFailure(quiet, NOW)).toEqual({ kind: 'metrics-forbidden', status: 403, since: lastGood, source: 'meta' });
    // Inside two minutes one missed sweep is not "failing".
    expect(meteringFailure(quiet, lastGood + 60_000)).toBeNull();
    // A tab that just started metering finds out for itself: no flash before its own first sweep lands.
    const opening = { ...quiet, status: { ...quiet.status, sweep: { ...quiet.status.sweep, metering: true, lastRunAt: undefined } } };
    expect(meteringFailure(opening, NOW)).toBeNull();
  });
});

describe('deriveDataStatus: never more than it knows', () => {
  it('connecting while hydration runs', () => {
    const s = healthy();
    expect(deriveDataStatus({ ...s, status: { ...s.status, hydrate: { phase: 'loading' } } }, NOW)).toBe('connecting');
  });

  it('live while this tab meters, stale when the figures age past five minutes', () => {
    expect(deriveDataStatus(healthy(), NOW)).toBe('live');
    const quiet = healthy({ snapshot: snapshot(NOW - STALE_AFTER_MS - 1_000), meta: meta({ lastSweepAt: iso(NOW - STALE_AFTER_MS - 1_000) }) }, { metering: false });
    expect(deriveDataStatus(quiet, NOW)).toBe('stale');
  });

  it('P1-D01: "Not metering yet" without prices, "Waiting" only when a sweep can come', () => {
    expect(deriveDataStatus(healthy({ prices: null, snapshot: null, meta: null }), NOW)).toBe('not-metering');
    expect(deriveDataStatus(healthy({ snapshot: null }), NOW)).toBe('waiting');
    // Unreadable prices are not "absent": the sweep reads them itself.
    const unreadable = healthy({ prices: null, snapshot: null, errors: { prices: { kind: 'server', status: 500, at: NOW } } });
    expect(deriveDataStatus(unreadable, NOW)).toBe('waiting');
  });

  it('P1-D01: an expired session reads "Signed out", a refused read of the App\'s own data "No access"', () => {
    const s = healthy();
    expect(deriveDataStatus({ ...s, status: { ...s.status, live: { ...s.status.live, lastError: { kind: 'unauthorized', status: 401, at: NOW } } } }, NOW)).toBe('signed-out');
    expect(deriveDataStatus({ ...s, errors: { snapshot: { kind: 'unauthorized', status: 401, at: NOW } } }, NOW)).toBe('signed-out');
    expect(deriveDataStatus({ ...s, errors: { meta: { kind: 'forbidden', status: 403, at: NOW } } }, NOW)).toBe('no-access');
    // A 403 on the inventory (secondary) is the Prices page's business, not the whole app's.
    expect(deriveDataStatus({ ...s, errors: { inventory: { kind: 'forbidden', status: 403, at: NOW } } }, NOW)).toBe('live');
  });

  it('P1-D01: every read failing at hydration reads Offline, with no "updated N s ago"', () => {
    const base = createAppState(DEFAULTS);
    const server = { kind: 'server' as const, status: 500, at: NOW };
    const state: AppState = { ...base, errors: { settings: server, snapshot: server, meta: server, prices: server }, status: { ...base.status, hydrate: { phase: 'error' }, live: { phase: 'waiting', lastError: server } } };
    expect(deriveDataStatus(state, NOW)).toBe('offline');
    expect(dataUpdatedAt(state)).toBeUndefined();
  });

  it('P0-07: failing sweeps are never "Live"', () => {
    expect(deriveDataStatus(failing('metrics outputs query failed: HTTP 403', 1), NOW)).toBe('failing');
    expect(deriveDataStatus(failing('KV PUT snapshot failed: HTTP 500', 1), NOW)).toBe('live');
    expect(deriveDataStatus(failing('KV PUT snapshot failed: HTTP 500', 2), NOW)).toBe('failing');
    expect(deriveDataStatus(failing('rate_limited', 1), NOW)).toBe('rate-limited');
    // A sweep answered 401: the session expired; that is "Signed out", not a metering fault.
    expect(deriveDataStatus(failing('config read /master/groups failed: HTTP 401', 1), NOW)).toBe('signed-out');
    // Recovery: a sweep that ran after the failures clears the status without a reload.
    expect(deriveDataStatus({ ...failing('rate_limited', 3), meta: meta({ lastSweepAt: iso(NOW - 1_000) }) }, NOW)).toBe('live');
  });

  it('P1-D02: without a snapshot there is no age to quote', () => {
    const s = healthy({ snapshot: null });
    expect(dataUpdatedAt({ ...s, status: { ...s.status, live: { ...s.status.live, lastOkAt: NOW - 4_000 } } })).toBeUndefined();
    expect(dataUpdatedAt(healthy())).toBe(NOW - 20_000);
  });
});

describe('who meters, and when it went quiet (P1-D03)', () => {
  it('names the runner that stopped sweeping and how long ago', () => {
    const lastAt = NOW - 20 * 60_000;
    const state = healthy({ meta: meta({ lastSweepAt: iso(lastAt), lastSweepOwner: 'runner:workhorse:4242' }) }, { metering: false });
    expect(meteredBy(state, NOW)).toBe('runner-silent');
    expect(meteredByLine('runner-silent', 'ui', sweepOwnerHost(state.meta), '20 min ago')).toBe('The runner on workhorse stopped sweeping 20 min ago');
    expect(meteredByLine('runner-silent', 'ui', undefined, '20 min ago')).toBe('The runner stopped sweeping 20 min ago');
    // Under five minutes the runner still meters.
    expect(meteredBy(state, lastAt + STALE_AFTER_MS - 1_000)).toBe('runner');
  });

  it('says the scheduled backend went quiet', () => {
    const state = healthy({ meta: meta({ lastSweepAt: iso(NOW - 9 * 60_000), lastSweepOwner: 'backend:meter' }) }, { metering: false });
    expect(meteredBy(state, NOW)).toBe('backend-silent');
    expect(meteredByLine('backend-silent', 'backend', undefined, '9 min ago')).toBe('The scheduled backend stopped sweeping 9 min ago');
  });

  it('a single tab reloaded under a new id is "this tab"', () => {
    // meta names this tab's previous id; this tab started metering after that sweep and nobody swept since.
    const reloaded = healthy({ meta: meta({ lastSweepOwner: 'ui:before-reload', lastSweepAt: iso(NOW - 40_000) }) }, { ownerId: 'ui:after-reload', meteringSince: NOW - 10_000, lastRunAt: undefined, lastResult: { ok: true, mode: 'ui', skipped: 'current' } });
    expect(meteredBy(reloaded, NOW)).toBe('this-tab');
  });

  it('two open tabs: exactly one says "this tab"', () => {
    const lastSweepAt = NOW - 15_000;
    const shared = meta({ lastSweepOwner: 'ui:tab-a', lastSweepAt: iso(lastSweepAt) });
    // Tab A ran the last sweep. Tab B has been open for a while; A swept after B started metering.
    const a = healthy({ meta: shared }, { ownerId: 'ui:tab-a', meteringSince: NOW - 5 * 60_000 });
    const b = healthy({ meta: shared }, { ownerId: 'ui:tab-b', meteringSince: NOW - 3 * 60_000, lastResult: { ok: true, mode: 'ui', skipped: 'current' } });
    expect([meteredBy(a, NOW), meteredBy(b, NOW)]).toEqual(['this-tab', 'other-tab']);
    // A 'locked' refusal proves another tab holds the lock, even before any sweep lands after B started.
    const bLocked = healthy({ meta: shared }, { ownerId: 'ui:tab-b', meteringSince: NOW - 10_000, lastResult: { ok: true, mode: 'ui', skipped: 'locked' } });
    expect(meteredBy(bLocked, NOW)).toBe('other-tab');
  });
});
