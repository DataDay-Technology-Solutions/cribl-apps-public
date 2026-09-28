// src/state/meterLoop.ts — the 'ui' RUNTIME (PRD 2.6, DECISIONS D11/D12b).
//
// On orgs without App backend compute, the open tab is the meter: when `settings.runtime === 'ui'`, the
// data on screen is live (not a tour or replay), settings are hydrated AND a prices document exists
// (REVIEW-3a #3: without prices a sweep would meter the 60-minute seed at $0 for good), this loop runs
// core `runSweep()` every 30 s as the member. `runSweep` holds the KV lock itself, so two open tabs never
// double-count, and backfills minutes missed while no tab was open. The moment prices are saved (in this
// tab, or read by live polling after another tab saved them) the first sweep runs at once, and its seed
// hour is priced at the first price (D25).
//
// Budget (P1-D05): the tab yields to a runner that swept in the last 90 s (meterBlocker 'runner'), answers
// the sweep's cheap check from the `meta` it already holds (no Leader call until a new minute settles), and
// re-reads documents only after a sweep that ran and did not hand them back.
//
// Failures (P0-07): every sweep this tab runs updates a failure streak in `status.sweep` (failures,
// failingSince, lastFailure); `meteringFailure` (selectors.ts) turns it into the chip, the footer and the
// Receipt's notice. `nextAt` is when the next timed sweep is due, for "Next sweep in 0:42".
//
// "Sweep now" (SPEC 7): client-throttled to once per 30 s. In the 'ui' runtime it runs the same local
// sweep with mode 'manual' (refused until prices exist, for the same reason); in the 'backend' runtime it
// POSTs `/endpoints/meter` once — the only place the UI ever calls that endpoint, and never from a timer.
//
// Weekly receipt (SPEC 11, D12b): after each timed sweep, when this open tab has crossed Monday 12:00 UTC
// (core/weekly `shouldAutoSendWeekly`), it sends last week's receipt once — skipped while the runner is
// metering (it swept within 90 s), which owns the Monday send then. "Send this week's receipt" in
// Settings is `sendWeekly()`.

import { SETTLE_MS } from '../../core/sweep.ts';
import { minuteFloor } from '../../core/time.ts';
import { mondayNoonUtc, shouldAutoSendWeekly } from '../../core/weekly.ts';
import { toMs } from '../lib/format.ts';
import type { AppState, AppStore, RuntimeStatus, SweepSummary, WeeklyAttempt } from './store.ts';
import { patchLive, patchSweep, setDocError } from './store.ts';
import type { SweepEngine, Timers, WeeklyOutcome } from './ports.ts';
import { browserTimers } from './ports.ts';
import { isRunnerFresh, meterBlocker, pricesAbsent, runnerSweepAt, type MeterBlocker } from './selectors.ts';

export const UI_SWEEP_INTERVAL_MS = 30_000;
export const MANUAL_THROTTLE_MS = 30_000;
/** Give hydration's first paint a moment before the first sweep competes for the Leader. */
export const FIRST_SWEEP_DELAY_MS = 3_000;

/** Whether this tab should be metering right now (see `meterBlocker` for the reasons it may not). */
export function shouldMeter(state: AppState, nowMs: number = Date.now()): boolean {
  return meterBlocker(state, nowMs) === null;
}

/**
 * The sweep's cheap check, answered from the `meta` this tab already holds (P1-D05): when the last completed
 * minute is metered, a 'ui' sweep would only read `meta` to learn that. `meteredThrough` only moves forward,
 * so a copy that is behind can only send a sweep that finds nothing to do — never skip a minute that needs one.
 */
export function minuteIsCurrent(state: AppState, nowMs: number): boolean {
  if (state.source !== 'live') return false;
  const through = toMs(state.meta?.meteredThrough);
  return Number.isFinite(through) && through >= minuteFloor(nowMs - SETTLE_MS);
}

