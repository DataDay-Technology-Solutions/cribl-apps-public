// src/components/Meter/Meter.tsx — the ticking hero number (PRD 8.1, SPEC 13 "Ticking", DESIGN_BRIEF §1/§4).
//
//   • between snapshots it advances by `ratePerSecM` per second, driven by requestAnimationFrame;
//   • on each snapshot it eases to the authoritative value over 900 ms and never visibly goes backwards
//     (a lower value is held until the accrual catches up, unless the gap exceeds $1 — then it rolls down);
//   • digits are odometer wheels in tabular numerals inside a fixed box: frames only move transforms,
//     React re-renders only when the number of dollar digits changes (no layout shift while ticking);
//   • each wheel shows exactly one glyph's cap box (Meter.css): mid-roll, no sliver of the next or previous
//     digit shows above the cap line or below the baseline (P0-16);
//   • cents show only while ticking, as a smaller trailing ".42"; a static meter (rate 0, e.g. the
//     annualized run rate) shows whole dollars — as plain text, or with `rollStatic` (the presenter's stage)
//     as wheels that roll to each new value;
//   • screen readers hear the whole-dollar value at most once per 30 s (polite live region);
//   • prefers-reduced-motion, followed live: no roll and no ticking — the value changes only when a snapshot
//     lands, and switching it on mid-roll stops the frame loop at once.
//
// Frame cost (P1-B05): a frame writes a wheel's transform only when that wheel moved, the value attribute at
// most 4 times a second, and the loop runs only while there is something to move (accruing, or easing to a
// new value) and the figure is on screen (a hidden tab or a figure scrolled out of view stops it; coming back
// jumps to where the money is now instead of rolling through the gap). A wheel turning eight or more digits a
// second (the last cent of a large meter) spins continuously on the compositor, one Web Animation at the true rate
// started in phase with the value, instead of being restyled every frame; an ease or the extrapolation cap
// hands it back to the frame loop, which puts it on its exact digit. Between the rolls of the wheels it does
// move, the loop sleeps (a timer, waking at most every 250 ms for the value attribute and the announcement),
// and a wheel whose roll is shorter than a frame just changes digit from one timer draw: a main-thread frame
// costs a style pass even when nothing changed, so an idle meter asks for none.
//
// Reused by the Presenter view (`size="inherit"`, `rollStatic`). Key the component by period so a period
// switch starts a fresh meter instead of rolling from one period's figure to another's.
//
// First paint (P2-W19): a meter given `rollIn="<id>"` rolls up from $0 to its figure over 1.2 s the first time a
// meter with that id mounts with a figure in this page — once per page, never on a remount (a period switch) and
// never under reduced motion. The wheels keep the final figure's digit count throughout (an odometer turning up
// from zeros), so the box never grows while it rolls.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { fmtDollars } from '../../../core/format.ts';
import { prefersReducedMotion } from '../../lib/dom.ts';
import {
  ARIA_THROTTLE_MS,
  DEFAULT_MAX_EXTRAPOLATION_SEC,
  accruing,
  announceDollars,
  beginMotion,
  digitCount,
  displayAt,
  figureEm,
  jumpMotion,
  layoutFigure,
  needsFrames,
  nextMove,
  continueRollIn,
  rollInMotion,
  rollingIn,
  rollWindow,
  settled,
  spinPeriodMs,
  spinPhase,
  targetAt,
  unitsOf,
  VALUE_ATTR_MS,
  wheelPosition,
  wheelTransform,
  type Glyph,
  type MeterAnchor,
  type MeterMotion,
  type NextMove,
} from './meterMath.ts';
import './Meter.css';

export type MeterSize = 'hero' | 'presenter' | 'inherit';

