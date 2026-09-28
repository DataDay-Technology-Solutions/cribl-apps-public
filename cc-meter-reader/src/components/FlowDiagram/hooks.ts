// src/components/FlowDiagram/hooks.ts — measuring the frame (width, the room left in the viewport), the
// phone breakpoint, and tweening the layout.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { prefersReducedMotion } from '../../lib/dom.ts';
import { figuresChanged, interpolateLayout, sameGeometry, type FlowLayout } from './layout.ts';

/**
 * The content width of an element, kept current with a ResizeObserver (0 until measured). `active` re-attaches
 * the observer when the element is mounted later (the phone list → map toggle).
 */
export function useElementWidth<T extends HTMLElement>(ref: RefObject<T | null>, active = true): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const read = () => setWidth(Math.floor(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => read());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, active]);
  return width;
}

/** Space kept free under the map card when it is fitted to the viewport. */
const FIT_MARGIN = 24;

/**
 * The tallest the map can be and still end, with the rest of its card (legend, notes, padding), above the
 * bottom of the viewport (BEAUTY F9: "one picture"). Measured from the frame's position in the document, so
 * scrolling never changes it; re-measured on resize and whenever the page above it changes height.
 * undefined until measured or while `enabled` is false.
 */
export function useFitHeight<F extends HTMLElement, C extends HTMLElement>(
  frameRef: RefObject<F | null>,
  cardRef: RefObject<C | null>,
  enabled: boolean,
  margin = FIT_MARGIN,
): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    // Disabled: nothing is measured (the hook answers undefined below, rather than a setState in the effect).
    if (!enabled || typeof window === 'undefined') return;
    const read = () => {
      const frame = frameRef.current;
      const card = cardRef.current;
      if (!frame || !card) return;
      const f = frame.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const top = f.top + window.scrollY;
      const below = Math.max(0, c.bottom - f.bottom);
      const room = Math.floor(window.innerHeight - top - below - margin);
      setHeight((cur) => (cur === room ? cur : room));
    };
    read();
    window.addEventListener('resize', read);
    const ro = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => read());
    ro?.observe(document.body);
    return () => {
      window.removeEventListener('resize', read);
      ro?.disconnect();
    };
  }, [frameRef, cardRef, enabled, margin]);
  return enabled ? height : undefined;
}

/**
 * The stage's label scale (P2-W10): the viewport's height over 540, in quarter steps between 1.5 and 2.5 — 2 on a
 * 1080-row projector (names 28 px, captions and plates 24 px), 1.5 on a 720-row one. Kept current on resize.
 */
export function stageScaleFor(viewportHeight: number): number {
  const q = Math.round((viewportHeight / 540) * 4) / 4;
  return Math.min(2.5, Math.max(1.5, q));
}

export function useStageScale(enabled: boolean): number {
  const read = () => (typeof window === 'undefined' ? 2 : stageScaleFor(window.innerHeight));
  const [scale, setScale] = useState(read);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const on = () => setScale(stageScaleFor(window.innerHeight));
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [enabled]);
  return scale;
}

/** Whether a media query matches, kept current (false where matchMedia is missing). */
export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(get);
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return matches;
}

const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3);

/**
 * How long a live snapshot's change eases (P1-I08): long enough to SEE a ribbon narrow and its saved wedge grow
 * out of the pipeline node when a pack lands on stage (PITCH step 6), short against the 10 s poll.
 */
export const LIVE_TWEEN_MS = 1200;

/**
 * The ease for a change of layout: the What-if morph (a new `morphKey`) over `morphMs`; new figures from a live
 * snapshot over LIVE_TWEEN_MS; the same figures re-fitted (the frame height moved) over `refitMs`.
 */
export function tweenDuration(from: FlowLayout, to: FlowLayout, morphed: boolean, refitMs: number, morphMs: number, liveMs = LIVE_TWEEN_MS): number {
  return tweenOf(from, to, morphed, refitMs, morphMs, liveMs).ms;
}

/** Which ease a change of layout takes, and for how long (see tweenDuration). */
export type TweenKind = 'morph' | 'live' | 'refit';

export function tweenOf(from: FlowLayout, to: FlowLayout, morphed: boolean, refitMs: number, morphMs: number, liveMs = LIVE_TWEEN_MS): { kind: TweenKind; ms: number } {
  if (morphed) return { kind: 'morph', ms: morphMs };
  return figuresChanged(from, to) ? { kind: 'live', ms: Math.max(refitMs, liveMs) } : { kind: 'refit', ms: refitMs };
}

