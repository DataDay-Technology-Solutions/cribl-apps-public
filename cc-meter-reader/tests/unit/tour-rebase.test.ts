// Moving the recorded tour onto the wall clock (src/tour/rebase.ts) and the first-run gate
// (src/tour/selectors.ts).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../../core/settings.ts';
import type { PricesDoc, Snapshot } from '../../core/types.ts';
import { homeTarget } from '../../src/state/selectors.ts';
import { createAppState } from '../../src/state/store.ts';
import { firstRunGate, isWorkspacePriced, liveDocs, pathAfterTour } from '../../src/tour/selectors.ts';
import { planRebase, rebaseHeadline, rebaseString, rebaseValue } from '../../src/tour/rebase.ts';
import { TOUR_FIXTURE } from '../../src/tour/fixture.ts';

const ANCHOR = Date.parse('2026-09-24T16:41:35.000Z');

describe('planRebase', () => {
  it('shifts instants by wall − anchor and day keys by whole local days', () => {
    const wall = Date.parse('2026-10-02T09:00:00.000Z');
    expect(planRebase(ANCHOR, wall, 'America/Chicago')).toEqual({ deltaMs: wall - ANCHOR, dayShift: 8 });
  });

  it('counts days in the fixture zone (a UTC-late evening is still the same Chicago day)', () => {
    const wall = Date.parse('2026-09-25T03:00:00.000Z'); // Sep 24, 10 PM in Chicago
    expect(planRebase(ANCHOR, wall, 'America/Chicago').dayShift).toBe(0);
    expect(planRebase(ANCHOR, wall, 'UTC').dayShift).toBe(1);
  });

  it('is a no-op for non-finite input', () => {
    expect(planRebase(Number.NaN, 0, 'UTC')).toEqual({ deltaMs: 0, dayShift: 0 });
  });
});

describe('rebaseString / rebaseValue', () => {
  const plan = { deltaMs: 86_400_000 + 3_600_000, dayShift: 1 };

  it('moves ISO instants and day keys, and nothing else', () => {
    expect(rebaseString('2026-09-24T16:41:35.000Z', plan)).toBe('2026-09-25T17:41:35.000Z');
    expect(rebaseString('2026-09-24T16:41:35Z', plan)).toBe('2026-09-25T17:41:35.000Z');
    expect(rebaseString('2026-09-30', plan)).toBe('2026-10-01');
    for (const s of ['Sep 14–20, 2026', 'inc_d7a20c', 'default|win_dc|r_win_dc|win_event_trim|splunk_cloud', '2026-09', '22d0a5e', '']) {
      expect(rebaseString(s, plan)).toBe(s);
    }
  });

  it('walks objects and arrays without mutating them; numbers never move', () => {
    const input = { t: '2026-09-24T00:00:00.000Z', day: '2026-09-24', n: 42, list: [{ at: '2026-09-24T12:00:00.000Z', v: 1.5 }], nil: null };
    const frozen = JSON.stringify(input);
    const out = rebaseValue(input, plan);
    expect(out).toEqual({ t: '2026-09-25T01:00:00.000Z', day: '2026-09-25', n: 42, list: [{ at: '2026-09-25T13:00:00.000Z', v: 1.5 }], nil: null });
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it('keeps every gap between two instants (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4e12 }), fc.integer({ min: 0, max: 4e9 }), fc.integer({ min: -4e11, max: 4e11 }), (a, gap, delta) => {
        const p = { deltaMs: delta, dayShift: 0 };
        const x = rebaseString(new Date(a).toISOString(), p);
        const y = rebaseString(new Date(a + gap).toISOString(), p);
        return Date.parse(y) - Date.parse(x) === gap && Date.parse(x) === a + delta;
      }),
    );
  });
});

describe('rebaseHeadline', () => {
  const tz = TOUR_FIXTURE.timezone ?? 'America/Chicago';
  const moved = (days: number): Snapshot => rebaseValue(TOUR_FIXTURE.snapshot, planRebase(ANCHOR, ANCHOR + days * 86_400_000, tz));

  it('changes nothing when the days did not move', () => {
    const s = rebaseHeadline(TOUR_FIXTURE.snapshot, tz, TOUR_FIXTURE.settings.criblCostCentsPerMonth);
    const h = TOUR_FIXTURE.snapshot.headline;
    expect([s.headline.mtdM, s.headline.whpMtdM, s.headline.paidMtdM, s.headline.netMtdM]).toEqual([h.mtdM, h.whpMtdM, h.paidMtdM, h.netMtdM]);
    expect(s.headline.paybackX).toBeCloseTo(h.paybackX ?? 0, 3);
  });

  it('into a new month: month to date is the new month’s days only', () => {
    const s = rebaseHeadline(moved(10), tz, undefined); // Oct 4
    const oct = s.trend.filter((p) => p.day.startsWith('2026-10'));
    expect(oct).toHaveLength(4);
    expect(s.headline.mtdM).toBe(oct.reduce((a, p) => a + p.savedM, 0));
    expect(s.headline.netMtdM).toBeUndefined();
    expect(s.headline.paybackX).toBeUndefined();
    expect(s.headline.annualizedM).toBe(TOUR_FIXTURE.snapshot.headline.annualizedM);
  });

  it("moves every destination's month to date with the hero, so the statements add up to it (review W2)", () => {
    const sum = (s: Snapshot, k: 'mtdWhpM' | 'mtdPaidM' | 'mtdSavedM') => (s.destinations ?? []).reduce((a, d) => a + d[k], 0);
    const recorded = TOUR_FIXTURE.snapshot;
    expect(sum(recorded, 'mtdSavedM')).toBe(recorded.headline.mtdM); // the recording adds up
    for (const days of [2, 10]) {
      const s = rebaseHeadline(moved(days), tz, TOUR_FIXTURE.settings.criblCostCentsPerMonth);
      expect(s.headline.mtdM).not.toBe(recorded.headline.mtdM);
      expect(sum(s, 'mtdSavedM')).toBe(s.headline.mtdM);
      expect(sum(s, 'mtdPaidM')).toBe(s.headline.paidMtdM);
      expect(sum(s, 'mtdWhpM')).toBe(s.headline.whpMtdM);
      expect((s.headline.reducedMtdM ?? 0) + (s.headline.divertedMtdM ?? 0)).toBe(s.headline.mtdM);
      for (const d of s.destinations ?? []) expect(d.mtdWhpM).toBeGreaterThanOrEqual(d.mtdSavedM);
    }
    // Into October (played on Oct 4): the month holds four days' minutes.
    const oct = rebaseHeadline(moved(10), tz, undefined);
    const expected = oct.headline.expectedMinutesMtd ?? 0;
    expect(expected).toBeGreaterThan(3 * 1440);
    expect(expected).toBeLessThanOrEqual(4 * 1440);
  });

  it('leaves a snapshot with an unreadable sweep time alone', () => {
    const odd = { ...TOUR_FIXTURE.snapshot, sweepAt: 'soon' };
    expect(rebaseHeadline(odd, tz, 1)).toBe(odd);
  });
});

