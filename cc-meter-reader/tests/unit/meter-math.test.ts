// The Meter's arithmetic (SPEC 13 "Ticking", SPEC 18 "Meter"): accrual, the 900 ms ease, the never-backwards
// rule with its $1 roll-down threshold, the odometer wheels, and the box-fitting estimate.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fmtDollars } from '../../core/format.ts';
import {
  DEFAULT_MAX_EXTRAPOLATION_SEC,
  EASE_MS,
  ROLL_DOWN_THRESHOLD_M,
  announceDollars,
  beginMotion,
  digitCount,
  displayAt,
  easeOutCubic,
  figureEm,
  jumpMotion,
  layoutFigure,
  rollWindow,
  settled,
  targetAt,
  unitsOf,
  wheelPosition,
  accruing,
  needsFrames,
  nextMove,
  spinPeriodMs,
  spinPhase,
  wheelTransform,
  FRAME_MS,
  SPIN_DIGITS_PER_SEC,
  type MeterAnchor,
} from '../../src/components/Meter/meterMath.ts';

const T0 = Date.parse('2026-09-26T12:00:00.000Z');
const anchor = (valueM: number, ratePerSecM: number, anchorMs = T0, maxExtrapolationSec?: number): MeterAnchor => ({
  valueM,
  ratePerSecM,
  anchorMs,
  maxExtrapolationSec,
});

describe('targetAt', () => {
  it('accrues ratePerSecM per second after the snapshot', () => {
    expect(targetAt(anchor(1_000_000, 500), T0)).toBe(1_000_000);
    expect(targetAt(anchor(1_000_000, 500), T0 + 10_000)).toBe(1_005_000);
  });
  it('never accrues before the snapshot and stops at the extrapolation cap', () => {
    expect(targetAt(anchor(1_000, 500), T0 - 60_000)).toBe(1_000);
    expect(targetAt(anchor(0, 1), T0 + 10 * 3_600_000)).toBe(DEFAULT_MAX_EXTRAPOLATION_SEC);
    expect(targetAt(anchor(0, 1, T0, 30), T0 + 60_000)).toBe(30);
  });
  it('treats a negative or non-finite rate as static and clamps negative values to 0', () => {
    expect(targetAt(anchor(5_000, -10), T0 + 5_000)).toBe(5_000);
    expect(targetAt(anchor(5_000, Number.NaN), T0 + 5_000)).toBe(5_000);
    expect(targetAt(anchor(-5, 0), T0)).toBe(0);
    expect(targetAt(anchor(Number.NaN, 0), T0)).toBe(0);
  });
});

