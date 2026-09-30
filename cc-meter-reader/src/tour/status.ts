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

// ─── "See your own number" (FOUNDER_PLAN row 12, founder-build r1 ui-11) ──────
// At the finished tour's end the SAMPLE DATA band offers "See your own number". Pressing it clears the sample; the
// controller's stop sends the member to Prices (not to first run) and Prices fills the suggested prices once, unsaved,
// with its toast. Two one-shot flags, so a Prices visit on any other path is untouched (the G5-prices frames).

let meterYoursPath = false;
let suggestedPrefill = false;

/** The band's "See your own number": the next tour stop goes to Prices, which fills the suggested prices once. */
export function requestMeterYours(): void {
  meterYoursPath = true;
  suggestedPrefill = true;
}

/** Where the member asked to go when the tour stops ('/settings/prices'), once; undefined otherwise. */
export function takeMeterYoursPath(): string | undefined {
  if (!meterYoursPath) return undefined;
  meterYoursPath = false;
  return '/settings/prices';
}

/**
 * True from "See your own number" until Prices takes the fill: the stop's own navigation is on its way to Prices, so
 * the Receipt must not bounce an unpriced workspace to first run meanwhile, and the ?tour param needs no separate drop.
 */
export function meterYoursPending(): boolean {
  return suggestedPrefill;
}

/** Whether Prices should fill the suggested prices on arrival, once (only after "See your own number"). */
export function takeSuggestedPrefill(): boolean {
  const on = suggestedPrefill;
  suggestedPrefill = false;
  return on;
}

// ─── The savings drop as the takeover card (FOUNDER_PLAN row 11, founder-build r1 ui-11) ──────
// Tour beat 2 (+25 s): the narration's regression beat puts the takeover card on the Receipt, under the SAMPLE DATA
// band, beside its toast. One card per landing: it stays until its close button, Escape, the regression's toast closed
// by hand, or TOUR_TAKEOVER_MS after it landed, and a tour that stops takes it away. Remembered here (not in the
// Receipt) so a hop to the Ledger and back within its 45 s shows the same card, never a second one.

/** How long the card stays after it lands (the presenter's takeover alert keeps 45 s too). */
export const TOUR_TAKEOVER_MS = 45_000;

export interface TourTakeover {
  /** The regression incident, looked up in the live snapshot (so its delivery landing updates the card). */
  incidentId: string;
  /** Wall-clock ms it landed: the 45 s run from here. */
  landedAt: number;
}

let takeover: TourTakeover | null = null;
const takeoverListeners = new Set<() => void>();

function setTakeover(next: TourTakeover | null): void {
  if (next === takeover) return;
  takeover = next;
  for (const l of [...takeoverListeners]) l();
}

/** The narration's regression beat: the card lands now. */
export function showTourTakeover(incidentId: string, landedAt: number = Date.now()): void {
  setTakeover({ incidentId, landedAt });
}

/** The card goes (its close button, Escape, 45 s, its toast closed, the tour stopping). Only that incident's, when named. */
export function dismissTourTakeover(incidentId?: string): void {
  if (!takeover || (incidentId !== undefined && takeover.incidentId !== incidentId)) return;
  setTakeover(null);
}

export function getTourTakeover(): TourTakeover | null {
  return takeover;
}

export function subscribeTourTakeover(listener: () => void): () => void {
  takeoverListeners.add(listener);
  return () => takeoverListeners.delete(listener);
}

/** The card the Receipt should show, re-rendering when one lands or goes. */
export function useTourTakeover(): TourTakeover | null {
  return useSyncExternalStore(subscribeTourTakeover, getTourTakeover, getTourTakeover);
}

/** Test hook: back to "no tour yet". */
export function resetTourBeat(): void {
  current = IDLE;
  meterYoursPath = false;
  suggestedPrefill = false;
  setTakeover(null);
  for (const l of [...listeners]) l();
}