/** A sweep that failed or was stopped (an error, a 429, a budget stop); skips for the lock or a current minute are not. */
export function isFailedSweep(summary: SweepSummary): boolean {
  return !summary.ok || summary.error !== undefined;
}

export type SweepNowResult =
  | { status: 'done'; summary: SweepSummary }
  | { status: 'throttled'; retryInMs: number }
  | { status: 'busy' }
  | { status: 'blocked'; reason: 'not-hydrated' | 'not-live' | 'no-prices' };

export type WeeklySendResult =
  | { status: 'done'; outcome: WeeklyOutcome }
  | { status: 'busy' }
  | { status: 'blocked'; reason: 'not-hydrated' | 'not-live' | 'unavailable' };

export interface MeterDeps {
  store: AppStore;
  engine: SweepEngine;
  /** Re-read snapshot + meta after a sweep that did not hand them back. */
  refresh?: () => Promise<void>;
  timers?: Timers;
  now?: () => number;
  intervalMs?: number;
  manualThrottleMs?: number;
  firstDelayMs?: number;
}

export interface MeterController {
  start(): void;
  stop(): void;
  sweepNow(): Promise<SweepNowResult>;
  /** ms until Sweep now is allowed again (0 = now). */
  manualRetryInMs(): number;
  /** "Send this week's receipt" (Settings → Where to send alerts): the seven days before today, every press. */
  sendWeekly(): Promise<WeeklySendResult>;
}

function weeklyFailure(error: unknown): WeeklyOutcome {
  return { sent: 0, endpoints: 0, deliveries: [], calls: 0, error: error instanceof Error ? error.message : String(error) };
}

