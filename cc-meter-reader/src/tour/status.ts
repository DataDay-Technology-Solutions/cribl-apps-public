// src/tour/status.ts — where the "Tour with sample data" stands, readable without loading the tour.
//
// The tour controller (and the ~270 KB fixture it imports) is a lazy chunk. Code in the main bundle — the
// `?tour=1` resume in the router (TourParamSync), the SAMPLE DATA band's beat chip — reads this tiny store
// instead, so nothing in the main chunk imports the fixture. Only src/tour/controller.ts writes it.
//
//   active     a tour owns the screen (running, paused or finished)
//   beat/beats how far the script is: beat 1 is the start, then one beat per distinct scripted second
//   lastStop   why the last tour ended ('user' / 'cleared': the member ended it; 'replaced': Story took the
//              screen and the tour comes back when Story ends); cleared again when a tour starts

import { useSyncExternalStore } from 'react';
import type { TourStopReason } from './types.ts';

export interface TourBeat {
  active: boolean;
  phase: 'idle' | 'running' | 'paused' | 'finished' | 'stopped';
  /** 1-based; 0 while no tour is active. */
  beat: number;
  /** 0 while no tour is active. */
  beats: number;
  lastStop?: TourStopReason;
}

const IDLE: TourBeat = { active: false, phase: 'idle', beat: 0, beats: 0 };

let current: TourBeat = IDLE;
const listeners = new Set<() => void>();

export function getTourBeat(): TourBeat {
  return current;
}

/** Replaces the status (controller only). A patch that changes nothing notifies nobody. */
export function setTourBeat(patch: Partial<TourBeat>): void {
  const next: TourBeat = { ...current, ...patch };
  if (
    next.active === current.active &&
    next.phase === current.phase &&
    next.beat === current.beat &&
    next.beats === current.beats &&
    next.lastStop === current.lastStop
  )
    return;
  current = next;
  for (const l of [...listeners]) l();
}

/** Forgets why the last tour ended (the `?tour=1` param went away, so the next one is a fresh ask). */
export function clearTourStop(): void {
  if (current.lastStop !== undefined) setTourBeat({ lastStop: undefined });
}

export function subscribeTourBeat(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The tour's status, re-rendering when it changes. */
export function useTourBeat(): TourBeat {
  return useSyncExternalStore(subscribeTourBeat, getTourBeat, getTourBeat);
}

/**
 * The beat a script position is on: beat 1 at the start, then one more for each distinct scripted second
 * already applied (`nextStep` steps of the sorted script). `beats` counts the start plus every distinct second.
 */
export function beatOf(stepSeconds: readonly number[], nextStep: number): { beat: number; beats: number } {
  const distinct = [...new Set(stepSeconds)].sort((a, b) => a - b);
  const applied = new Set(stepSeconds.slice(0, Math.max(0, nextStep)));
  return { beat: 1 + distinct.filter((s) => applied.has(s)).length, beats: 1 + distinct.length };
}

/** Test hook: back to "no tour yet". */
export function resetTourBeat(): void {
  current = IDLE;
  for (const l of [...listeners]) l();
}
