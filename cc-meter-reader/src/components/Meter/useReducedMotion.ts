// src/components/Meter/useReducedMotion.ts — `prefers-reduced-motion`, live, with an explicit override (tests). Shared by
// the Meter and the Receipt hero's aside (founder-build r2 ui-8, BO-7), so the aside prints what its meter prints.

import { useEffect, useState } from 'react';
import { prefersReducedMotion } from '../../lib/dom.ts';

/** Tracks `prefers-reduced-motion`, live; an explicit override (tests) wins. */
export function useReducedMotion(override?: boolean): boolean {
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
