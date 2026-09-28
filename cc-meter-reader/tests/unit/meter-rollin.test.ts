// P2-W19: the stage hero's first-paint roll-up — from $0 to the figure over 1.2 s, once, continued (not restarted)
// when a sweep lands mid-roll.
import { describe, expect, it } from 'vitest';
import { EASE_MS, ROLL_IN_MS, continueRollIn, displayAt, needsFrames, rollInMotion, rollingIn, settled, type MeterAnchor } from '../../src/components/Meter/meterMath.ts';

const T0 = 1_000_000;
const anchor: MeterAnchor = { valueM: 1_284_435 * 100_000, ratePerSecM: 0, anchorMs: T0 };

describe('the first-paint roll-up (P2-W19)', () => {
  it('rolls from $0 to the figure over ROLL_IN_MS, eased out, then tracks', () => {
    const m = rollInMotion(T0);
    expect(ROLL_IN_MS).toBe(1_200);
    expect(displayAt(m, anchor, T0)).toBe(0);
    const mid = displayAt(m, anchor, T0 + 600);
    expect(mid).toBeGreaterThan(anchor.valueM / 2); // ease-out: most of it early
    expect(mid).toBeLessThan(anchor.valueM);
    expect(displayAt(m, anchor, T0 + ROLL_IN_MS)).toBe(anchor.valueM);
    expect(rollingIn(m, T0 + 1_000)).toBe(true);
    expect(rollingIn(m, T0 + ROLL_IN_MS)).toBe(false);
    // The frame loop runs for the whole roll-up, not the ordinary ease's 900 ms.
    expect(needsFrames(m, anchor, T0 + EASE_MS + 100)).toBe(true);
    expect(settled(m, anchor, T0 + EASE_MS + 100)).toBe(false);
    expect(settled(m, anchor, T0 + ROLL_IN_MS)).toBe(true);
  });

  it('a sweep mid-roll continues the same roll-up to the new figure, ending when it would have (never sooner than an ease)', () => {
    const m = rollInMotion(T0);
    const shown = displayAt(m, anchor, T0 + 200);
    const next = continueRollIn(m, shown, T0 + 200);
    expect(next.rollIn).toBe(true);
    expect(next.fromM).toBe(shown);
    expect(next.durationMs).toBe(1_000);
    const late = continueRollIn(m, shown, T0 + 1_000);
    expect(late.durationMs).toBe(EASE_MS);
    const bigger: MeterAnchor = { ...anchor, valueM: anchor.valueM + 5_000 * 100_000 };
    expect(displayAt(next, bigger, T0 + 1_200)).toBe(bigger.valueM);
  });

  it('an ordinary ease is not a roll-up', () => {
    expect(rollingIn({ mode: 'ease', fromM: 0, startMs: T0 }, T0 + 10)).toBe(false);
    expect(rollingIn(null, T0)).toBe(false);
  });
});
