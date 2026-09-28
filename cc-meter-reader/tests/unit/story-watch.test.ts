// The Story's "watching" chart frame (src/views/Story/watchWindow.ts, P1-C04): the time after a change (to the
// second) takes at least a third of the width, after whole steady minutes before it (1–8), and the ratio axis
// starts a quarter below the lowest reading instead of at zero.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { TourDoc } from '../../core/types.ts';
import { storyMoments } from '../../src/story/beats.ts';
import { flowOf } from '../../src/story/select.ts';
import { MAX_BEFORE_MINUTES, MIN_BEFORE_MINUTES, changeIndex, watchWindow } from '../../src/views/Story/watchWindow.ts';

const MIN = 60_000;
const END = Date.parse('2026-09-24T16:41:00Z');

/** A 30-minute series steady at `from`, stepping to `to` for its last `after` minutes. */
function series(after: number, from = 0.75, to = 0.5, n = 30): number[] {
  return Array.from({ length: n }, (_, i) => (i >= n - after ? to : from));
}

/** The share of the plot's width (its minutes) that comes after the change, measured from the change itself. */
const afterShare = (w: ReturnType<typeof watchWindow>, changeMs: number) => (w.endMs - changeMs) / MIN / w.minutes;

describe('watchWindow', () => {
  // Every after-span from one minute to ten, landing anywhere inside its minute (the story rebases the
  // fixture onto the wall clock, so the change's second within a series minute is arbitrary).
  const spans = [1, 1.02, 1.2, 1.5, 1.85, 1.99, 2, 2.5, 3, 4.1, 6, 10];
  it.each(spans)('%f minute(s) after the change fill at least a third of the plot', (span) => {
    const change = END - span * MIN;
    const w = watchWindow(series(Math.ceil(span)), END, change, 0.75);
    expect(afterShare(w, change)).toBeGreaterThanOrEqual(1 / 3 - 1e-9);
    // Whole minutes before the change's own minute: at least one, never more than the cap.
    const cut = changeIndex(30, END, change)!;
    const before = cut - w.first;
    expect(before).toBeGreaterThanOrEqual(MIN_BEFORE_MINUTES);
    expect(before).toBeLessThanOrEqual(MAX_BEFORE_MINUTES);
    expect(w.startMs).toBe(END - w.minutes * MIN);
    expect(w.first).toBe(30 - w.minutes);
  });

  it('shows as much steady line as the third allows: before ≤ 2 × after, to the minute', () => {
    // 1 min 51 s after (the fixture's own shape): the change is 9 s into its minute, three whole minutes before it.
    const change = END - 111_000;
    const w = watchWindow(series(2), END, change, 0.75);
    expect(changeIndex(30, END, change)! - w.first).toBe(3);
    expect(afterShare(w, change)).toBeCloseTo(111 / 300, 5);
    // Long after a change the steady stretch stops at the cap.
    expect(changeIndex(30, END, END - 20 * MIN)! - watchWindow(series(20), END, END - 20 * MIN, 0.75).first).toBe(MAX_BEFORE_MINUTES);
  });

  it('frames the enterprise sample story the way the loop plays it: 3 steady minutes, the change, 37 % after it, a 25–100 % axis', () => {
    const tour = JSON.parse(readFileSync(new URL('../../demo/sample/tour.json', import.meta.url), 'utf8')) as TourDoc;
    const m = storyMoments(tour);
    const flow = flowOf(tour.snapshot.flows, m.incident.objectKey)!;
    const change = Date.parse(m.commit.deployedAt ?? m.commit.committedAt);
    const w = watchWindow(flow.sparkline, Date.parse(tour.snapshot.windowEnd), change, m.incident.before);
    expect(w.minutes).toBe(5);
    expect(afterShare(w, change)).toBeCloseTo(0.37, 5);
    expect(w.lo).toBe(0.25);
    expect(w.ticks).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('keeps the baseline and every shown reading on the axis, a quarter below the lowest', () => {
    const w = watchWindow(series(2, 0.92, 0.4), END, END - 2 * MIN, 0.92);
    expect(w.lo).toBe(0.25);
    const shallow = watchWindow(series(2, 0.95, 0.9), END, END - 2 * MIN, 0.95);
    expect(shallow.lo).toBe(0.75);
    expect(shallow.ticks).toEqual([0.75, 1]);
    const deep = watchWindow(series(2, 0.3, 0.05), END, END - 2 * MIN, 0.3);
    expect(deep.lo).toBe(0);
    expect(deep.ticks).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("reads the change against the series' own minutes, wherever the wall clock put them", () => {
    // The story rebases the fixture onto the wall clock: the series' minutes may start 17.4 s past a clock minute.
    const end = END + 17_400;
    const change = end - 2 * MIN - 50_000; // inside the third-last series minute, 10 s into it
    expect(changeIndex(30, end, change)).toBe(27);
    const w = watchWindow(series(3), end, change, 0.75);
    expect(afterShare(w, change)).toBeGreaterThanOrEqual(1 / 3);
    expect(27 - w.first).toBe(5);
    expect(changeIndex(30, end, end)).toBeNull();
    expect(changeIndex(30, end, end - 45 * MIN)).toBe(0);
  });

  it('a change before the series or not yet in it shows the latest minutes', () => {
    const early = watchWindow(series(0), END, END - 40 * MIN, 0.75);
    expect(early.first).toBe(0);
    const pending = watchWindow(series(0), END, END + 3 * MIN, 0.75);
    expect(pending.minutes).toBe(MAX_BEFORE_MINUTES * 2);
    const bad = watchWindow(series(0), END, Number.NaN, 0.75);
    expect(bad.minutes).toBeGreaterThan(0);
    expect(bad.ticks.at(-1)).toBe(1);
  });
});