export function createMeterLoop(deps: MeterDeps): MeterController {
  const { store, engine } = deps;
  const timers = deps.timers ?? browserTimers;
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? UI_SWEEP_INTERVAL_MS;
  const throttleMs = deps.manualThrottleMs ?? MANUAL_THROTTLE_MS;
  const firstDelayMs = deps.firstDelayMs ?? FIRST_SWEEP_DELAY_MS;

  let started = false;
  let metering = false;
  /** Why the loop was not metering at the last evaluation ('stopped' before start / after stop). */
  let lastBlocker: MeterBlocker | 'stopped' | null = 'stopped';
  let handle: unknown;
  let inFlight: Promise<SweepSummary> | null = null;
  let weeklyInFlight: Promise<WeeklyOutcome> | null = null;
  /** `mondayNoonUtc` of the week whose automatic receipt this tab already handled. */
  let weeklyHandledFor: number | undefined;
  let unsubscribe: (() => void) | null = null;

  const clearTimer = () => {
    if (handle !== undefined) timers.clearTimeout(handle);
    handle = undefined;
  };

  const scheduleNext = (delay: number) => {
    clearTimer();
    if (!metering) return;
    const wait = Math.max(0, delay);
    patchSweep(store, { nextAt: now() + wait });
    handle = timers.setTimeout(() => {
      handle = undefined;
      void tick();
    }, wait);
  };

  /** The failure streak after one of this tab's own sweeps (P0-07); a lock refusal leaves it as it is. */
  const streakAfter = (sweep: RuntimeStatus['sweep'], summary: SweepSummary, finishedAt: number): Partial<RuntimeStatus['sweep']> => {
    if (isFailedSweep(summary)) {
      const failures = (sweep.failures ?? 0) + 1;
      return {
        failures,
        failingSince: failures === 1 || sweep.failingSince === undefined ? finishedAt : sweep.failingSince,
        lastFailure: { code: summary.error ?? summary.skipped ?? 'unknown', ...(summary.status !== undefined ? { status: summary.status } : {}), at: finishedAt },
      };
    }
    if (summary.skipped === 'locked') return {};
    return { failures: 0, failingSince: undefined, lastFailure: undefined };
  };

  const applySummary = async (summary: SweepSummary, local: boolean) => {
    const finishedAt = now();
    const sweep = store.getState().status.sweep;
    patchSweep(store, { running: false, lastRunAt: finishedAt, lastResult: summary, ...(local ? streakAfter(sweep, summary, finishedAt) : {}) });
    // Only live data may be replaced; a tour that started mid-sweep keeps the screen.
    if (store.getState().source === 'live' && (summary.snapshot || summary.meta)) {
      store.setState({
        ...(summary.snapshot ? { snapshot: summary.snapshot } : {}),
        ...(summary.meta ? { meta: summary.meta } : {}),
      });
      // A sweep that read and wrote them proves they are readable again.
      if (summary.snapshot) setDocError(store, 'snapshot', undefined);
      if (summary.meta) setDocError(store, 'meta', undefined);
      // Both documents are as new as they get: the next poll need not read them again (P1-D05).
      if (summary.snapshot && summary.meta) patchLive(store, { docsAt: finishedAt });
    }
    // Re-read only after a sweep that ran and wrote documents it did not hand back. A skipped sweep ('current',
    // 'locked', 'no_prices') or a failed one changed no snapshot; the regular poll reads what another meter wrote.
    const ran = !summary.skipped && !isFailedSweep(summary);
    if (ran && !(summary.snapshot && summary.meta) && deps.refresh) await deps.refresh().catch(() => undefined);
  };

  const run = (mode: 'ui' | 'manual', invoke: () => Promise<SweepSummary>, local = true): Promise<SweepSummary> => {
    if (inFlight) return inFlight;
    patchSweep(store, { running: true });
    inFlight = invoke()
      .catch((error: unknown): SweepSummary => ({
        ok: false,
        mode,
        error: error instanceof Error ? error.message : String(error),
      }))
      .then(async (summary) => {
        await applySummary(summary, local);
        return summary;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  /** Runs one weekly receipt and records it; coalesces with one already running. Never throws. */
  const runWeekly = (mode: 'manual' | 'ui'): Promise<WeeklyOutcome> => {
    if (weeklyInFlight) return weeklyInFlight;
    const send = engine.runWeekly;
    if (!send) return Promise.resolve(weeklyFailure('weekly receipt unavailable'));
    const runtime = store.getState().settings.runtime;
    weeklyInFlight = send(mode, runtime)
      .catch(weeklyFailure)
      .then(async (outcome) => {
        const attempt: WeeklyAttempt = { at: now(), mode, outcome };
        patchSweep(store, { lastWeekly: attempt });
        // An automatic send stamps meta.lastWeeklySentAt; read it back so the store agrees.
        if (mode === 'ui' && deps.refresh) await deps.refresh().catch(() => undefined);
        return outcome;
      })
      .finally(() => {
        weeklyInFlight = null;
      });
    return weeklyInFlight;
  };

  /** The Monday send (D12b): once per week per tab, only in the 'ui' runtime, never while the runner meters. */
  const maybeAutoWeekly = async () => {
    if (!engine.runWeekly) return;
    const state = store.getState();
    if (state.source !== 'live' || state.settings.runtime !== 'ui') return;
    const t = now();
    if (!shouldAutoSendWeekly(state.meta, t)) return;
    const week = mondayNoonUtc(t);
    if (weeklyHandledFor === week) return;
    if (isRunnerFresh(state.status.sweep.runnerSeenAt, t)) return;
    const outcome = await runWeekly('ui');
    // Another sweep held the lock, or the Leader said slow down: try again on a later tick. Anything else
    // (sent, nothing to send, already sent, an error) settles this week for this tab, so a workspace with
    // no weekly endpoints doesn't re-read four KV documents every 30 s all Monday.
    if (outcome.skipped === 'locked' || outcome.skipped === 'rate_limited') return;
    weeklyHandledFor = week;
  };

  const tick = async () => {
    if (!metering) return;
    const startedAt = now();
    // Nothing to meter until the next minute settles: no Leader call at all (P1-D05, the cheap check without its GET).
    if (!minuteIsCurrent(store.getState(), startedAt)) await run('ui', () => engine.runLocal('ui'));
    // Sequential, after the sweep released the KV lock the automatic receipt also takes.
    if (metering) await maybeAutoWeekly().catch(() => undefined);
    // Keep a steady cadence measured from each sweep's start; a slow sweep doesn't stack the next.
    scheduleNext(intervalMs - (now() - startedAt));
  };

  /** Remembers the newest runner sweep seen in `meta`, so a runner stays "fresh" after a tab wins one minute. */
  const noteRunner = (state: AppState) => {
    const at = runnerSweepAt(state.meta);
    if (at === undefined) return;
    const seen = state.status.sweep.runnerSeenAt;
    if (seen !== undefined && seen >= at) return;
    patchSweep(store, { runnerSeenAt: at });
  };

  const evaluate = () => {
    const state = store.getState();
    if (started) noteRunner(state);
    const t = now();
    const blocker = started ? meterBlocker(store.getState(), t) : 'stopped';
    const previous = lastBlocker;
    lastBlocker = blocker;
    const should = blocker === null;
    if (should === metering) return;
    metering = should;
    patchSweep(store, should ? { metering: true, meteringSince: t } : { metering: false, meteringSince: undefined, nextAt: undefined });
    if (!should) {
      clearTimer();
      return;
    }
    // Prices just arrived (Save changes here, or another tab's save read by live polling), or the runner went
    // quiet: the first paint is long done and nobody is metering — sweep now, not in 3 s.
    scheduleNext(previous === 'no-prices' || previous === 'runner' ? 0 : firstDelayMs);
  };

  return {
    start() {
      if (started) return;
      started = true;
      if (engine.ownerId && store.getState().status.sweep.ownerId !== engine.ownerId) patchSweep(store, { ownerId: engine.ownerId });
      unsubscribe = store.subscribe(evaluate);
      evaluate();
    },
    stop() {
      started = false;
      unsubscribe?.();
      unsubscribe = null;
      evaluate();
    },
    manualRetryInMs() {
      return Math.max(0, store.getState().status.sweep.nextManualAt - now());
    },
    async sweepNow() {
      const state = store.getState();
      if (!state.hasHydrated) return { status: 'blocked', reason: 'not-hydrated' };
      if (state.source !== 'live') return { status: 'blocked', reason: 'not-live' };
      // A local sweep without prices would meter the seed hour at $0 for good (REVIEW-3a #3).
      if (state.settings.runtime === 'ui' && pricesAbsent(state)) return { status: 'blocked', reason: 'no-prices' };
      const retryInMs = Math.max(0, state.status.sweep.nextManualAt - now());
      if (retryInMs > 0) return { status: 'throttled', retryInMs };
      if (inFlight) return { status: 'busy' };

      patchSweep(store, { nextManualAt: now() + throttleMs });
      if (state.settings.runtime === 'ui') {
        clearTimer();
        const summary = await run('manual', () => engine.runLocal('manual'));
        scheduleNext(intervalMs); // the manual sweep counts as this cycle's sweep
        return { status: 'done', summary };
      }
      // The backend's own schedule meters; one manual call failing says nothing about it (no failure streak).
      const summary = await run('manual', () => engine.invokeBackend(), false);
      return { status: 'done', summary };
    },
    async sendWeekly() {
      const state = store.getState();
      if (!state.hasHydrated) return { status: 'blocked', reason: 'not-hydrated' };
      if (state.source !== 'live') return { status: 'blocked', reason: 'not-live' };
      if (!engine.runWeekly) return { status: 'blocked', reason: 'unavailable' };
      if (weeklyInFlight) return { status: 'busy' };
      return { status: 'done', outcome: await runWeekly('manual') };
    },
  };
}
