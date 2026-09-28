// src/state/services.ts — composes the store, the KV documents, live polling and the UI meter loop
// into the one object the React tree receives, and defines the actions views call.
//
// Write rules (SPEC 13, AGENTS.md):
// - `hasHydrated` gates every KV write: before settings are known, saves are refused, never queued.
// - Sample / replay data is never written back to KV.
// - Settings and prices saves are explicit user actions (a Save button); nothing here writes on load,
//   on render or on a timer. The sweep writes its own documents inside core `runSweep()`.

import type { Meta, PricesDoc, RollHourDoc, Settings, Snapshot, TotalsDoc } from '../../core/types.ts';
import type { RangeSpec } from '../../core/range.ts';
import { fromIso } from '../../core/time.ts';
import { IS_DEMO_BUILD } from '../lib/env.ts';
import type { HostTheme } from '../theme/bridge.ts';
import { hydrate, hydrateSecondary, retrySettings, type HydrateDeps } from './hydrate.ts';
import { createLiveController, type LiveController } from './live.ts';
import { createMeterLoop, type MeterController, type SweepNowResult, type WeeklySendResult } from './meterLoop.ts';
import type { AppDocs, MergeSettings, SweepEngine, Timers, VisibilitySource } from './ports.ts';
import { rebasePrices } from './pricesMerge.ts';
import { createRangeReader, type RangeReadResult } from './rangeReader.ts';
import { classifyError, type ApiErrorInfo, type AppStore, type DataSource } from './store.ts';
import { sampleRollups, type SampleRollups } from '../../core/sampleRollups.ts';
import type { RangeReader } from './rangeReader.ts';
import type { AppState } from './store.ts';

export type WriteResult =
  /** `merged`: another tab saved first, and this save was appended on top of it (prices, P1-D04). */
  | { ok: true; merged?: boolean }
  | { ok: false; reason: 'not-hydrated' | 'not-live' | 'error'; error?: ApiErrorInfo };

/** A bundled fixture shown instead of live data (Tour with sample data, Replay, Story). */
export interface SampleData {
  source: Exclude<DataSource, 'live'>;
  snapshot: Snapshot;
  settings?: Settings;
  prices?: PricesDoc | null;
  meta?: Meta | null;
}

export interface AppActions {
  /** Replaces the stored settings (stamps `updatedAt`). Refused until hydrated and while sample data shows. */
  saveSettings(next: Settings): Promise<WriteResult>;
  /**
   * Writes the prices document (stamps `updatedAt`). Same gates as saveSettings. Reads the stored document
   * first: when another tab saved since this one loaded, only this save's changes are appended on top of it
   * (src/state/pricesMerge.ts), so neither save is lost (P1-D04).
   */
  savePrices(next: PricesDoc): Promise<WriteResult>;
  /** Sweep now — throttled to once per 30 s; refused in the 'ui' runtime until prices exist (see meterLoop.ts). */
  sweepNow(): Promise<SweepNowResult>;
  /** "Send this week's receipt" — the seven days before today, to every endpoint with Weekly receipt on. */
  sendWeeklyReceipt(): Promise<WeeklySendResult>;
  /** Re-read snapshot, meta and prices now (Refresh / Try again). */
  refresh(): Promise<void>;
  /** Re-read the inventory summary (and demo state in the demo build). */
  refreshSecondary(): Promise<void>;
  /**
   * Sums the rollup rows behind a custom range on the Receipt (core/range.ts, rangeReader.ts). Reads only;
   * refused before hydration. On sample data it sums rollups built in memory from the tour's snapshot
   * (core/sampleRollups.ts, P2-W05) and never reads KV. `signal` stops a live read's queue when a newer range
   * replaces it (rangeReader.ts).
   */
  readRange(spec: RangeSpec, signal?: AbortSignal): Promise<RangeReadResult>;
  /**
   * What a destination statement reads when it opens (P2-W25): the running totals (this month and last, per
   * destination) and the hour rollups named by `hourKeys` (the last seven days: at most 8 documents). Reads only;
   * refused before hydration; on the tour's sample the hour documents are synthesized in memory (no totals).
   */
  readHistory(hourKeys: readonly string[]): Promise<HistoryReadResult>;
  enterSample(data: SampleData): void;
  clearSample(): void;
  setTheme(theme: HostTheme): void;
  setPresenter(on: boolean): void;
}

