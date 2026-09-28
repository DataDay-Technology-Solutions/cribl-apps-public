// src/state/ports.ts — the seams between the UI state layer and the I/O it drives.
//
// hydrate / live / meterLoop / actions depend only on these interfaces. `runtime.ts` implements them
// in the browser on top of core/kv.ts, core/codec.ts, core/sweep.ts and core/settings.ts; tests
// implement them in memory. Keeping the binding to other modules in one file means a change in a core
// signature is a one-file fix here.

import type { DemoState, InventoryDoc, Meta, PricesDoc, RollDayDoc, RollHourDoc, RollMinuteDoc, Settings, Snapshot, TotalsDoc } from '../../core/types.ts';
import type { WeeklyResult } from '../../core/weekly.ts';
import type { SweepSummary } from './store.ts';

/**
 * The rollup documents a custom range sums (core/range.ts): reads by full key (`roll/min/2026-09-26T10`),
 * null when the store has none, rejecting on any other failure — the same contract as AppDocs.
 */
export interface RollupDocs {
  readMinute(key: string): Promise<RollMinuteDoc | null>;
  readHour(key: string): Promise<RollHourDoc | null>;
  readDay(key: string): Promise<RollDayDoc | null>;
}

/**
 * The app's KV documents. Reads resolve to `null` when the key does not exist (HTTP 404) and REJECT on
 * any other failure — callers distinguish "absent" (first run) from "unreadable" (403, 5xx), which is
 * what keeps defaults from ever overwriting stored values.
 */
export interface AppDocs {
  readSettings(): Promise<Settings | null>;
  readPrices(): Promise<PricesDoc | null>;
  readSnapshot(): Promise<Snapshot | null>;
  readMeta(): Promise<Meta | null>;
  readDemoState(): Promise<DemoState | null>;
  readInventory(): Promise<InventoryDoc | null>;
  writeSettings(doc: Settings): Promise<void>;
  writePrices(doc: PricesDoc): Promise<void>;
  /**
   * NOT a KV document: the inventory read straight from the Leader (`GET /products/stream/groups`, then inputs,
   * outputs, pipelines and routes per group — GETs only, nothing is written). The Prices and Budgets pages
   * use it before the first sweep has written the `inventory` KV document: the 'ui' runtime no longer
   * sweeps until prices exist (REVIEW-3a #3), and pricing needs the destination list first. Optional so
   * in-memory test docs need not implement it.
   */
  readLeaderInventory?(): Promise<InventoryDoc>;
  /** The rollup history a custom range on the Receipt reads (never written from the UI). Optional for in-memory test docs. */
  rollups?: RollupDocs;
  /** The running totals (month by month per destination) a destination statement reads (P2-W25). Optional for in-memory test docs. */
  readTotals?(): Promise<TotalsDoc | null>;
}

/** Merges a stored settings document over the defaults; stored values always win (core/settings.ts). */
export type MergeSettings = (stored: Settings) => Settings;

/**
 * The contract core/sweep.ts implements (as stated for the build): `runSweep(deps, opts)` resolving to a
 * SweepResult. Declared here so the UI can bind it before the module exists; see runtime.ts.
 */
export type RunSweep = (
  deps: Record<string, unknown>,
  opts: { mode: 'scheduled' | 'manual' | 'ui'; nowMs?: number },
) => Promise<unknown>;

/** What a weekly-receipt run reports (core/weekly.ts `WeeklyResult`, or the backend endpoint's JSON). */
export type WeeklyOutcome = WeeklyResult;

/** Runs sweeps for the two runtimes (DECISIONS D11/D12b). */
export interface SweepEngine {
  /** runtime 'ui': run core `runSweep()` in this tab, as the member. */
  runLocal(mode: 'ui' | 'manual'): Promise<SweepSummary>;
  /** runtime 'backend': `POST ${CRIBL_API_URL}/endpoints/meter {mode:'manual'}` — Sweep now only, never on a timer. */
  invokeBackend(): Promise<SweepSummary>;
  /** This tab's KV-lock owner id (`ui:<uuid>`); optional so test engines need not provide it. */
  readonly ownerId?: string;
  /**
   * The weekly receipt (SPEC 11, 12.4; DECISIONS D12b). 'manual' = "Send this week's receipt" (the seven
   * days before today, no lock, sent every time it is pressed); 'ui' = the open tab's automatic Monday send
   * (previous Monday–Sunday, holds the KV lock, once per week via `meta.lastWeeklySentAt`). In the 'backend'
   * runtime a manual send POSTs `/endpoints/weeklyReceipt {mode:'manual'}` instead. Never throws.
   */
  runWeekly?(mode: 'manual' | 'ui', runtime: Settings['runtime']): Promise<WeeklyOutcome>;
}

/** Timer functions, injectable so tests can drive time. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The slice of `document` live polling needs (visibility), injectable for tests. */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}
