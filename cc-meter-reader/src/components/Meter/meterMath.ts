// src/components/Meter/meterMath.ts — the pure arithmetic behind the ticking Meter (SPEC 13 "Ticking",
// PRD 8.8 item 4). No DOM, no React: the component calls these once per animation frame.
//
//   target(t)    = snapshot value + ratePerSecM × seconds since the snapshot (capped, so a stalled sweep
//                  never runs away)
//   on snapshot  → ease from what is on screen to the moving target over 900 ms
//   never back   → if the new target is LOWER than what is on screen, hold the screen value and let the
//                  accrual catch up — unless the gap exceeds $1, then roll down (SPEC 13)
//   odometer     → each digit is a wheel; a wheel turns only while every digit to its right is rolling
//                  over from 9 to 0 (carry), so digits never sit half-way between two values
//
// Money is integer MILLICENTS ($1 = 100,000 mc); the display value is fractional while ticking.

import { MC_PER_CENT, MC_PER_DOLLAR } from '../../../core/format.ts';

/** How long the Meter eases to a new authoritative value (SPEC 13). */
export const EASE_MS = 900;
/** The first-paint roll-up (P2-W19): a meter that opts in rolls from $0 to its figure once per page. */
export const ROLL_IN_MS = 1_200;
/** Below this gap a lower authoritative value is held, not rolled down to (SPEC 13: "unless the gap exceeds $1"). */
export const ROLL_DOWN_THRESHOLD_M = MC_PER_DOLLAR;
/** Default cap on extrapolation past the snapshot: a stalled sweep stops the meter instead of inventing money. */
export const DEFAULT_MAX_EXTRAPOLATION_SEC = 180;
/** Screen readers hear the value at most this often (SPEC 18 "aria-live throttled"). */
export const ARIA_THROTTLE_MS = 30_000;
/** How long one digit takes to roll to the next, when the rate allows it. */
export const ROLL_SECONDS = 0.22;
/** The figure's value attribute (`data-value-m`, read by tests and the tour) is refreshed at most this often. */
export const VALUE_ATTR_MS = 250;

/** The authoritative value from the latest snapshot and how fast it accrues. */
export interface MeterAnchor {
  /** Value at `anchorMs`, integer millicents. */
  valueM: number;
  /** Accrual in millicents per second (snapshot.ratePerSecM); 0 = static (e.g. the annualized rate). */
  ratePerSecM: number;
  /** When `valueM` was true (snapshot.sweepAt), epoch ms. */
  anchorMs: number;
  /** Stop extrapolating this many seconds after `anchorMs`. */
  maxExtrapolationSec?: number;
}

export type MotionMode = 'ease' | 'hold' | 'track';

/** How the screen value moves toward the target after the latest snapshot. */
export interface MeterMotion {
  mode: MotionMode;
  /** The value on screen when this motion began. */
  fromM: number;
  /** When this motion began, epoch ms. */
  startMs: number;
  /** An ease's length; EASE_MS when absent (the roll-up's is ROLL_IN_MS). */
  durationMs?: number;
  /** Part of the first-paint roll-up (P2-W19): the figure keeps its final layout while it runs. */
  rollIn?: boolean;
}

/** The first-paint roll-up (P2-W19): from $0 to the moving target over ROLL_IN_MS. */
export function rollInMotion(nowMs: number): MeterMotion {
  return { mode: 'ease', fromM: 0, startMs: nowMs, durationMs: ROLL_IN_MS, rollIn: true };
}

/** Whether a roll-up is still running at `nowMs`. */
export function rollingIn(motion: MeterMotion | null | undefined, nowMs: number): boolean {
  return !!motion?.rollIn && nowMs - motion.startMs < (motion.durationMs ?? EASE_MS);
}

/**
 * A new value while the roll-up runs (a sweep lands mid-roll): keep rolling from where the figure is to the new
 * target, ending when the roll-up would have (never sooner than an ordinary ease) — one roll-up, not two.
 */