export interface MeterProps {
  /** Authoritative value at `anchorMs`, integer millicents (e.g. snapshot.headline.mtdM). */
  valueM: number;
  /** Millicents per second to accrue between snapshots (snapshot.ratePerSecM); 0 = static. */
  ratePerSecM: number;
  /** When `valueM` was true — the snapshot's sweepAt, epoch ms. */
  anchorMs: number;
  /** `hero` 56–88 px, `presenter` ≥ 160 px at 1920, `inherit` = the parent's font size. */
  size?: MeterSize;
  /** Story/video callout id on the number (DESIGN_BRIEF §8). Default 'saved'; null for none (a secondary meter). */
  callout?: string | null;
  /** What the number is, for screen readers: "Saved by Cribl, month to date". */
  label: string;
  /** Stop extrapolating this long after the snapshot (default 180 s). */
  maxExtrapolationSec?: number;
  /**
   * Roll up from $0 to the figure on first paint, once per page for this id (P2-W19, the stage's hero). Off by
   * default: the Story's frames and every other meter show their figure at once.
   */
  rollIn?: string;
  /**
   * What `data-value-m` reports while the roll-up runs: the figure on the wheels ('shown', the default: the stage's
   * evidence of the roll) or the figure it rolls to ('target', the Receipt: a spec that reads the figure once reads
   * the snapshot's figure from the first frame, as the announcement says it, e5fc584).
   */
  rollInValue?: 'shown' | 'target';
  /** Force the reduced-motion path (tests); default follows `prefers-reduced-motion`, live. */
  reducedMotion?: boolean;
  /**
   * A static figure (rate 0) still rolls its wheels to each new authoritative value over 900 ms (the stage's
   * annualized run rate on every sweep). Default: a static figure is plain text and jumps.
   */
  rollStatic?: boolean;
  className?: string;
}

/** Tracks `prefers-reduced-motion`, live; an explicit override (tests) wins. */
function useReducedMotion(override?: boolean): boolean {
  const [media, setMedia] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setMedia(query.matches);
    onChange(); // a change between the first render and this effect is not missed
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return override ?? media;
}

const STRIP_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

/** The roll-in ids that have rolled in this page (P2-W19: once per page per id). */
const ROLLED_IN = new Set<string>();

/** The loop sleeps only for gaps at least this long; shorter ones stay on requestAnimationFrame. */
const SLEEP_MIN_MS = 50;
/** Wake this much before a roll is due (timers fire late), so the roll's first frame is never missed. */
const WAKE_EARLY_MS = 24;
/** Draw this long after a sub-frame carry, so the draw lands on the new digit. */
const CARRY_SLACK_MS = 2;
/** An ease, a hold or a roll under way: the loop draws every frame. */
const EVERY_FRAME: NextMove = { ms: 0, roll: true };

/** One full turn of a strip: from its leading 0 to its trailing 0 (the same glyph, so the loop is seamless). */
const SPIN_KEYFRAMES: Keyframe[] = [{ transform: wheelTransform(0, STRIP_DIGITS.length) }, { transform: wheelTransform(10, STRIP_DIGITS.length) }];

/** Web Animations (every supported browser; not jsdom): without them every wheel rolls from the frame loop. */
const canSpin = (el: HTMLElement): boolean => typeof el.animate === 'function';

