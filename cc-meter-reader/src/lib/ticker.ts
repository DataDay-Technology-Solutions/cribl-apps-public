// src/lib/ticker.ts — one shared wall clock for every "12 s ago" label.
//
// A single interval serves all subscribers (instead of one timer per label), starts with the first
// subscriber and stops with the last, so an idle page runs no timers at all.

import { useSyncExternalStore } from 'react';

type Listener = () => void;

export interface Ticker {
  now(): number;
  subscribe(listener: Listener): () => void;
}

export function createTicker(periodMs = 1000, clock: () => number = () => Date.now()): Ticker {
  const listeners = new Set<Listener>();
  let current = clock();
  let handle: ReturnType<typeof setInterval> | undefined;

  const tick = () => {
    current = clock();
    for (const listener of [...listeners]) listener();
  };

  return {
    now() {
      // With no subscriber there is no interval keeping `current` fresh; the first read after an idle
      // spell (e.g. a label mounting) refreshes it, then stays stable for a period so repeated reads
      // within one render agree (useSyncExternalStore requires that).
      if (handle === undefined) {
        const t = clock();
        if (t - current >= periodMs || t < current) current = t;
      }
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (handle === undefined) {
        current = clock();
        handle = setInterval(tick, periodMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && handle !== undefined) {
          clearInterval(handle);
          handle = undefined;
        }
      };
    },
  };
}

const secondTicker = createTicker(1000);

/** Current epoch ms, re-rendering the caller once per second while mounted. */
export function useNow(): number {
  return useSyncExternalStore(secondTicker.subscribe, secondTicker.now, secondTicker.now);
}

const still = (): (() => void) => () => {};

/**
 * Current epoch ms read at render time (fresh to the second), without ever scheduling a render of its own: for a
 * figure that needs "now" only when its data changes (the Flow map's recovered marks), read the React way.
 */
export function useClockReading(): number {
  return useSyncExternalStore(still, secondTicker.now, secondTicker.now);
}