export function continueRollIn(motion: MeterMotion, displayedM: number, nowMs: number): MeterMotion {
  const end = motion.startMs + (motion.durationMs ?? EASE_MS);
  return { mode: 'ease', fromM: displayedM, startMs: nowMs, durationMs: Math.max(EASE_MS, end - nowMs), rollIn: true };
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Where the authoritative value is at `nowMs` (never below the snapshot value, never negative). */
export function targetAt(anchor: MeterAnchor, nowMs: number): number {
  const cap = anchor.maxExtrapolationSec ?? DEFAULT_MAX_EXTRAPOLATION_SEC;
  const rate = Number.isFinite(anchor.ratePerSecM) && anchor.ratePerSecM > 0 ? anchor.ratePerSecM : 0;
  const base = Number.isFinite(anchor.valueM) ? Math.max(0, anchor.valueM) : 0;
  const elapsed = Number.isFinite(nowMs - anchor.anchorMs) ? clamp((nowMs - anchor.anchorMs) / 1000, 0, cap) : 0;
  return base + rate * elapsed;
}

/** Ease-out cubic: fast start, gentle landing (Capra's standard curve is the same family). */
export function easeOutCubic(p: number): number {
  const x = clamp(p, 0, 1);
  return 1 - (1 - x) ** 3;
}

/**
 * The motion to start when a new snapshot (anchor) arrives while `displayedM` is on screen.
 * Up → ease. Down by more than $1 → ease (roll down). Down by $1 or less → hold.
 */
export function beginMotion(displayedM: number, anchor: MeterAnchor, nowMs: number): MeterMotion {
  const target = targetAt(anchor, nowMs);
  if (target >= displayedM || displayedM - target > ROLL_DOWN_THRESHOLD_M) return { mode: 'ease', fromM: displayedM, startMs: nowMs };
  return { mode: 'hold', fromM: displayedM, startMs: nowMs };
}

/**
 * The motion after a pause (tab hidden, first mount, reduced motion): jump straight to the target when
 * that is up (or a > $1 drop), otherwise hold — the no-backwards rule still applies, the roll does not.
 */
export function jumpMotion(displayedM: number | undefined, anchor: MeterAnchor, nowMs: number): MeterMotion {
  const target = targetAt(anchor, nowMs);
  if (displayedM === undefined || target >= displayedM || displayedM - target > ROLL_DOWN_THRESHOLD_M) {
    return { mode: 'track', fromM: target, startMs: nowMs };
  }
  return { mode: 'hold', fromM: displayedM, startMs: nowMs };
}

/** The value to draw at `nowMs`. Monotonic non-decreasing while the target is, except a > $1 roll-down. */
export function displayAt(motion: MeterMotion, anchor: MeterAnchor, nowMs: number): number {
  const target = targetAt(anchor, nowMs);
  switch (motion.mode) {
    case 'hold':
      return Math.max(motion.fromM, target);
    case 'ease': {
      const p = (nowMs - motion.startMs) / (motion.durationMs ?? EASE_MS);
      if (p >= 1) return target;
      return motion.fromM + (target - motion.fromM) * easeOutCubic(p);
    }
    default:
      return target;
  }
}

/** Whether a motion has settled into plain tracking (lets the loop drop the bookkeeping). */
export function settled(motion: MeterMotion, anchor: MeterAnchor, nowMs: number): boolean {
  if (motion.mode === 'track') return true;
  if (motion.mode === 'ease') return nowMs - motion.startMs >= (motion.durationMs ?? EASE_MS);
  return targetAt(anchor, nowMs) >= motion.fromM;
}

/** Whether the figure is accruing at `nowMs`: it has a rate and has not reached its extrapolation cap. */
export function accruing(anchor: MeterAnchor, nowMs: number): boolean {
  const rate = Number.isFinite(anchor.ratePerSecM) && anchor.ratePerSecM > 0 ? anchor.ratePerSecM : 0;
  if (rate === 0) return false;
  const capMs = (anchor.maxExtrapolationSec ?? DEFAULT_MAX_EXTRAPOLATION_SEC) * 1000;
  return nowMs - anchor.anchorMs < capMs;
}

/**
 * Whether the figure still moves at `nowMs`, so the frame loop must keep running (P1-B05): an ease in
 * progress, or an accrual that has not reached its extrapolation cap. A static figure at rest, a hold with
 * no accrual, and a stalled feed past its cap need no frames at all.
 */
export function needsFrames(motion: MeterMotion | null, anchor: MeterAnchor, nowMs: number): boolean {
  if (motion?.mode === 'ease' && nowMs - motion.startMs < (motion.durationMs ?? EASE_MS)) return true;
  return accruing(anchor, nowMs);
}

// ─── Odometer ────────────────────────────────────────────────────────────────

/** One glyph of the rendered figure: a digit wheel (with its place value) or a static character. */
export type Glyph = { kind: 'digit'; place: number } | { kind: 'static'; char: string };

/** The glyph layout of a figure: `$12,345` + optional `.67`. Place 0 is the smallest unit shown. */
export interface FigureLayout {
  /** Glyphs of the whole-dollar part, left to right ("$", digits, commas). */
  whole: Glyph[];
  /** Cent digit wheels (places 1, 0) when cents are shown, else empty. */
  cents: Glyph[];
  /** Number of whole-dollar digits (the layout only changes when this does). */
  dollarDigits: number;
}

/** Digits in the integer part of `dollars` (at least 1). */
export function digitCount(dollars: number): number {
  const d = Math.floor(Math.max(0, dollars));
  return d < 10 ? 1 : Math.floor(Math.log10(d)) + 1;
}

/**
 * The glyph layout for a value with `dollarDigits` whole-dollar digits. `formatWhole` is core/format's
 * whole-dollar formatter (so grouping matches every other money figure); it is fed a same-length
 * integer so the separators land where the real value's will.
 */
export function layoutFigure(dollarDigits: number, showCents: boolean, formatWhole: (mc: number) => string): FigureLayout {
  const n = Math.max(1, Math.floor(dollarDigits));
  const probe = n === 1 ? 0 : 10 ** (n - 1); // e.g. 3 digits → 100 → "$100"
  const text = formatWhole(probe * MC_PER_DOLLAR);
  const base = showCents ? 2 : 0;
  let place = base + n - 1;
  const whole: Glyph[] = [];
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') whole.push({ kind: 'digit', place: place-- });
    else whole.push({ kind: 'static', char: ch });
  }
  const cents: Glyph[] = showCents ? [{ kind: 'digit', place: 1 }, { kind: 'digit', place: 0 }] : [];
  return { whole, cents, dollarDigits: n };
}

