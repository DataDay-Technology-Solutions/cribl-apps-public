// @vitest-environment jsdom
// The Meter as the presenter's stage uses it (P0-16, P1-B03) and its frame loop (P1-B05): a static figure that
// rolls to each new value (`rollStatic`), prefers-reduced-motion followed live, a fresh figure that starts at the
// accrued value, and a loop that runs only while something moves.

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fmtDollars } from '../../core/format.ts';
import { Meter } from '../../src/components/Meter/Meter.tsx';
import { EASE_MS } from '../../src/components/Meter/meterMath.ts';

const MC = 100_000;
const figure = () => document.querySelector<HTMLElement>('[data-callout="saved"]');
const valueM = () => Number(figure()?.dataset.valueM);

/** A controllable prefers-reduced-motion media query. */
function mockReducedMotion(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    media: '(prefers-reduced-motion: reduce)',
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal('matchMedia', () => query);
  return {
    set(matches: boolean) {
      query.matches = matches;
      for (const fn of [...listeners]) fn();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'setInterval', 'clearTimeout'] });
  vi.setSystemTime(Date.parse('2026-09-26T12:00:00.000Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Meter on the stage', () => {
  it('rollStatic: a static figure keeps whole-dollar wheels and eases to each new value over 900 ms', () => {
    mockReducedMotion(false);
    const t0 = Date.now();
    const { rerender } = render(<Meter valueM={1_284_435 * MC} ratePerSecM={0} anchorMs={t0} label="Saved" size="inherit" rollStatic />);
    expect(document.querySelectorAll('.mr-meter-wheel')).toHaveLength(7); // $1,284,435: seven digit wheels
    expect(document.querySelector('.mr-meter-cents')).toBeNull(); // no cents on a static figure
    expect(figure()?.dataset.ticking).toBe('false');
    expect(valueM()).toBe(1_284_435 * MC);
    // At rest nothing moves: the loop is idle.
    expect(figure()?.dataset.running).toBe('false');

    rerender(<Meter valueM={1_398_762 * MC} ratePerSecM={0} anchorMs={Date.now()} label="Saved" size="inherit" rollStatic />);
    expect(figure()?.dataset.running).toBe('true');
    act(() => {
      vi.advanceTimersByTime(EASE_MS / 3);
    });
    const mid = valueM();
    expect(mid).toBeGreaterThan(1_284_435 * MC);
    expect(mid).toBeLessThan(1_398_762 * MC);
    act(() => {
      vi.advanceTimersByTime(EASE_MS);
    });
    expect(valueM()).toBe(1_398_762 * MC);
    expect(figure()?.dataset.running).toBe('false');
  });

  it('without rollStatic a static figure is plain text and jumps', () => {
    mockReducedMotion(false);
    render(<Meter valueM={1_284_435 * MC} ratePerSecM={0} anchorMs={Date.now()} label="Saved" />);
    expect(document.querySelector('.mr-meter-wheel')).toBeNull();
    expect(figure()?.textContent).toBe(fmtDollars(1_284_435 * MC));
  });

  it('follows prefers-reduced-motion live: switching it on mid-tick stops the loop and drops the wheels', () => {
    const media = mockReducedMotion(false);
    render(<Meter valueM={91_420 * MC} ratePerSecM={4_073} anchorMs={Date.now()} label="Saved" size="inherit" rollStatic />);
    expect(figure()?.dataset.ticking).toBe('true');
    expect(figure()?.dataset.running).toBe('true');
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    act(() => media.set(true));
    expect(figure()?.dataset.ticking).toBe('false');
    expect(document.querySelector('.mr-meter-wheel')).toBeNull();
    raf.mockClear();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(raf).not.toHaveBeenCalled();
    // And back: it ticks again.
    act(() => media.set(false));
    expect(figure()?.dataset.ticking).toBe('true');
    expect(document.querySelectorAll('.mr-meter-wheel').length).toBeGreaterThan(0);
  });

  it('a fresh figure starts at the accrued value (the accrual since the sweep is not rolled in)', () => {
    mockReducedMotion(false);
    const sweptAt = Date.now() - 120_000;
    render(<Meter valueM={91_420 * MC} ratePerSecM={10 * MC} anchorMs={sweptAt} label="Saved" maxExtrapolationSec={600} />);
    // $91,420 + 120 s × $10/s, on the very first paint.
    expect(valueM()).toBe((91_420 + 1_200) * MC);
  });

  it('between the rolls of a slow meter the loop sleeps instead of asking for every frame', () => {
    mockReducedMotion(false);
    // 0.32 cents a second (the live rig): the last cent rolls for ~220 ms every ~3 s.
    render(<Meter valueM={1_000 * MC} ratePerSecM={320} anchorMs={Date.now()} label="Saved" />);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    // ~180 frames in 3 s if it never slept; one roll (~14 frames) and a few wake-ups when it does.
    expect(raf.mock.calls.length).toBeLessThan(40);
    expect(figure()?.dataset.running).toBe('true');
  });
});