describe('ease to the authoritative value', () => {
  it('eases up over 900 ms and lands exactly on the moving target', () => {
    const a = anchor(2_000_000, 1_000);
    const m = beginMotion(1_000_000, a, T0);
    expect(m.mode).toBe('ease');
    expect(displayAt(m, a, T0)).toBe(1_000_000);
    const mid = displayAt(m, a, T0 + EASE_MS / 2);
    expect(mid).toBeGreaterThan(1_000_000);
    expect(mid).toBeLessThan(targetAt(a, T0 + EASE_MS / 2));
    expect(displayAt(m, a, T0 + EASE_MS)).toBe(targetAt(a, T0 + EASE_MS));
    expect(settled(m, a, T0 + EASE_MS)).toBe(true);
  });

  it('holds a lower value within $1 (never visibly backwards) until the accrual catches up', () => {
    const shown = 10_000_000;
    const a = anchor(shown - 60_000, 1_000); // 60 cents lower, accruing 1 cent/s
    const m = beginMotion(shown, a, T0);
    expect(m.mode).toBe('hold');
    expect(displayAt(m, a, T0)).toBe(shown);
    expect(displayAt(m, a, T0 + 30_000)).toBe(shown); // still 30 cents short
    expect(settled(m, a, T0 + 30_000)).toBe(false);
    expect(displayAt(m, a, T0 + 90_000)).toBe(targetAt(a, T0 + 90_000)); // caught up, tracks again
    expect(settled(m, a, T0 + 90_000)).toBe(true);
  });

  it('rolls down when the authoritative value is more than $1 lower', () => {
    const shown = 10_000_000;
    const a = anchor(shown - ROLL_DOWN_THRESHOLD_M - 1, 0);
    const m = beginMotion(shown, a, T0);
    expect(m.mode).toBe('ease');
    expect(displayAt(m, a, T0 + EASE_MS)).toBe(shown - ROLL_DOWN_THRESHOLD_M - 1);
  });

  it('jumps (no roll) after a pause, but still holds a small drop', () => {
    const a = anchor(5_000_000, 100);
    expect(jumpMotion(undefined, a, T0).mode).toBe('track');
    expect(jumpMotion(4_000_000, a, T0).mode).toBe('track');
    expect(jumpMotion(5_050_000, a, T0).mode).toBe('hold');
    expect(jumpMotion(9_000_000, a, T0).mode).toBe('track');
  });

  it('property: between snapshots the display never decreases unless the drop exceeds $1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e12 }),
        fc.integer({ min: 0, max: 5e7 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: -2e5, max: 2e7 }),
        (shown, rate, lagMs, delta) => {
          const a = anchor(Math.max(0, shown + delta), rate, T0 - lagMs);
          const m = beginMotion(shown, a, T0);
          let prev = displayAt(m, a, T0);
          const drop = shown - targetAt(a, T0);
          for (let t = T0; t <= T0 + 3_000; t += 37) {
            const v = displayAt(m, a, t);
            if (drop <= ROLL_DOWN_THRESHOLD_M) expect(v).toBeGreaterThanOrEqual(prev - 1e-6);
            prev = v;
          }
          // Wherever it went, after the ease it equals (or, holding, never goes below) the target.
          expect(displayAt(m, a, T0 + 3_000)).toBeGreaterThanOrEqual(targetAt(a, T0 + 3_000) - 1e-6);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('easeOutCubic is clamped and monotonic', () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
  });
});

describe('odometer wheels', () => {
  it('lays out $12,345 + cents with place values, commas from core/format', () => {
    const layout = layoutFigure(5, true, fmtDollars);
    const text = layout.whole.map((g) => (g.kind === 'static' ? g.char : 'd')).join('');
    expect(text).toBe('$dd,ddd');
    const places = layout.whole.filter((g) => g.kind === 'digit').map((g) => (g.kind === 'digit' ? g.place : -1));
    expect(places).toEqual([6, 5, 4, 3, 2]);
    expect(layout.cents.map((g) => (g.kind === 'digit' ? g.place : -1))).toEqual([1, 0]);
    expect(layoutFigure(1, false, fmtDollars).whole).toEqual([{ kind: 'static', char: '$' }, { kind: 'digit', place: 0 }]);
  });

  it('counts digits', () => {
    expect(digitCount(0)).toBe(1);
    expect(digitCount(9)).toBe(1);
    expect(digitCount(10)).toBe(2);
    expect(digitCount(179_413)).toBe(6);
    expect(digitCount(-5)).toBe(1);
  });

  it('each digit shows its integer value and turns only during the carry', () => {
    const w = 0.2;
    // 1,234.50 cents: units digit 4 is half-way through its unit but outside the roll window.
    expect(wheelPosition(1234.5, 0, w)).toBe(4);
    expect(wheelPosition(1234.5, 1, w)).toBe(3);
    // In the last 20 % of the unit the lowest digit rolls toward 5.
    expect(wheelPosition(1234.95, 0, w)).toBeGreaterThan(4);
    expect(wheelPosition(1234.95, 0, w)).toBeLessThan(5);
    // Higher digits roll only when every lower digit reads 9.
    expect(wheelPosition(1234.95, 1, w)).toBe(3);
    const carry = wheelPosition(1299.95, 2, w);
    expect(carry).toBeGreaterThan(2);
    expect(carry).toBeLessThan(3);
    expect(wheelPosition(1299.95, 3, w)).toBe(1);
    // 9 → 0 lands on the strip's trailing zero (position 10).
    expect(wheelPosition(9.99999, 0, w)).toBeCloseTo(10, 3);
  });

  it('units and roll windows', () => {
    expect(unitsOf(123_456, true)).toBeCloseTo(123.456);
    expect(unitsOf(123_456, false)).toBeCloseTo(1.23456);
    expect(unitsOf(-5, true)).toBe(0);
    expect(rollWindow(0)).toBe(0.25);
    expect(rollWindow(0.1)).toBeCloseTo(0.022);
    expect(rollWindow(100)).toBe(0.33);
    expect(rollWindow(0.0001)).toBe(0.02);
  });

  it('announces whole dollars (floor, like the wheels)', () => {
    expect(announceDollars(17_941_399_999)).toBe(179_413);
    expect(announceDollars(Number.NaN)).toBe(0);
  });

  it('estimates the figure width so a long number can be capped to its container', () => {
    const short = figureEm('$10', 2);
    const long = figureEm('$12,345,678', 2);
    expect(long).toBeGreaterThan(short);
    // "$179,413" + ".42" at 56 px fits a 326 px card (390 px phone − gutters − card padding)?
    expect(figureEm('$179,413', 2) * 56).toBeLessThan(326);
    // "$12,345,678" + cents would not: the CSS cap shrinks it instead of overflowing.
    expect(figureEm('$12,345,678', 2) * 56).toBeGreaterThan(326);
  });
});

// P1-B05: the frame loop runs only while something moves, the unreadably fast wheels spin on the compositor, and
// between rolls the loop sleeps until the next one.
describe('frame cost', () => {
  it('accrues only with a rate and under the extrapolation cap', () => {
    expect(accruing(anchor(100, 1_000), T0 + 1_000)).toBe(true);
    expect(accruing(anchor(100, 0), T0 + 1_000)).toBe(false);
    expect(accruing(anchor(100, Number.NaN), T0 + 1_000)).toBe(false);
    expect(accruing(anchor(100, 1_000), T0 + DEFAULT_MAX_EXTRAPOLATION_SEC * 1000)).toBe(false);
    expect(accruing(anchor(100, 1_000, T0, 10), T0 + 9_999)).toBe(true);
  });

  it('needs frames during an ease or an accrual; a static figure at rest needs none', () => {
    const still = anchor(100_000, 0);
    expect(needsFrames(null, still, T0)).toBe(false);
    expect(needsFrames({ mode: 'ease', fromM: 0, startMs: T0 }, still, T0 + EASE_MS - 1)).toBe(true);
    expect(needsFrames({ mode: 'ease', fromM: 0, startMs: T0 }, still, T0 + EASE_MS)).toBe(false);
    expect(needsFrames({ mode: 'track', fromM: 0, startMs: T0 }, anchor(100_000, 500), T0 + 1)).toBe(true);
    // A stalled feed past its cap stops the loop.
    expect(needsFrames({ mode: 'track', fromM: 0, startMs: T0 }, anchor(100_000, 500), T0 + 200_000)).toBe(false);
  });

  it('spins a wheel only when its digit changes at least 8 times a second, one turn per ten digits', () => {
    expect(SPIN_DIGITS_PER_SEC).toBe(8);
    // 37.3 cents a second: the last cent spins (a turn every 268 ms), the tens of cents (3.7/s) do not.
    expect(spinPeriodMs(37.3, 0)).toBeCloseTo(268.1, 1);
    expect(spinPeriodMs(37.3, 1)).toBeNull();
    expect(spinPeriodMs(80, 1)).toBeCloseTo(1_250, 5);
    expect(spinPeriodMs(7.99, 0)).toBeNull();
    expect(spinPeriodMs(0, 0)).toBeNull();
    expect(spinPeriodMs(Number.NaN, 0)).toBeNull();
  });

  it('starts a spin on the digit the value shows', () => {
    expect(spinPhase(1234.5, 0)).toBeCloseTo(0.45, 10);
    expect(spinPhase(1234.5, 1)).toBeCloseTo(0.345, 10);
    expect(spinPhase(-3, 0)).toBe(0);
    // The spin's keyframes cover one turn: the leading 0 to the trailing 0 of the 11-cell strip.
    expect(wheelTransform(0, 11)).toBe('translate3d(0, 0%, 0)');
    expect(wheelTransform(10, 11)).toBe(`translate3d(0, ${(-10 * 100) / 11}%, 0)`);
  });

  it('knows when the lowest rolled wheel next moves: frames for a visible roll, one draw for a sub-frame carry', () => {
    // A slow meter (0.32 cents/s): the last cent rolls over the last 0.07 of each cent, 220 ms — frames needed.
    const w = rollWindow(0.32);
    const soon = nextMove(1000.5, 0.32, w, 0);
    expect(soon.roll).toBe(true);
    expect(soon.ms).toBeCloseTo(((1 - w - 0.5) / 0.32) * 1000, 6);
    expect(nextMove(1000.97, 0.32, w, 0)).toEqual({ ms: 0, roll: true });
    // 37 cents a second with the last cent spinning: the tens of cents change on the carry, which lasts under a
    // frame, so the next move is the carry itself.
    const fast = rollWindow(37);
    expect((fast / 37) * 1000).toBeLessThan(FRAME_MS);
    const carry = nextMove(1234, 37, fast, 1);
    expect(carry.roll).toBe(false);
    expect(carry.ms).toBeCloseTo((6 / 37) * 1000, 6);
    // Nothing rolls: every wheel spins, or there is no accrual.
    expect(nextMove(1234, 37, fast, Number.POSITIVE_INFINITY)).toEqual({ ms: Number.POSITIVE_INFINITY, roll: false });
    expect(nextMove(1234, 0, fast, 0)).toEqual({ ms: Number.POSITIVE_INFINITY, roll: false });
  });
});

