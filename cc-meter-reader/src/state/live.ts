// src/state/live.ts — live mode (SPEC 13 "Live mode").
//
// While the tab is visible, read the `snapshot` and `meta` KV keys every `settings.live.pollSeconds`
// (10 s; presenter mode `presenterPollSeconds`, 5 s); while hidden, every 60 s; on becoming visible,
// read immediately. A KV 429 backs polling off to 60 s for 5 minutes. This module NEVER invokes
// `/endpoints/meter`: the backend budget is per App and metrics only move once a minute (SPEC 13, S16).
// While a tour / replay is showing (`source !== 'live'`) it keeps its schedule but reads nothing.
//
// What each poll reads (P1-D04, P1-D05 — the Leader budget is shared with the sweep):
//   • meta, unless a sweep handed both documents back within the last interval (`status.live.docsAt`);
//   • the snapshot only when that meta says it moved: a meta that differs from the one this tab holds means a
//     sweep ran (or failed) since, so the snapshot is read right after it. Every sweep writes the snapshot
//     before meta, so a new snapshot is never missed, and an unchanged minute costs one small read, not two;
//     a snapshot read that failed is retried on the next poll;
//   • prices every 20 s until a document exists, then once a minute: a tab opened before prices were saved (in
//     another tab) sees them and starts metering (meterLoop's prices gate, REVIEW-3a #3), and a tab that holds
//     prices adopts a NEWER document another tab saved (by `updatedAt`), so its next Save builds on it instead
//     of reverting it;
//   • demo/state (demo build, demo mode on) every poll while a scene or lever is running, else every 30 s.
// `pollNow()` (visible again, a sweep's refresh, sample data cleared) reads snapshot and meta together;
// `pollNow({ full: true })` (Refresh / Try again) reads all of them.

import type { DemoState, Meta, PricesDoc, Settings, Snapshot } from '../../core/types.ts';
import type { AppDocs, Timers, VisibilitySource } from './ports.ts';
import { browserTimers } from './ports.ts';
import { classifyError, patchLive, setDocError, type ApiErrorInfo, type AppStore, type DocName } from './store.ts';

export const HIDDEN_POLL_MS = 60_000;
export const BACKOFF_POLL_MS = 60_000;
export const BACKOFF_WINDOW_MS = 5 * 60_000;
/** Prices this tab holds are re-read at most this often (the hidden cadence). */
export const PRICES_REFRESH_MS = 60_000;
/** Before any prices document exists (first run), a little sooner: a save in another tab starts this tab's meter. */
export const PRICES_ABSENT_REFRESH_MS = 20_000;
/** demo/state while no scene or lever is running. */
export const DEMO_IDLE_REFRESH_MS = 30_000;

/** Whether `lastAt` is at least `everyMs` ago (or never happened). A clock that went backwards reads as due. */
function due(lastAt: number | undefined, nowMs: number, everyMs: number): boolean {
  return lastAt === undefined || nowMs - lastAt >= everyMs || nowMs < lastAt;
}

/** Whether a demo scene or a lever is in progress, so demo/state changes by the second. */
export function demoIsActive(demo: DemoState | null | undefined): boolean {
  return Boolean(demo?.scene || demo?.inFlight);
}

/**
 * Whether a `meta` document just read says the snapshot on screen may be behind (P1-D05): it differs from the
 * meta this tab holds, so a sweep ran or failed since. A sweep writes the snapshot before meta, so once meta
 * moved, the snapshot it describes is already stored.
 */
export function metaMoved(held: Meta | null, read: Meta | null): boolean {
  if (read === null) return false; // nothing has swept (or meta is gone): nothing new to read
  return !isSameJson(held, read);
}

/** ISO `updatedAt` of `a` is strictly newer than `b`'s (both from `new Date().toISOString()`). */
function isNewerDoc(a: { updatedAt?: string } | null | undefined, b: { updatedAt?: string } | null | undefined): boolean {
  const at = a?.updatedAt ? Date.parse(a.updatedAt) : Number.NaN;
  const bt = b?.updatedAt ? Date.parse(b.updatedAt) : Number.NaN;
  if (!Number.isFinite(at)) return false;
  return !Number.isFinite(bt) || at > bt;
}

/** SPEC 5 validation ranges; out-of-range stored values are clamped, never trusted. */
const POLL_RANGE_S = { min: 5, max: 60 } as const;
const PRESENTER_POLL_RANGE_S = { min: 3, max: 30 } as const;

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export interface PollDelayInput {
  hidden: boolean;
  presenter: boolean;
  live: Settings['live'];
  backoffUntil?: number;
  now: number;
}