function Wheel({ place, register }: { place: number; register: (place: number, el: HTMLSpanElement | null) => void }) {
  return (
    <span className="mr-meter-wheel">
      <span className="mr-meter-strip" ref={(el) => register(place, el)}>
        {STRIP_DIGITS.map((d, i) => (
          <span key={i} className="mr-meter-cell">
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

function Glyphs({ glyphs, register }: { glyphs: Glyph[]; register: (place: number, el: HTMLSpanElement | null) => void }) {
  return glyphs.map((g, i) =>
    g.kind === 'digit' ? (
      <Wheel key={`d${g.place}`} place={g.place} register={register} />
    ) : (
      <span key={`s${i}`} className="mr-meter-static">
        {g.char}
      </span>
    ),
  );
}

export function Meter(props: MeterProps) {
  const { valueM, ratePerSecM, anchorMs, size = 'hero', callout = 'saved', label, maxExtrapolationSec, rollStatic = false, rollIn, rollInValue = 'shown', className } = props;
  const reduced = useReducedMotion(props.reducedMotion);
  const safeAnchorMs = Number.isFinite(anchorMs) ? anchorMs : 0;
  const safeRate = Number.isFinite(ratePerSecM) && ratePerSecM > 0 && Number.isFinite(anchorMs) ? ratePerSecM : 0;
  const ticking = safeRate > 0 && !reduced;
  // A meter that rolls eases to each new value: while ticking, and a static figure with `rollStatic`.
  const rolls = !reduced && (ticking || rollStatic);

  // Cents appear once the meter ticks and then stay for the life of this meter, so a snapshot with a
  // momentary zero rate never removes them (that would change the box width).
  const [centsLatched, setCentsLatched] = useState(ticking);
  if (ticking && !centsLatched) setCentsLatched(true);
  const showCents = !reduced && (ticking || centsLatched);
  // Wheels whenever the figure rolls or keeps its cents; plain text otherwise (always under reduced motion).
  const wheels = rolls || showCents;

  // Memoized by content, so a re-render with the same snapshot never restarts the ease.
  const anchorValue = Number.isFinite(valueM) ? Math.max(0, valueM) : 0;
  const anchorRate = reduced ? 0 : safeRate;
  const anchorCap = maxExtrapolationSec ?? DEFAULT_MAX_EXTRAPOLATION_SEC;
  const anchor = useMemo<MeterAnchor>(
    () => ({ valueM: anchorValue, ratePerSecM: anchorRate, anchorMs: safeAnchorMs, maxExtrapolationSec: anchorCap }),
    [anchorValue, anchorRate, safeAnchorMs, anchorCap],
  );

  const anchorRef = useRef<MeterAnchor>(anchor);
  const motionRef = useRef<MeterMotion | null>(null);
  const displayedRef = useRef<number | undefined>(undefined);
  const stripsRef = useRef(new Map<number, HTMLSpanElement>());
  /** The last position written to each strip (P1-B05: a frame writes only the wheels that moved). */
  const writtenRef = useRef(new WeakMap<HTMLSpanElement, number>());
  /** Strips spinning on the compositor, with their turn period (P1-B05). */
  const spinsRef = useRef(new Map<HTMLSpanElement, { anim: Animation; periodMs: number }>());
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const liveRef = useRef<HTMLSpanElement | null>(null);
  const lastAnnounceRef = useRef(0);
  const lastValueAttrRef = useRef(Number.NEGATIVE_INFINITY);
  /** Starts the frame loop if it is idle and there is something to move (set by the loop's effect). */
  const kickRef = useRef<() => void>(() => {});
  /** Whether the frame loop is running (fast wheels may spin only then). */
  const loopRunningRef = useRef(false);

  // The value to lay out (and, for a static meter, to print). Updated on snapshots and when the dollar
  // digit count changes mid-tick.
  const [shown, setShown] = useState(() => displayAt(jumpMotion(undefined, anchor, Date.now()), anchor, Date.now()));
  const dollarDigits = digitCount(Math.floor(shown / 100_000));
  const layout = layoutFigure(dollarDigits, showCents, fmtDollars);

  const stopSpin = (el: HTMLSpanElement) => {
    const spin = spinsRef.current.get(el);
    if (!spin) return;
    spin.anim.cancel();
    spinsRef.current.delete(el);
    writtenRef.current.delete(el); // the frame loop owns it again: its next frame writes the exact digit
  };
  const stopSpins = () => {
    for (const el of [...spinsRef.current.keys()]) stopSpin(el);
  };
  const startSpin = (el: HTMLSpanElement, periodMs: number, phase: number) => {
    const spin = spinsRef.current.get(el);
    if (spin && Math.abs(spin.periodMs - periodMs) <= periodMs * 0.02) return; // already turning at this rate
    spin?.anim.cancel();
    const anim = el.animate(SPIN_KEYFRAMES, { duration: periodMs, iterations: Infinity, easing: 'linear' });
    anim.currentTime = phase * periodMs;
    spinsRef.current.set(el, { anim, periodMs });
  };

  // (A callback ref is called with null and then the element on every render, so a spin is never stopped
  // here; draw() drops the spins of strips that have left the document.)
  const register = (place: number, el: HTMLSpanElement | null) => {
    if (el) stripsRef.current.set(place, el);
    else stripsRef.current.delete(place);
  };

  // A new snapshot: start the ease (or hold) from whatever is on screen right now.
  useLayoutEffect(() => {
    const next = anchor;
    anchorRef.current = next;
    const now = Date.now();
    const displayed = displayedRef.current;
    if (!rolls) {
      // Meters that do not roll (static, reduced motion) jump — never backwards by $1 or less.
      const motion = jumpMotion(displayed, next, now);
      const value = displayAt(motion, next, now);
      motionRef.current = motion;
      displayedRef.current = value;
      setShown(value);
      return;
    }
    // The first value on mount is shown as it is now (the accrual since the sweep included): nothing rolls in —
    // unless this meter opted into the once-per-page roll-up (P2-W19).
    const current = motionRef.current;
    if (displayed === undefined && rollIn && !ROLLED_IN.has(rollIn) && next.valueM > 0) {
      ROLLED_IN.add(rollIn);
      motionRef.current = rollInMotion(now);
    } else if (displayed !== undefined && current && rollIn && rollingIn(current, now)) {
      // A new value mid-roll (a sweep): one roll-up to it, laid out for it. A caller that withdrew the roll-up (the
      // Receipt on a period switch) gets an ordinary ease from wherever the wheels are instead.
      motionRef.current = continueRollIn(current, displayed, now);
      setShown(targetAt(next, now));
    } else {
      motionRef.current = displayed === undefined ? jumpMotion(undefined, next, now) : beginMotion(displayed, next, now);
    }
    kickRef.current();
  }, [anchor, rolls, rollIn]);

  // Draw one frame: the wheels that moved, the value attribute (≤ 4 Hz unless forced), the throttled
  // announcement, and a re-layout when the number of dollar digits changes.
  // Returns when a rolled wheel next moves, so the loop can sleep until then (an ease or a hold: every frame).
  const drawRef = useRef<(now: number, force?: boolean) => NextMove>(() => EVERY_FRAME);
  const draw = (now: number, force = false): NextMove => {
    const current = anchorRef.current;
    const motion = motionRef.current ?? jumpMotion(displayedRef.current, current, now);
    motionRef.current = motion;
    const value = displayAt(motion, current, now);
    displayedRef.current = value;
    let next: NextMove = EVERY_FRAME;
    if (wheels) {
      const units = unitsOf(value, showCents);
      const unitsPerSec = unitsOf(current.ratePerSecM, showCents);
      const window = rollWindow(unitsPerSec);
      const written = writtenRef.current;
      // Fast wheels spin only while the figure simply tracks a live accrual (no ease, no hold, under the cap).
      // Spins run only while the frame loop does (on screen, tab visible): stopping the loop parks them.
      const tracking = settled(motion, current, now) && accruing(current, now);
      const spinning = loopRunningRef.current && tracking;
      let lowestRolled = Number.POSITIVE_INFINITY;
      for (const [place, el] of stripsRef.current) {
        const periodMs = spinning && canSpin(el) ? spinPeriodMs(unitsPerSec, place) : null;
        if (periodMs !== null) {
          startSpin(el, periodMs, spinPhase(units, place));
          continue;
        }
        stopSpin(el);
        lowestRolled = Math.min(lowestRolled, place);
        const pos = wheelPosition(units, place, window);
        const key = Math.round(pos * 1000);
        if (written.get(el) === key) continue;
        written.set(el, key);
        el.style.transform = wheelTransform(pos, STRIP_DIGITS.length);
      }
      for (const el of spinsRef.current.keys()) if (!el.isConnected) stopSpin(el);
      // While the figure just tracks the accrual, nothing the loop draws moves until the lowest rolled wheel's
      // next roll (an ease or a hold needs every frame).
      if (tracking) next = nextMove(units, unitsPerSec, window, lowestRolled);
    }
    if (rootRef.current && (force || now - lastValueAttrRef.current >= VALUE_ATTR_MS)) {
      lastValueAttrRef.current = now;
      // A roll-up that reports its target (the Receipt) says the snapshot's figure from its first frame.
      rootRef.current.dataset.valueM = String(Math.floor(rollInValue === 'target' && rollingIn(motion, now) ? targetAt(current, now) : value));
    }
    if (liveRef.current && now - lastAnnounceRef.current >= ARIA_THROTTLE_MS) {
      lastAnnounceRef.current = now;
      // The words say what the figure shows: whole dollars floored on the wheels (as they turn), rounded as plain text.
      // During the first-paint roll-up (P2-W19) they say the figure it rolls to, never the $0 it rolls from: the
      // announcement is throttled to one per 30 s, and a static figure never ticks again to correct it (review W2).
      const spoken = rollingIn(motion, now) ? targetAt(current, now) : value;
      liveRef.current.textContent = `${label}: ${fmtDollars(wheels ? announceDollars(spoken) * 100_000 : spoken)}`;
    }
    // A roll-up keeps the figure's own layout (laid out for the figure it rolls to): its wheels turn up from zeros.
    if (!rollingIn(motion, now) && digitCount(Math.floor(value / 100_000)) !== dollarDigits) setShown(value);
    return next;
  };

  // Every render hands the loop the latest draw (it closes over this render's layout), then paints a
  // frame before the browser does — so a re-layout never shows unpositioned wheels, and static meters
  // still get their test hook and announcement.
  useLayoutEffect(() => {
    drawRef.current = draw;
    draw(Date.now(), true);
  });

  // The animation loop — only for wheels, only while something moves, only while the figure can be seen.
  // StrictMode mounts effects twice; the cleanup cancels the frame and the observers, so exactly one loop
  // ever runs.
  useEffect(() => {
    if (!wheels) return;
    let frame = 0;
    let timer = 0;
    let inView = true;
    const setRunning = (running: boolean) => {
      loopRunningRef.current = running;
      if (!running) stopSpins();
      if (rootRef.current) rootRef.current.dataset.running = running ? 'true' : 'false';
    };
    const wanted = (now: number) =>
      inView && document.visibilityState !== 'hidden' && needsFrames(motionRef.current, anchorRef.current, now);
    const loop = () => {
      frame = 0;
      timer = 0;
      const now = Date.now();
      const more = wanted(now);
      // The frame that ends the loop always writes the value, so the attribute never lags a settled figure.
      const next = drawRef.current(now, !more);
      if (!more) {
        setRunning(false);
        return;
      }
      // Nothing to draw for a while (only spinning wheels, or rolled wheels between rolls): sleep on a timer
      // instead of asking for frames — waking for the value attribute, just before a roll (then frame by frame),
      // or right after a sub-frame carry (one draw shows the new digit).
      if (!next.roll) timer = window.setTimeout(loop, Math.min(next.ms + CARRY_SLACK_MS, VALUE_ATTR_MS));
      else if (next.ms >= SLEEP_MIN_MS) timer = window.setTimeout(loop, Math.min(next.ms - WAKE_EARLY_MS, VALUE_ATTR_MS));
      else frame = requestAnimationFrame(loop);
    };
    const start = () => {
      if (frame !== 0 || !wanted(Date.now())) return;
      // A sleeping loop is woken (a new snapshot starts an ease that needs every frame).
      if (timer !== 0) {
        window.clearTimeout(timer);
        timer = 0;
      }
      setRunning(true);
      frame = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      if (timer !== 0) window.clearTimeout(timer);
      frame = 0;
      timer = 0;
      setRunning(false);
    };
    // Back on screen (a tab, or a scroll): jump to where the money is now instead of rolling through the gap.
    const resume = () => {
      const now = Date.now();
      motionRef.current = jumpMotion(displayedRef.current, anchorRef.current, now);
      drawRef.current(now, true);
      start();
    };
    const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : resume());
    kickRef.current = start;
    document.addEventListener('visibilitychange', onVisibility);
    let observer: IntersectionObserver | undefined;
    if (rootRef.current && typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        const visible = entries[entries.length - 1]?.isIntersecting ?? true;
        if (visible === inView) return;
        inView = visible;
        if (visible) resume();
        else stop();
      });
      observer.observe(rootRef.current);
    }
    setRunning(false); // until there is something to move
    start();
    return () => {
      stop();
      kickRef.current = () => {};
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [wheels]);

  const staticText = fmtDollars(shown);
  const wholeText = wheels && showCents ? fmtDollars(10 ** (dollarDigits - 1) * 100_000) : staticText;
  const fit = { '--mr-meter-em': String(figureEm(wholeText, wheels && showCents ? 2 : 0)) } as CSSProperties;

  return (
    <span className={['mr-meter', `mr-meter--${size}`, className].filter(Boolean).join(' ')} data-testid="meter">
      <span
        ref={rootRef}
        className="mr-meter-figure"
        style={fit}
        data-callout={callout ?? undefined}
        data-ticking={ticking ? 'true' : 'false'}
        aria-hidden="true"
      >
        {wheels ? (
          <>
            <span className="mr-meter-whole">
              <Glyphs glyphs={layout.whole} register={register} />
            </span>
            {showCents ? (
              <span className="mr-meter-cents">
                <span className="mr-meter-static">.</span>
                <Glyphs glyphs={layout.cents} register={register} />
              </span>
            ) : null}
          </>
        ) : (
          <span className="mr-meter-whole mr-meter-text">{staticText}</span>
        )}
      </span>
      <span ref={liveRef} className="mr-visually-hidden" role="status" aria-live="polite" aria-atomic="true" />
    </span>
  );
}
