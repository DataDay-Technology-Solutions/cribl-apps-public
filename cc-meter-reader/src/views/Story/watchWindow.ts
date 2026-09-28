// src/views/Story/watchWindow.ts — what the "watching" chart frames (P1-C04), pure.
//
// The chart used to span the snapshot's whole 30-minute series on a fixed 0–100 % axis, so the drop after the
// change was a 60 px stub in the last fifteenth of the plot. It now frames the change: the time after it (from
// the deploy to the series' end, to the second) takes at least a third of the width, with a steady stretch
// before it of up to twice that, whole series minutes, never more than 8; and the ratio axis starts a step
// below the lowest reading instead of at zero, so a 75 % → 50 % drop fills a third of the height.

const MINUTE = 60_000;

/** At most this many whole minutes of the steady line before the change's own minute. */
export const MAX_BEFORE_MINUTES = 8;
/** At least this many (so there is a steady line to read the drop against). */
export const MIN_BEFORE_MINUTES = 1;
/** The time shown before the change is at most this many times the time after it: the after part is ≥ 1/3. */
const BEFORE_PER_AFTER = 2;
/** The ratio axis steps in quarters; its floor is the quarter at or below (lowest reading − 0.15). */
const AXIS_STEP = 0.25;
const AXIS_HEADROOM = 0.15;

export interface WatchWindow {
  /** index of the first minute shown in the series */
  first: number;
  /** start of the first minute shown, epoch ms */
  startMs: number;
  /** end of the last minute (the series' end), epoch ms */
  endMs: number;
  /** minutes shown */
  minutes: number;
  /** the ratio axis: [lo, 1] */
  lo: number;
  /** the axis' gridlines, lo … 1 in quarters */
  ticks: number[];
}

/**
 * The window around a change for a per-minute series (oldest first; point i is the minute starting at
 * endMs − (n − i) min) and the ratio axis for it. `baseline` (the ratio held before the change) is always
 * inside the axis.
 */
export function watchWindow(values: readonly number[], endMs: number, changeMs: number, baseline: number): WatchWindow {
  const n = values.length;
  const seriesStart = endMs - n * MINUTE;
  // The series' own minute the change landed in (the story rebases every time onto the wall clock, so the
  // series' minutes need not start on a clock minute, and the change may land anywhere inside one).
  const cut = changeIndex(n, endMs, changeMs);
  let first = 0;
  if (cut !== null && cut > 0) {
    // Measured to the second: the change is `into` minutes into its own series minute, and `after` minutes
    // of the plot follow it. The whole minutes before its minute are the most that keep before ≤ 2 × after.
    const after = (endMs - changeMs) / MINUTE;
    const into = (changeMs - (seriesStart + cut * MINUTE)) / MINUTE;
    const whole = Math.floor(BEFORE_PER_AFTER * after - into + 1e-9);
    const before = Math.min(MAX_BEFORE_MINUTES, Math.max(MIN_BEFORE_MINUTES, whole));
    first = Math.max(0, cut - before);
  } else if (cut === null && n > MAX_BEFORE_MINUTES * 2) {
    // The change has not reached the series yet: the latest minutes, as they would read up to it.
    first = n - MAX_BEFORE_MINUTES * 2;
  }
  const shown = values.slice(first).filter((v) => Number.isFinite(v));
  const low = Math.min(...shown, Number.isFinite(baseline) ? baseline : 1, 1);
  const lo = Math.max(0, Math.floor((low - AXIS_HEADROOM) / AXIS_STEP + 1e-9) * AXIS_STEP);
  const ticks: number[] = [];
  for (let v = lo; v <= 1 + 1e-9; v += AXIS_STEP) ticks.push(Math.round(v * 100) / 100);
  return { first, startMs: seriesStart + first * MINUTE, endMs, minutes: n - first, lo, ticks };
}

/**
 * The index of the series minute a change landed in (point i covers [endMs − (n − i) min, endMs − (n − i − 1) min)),
 * 0 when it predates the series, null when it has not reached it (or is not a time).
 */
export function changeIndex(n: number, endMs: number, changeMs: number): number | null {
  if (!Number.isFinite(changeMs) || !Number.isFinite(endMs) || changeMs >= endMs) return null;
  return Math.max(0, Math.floor((changeMs - (endMs - n * MINUTE)) / MINUTE));
}