/** The delay before the next poll. Backoff and hidden both mean 60 s; presenter wins over normal. */
export function computePollDelayMs(input: PollDelayInput): number {
  if (input.backoffUntil !== undefined && input.backoffUntil > input.now) return BACKOFF_POLL_MS;
  if (input.hidden) return HIDDEN_POLL_MS;
  if (input.presenter) {
    return clamp(input.live.presenterPollSeconds, PRESENTER_POLL_RANGE_S.min, PRESENTER_POLL_RANGE_S.max, 5) * 1000;
  }
  return clamp(input.live.pollSeconds, POLL_RANGE_S.min, POLL_RANGE_S.max, 10) * 1000;
}

/** A snapshot is "new" when a different sweep wrote it; re-renders are skipped for identical polls. */
export function isSameSnapshot(a: Snapshot | null, b: Snapshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.sweepAt === b.sweepAt && a.mode === b.mode && a.calls === b.calls && a.windowEnd === b.windowEnd;
}

function isSameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export interface LiveDeps {
  store: AppStore;
  docs: AppDocs;
  timers?: Timers;
  visibility?: VisibilitySource;
  now?: () => number;
  /** Called on each poll while settings are still unknown (failed hydration), e.g. `retrySettings`. */
  retrySettings?: () => Promise<unknown>;
  /** Whether to poll `demo/state` too (demo build with demo mode on). */
  includeDemoState?: () => boolean;
}

export interface PollOptions {
  /** Read every document regardless of its cadence (Refresh / Try again). */
  full?: boolean;
  /**
   * Read snapshot + meta even if a sweep just handed them back (the tab became visible, sample data was
   * cleared, a sweep asked for a refresh). Only the timer's own polls skip them.
   */
  docs?: boolean;
}

export interface LiveController {
  /** Begin polling (first read after one interval; hydrate has just read everything). */
  start(): void;
  stop(): void;
  /** Poll right away (visibility change, Sweep now finished, sample cleared). Coalesces with an in-flight poll. */
  pollNow(opts?: PollOptions): Promise<void>;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: ApiErrorInfo };

