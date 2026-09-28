// P2-W01: "Saved since you started watching" — the running total the stage accrues while the room watches.
import { describe, expect, it } from 'vitest';
import {
  SESSION_MAX_EXTRAPOLATION_SEC,
  nextSegment,
  sessionRate,
  sessionRateText,
  sessionValueAt,
  startSession,
} from '../../src/views/Presenter/session.ts';

const T0 = Date.parse('2026-09-30T16:00:00.000Z');
const RATE = 4_073; // mc/s ≈ $3,519 a day

describe('the session ticker (P2-W01)', () => {
  it('starts at $0.00 when the stage opens and accrues at the measured rate', () => {
    const seg = startSession(T0, RATE, 'a');
    expect(sessionValueAt(seg, T0)).toBe(0);
    expect(sessionValueAt(seg, T0 + 10_000)).toBe(RATE * 10);
    // Never before the stage opened.
    expect(sessionValueAt(seg, T0 - 5_000)).toBe(0);
  });

  it('carries the total over when a new snapshot changes the rate, and never jumps', () => {
    const a = startSession(T0, RATE, 'a');
    const b = nextSegment(a, T0 + 30_000, RATE * 2, 'b');
    expect(b.baseM).toBe(RATE * 30);
    expect(b.fromMs).toBe(T0 + 30_000);
    expect(sessionValueAt(b, T0 + 30_000)).toBe(sessionValueAt(a, T0 + 30_000));
    expect(sessionValueAt(b, T0 + 40_000)).toBe(RATE * 30 + RATE * 2 * 10);
  });

  it('freezes while the data is not live (rate 0) and resumes from where it stopped', () => {
    const a = startSession(T0, RATE, 'live');
    const frozen = nextSegment(a, T0 + 20_000, 0, 'stale');
    expect(frozen.ratePerSecM).toBe(0);
    expect(sessionValueAt(frozen, T0 + 20_000)).toBe(RATE * 20);
    expect(sessionValueAt(frozen, T0 + 600_000)).toBe(RATE * 20);
    const again = nextSegment(frozen, T0 + 600_000, RATE, 'live2');
    expect(sessionValueAt(again, T0 + 610_000)).toBe(RATE * 30);
  });

  it('stops at the live window past its anchor: a stalled sweep never invents money', () => {
    const seg = startSession(T0, RATE, 'a');
    expect(sessionValueAt(seg, T0 + 3_600_000)).toBe(RATE * SESSION_MAX_EXTRAPOLATION_SEC);
  });

  it('treats a missing, negative or non-finite rate as frozen', () => {
    for (const r of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, undefined, null]) expect(sessionRate(r as number)).toBe(0);
    expect(sessionRateText(0)).toBeNull();
  });

  it('names the rate in a unit that shows at least a cent', () => {
    expect(sessionRateText(26_000)).toBe('~$0.26 a second'); // the enterprise sample, $8.1M a year
    expect(sessionRateText(RATE)).toBe('~$0.04 a second');
    expect(sessionRateText(316)).toBe('~$0.19 a minute'); // ≈ $99.5k a year
    expect(sessionRateText(10)).toBe('~$0.36 an hour');
  });
});