describe('first-run gate', () => {
  const defaults = defaultSettings('2026-09-26T00:00:00.000Z', 'UTC');
  const hydrated = { hasHydrated: true, status: { hydrate: { phase: 'done' as const }, live: { phase: 'idle' as const }, sweep: { running: false, nextManualAt: 0, metering: false } } };
  const priced: PricesDoc = { schemaVersion: 1, updatedAt: '', versions: [{ effectiveFrom: '2026-09-25T00:00:00.000Z', byOutputId: { splunk: { milliCentsPerGb: 250_000 } } }] };
  const zeroPriced: PricesDoc = { schemaVersion: 1, updatedAt: '', versions: [{ effectiveFrom: '2026-09-25T00:00:00.000Z', byOutputId: { devnull: { milliCentsPerGb: 0, preset: 'internal' } } }] };
  const unpricedSnapshot = { destinations: [{ outputId: 'splunk', unpriced: true, milliCentsPerGb: 0 }] } as unknown as Snapshot;
  const pricedSnapshot = { destinations: [{ outputId: 'splunk', unpriced: false, milliCentsPerGb: 250_000 }] } as unknown as Snapshot;

  it('waits for hydration', () => {
    expect(firstRunGate(createAppState(defaults))).toBe('loading');
    expect(firstRunGate(createAppState(defaults, { status: { ...hydrated.status, hydrate: { phase: 'loading' } } }))).toBe('loading');
  });

  it('shows the card only on an empty workspace: the same gate as `/` (P1-D06)', () => {
    expect(firstRunGate(createAppState(defaults, hydrated))).toBe('show');
    // A snapshot, or a saved prices document (even all $0), is past first run on both routes: `/` shows the
    // Receipt (with its unpriced / all-$0 notice) and `/first-run` sends there too.
    for (const extra of [{ snapshot: unpricedSnapshot }, { prices: zeroPriced }]) {
      const state = createAppState(defaults, { ...hydrated, ...extra });
      expect(firstRunGate(state)).toBe('priced');
      expect(homeTarget(state)).toBe('receipt');
    }
    expect(homeTarget(createAppState(defaults, hydrated))).toBe('first-run');
  });

  it('never calls an unreadable workspace empty', () => {
    const forbidden = { kind: 'forbidden' as const, status: 403, at: 0 };
    const state = createAppState(defaults, { ...hydrated, errors: { prices: forbidden } });
    expect(firstRunGate(state)).toBe('priced');
    expect(homeTarget(state)).toBe('receipt');
  });

  it('hands over to the Receipt once a price exists', () => {
    expect(firstRunGate(createAppState(defaults, { ...hydrated, prices: priced }))).toBe('priced');
    expect(firstRunGate(createAppState(defaults, { ...hydrated, snapshot: pricedSnapshot }))).toBe('priced');
    expect(pathAfterTour(createAppState(defaults, { ...hydrated, prices: priced }))).toBe('/');
    expect(pathAfterTour(createAppState(defaults, hydrated))).toBe('/first-run');
  });

  it('never shows while a tour or replay owns the screen, and judges the LIVE workspace', () => {
    const touring = createAppState(defaults, {
      ...hydrated,
      source: 'sample',
      prices: priced,
      snapshot: pricedSnapshot,
      liveStash: { settings: defaults, prices: null, snapshot: null, meta: null },
    });
    expect(firstRunGate(touring)).toBe('tour');
    expect(isWorkspacePriced(touring)).toBe(false); // the sample's prices are not the member's
    expect(liveDocs(touring)).toEqual({ prices: null, snapshot: null });
    expect(pathAfterTour(touring)).toBe('/first-run');
  });

  it('a failed hydration still shows the card (the tour needs no KV)', () => {
    expect(firstRunGate(createAppState(defaults, { status: { ...hydrated.status, hydrate: { phase: 'error' } } }))).toBe('show');
  });
});
