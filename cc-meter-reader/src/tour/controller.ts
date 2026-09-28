// src/tour/controller.ts — the app's one "Tour with sample data" (PRD 8.5).
//
//   startSampleTour(services, { navigate })   show the bundled enterprise workspace and play its script
//   stopSampleTour()                          clear it (the SAMPLE DATA band's button does the same)
//   useActiveTour()                           the running engine, for views that show tour controls
//   sampleOpeningMtdM(now)                    the month to date the tour opens on at `now` (the first-run
//                                             card's meter rolls to it before the tour starts, P2-W27)
//
// One tour at a time per page: starting another replaces the first. Tour state lives in memory only —
// nothing is written to KV, so the member's real data is untouched. What survives a reload is the URL:
// the tour runs under `?tour=1` (a sticky param), and src/tour/TourParamSync.tsx starts it again when a
// page opens with it — a reload, the presenter or a shared link keep the sample workspace (P1-M02).
//
// Status for the main bundle (src/tour/status.ts): active, phase, the beat the script is on, and why the
// last tour stopped — so the `?tour=1` resume and the SAMPLE DATA band never import this chunk.
//
// DOM contract (like `data-mr-hydrated`): <html data-mr-tour="running|paused|finished"> while a tour
// owns the screen, removed when it stops. Tests and tooling read it; nothing in the app does.

import { useSyncExternalStore } from 'react';
import type { AppServices } from '../state/services.ts';
import { createTourEngine, type TourEngine } from './engine.ts';
import { TOUR_FIXTURE } from './fixture.ts';
import { narrate } from './narration.ts';
import { pathAfterTour } from './selectors.ts';
import { closeTourDialogs } from './dialogs.ts';
import { beatOf, setTourBeat } from './status.ts';
import { planRebase, rebaseHeadline, rebaseValue } from './rebase.ts';
import { fromIso } from '../../core/time.ts';
import type { TourFixture, TourStopReason } from './types.ts';

/**
 * The sample workspace's Saved by Cribl, month to date (integer millicents), as the tour opens on it at `nowMs`:
 * the fixture moved onto the wall clock exactly as the engine moves it at start (rebase.ts: the days shift, and
 * month to date is re-summed over the moved trend), so the first-run card's meter rolls to the very figure the
 * tour's Receipt then shows.
 */
export function sampleOpeningMtdM(nowMs: number = Date.now(), doc: TourFixture = TOUR_FIXTURE): number {
  const zone = doc.timezone || 'UTC';
  const plan = planRebase(fromIso(doc.anchor ?? doc.generatedAt), nowMs, zone);
  if (plan.dayShift === 0) return doc.snapshot.headline.mtdM;
  return rebaseHeadline(rebaseValue(doc.snapshot, plan), zone, doc.settings.criblCostCentsPerMonth).headline.mtdM;
}

export interface StartTourOptions {
  /** react-router navigate: toasts link into the Ledger, and clearing the sample returns to first run. */
  navigate?: (to: string) => void;
  /** Defaults to the bundled fixture (demo/sample/tour.json). */
  doc?: TourFixture;
  loop?: boolean;
  speed?: number;
  /** Toasts for each beat (default true). */
  narrate?: boolean;
  /** Start at this script second (silently rebuilt up to it): a tour coming back after Story (OQ-02). */
  resumeAtSec?: number;
}

let active: TourEngine | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

function setDomFlag(phase: string | null): void {
  if (typeof document === 'undefined') return;
  const el = document.documentElement;
  if (phase === null) delete el.dataset.mrTour;
  else el.dataset.mrTour = phase;
}

export function startSampleTour(services: AppServices, opts: StartTourOptions = {}): TourEngine {
  active?.stop('replaced');
  const { store, actions } = services;
  const withNarration = opts.narrate !== false;
  const doc = opts.doc ?? TOUR_FIXTURE;
  const seconds = doc.script.map((s) => s.at).sort((a, b) => a - b);
  let engine: TourEngine | null = null;

  const onStop = (reason: TourStopReason): void => {
    console.info(`[meter-reader] tour stopped (${reason})`);
    setDomFlag(null);
    closeTourDialogs();
    if (active === engine) {
      active = null;
      setTourBeat({ active: false, phase: 'stopped', beat: 0, beats: 0, lastStop: reason });
    }
    emit();
    if (reason === 'cleared' || reason === 'user') opts.navigate?.(pathAfterTour(store.getState()));
  };

  engine = createTourEngine({
    store,
    actions,
    doc,
    source: 'sample',
    loop: opts.loop,
    speed: opts.speed,
    onEvent: (event) => {
      if (withNarration && engine) narrate(event, { store, engine, navigate: opts.navigate });
    },
    onStop,
  });
  engine.subscribe((s) => {
    if (s.phase === 'running' || s.phase === 'paused' || s.phase === 'finished') {
      setDomFlag(s.phase);
      if (active === engine) setTourBeat({ active: true, phase: s.phase, ...beatOf(seconds, s.nextStep) });
    }
  });
  active = engine;
  setTourBeat({ active: true, phase: 'running', ...beatOf(seconds, 0), lastStop: undefined });
  engine.start();
  if (opts.resumeAtSec !== undefined && opts.resumeAtSec > 0) engine.seek(opts.resumeAtSec);
  emit();
  return engine;
}

export function stopSampleTour(reason: TourStopReason = 'user'): void {
  active?.stop(reason);
}

/** Where a tour stood when Story took the screen, so it comes back at that beat (OQ-02); taken once. */
let resumeAtSec: number | undefined;

/** Story mode takes the sample screen: the running tour ends ('replaced') and remembers where it was. */
export function suspendSampleTourForStory(): void {
  const running = getActiveTour();
  if (!running) return;
  resumeAtSec = running.status().elapsedSec;
  running.stop('replaced');
}

/** The second a replaced tour stopped at, once (the next start uses it; later starts begin at the top). */
export function takeTourResume(): number | undefined {
  const at = resumeAtSec;
  resumeAtSec = undefined;
  return at;
}

export function getActiveTour(): TourEngine | null {
  return active && active.isActive() ? active : null;
}

export function subscribeTour(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The running (or paused / finished) tour, re-rendering when one starts or stops. */
export function useActiveTour(): TourEngine | null {
  return useSyncExternalStore(subscribeTour, getActiveTour, getActiveTour);
}