export type HistoryReadResult =
  | { ok: true; totals: TotalsDoc | null; hours: (RollHourDoc | null)[]; sample?: boolean }
  | { ok: false; reason: 'not-hydrated' | 'not-live' | 'unavailable' | 'error'; error?: ApiErrorInfo };

export interface AppServices {
  store: AppStore;
  docs: AppDocs;
  live: LiveController;
  meter: MeterController;
  actions: AppActions;
  /** Hydrate, then start live polling and (runtime 'ui') the meter loop. Resolves after hydration. */
  start(): Promise<void>;
  stop(): void;
}

export interface ServicesDeps {
  store: AppStore;
  docs: AppDocs;
  engine: SweepEngine;
  mergeSettings: MergeSettings;
  timers?: Timers;
  visibility?: VisibilitySource;
  now?: () => number;
}

export function createAppServices(deps: ServicesDeps): AppServices {
  const { store, docs, engine, mergeSettings } = deps;
  const now = deps.now ?? Date.now;
  const hydrateDeps: HydrateDeps = { store, docs, mergeSettings, now };
  const includeDemoState = () => IS_DEMO_BUILD && store.getState().settings.demo.enabled;

  const live = createLiveController({
    store,
    docs,
    timers: deps.timers,
    visibility: deps.visibility,
    now,
    retrySettings: () => retrySettings(hydrateDeps),
    includeDemoState,
  });
  const meter = createMeterLoop({ store, engine, refresh: () => live.pollNow(), timers: deps.timers, now });
  const rangeReader = docs.rollups ? createRangeReader({ rollups: docs.rollups, now }) : null;

  // The tour's sample shows a custom range too (P2-W05): its rollups are synthesized in memory from the snapshot
  // on screen (core/sampleRollups.ts) — nothing is read from KV and nothing is written. One reader per snapshot.
  const sampleReaders = new WeakMap<Snapshot, RangeReader>();
  const readSampleRange = (state: AppState, snapshot: Snapshot, spec: RangeSpec): Promise<RangeReadResult> => {
    let reader = sampleReaders.get(snapshot);
    if (!reader) {
      reader = createRangeReader({ rollups: sampleRollups(snapshot, state.settings.displayTimezone), now });
      sampleReaders.set(snapshot, reader);
    }
    const sinceMs = fromIso(state.meta?.collectingSince ?? snapshot.collectingSince);
    return reader.read(spec, Number.isFinite(sinceMs) ? sinceMs : undefined);
  };

  // A destination statement's hour map on the sample (P2-W25): one synthesized history per snapshot.
  const sampleHistory = new WeakMap<Snapshot, SampleRollups>();

  const guardWrite = (): WriteResult | null => {
    const state = store.getState();
    if (!state.hasHydrated) return { ok: false, reason: 'not-hydrated' };
    if (state.source !== 'live') return { ok: false, reason: 'not-live' };
    return null;
  };

  const actions: AppActions = {
    async saveSettings(next) {
      const refused = guardWrite();
      if (refused) return refused;
      const doc: Settings = { ...next, updatedAt: new Date(now()).toISOString() };
      try {
        await docs.writeSettings(doc);
      } catch (error) {
        return { ok: false, reason: 'error', error: classifyError(error, now()) };
      }
      store.setState({ settings: doc, settingsStored: true });
      return { ok: true };
    },

    async savePrices(next) {
      const refused = guardWrite();
      if (refused) return refused;
      const base = store.getState().prices;
      let stored: PricesDoc | null;
      try {
        stored = await docs.readPrices();
      } catch (error) {
        // Unreadable now means the write would likely fail too; never write blind over a document we can't see.
        return { ok: false, reason: 'error', error: classifyError(error, now()) };
      }
      const { doc, merged } = rebasePrices(next, base, stored, new Date(now()).toISOString());
      try {
        await docs.writePrices(doc);
      } catch (error) {
        return { ok: false, reason: 'error', error: classifyError(error, now()) };
      }
      store.setState({ prices: doc });
      return merged ? { ok: true, merged: true } : { ok: true };
    },

    sweepNow: () => meter.sweepNow(),
    sendWeeklyReceipt: () => meter.sendWeekly(),
    refresh: () => live.pollNow({ full: true }),
    refreshSecondary: () => hydrateSecondary({ ...hydrateDeps, includeDemoState: includeDemoState() }),

    async readRange(spec, signal) {
      const state = store.getState();
      if (!state.hasHydrated) return { ok: false, reason: 'not-hydrated' };
      if (state.source === 'sample' && state.snapshot) return readSampleRange(state, state.snapshot, spec);
      if (state.source !== 'live') return { ok: false, reason: 'not-live' };
      if (!rangeReader) return { ok: false, reason: 'unavailable' };
      // Never before collecting began: the meta document knows, the snapshot repeats it. The sweep cursor
      // lets the reader notice a catch-up that rewrote history it had cached.
      const sinceIso = state.meta?.collectingSince ?? state.snapshot?.collectingSince;
      const since = sinceIso ? fromIso(sinceIso) : Number.NaN;
      const through = state.meta?.meteredThrough ? fromIso(state.meta.meteredThrough) : Number.NaN;
      return rangeReader.read(spec, Number.isFinite(since) ? since : undefined, Number.isFinite(through) ? through : undefined, signal);
    },

    async readHistory(hourKeys) {
      const state = store.getState();
      if (!state.hasHydrated) return { ok: false, reason: 'not-hydrated' };
      // The tour's sample: the same hour documents the Custom range sums, synthesized in memory (P2-W05); it has
      // no running totals. Replay has neither.
      if (state.source === 'sample' && state.snapshot) {
        let rollups = sampleHistory.get(state.snapshot);
        if (!rollups) {
          rollups = sampleRollups(state.snapshot, state.settings.displayTimezone);
          sampleHistory.set(state.snapshot, rollups);
        }
        const docsFor = rollups;
        return { ok: true, sample: true, totals: null, hours: hourKeys.slice(0, 8).map((k) => docsFor.hourDoc(k)) };
      }
      if (state.source !== 'live') return { ok: false, reason: 'not-live' };
      if (!docs.readTotals || !docs.rollups) return { ok: false, reason: 'unavailable' };
      try {
        const [totals, ...hours] = await Promise.all([docs.readTotals(), ...hourKeys.slice(0, 8).map((k) => docs.rollups!.readHour(k))]);
        return { ok: true, totals, hours };
      } catch (error) {
        return { ok: false, reason: 'error', error: classifyError(error, now()) };
      }
    },

    enterSample(data) {
      store.setState((state) => ({
        // Stash the live documents once; switching tour → replay keeps the original live stash.
        liveStash:
          state.source === 'live'
            ? { settings: state.settings, prices: state.prices, snapshot: state.snapshot, meta: state.meta }
            : state.liveStash,
        source: data.source,
        snapshot: data.snapshot,
        settings: data.settings ?? state.settings,
        prices: data.prices === undefined ? state.prices : data.prices,
        meta: data.meta === undefined ? state.meta : data.meta,
      }));
    },

    clearSample() {
      store.setState((state) => {
        if (state.source === 'live') return {};
        const stash = state.liveStash;
        return {
          source: 'live',
          liveStash: null,
          ...(stash ? { settings: stash.settings, prices: stash.prices, snapshot: stash.snapshot, meta: stash.meta } : {}),
        };
      });
      // live.ts polls immediately when the source returns to 'live'.
    },

    setTheme(theme) {
      store.setState({ theme });
    },

    setPresenter(on) {
      store.setState({ presenter: on });
    },
  };

  return {
    store,
    docs,
    live,
    meter,
    actions,
    async start() {
      await hydrate(hydrateDeps);
      live.start();
      meter.start();
      void hydrateSecondary({ ...hydrateDeps, includeDemoState: includeDemoState() });
    },
    stop() {
      meter.stop();
      live.stop();
    },
  };
}