/**
 * Eases from the layout on screen to `target`: a live snapshot's new figures over 1.2 s ease-out (P1-I08), a re-fit
 * of the same figures over `durationMs` (200 ms), and a What-if change (`morphKey` changed with it) over `morphMs`
 * (400 ms). Jumps when motion is reduced, when the frame width changed (a resize is not a data change) or when
 * there is nothing on screen yet; does nothing when the picture is the same (a re-read of the same snapshot), so an
 * idle map never repaints.
 *
 * A target that lands while a morph is still running (opening the What-if re-fits the map's height a frame
 * later, and can bring the page's scrollbar in the same frame) joins that morph (P1-J04): it eases from the frame
 * on screen along the same curve and finishes when the morph does, so a projection is one ~400 ms move — never a
 * second tween that dips past the end.
 */
export function useTweenedLayout(target: FlowLayout, durationMs: number, morphKey = '', morphMs = durationMs, liveMs = LIVE_TWEEN_MS): { layout: FlowLayout; tween: TweenKind | null } {
  const [shown, setShown] = useState(target);
  // the ease in progress (published as data-tween on the SVG: what a test, or a curious reader, can see)
  const [tween, setTween] = useState<TweenKind | null>(null);
  const shownRef = useRef(target);
  const morphRef = useRef(morphKey);
  /** performance.now() when the running morph started (-Infinity when none). */
  const morphStart = useRef(-Infinity);
  useEffect(() => {
    const from = shownRef.current;
    const now = typeof performance === 'undefined' ? 0 : performance.now();
    // A new morph key means the member changed the What-if: that change eases over morphMs.
    const newMorph = morphRef.current !== morphKey;
    morphRef.current = morphKey;
    if (newMorph) morphStart.current = now;
    const inMorph = now - morphStart.current < morphMs;
    const jump = () => {
      shownRef.current = target;
      setShown(target);
      setTween(null);
    };
    if (from === target) return;
    if (!inMorph && sameGeometry(from, target)) {
      // nothing moved: one render with the new figures (aria, data), not sixty frames of the same picture
      jump();
      return;
    }
    const { kind, ms: duration } = tweenOf(from, target, inMorph, durationMs, morphMs, liveMs);
    // A new frame width alone is a resize, not a data change: jump. Inside a morph (opening the What-if can
    // bring the page's scrollbar in the same frame) it is part of the morph and eases with it.
    if (duration <= 0 || prefersReducedMotion() || (!inMorph && from.width !== target.width) || from.ribbons.length === 0 || typeof requestAnimationFrame === 'undefined') {
      jump();
      return;
    }
    // On the morph's clock when one is running (t0 = its start), else a fresh re-scale starting now.
    const t0 = inMorph ? morphStart.current : now;
    const eased0 = easeOutCubic(Math.min(1, (now - t0) / duration));
    let raf = 0;
    const step = (at: number) => {
      const p = Math.min(1, (at - t0) / duration);
      const q = p >= 1 || eased0 >= 1 ? 1 : Math.max(0, (easeOutCubic(p) - eased0) / (1 - eased0));
      const frame = q >= 1 ? target : interpolateLayout(from, target, q);
      shownRef.current = frame;
      setShown(frame);
      setTween(q >= 1 ? null : kind);
      if (q < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs, morphKey, morphMs, liveMs]);
  return { layout: shown, tween };
}

/**
 * Whether the element is on screen and the document visible (IntersectionObserver + visibilitychange): the Flow
 * drift pauses otherwise (P1-I08). True where the observers are missing.
 */
export function useOnScreen<T extends Element>(ref: RefObject<T | null>): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof document === 'undefined') return;
    let inView = true;
    const update = () => setVisible(inView && document.visibilityState !== 'hidden');
    const io =
      typeof IntersectionObserver === 'undefined'
        ? undefined
        : new IntersectionObserver((entries) => {
            inView = entries.some((e) => e.isIntersecting);
            update();
          });
    io?.observe(el);
    document.addEventListener('visibilitychange', update);
    return () => {
      io?.disconnect();
      document.removeEventListener('visibilitychange', update);
    };
  }, [ref]);
  return visible;
}