/** Value in the smallest shown unit: cents when cents are shown, else dollars. */
export function unitsOf(valueM: number, showCents: boolean): number {
  const v = Math.max(0, Number.isFinite(valueM) ? valueM : 0);
  return v / (showCents ? MC_PER_CENT : MC_PER_DOLLAR);
}

/** Smoothstep 0→1 (zero slope at both ends, so a roll starts and lands softly). */
function smooth(x: number): number {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * The roll window, as a fraction of one unit of the smallest digit: long enough to read as a roll,
 * never more than a third of a unit (so every digit sits still and readable most of the time).
 */
export function rollWindow(unitsPerSecond: number): number {
  if (!Number.isFinite(unitsPerSecond) || unitsPerSecond <= 0) return 0.25;
  return clamp(unitsPerSecond * ROLL_SECONDS, 0.02, 0.33);
}

/**
 * Wheel position (0 ≤ p < 10) for the digit at `place` when the figure reads `units` (fractional).
 * The digit shows ⌊units / 10^place⌋ mod 10 and turns toward the next value only during the carry:
 * while every lower digit reads 9 and the smallest digit is in its last `window` of travel.
 */
export function wheelPosition(units: number, place: number, window: number): number {
  const u = Math.max(0, units);
  const whole = Math.floor(u);
  const frac = u - whole;
  const scale = 10 ** place;
  const digit = Math.floor(whole / scale) % 10;
  const lower = whole % scale; // the digits to the right of this one
  const carrying = place === 0 || lower === scale - 1;
  const w = clamp(window, 0.001, 1);
  const progress = carrying ? smooth((frac - (1 - w)) / w) : 0;
  return digit + progress; // 9 + 1 = 10 lands on the strip's trailing 0
}

/**
 * The strip's transform for a wheel position: a percentage of the strip's own height (its `cells` digits), so
 * a font-size change (a resized frame) never reads as a transform change.
 */
export function wheelTransform(pos: number, cells: number): string {
  return `translate3d(0, ${(-pos * 100) / cells}%, 0)`;
}

/**
 * A wheel whose digit changes at least this often — too fast for anyone to read a digit — turns continuously,
 * like the last wheel of a mechanical meter (P1-B05). Rolled digit by digit from the frame loop, a meter
 * accruing tens of cents a second restyled its cents wheel on every frame (~55 style recalculations a second
 * on a phone); spun by one compositor animation at the true rate, it costs nothing per frame and still reads as
 * money running. Slower wheels keep stepping crisply, so a still frame (a screenshot, a video frame) shows
 * readable digits everywhere but the blur.
 */
export const SPIN_DIGITS_PER_SEC = 8;

/** Milliseconds per full turn (ten digits) of the wheel at `place` when it spins; null when it rolls digit by digit. */
export function spinPeriodMs(unitsPerSecond: number, place: number): number | null {
  if (!Number.isFinite(unitsPerSecond) || unitsPerSecond <= 0) return null;
  const digitsPerSec = unitsPerSecond / 10 ** place;
  return digitsPerSec >= SPIN_DIGITS_PER_SEC ? (10 / digitsPerSec) * 1000 : null;
}

/** How far through its turn (0 ≤ phase < 1) a spinning wheel at `place` is when the figure reads `units`, so the
 * spin starts on the digit the value shows and stays in step with the wheels to its left. */
export function spinPhase(units: number, place: number): number {
  const u = Math.max(0, Number.isFinite(units) ? units : 0) / 10 ** place;
  return (u % 10) / 10;
}

/** One display frame at 60 Hz. */
export const FRAME_MS = 1000 / 60;

/** The next time a rolled wheel moves, and whether that move is a roll the loop must draw frame by frame. */
export interface NextMove {
  /** Milliseconds from now; 0 while a roll is under way; Infinity when nothing rolls. */
  ms: number;
  /**
   * true: a roll that lasts at least a frame, drawn frame by frame from requestAnimationFrame. false: a change
   * shorter than a frame (a fast wheel's carry), which one draw right after it shows exactly as well.
   */
  roll: boolean;
}

/**
 * When the rolled wheel at `place` next moves (P1-B05). Its roll runs over the last `window` units of each
 * 10^place-unit cycle (wheelPosition), and every wheel to its left moves only then, so between rolls only
 * spinning wheels move — and they need no frames at all. `place` = Infinity (every wheel spins) or no accrual:
 * nothing rolls.
 */
export function nextMove(units: number, unitsPerSecond: number, window: number, place: number): NextMove {
  if (!Number.isFinite(place) || !Number.isFinite(unitsPerSecond) || unitsPerSecond <= 0) return { ms: Number.POSITIVE_INFINITY, roll: false };
  const scale = 10 ** place;
  const into = Math.max(0, Number.isFinite(units) ? units : 0) % scale;
  const w = clamp(window, 0.001, 1);
  // A roll shorter than a frame is never seen mid-way: the move is the carry itself.
  if ((w / unitsPerSecond) * 1000 < FRAME_MS) return { ms: ((scale - into) / unitsPerSecond) * 1000, roll: false };
  const rollStart = scale - w;
  if (into >= rollStart) return { ms: 0, roll: true };
  return { ms: ((rollStart - into) / unitsPerSecond) * 1000, roll: true };
}

/** Whole-dollar value announced to screen readers (floor while ticking, like the wheels). */
export function announceDollars(valueM: number): number {
  return Math.floor(Math.max(0, Number.isFinite(valueM) ? valueM : 0) / MC_PER_DOLLAR);
}

// ─── Fitting the box ─────────────────────────────────────────────────────────

/** Open Sans advance widths (em) for the glyphs a money figure uses, with the −0.02em display tracking. */
const ADVANCE_EM: Record<string, number> = { digit: 0.572, $: 0.572, ',': 0.258, '.': 0.266, '−': 0.572 };
const TRACKING_EM = -0.02;
const CENTS_SCALE = 0.42;

/**
 * The figure's width in em of its own font size (with a little slack), so CSS can cap the font size at
 * `container width ÷ this` and a large number never overflows a 390 px card.
 */
export function figureEm(text: string, centsDigits: number): number {
  let em = 0;
  for (const ch of text) {
    const adv = ch >= '0' && ch <= '9' ? ADVANCE_EM.digit : (ADVANCE_EM[ch] ?? 0.6);
    em += adv + TRACKING_EM;
  }
  if (centsDigits > 0) em += 0.04 + CENTS_SCALE * (ADVANCE_EM['.'] + centsDigits * ADVANCE_EM.digit);
  return Math.round(em * 1.06 * 1000) / 1000;
}