export function createLiveController(deps: LiveDeps): LiveController {
  const { store, docs } = deps;
  const timers = deps.timers ?? browserTimers;
  const now = deps.now ?? Date.now;
  const visibility = deps.visibility ?? (typeof document === 'undefined' ? undefined : document);

  let running = false;
  let handle: unknown;
  let inFlight: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;

  const settle = async <T>(promise: Promise<T>): Promise<Settled<T>> => {
    try {
      return { ok: true, value: await promise };
    } catch (error) {
      return { ok: false, error: classifyError(error, now()) };
    }
  };

  const clearTimer = () => {
    if (handle !== undefined) timers.clearTimeout(handle);
    handle = undefined;
  };

  const schedule = () => {
    clearTimer();
    if (!running) return;
    const state = store.getState();
    const t = now();
    const hidden = visibility?.hidden ?? false;
    const delay = computePollDelayMs({
      hidden,
      presenter: state.presenter,
      live: state.settings.live,
      backoffUntil: state.status.live.backoffUntil,
      now: t,
    });
    const backoff = state.status.live.backoffUntil !== undefined && state.status.live.backoffUntil > t;
    patchLive(store, { nextPollAt: t + delay, phase: backoff ? 'backoff' : hidden ? 'hidden' : 'waiting' });
    handle = timers.setTimeout(() => {
      handle = undefined;
      void pollNow({ docs: false });
    }, delay);
  };

  const poll = async (opts: PollOptions = {}): Promise<void> => {
    const state = store.getState();
    if (!state.hasHydrated && deps.retrySettings) await deps.retrySettings().catch(() => undefined);
    if (store.getState().source !== 'live') return; // a tour/replay owns the screen; nothing to read

    patchLive(store, { phase: 'polling' });
    const before = store.getState();
    const started = now();
    const full = opts.full === true;
    const pollMs = computePollDelayMs({
      hidden: visibility?.hidden ?? false,
      presenter: before.presenter,
      live: before.settings.live,
      backoffUntil: before.status.live.backoffUntil,
      now: started,
    });
    const liveStatus = before.status.live;
    // A sweep handed back both documents moments ago: they are as new as a read would return (P1-D05).
    const docsFresh = !full && opts.docs !== true && liveStatus.docsAt !== undefined && started - liveStatus.docsAt >= 0 && started - liveStatus.docsAt < pollMs * 0.9;
    // The snapshot rides with meta when asked for (Refresh, visible again, a sweep's refresh) or when its last read
    // failed; otherwise it is read only after a meta that moved (see the header).
    const snapshotWithMeta = !docsFresh && (full || opts.docs === true || before.errors.snapshot !== undefined);
    const wantMeta = !docsFresh;
    const wantDemo = (deps.includeDemoState?.() ?? false) && (full || demoIsActive(before.demoState) || due(liveStatus.demoReadAt, started, DEMO_IDLE_REFRESH_MS));
    const wantPrices = full || due(liveStatus.pricesReadAt, started, before.prices === null ? PRICES_ABSENT_REFRESH_MS : PRICES_REFRESH_MS);
    const [snapshotFirst, meta, demo, prices] = await Promise.all([
      snapshotWithMeta ? settle<Snapshot | null>(docs.readSnapshot()) : Promise.resolve(null),
      wantMeta ? settle<Meta | null>(docs.readMeta()) : Promise.resolve(null),
      wantDemo ? settle<DemoState | null>(docs.readDemoState()) : Promise.resolve(null),
      wantPrices ? settle<PricesDoc | null>(docs.readPrices()) : Promise.resolve(null),
    ]);
    let snapshot = snapshotFirst;
    if (snapshot === null && meta?.ok && store.getState().source === 'live' && metaMoved(store.getState().meta, meta.value)) {
      snapshot = await settle<Snapshot | null>(docs.readSnapshot());
    }
    const t = now();

    // A tour may have started while the reads were out; its data must not be overwritten.
    if (store.getState().source !== 'live') return;

    const results: [DocName, Settled<unknown> | null][] = [
      ['snapshot', snapshot],
      ['meta', meta],
      ['demoState', demo],
      ['prices', prices],
    ];
    let firstError: ApiErrorInfo | undefined;
    for (const [doc, result] of results) {
      if (!result) continue;
      setDocError(store, doc, result.ok ? undefined : result.error);
      if (!result.ok && !firstError) firstError = result.error;
    }

    store.setState((s) => {
      const patch: Partial<typeof s> = {};
      if (snapshot?.ok && !isSameSnapshot(s.snapshot, snapshot.value)) patch.snapshot = snapshot.value;
      if (meta?.ok && !isSameJson(s.meta, meta.value)) patch.meta = meta.value;
      if (demo?.ok && !isSameJson(s.demoState, demo.value)) patch.demoState = demo.value;
      // Fill a gap, or adopt a document another tab saved since (strictly newer `updatedAt`). A read that left
      // before this tab's own save returns the older document (or none) and never replaces it.
      if (prices?.ok && prices.value !== null && (s.prices === null || isNewerDoc(prices.value, s.prices))) patch.prices = prices.value;
      return patch;
    });

    const rateLimited = results.some(([, r]) => r !== null && !r.ok && r.error.kind === 'rate-limited');
    const current = store.getState().status.live;
    // "Last good data" needs data (P1-D02): a read that found no snapshot is not good data to fall back on.
    const hasSnapshot = store.getState().snapshot !== null;
    // Meta read fine and the snapshot on screen is the one it describes (read now, or unchanged since).
    const docsCurrent = meta?.ok === true && (snapshot === null || snapshot.ok);
    patchLive(store, {
      lastPollAt: t,
      lastOkAt: docsCurrent && hasSnapshot ? t : current.lastOkAt,
      lastError: firstError,
      ...(docsCurrent ? { docsAt: t } : {}),
      ...(demo ? { demoReadAt: t } : {}),
      ...(prices ? { pricesReadAt: t } : {}),
      // Enter backoff on a 429; don't extend an active window on every poll inside it.
      backoffUntil: rateLimited
        ? current.backoffUntil !== undefined && current.backoffUntil > t
          ? current.backoffUntil
          : t + BACKOFF_WINDOW_MS
        : current.backoffUntil !== undefined && current.backoffUntil > t
          ? current.backoffUntil
          : undefined,
    });
  };

  const pollNow = (opts?: PollOptions): Promise<void> => {
    if (inFlight) return inFlight;
    clearTimer();
    inFlight = poll(opts ?? { docs: true })
      .catch((error: unknown) => {
        // poll() settles every read itself; this only catches a bug, which must not stop live mode.
        patchLive(store, { lastError: classifyError(error, now()) });
      })
      .finally(() => {
        inFlight = null;
        schedule();
      });
    return inFlight;
  };

  const onVisibility = () => {
    if (!running) return;
    if (visibility && !visibility.hidden) void pollNow();
    else schedule();
  };

  return {
    start() {
      if (running) return;
      running = true;
      visibility?.addEventListener('visibilitychange', onVisibility);
      // Re-plan when anything that changes the cadence changes; poll at once when live data returns.
      let prev = store.getState();
      unsubscribe = store.subscribe(() => {
        const next = store.getState();
        const cadenceChanged =
          next.presenter !== prev.presenter ||
          next.settings.live.pollSeconds !== prev.settings.live.pollSeconds ||
          next.settings.live.presenterPollSeconds !== prev.settings.live.presenterPollSeconds;
        const backToLive = prev.source !== 'live' && next.source === 'live';
        prev = next;
        if (backToLive) void pollNow();
        else if (cadenceChanged && !inFlight) schedule();
      });
      schedule();
    },
    stop() {
      running = false;
      clearTimer();
      visibility?.removeEventListener('visibilitychange', onVisibility);
      unsubscribe?.();
      unsubscribe = null;
      patchLive(store, { phase: 'stopped', nextPollAt: undefined });
    },
    pollNow,
  };
}
