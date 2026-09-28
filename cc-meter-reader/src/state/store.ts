// src/state/store.ts — the app's single state container.
//
// A deliberately small external store (no state library): `getState / setState / subscribe`, read from
// React through `useSyncExternalStore` with a memoized selector so a component re-renders only when the
// slice it selected changes. Everything that talks to the Leader (hydrate, live polling, the UI meter
// loop) writes here; views only read and call actions.

import type { DemoState, Meta, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import type { WeeklyResult } from '../../core/weekly.ts';
import type { HostTheme } from '../theme/bridge.ts';

// ─── Generic store ───────────────────────────────────────────────────────────

type Listener = () => void;

export interface Store<S> {
  getState(): S;
  /** Shallow-merges a patch (or the patch returned by `fn(state)`) and notifies once. */
  setState(update: Partial<S> | ((state: S) => Partial<S>)): void;
  subscribe(listener: Listener): () => void;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    setState(update) {
      const patch = typeof update === 'function' ? update(state) : update;
      let changed = false;
      for (const key of Object.keys(patch) as (keyof S)[]) {
        if (!Object.is(state[key], patch[key])) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// ─── App state ───────────────────────────────────────────────────────────────

/** How an API failure is shown (SPEC 13 "Errors"). */
export type ApiErrorKind = 'unauthorized' | 'forbidden' | 'not-found' | 'rate-limited' | 'server' | 'network' | 'unknown';

export interface ApiErrorInfo {
  kind: ApiErrorKind;
  /** HTTP status; 0 for network errors / unknown. */
  status: number;
  message?: string;
  /** epoch ms when it happened */
  at: number;
}

/** Which data the screens are showing: the member's live KV, or a bundled fixture (tour / replay). */
export type DataSource = 'live' | 'sample' | 'replay';

/** The documents hydrate and live polling manage; also the keys of `AppState.errors`. */
export type DocName = 'settings' | 'prices' | 'snapshot' | 'meta' | 'demoState' | 'inventory';

export interface InventorySummary {
  updatedAt: string;
  groups: string[];
  counts: { inputs: number; outputs: number; pipelines: number; routes: number };
  /**
   * What the sweep meters from this inventory (core/flows.ts buildFlows with the workspace's settings): every flow,
   * and the routes and sources the detector watches. A snapshot over its size cap folds the smaller flows into one
   * 'Other' flow (core/snapshot.ts compactSnapshot); these counts say how many the fold holds (usefulness review,
   * round 2). Absent when the summary was made without settings.
   */
  metered?: { flows: number; routes: number; sources: number };
}

/** What the UI shows about the most recent sweep this tab started or requested. */
export interface SweepSummary {
  ok: boolean;
  /** e.g. 'locked' when another tab holds the KV lock (SPEC 7 step 1) */
  skipped?: string;
  calls?: number;
  durationMs?: number;
  mode: 'ui' | 'manual';
  error?: string;
  status?: number;
  /** A sweep may hand back what it just wrote, saving the two KV reads of the next poll. */
  snapshot?: Snapshot;
  meta?: Meta;
}

/**
 * A sweep this tab ran that failed or was stopped (P0-07): the sweep's own error code (e.g. `rate_limited`,
 * `metrics outputs query failed: HTTP 403 …`), never shown raw — `classifySweepError` in
 * src/components/Shell/status.ts turns it into copy.
 */
export interface SweepFailure {
  code: string;
  /** HTTP status when the sweep reported one (the backend endpoint's answer) */
  status?: number;
  /** epoch ms when the failed sweep finished */
  at: number;
}

/** One weekly-receipt run started by this tab (core/weekly.ts `WeeklyResult` as `outcome`). */
export interface WeeklyAttempt {
  /** epoch ms when it finished */
  at: number;
  mode: 'manual' | 'ui';
  outcome: WeeklyResult;
}

export interface RuntimeStatus {
  hydrate: { phase: 'idle' | 'loading' | 'done' | 'error'; startedAt?: number; finishedAt?: number };
  live: {
    phase: 'idle' | 'polling' | 'waiting' | 'hidden' | 'backoff' | 'stopped';
    lastPollAt?: number;
    /** last poll that returned without error — drives "updated 12 s ago" when no sweep time exists */
    lastOkAt?: number;
    lastError?: ApiErrorInfo;
    /** KV 429 → poll every 60 s until this time (SPEC 13) */
    backoffUntil?: number;
    nextPollAt?: number;
    /**
     * epoch ms when `snapshot` + `meta` were last known current: a poll that read meta (and the snapshot it
     * described), or a sweep that handed both back. A poll inside one interval of it reads neither (P1-D05).
     */
    docsAt?: number;
    /** epoch ms of the last `prices` read by polling (re-read once a minute, P1-D04/P1-D05) */
    pricesReadAt?: number;
    /** epoch ms of the last `demo/state` read by polling (every poll only while a scene or lever runs) */
    demoReadAt?: number;
  };
  sweep: {
    running: boolean;
    lastRunAt?: number;
    lastResult?: SweepSummary;
    /** client throttle for Sweep now (SPEC 7: once per 30 s) */
    nextManualAt: number;
    /** whether this tab is currently metering (runtime 'ui', live data, hydrated, prices saved) */
    metering: boolean;
    /** This tab's KV-lock owner id (`ui:<uuid>`), so "Metered by this tab" can be told from another tab. */
    ownerId?: string;
    /**
     * epoch ms of the newest sweep this tab has seen the runner complete (`meta.lastSweepOwner` = `runner:…`).
     * Kept across polls, because a tab that wins the lock for one minute overwrites `lastSweepOwner`.
     */
    runnerSeenAt?: number;
    /** The last weekly receipt this tab sent or tried ("Send this week's receipt", or the Monday auto-send). */
    lastWeekly?: WeeklyAttempt;
    /** Consecutive sweeps this tab ran that failed or were stopped; 0 or absent after one that ran (P0-07). */
    failures?: number;
    /** epoch ms the first failure of the current streak finished */
    failingSince?: number;
    /** The newest failure of the current streak (cleared with the streak). */
    lastFailure?: SweepFailure;
    /** epoch ms this tab's next timed sweep is due (runtime 'ui'), for "Next sweep in 0:42" */
    nextAt?: number;
    /**
     * epoch ms this tab started metering. A sweep another open tab completes after this is proof that tab is
     * open; one completed before it may be this very tab before a reload (P1-D03).
     */
    meteringSince?: number;
  };
}

export interface AppState {
  /** True once the stored settings are known (read OK or confirmed absent). Gates every KV write. */
  hasHydrated: boolean;
  /** Whether KV held a settings document (false = first run; defaults shown but not yet saved). */
  settingsStored: boolean;
  source: DataSource;
  theme: HostTheme;
  /** ?present=1 — mirrored from the URL by the shell; live polling uses it for the 5 s cadence. */
  presenter: boolean;
  settings: Settings;
  prices: PricesDoc | null;
  snapshot: Snapshot | null;
  meta: Meta | null;
  demoState: DemoState | null;
  inventory: InventorySummary | null;
  status: RuntimeStatus;
  /** Latest read error per document (cleared by the next successful read). 404 is never an error. */
  errors: Partial<Record<DocName, ApiErrorInfo>>;
  /** Live data set aside while a tour / replay is showing, restored by `clearSample`. */
  liveStash: { settings: Settings; prices: PricesDoc | null; snapshot: Snapshot | null; meta: Meta | null } | null;
}

export type AppStore = Store<AppState>;

export function initialRuntimeStatus(): RuntimeStatus {
  return {
    hydrate: { phase: 'idle' },
    live: { phase: 'idle' },
    sweep: { running: false, nextManualAt: 0, metering: false },
  };
}

export function createAppState(defaults: Settings, overrides: Partial<AppState> = {}): AppState {
  return {
    hasHydrated: false,
    settingsStored: false,
    source: 'live',
    theme: 'light',
    presenter: false,
    settings: defaults,
    prices: null,
    snapshot: null,
    meta: null,
    demoState: null,
    inventory: null,
    status: initialRuntimeStatus(),
    errors: {},
    liveStash: null,
    ...overrides,
  };
}

export function createAppStore(defaults: Settings, overrides: Partial<AppState> = {}): AppStore {
  return createStore(createAppState(defaults, overrides));
}

// ─── Nested-update helpers (keep reducers readable) ──────────────────────────

export function patchLive(store: AppStore, patch: Partial<RuntimeStatus['live']>): void {
  store.setState((s) => ({ status: { ...s.status, live: { ...s.status.live, ...patch } } }));
}

export function patchSweep(store: AppStore, patch: Partial<RuntimeStatus['sweep']>): void {
  store.setState((s) => ({ status: { ...s.status, sweep: { ...s.status.sweep, ...patch } } }));
}

export function patchHydrate(store: AppStore, patch: Partial<RuntimeStatus['hydrate']>): void {
  store.setState((s) => ({ status: { ...s.status, hydrate: { ...s.status.hydrate, ...patch } } }));
}

export function setDocError(store: AppStore, doc: DocName, error: ApiErrorInfo | undefined): void {
  store.setState((s) => {
    if (s.errors[doc] === error) return {};
    const next = { ...s.errors };
    if (error) next[doc] = error;
    else delete next[doc];
    return { errors: next };
  });
}

// ─── Error classification ────────────────────────────────────────────────────

export function errorKindForStatus(status: number): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  if (status === 0) return 'network';
  return 'unknown';
}

/**
 * Normalizes anything thrown by an HTTP/KV call into `ApiErrorInfo`. Reads a numeric `status` (or
 * `statusCode`) property when the thrower provided one, else a 3-digit HTTP code in the message; a
 * `TypeError` from fetch is a network failure.
 */
export function classifyError(error: unknown, now: number = Date.now()): ApiErrorInfo {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  let status = 0;
  if (error && typeof error === 'object') {
    const candidate = (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) status = candidate;
  }
  if (status === 0 && message) {
    const match = /\b([45]\d\d)\b/.exec(message);
    if (match) status = Number(match[1]);
  }
  const kind: ApiErrorKind = status === 0 && error instanceof TypeError ? 'network' : errorKindForStatus(status);
  return { kind, status, message, at: now };
}
