// src/tour/types.ts — the shape of the bundled tour fixture (demo/sample/tour.json) and of the engine's
// public status. Pure types: shared by the engine (src/tour/engine.ts), the generator
// (testdata/tour.ts) and the tests.
//
// `TourFixture` is SPEC 15's `TourDoc` (core/types.ts, the contract) plus what the UI needs to show the
// fixture as a whole workspace without any Cribl call:
//   anchor     t0 — the instant the tour starts. Every timestamp in the file is relative to it; the
//              engine shifts them all by (wall clock at start − anchor), so the sample always reads
//              "just now" whenever it is played.
//   timezone   the zone the fixture's local-day keys (trend days, roll.day rows) were computed in.
//   meta       the footer / freshness document the live app would read from KV.
//   inventory  names, types and routes of the sample workspace (Flow and Ledger labels).
//   roll.day   per-flow daily rows for the two weeks the weekly receipt reads (its week and the week
//              before, for its trend); every flow keeps a key. SPEC 15 names 30 days of hourly rows; for 55
//              flows those would be ≈ 7 MB and 30 days of day rows ≈ 210 KB, so the fixture carries the
//              receipt's evidence only (the 400 KB cap). The 30-day history on screen is the snapshot's trend.
//   workspace  headline facts for the first-run caption ("40 sources, 8 destinations, 30 days").

import type { DayRow, FlowKey, ISO, InventoryDoc, Meta, TourDoc, TourStep } from '../../core/types.ts';

export interface TourWorkspaceFacts {
  name: string;
  sources: number;
  destinations: number;
  historyDays: number;
}

/** Payload of a `caption` step. `id` selects the copy (src/copy/en.ts `tour.*`); the fixture holds no UI strings. */
export interface TourCaption {
  id: 'weekly-receipt' | 'welcome' | string;
}

export interface TourFixture extends TourDoc {
  anchor: ISO;
  timezone: string;
  meta: Meta;
  inventory: InventoryDoc;
  roll: { day: Record<FlowKey, DayRow[]> };
  workspace: TourWorkspaceFacts;
  /** Seconds from start after which the script is complete (last step + hold). */
  durationSec: number;
}

/** What the engine reports to its listeners. */
export type TourPhase = 'idle' | 'running' | 'paused' | 'finished' | 'stopped';

export type TourStopReason = 'user' | 'cleared' | 'replaced' | 'finished';

export interface TourStatus {
  phase: TourPhase;
  /** seconds of script time elapsed (0 … durationSec) */
  elapsedSec: number;
  durationSec: number;
  loop: boolean;
  /** how many times the script has wrapped (loop mode) */
  iteration: number;
  /** index of the next step to play */
  nextStep: number;
}

/** A step the engine has just applied, handed to listeners (toasts, captions, story beats). */
export interface TourEvent {
  step: TourStep;
  /** the step's payload after time-rebasing (ISO times shifted to the wall clock) */
  payload: unknown;
  /** true when applied by a seek/fast-forward rather than in real time (listeners should stay quiet) */
  silent: boolean;
  /** which pass of the script this is (0 for the first; loop mode counts up) */
  iteration: number;
}
