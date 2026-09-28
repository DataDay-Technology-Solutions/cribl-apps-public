// @vitest-environment jsdom
// W3-RECEIPT-5: the Receipt hero's first-paint roll-up (P2-W19). Two Meter behaviours the Receipt relies on:
//   • rollInValue="target": data-value-m says the figure the roll-up rolls to from its first frame (a spec that reads
//     it once reads the snapshot's figure), while the default ('shown', the presenter's evidence) says the rolling one;
//   • a caller that withdraws `rollIn` mid-roll (the Receipt on a period switch) gets an ordinary ease from wherever
//     the wheels are, not the roll-up continued to the new figure.

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Meter } from '../../src/components/Meter/Meter.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const figure = () => document.querySelector<HTMLElement>('[data-callout="saved"]');
const value = (): number => Number(figure()?.dataset.valueM);
const V = 59_785_209_238; // $597,852.09, the tour's month to date
const RATE = 37_000; // ~37 cents a second

function fakeClock(): number {
  vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'setInterval'] });
  vi.setSystemTime(Date.parse('2026-09-27T09:00:00.000Z'));
  return Date.now();
}

describe('W3-RECEIPT-5: the Receipt hero rolls up once, and says its figure from the first frame', () => {
  it('rollInValue="target": data-value-m is the snapshot figure on the first frame and throughout the roll', () => {
    const t0 = fakeClock();
    render(<Meter valueM={V} ratePerSecM={RATE} anchorMs={t0} label="Saved by Cribl, month to date" rollIn={`w3-target-${Math.random()}`} rollInValue="target" />);
    expect(value()).toBe(V);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    // Mid-roll the wheels are below the figure, but the attribute says the figure (plus the accrual since).
    expect(value()).toBeGreaterThanOrEqual(V);
    expect(value()).toBeLessThanOrEqual(V + RATE * 0.3 + 1);
  });

  it('the default (the presenter): data-value-m says the rolling figure, near $0 on the first frame', () => {
    const t0 = fakeClock();
    render(<Meter valueM={V} ratePerSecM={RATE} anchorMs={t0} label="Saved by Cribl, month to date" rollIn={`w3-shown-${Math.random()}`} />);
    expect(value()).toBeLessThan(V * 0.1);
  });

  it('once per page per id: a second meter with the same id shows its figure at once', () => {
    const t0 = fakeClock();
    const id = `w3-once-${Math.random()}`;
    render(<Meter valueM={V} ratePerSecM={RATE} anchorMs={t0} label="Saved" rollIn={id} />);
    cleanup();
    render(<Meter valueM={V} ratePerSecM={RATE} anchorMs={t0} label="Saved" rollIn={id} />);
    expect(value()).toBeGreaterThanOrEqual(V);
  });

  it('withdrawing rollIn mid-roll (a period switch) eases from where the wheels are; keeping it continues the roll-up', () => {
    const today = 1_277_063_504; // $12,770.64
    for (const withdraw of [true, false]) {
      cleanup();
      const t0 = fakeClock();
      const id = `w3-switch-${withdraw}-${Math.random()}`;
      const { rerender } = render(<Meter valueM={V} ratePerSecM={RATE} anchorMs={t0} label="Saved" rollIn={id} rollInValue="target" />);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      rerender(<Meter valueM={today} ratePerSecM={RATE} anchorMs={Date.now()} label="Saved" rollIn={withdraw ? undefined : id} rollInValue="target" />);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      if (withdraw) {
        // An ordinary ease: the attribute reports the wheels on their way down, well above today's figure.
        expect(value()).toBeGreaterThan(today * 2);
        expect(value()).toBeLessThan(V);
      } else {
        // The roll-up continued to the new figure: the attribute says that figure.
        expect(value()).toBeGreaterThanOrEqual(today);
        expect(value()).toBeLessThanOrEqual(today + RATE + 1);
      }
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(value()).toBeGreaterThanOrEqual(today);
      expect(value()).toBeLessThan(today + RATE * 3);
      vi.useRealTimers();
    }
  });
});
