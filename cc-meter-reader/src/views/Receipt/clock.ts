// src/views/Receipt/clock.ts — the Receipt's own clock, ticking only while something on it reads the time (P1-B05).
//
// The Receipt used to re-render whole once a second on the shared 1 Hz clock (src/lib/ticker.ts useNow), which on a
// throttled phone cost 56–72 ms animation frames for a view whose figures change once a sweep. Only a custom range's
// planned words (and a comparison's refusal) read the time there, so the view ticks only while one is shown; the
// leaves that print the time tick themselves (IncidentCard's "… ago", the range picker's panel).

import { useSyncExternalStore } from 'react';
import { createTicker } from '../../lib/ticker.ts';

const receiptTicker = createTicker(1000);
const still = (): (() => void) => () => {};

/**
 * Epoch ms. While `active`, re-renders the caller once a second; otherwise it is read at render time (fresh to the
 * second: the ticker refreshes an idle reading once it is a period old) and never schedules a render on its own.
 */
export function useNowWhile(active: boolean): number {
  return useSyncExternalStore(active ? receiptTicker.subscribe : still, receiptTicker.now, receiptTicker.now);
}
