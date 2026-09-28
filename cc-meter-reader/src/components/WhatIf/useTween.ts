// src/components/WhatIf/useTween.ts — the What-if's figures roll to a new value over the same 400 ms the
// map morphs (DESIGN_BRIEF 5.9, P1-J04): a new stream, treatment or drop, and every new snapshot, ease from
// the figures on screen to the new ones. Reduced motion: no roll — the figures change at once and the strip
// and hero crossfade instead (WhatIf.css).
//
// Money stays integer millicents on every frame (rounded), so a frame is always formattable by core/format.ts.

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { EstimateOk, HeadlinePreview, Projection } from '../../../core/whatif.ts';
import { prefersReducedMotion } from '../../lib/dom.ts';

/** The What-if morph: the map, the strip and the hero all move over this long. */
export const WHATIF_MORPH_MS = 400;

const easeOutCubic = (p: number): number => 1 - Math.pow(1 - p, 3);

const lerp = (a: number, b: number, p: number): number => a + (b - a) * p;
const lerpInt = (a: number, b: number, p: number): number => Math.round(lerp(a, b, p));

/** One projection part-way to another: money and bytes stay whole numbers, the ratio is continuous. */
export function lerpProjection(a: Projection, b: Projection, p: number): Projection {
  return {
    ratio: lerp(a.ratio, b.ratio, p),
    inBPerDay: lerpInt(a.inBPerDay, b.inBPerDay, p),
    outBPerDay: lerpInt(a.outBPerDay, b.outBPerDay, p),
    whpPerDayM: lerpInt(a.whpPerDayM, b.whpPerDayM, p),
    paidPerDayM: lerpInt(a.paidPerDayM, b.paidPerDayM, p),
    savedPerDayM: lerpInt(a.savedPerDayM, b.savedPerDayM, p),
    whpPerYearM: lerpInt(a.whpPerYearM, b.whpPerYearM, p),
    paidPerYearM: lerpInt(a.paidPerYearM, b.paidPerYearM, p),
    savedPerYearM: lerpInt(a.savedPerYearM, b.savedPerYearM, p),
    deltaSavedPerDayM: lerpInt(a.deltaSavedPerDayM, b.deltaSavedPerDayM, p),
    deltaSavedPerYearM: lerpInt(a.deltaSavedPerYearM, b.deltaSavedPerYearM, p),
  };
}

/** An estimate's figures part-way to the next; everything that is not a figure (basis, range, detail) is the target's. */
export function lerpEstimate(a: EstimateOk, b: EstimateOk, p: number): EstimateOk {
  if (p >= 1) return b;
  return {
    ...b,
    current: lerpProjection(a.current, b.current, p),
    low: lerpProjection(a.low, b.low, p),
    mid: lerpProjection(a.mid, b.mid, p),
    high: lerpProjection(a.high, b.high, p),
  };
}

export function lerpPreview(a: HeadlinePreview, b: HeadlinePreview, p: number): HeadlinePreview {
  if (p >= 1) return b;
  return { ...b, beforeM: lerpInt(a.beforeM, b.beforeM, p), afterM: lerpInt(a.afterM, b.afterM, p), deltaM: lerpInt(a.deltaM, b.deltaM, p) };
}

/**
 * `target`, eased from the value on screen whenever it changes (`mix(from, to, p)` makes the in-between
 * frames). A change mid-roll starts a new roll from the frame on screen, so a value never jumps. With
 * reduced motion — or no requestAnimationFrame — it is simply `target`.
 */
export function useTweened<T>(target: T, mix: (from: T, to: T, p: number) => T, ms = WHATIF_MORPH_MS): T {
  const reduce = prefersReducedMotion();
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);
  useEffect(() => {
    const from = shownRef.current;
    if (from === target) return;
    if (reduce || ms <= 0 || typeof requestAnimationFrame === 'undefined') {
      shownRef.current = target;
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / ms);
      const frame = p >= 1 ? target : mix(from, target, easeOutCubic(p));
      shownRef.current = frame;
      setShown(frame);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, mix, ms, reduce]);
  return reduce ? target : shown;
}

/**
 * Reduced motion (DESIGN_BRIEF 5.9: "reduced-motion → crossfade"): a change of `key` fades the element in over
 * `ms` instead of rolling or moving anything. Uses the Web Animations API, which the global reduced-motion rule
 * (it shortens CSS animations and transitions) does not cut; does nothing when motion is allowed.
 */
export function useReducedMotionCrossfade(ref: RefObject<Element | null>, key: string, ms = 200): void {
  const last = useRef(key);
  useEffect(() => {
    if (last.current === key) return;
    last.current = key;
    const el = ref.current;
    if (!el || typeof el.animate !== 'function' || !prefersReducedMotion()) return;
    el.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' });
  }, [ref, key, ms]);
}
