// src/components/Shell/status.ts — derives the one data-status the chrome shows (live dot + caption), and the
// words for why metering is not running.
//
// Truthfulness (EPIC_AUDIT P0-07, P1-D01, P1-D02, P1-D03): the chip never says "Live" over sweeps that fail,
// "Waiting for the first sweep" when nothing can sweep (no prices) or when every read failed, or "Live" after
// the session expired; "updated N s ago" is only ever the age of figures actually on screen.

import type { Settings } from '../../../core/types.ts';
import { t, type CopyKey } from '../../copy/en.ts';
import type { AppState } from '../../state/store.ts';
import {
  classifySweepError,
  meteringFailure,
  pricesAbsent,
  STALE_AFTER_MS,
  type MeteredBy,
  type MeteringFailure,
  type SweepErrorInfo,
  type SweepErrorKind,
} from '../../state/selectors.ts';
import { formatClock, toMs } from '../../lib/format.ts';

export { classifySweepError, STALE_AFTER_MS, type SweepErrorInfo, type SweepErrorKind };

export type DataStatus =
  | 'connecting'
  | 'waiting'
  | 'live'
  | 'stale'
  | 'rate-limited'
  | 'offline'
  | 'sample'
  | 'replay'
  /** sweeps are failing (P0-07): "Not metering since 2:14 PM" */
  | 'failing'
  /** nothing can meter: no prices document yet (P1-D01) */
  | 'not-metering'
  /** a 401: the Cribl session expired (P1-D01) */
  | 'signed-out'
  /** a 403 on the App's own documents: this role can't read them (P1-D01) */
  | 'no-access';

/**
 * When the figures on screen were produced: the sweep that wrote the snapshot. Without a snapshot there are no
 * figures, so no age (P1-D02: "updated 4 s ago" over a $-- ghost claimed data that never loaded).
 */
export function dataUpdatedAt(state: AppState): number | undefined {
  if (!state.snapshot) return undefined;
  const sweepAt = toMs(state.snapshot.sweepAt ?? state.meta?.lastSweepAt);
  if (Number.isFinite(sweepAt)) return sweepAt;
  return state.status.live.lastOkAt;
}

/** The App's own documents: a 403 on one of these means the page can't show anything real. */
const CORE_DOCS = ['settings', 'snapshot', 'meta'] as const;

export function deriveDataStatus(state: AppState, now: number): DataStatus {
  if (state.source === 'sample') return 'sample';
  if (state.source === 'replay') return 'replay';
  const { live, hydrate } = state.status;
  if (hydrate.phase === 'idle' || hydrate.phase === 'loading') return 'connecting';
  const coreErrors = CORE_DOCS.map((doc) => state.errors[doc]);
  const failure = meteringFailure(state, now);
  // A 401 anywhere — a read, or this tab's own sweep — is an expired session, not a metering fault.
  if (live.lastError?.kind === 'unauthorized' || coreErrors.some((e) => e?.kind === 'unauthorized') || (failure?.kind === 'unauthorized' && failure.source === 'this-tab')) {
    return 'signed-out';
  }
  if (coreErrors.some((e) => e?.kind === 'forbidden')) return 'no-access';
  if (
    (live.backoffUntil !== undefined && live.backoffUntil > now) ||
    live.lastError?.kind === 'rate-limited' ||
    failure?.kind === 'rate-limited'
  ) {
    return 'rate-limited';
  }
  if (live.lastError && (live.lastError.kind === 'server' || live.lastError.kind === 'network' || live.lastError.kind === 'unknown')) {
    return 'offline';
  }
  if (failure) return 'failing';
  // Nothing sweeps without a prices document (D33): not "waiting" for a sweep that cannot come.
  if (state.hasHydrated && pricesAbsent(state)) return 'not-metering';
  const updated = dataUpdatedAt(state);
  // Hydrated, readable, priced, but no sweep has written a snapshot yet (fresh install, first minute).
  if (updated === undefined || !state.snapshot) return 'waiting';
  return now - updated > STALE_AFTER_MS ? 'stale' : 'live';
}

// ─── Why metering fails, in words (P0-07) ─────────────────────────────────────

const FAILURE_COPY: Record<Exclude<SweepErrorKind, 'metrics-forbidden' | 'server'>, CopyKey> = {
  forbidden: 'sweep.failure.forbidden',
  unauthorized: 'sweep.failure.unauthorized',
  'rate-limited': 'sweep.failure.rateLimited',
  budget: 'sweep.failure.budget',
  'time-budget': 'sweep.failure.timeBudget',
  storage: 'sweep.failure.storage',
  network: 'sweep.failure.network',
  unknown: 'sweep.failure.unknown',
};

export interface SweepErrorTextOptions {
  /** worker groups the metrics query covers, for "Couldn't read metrics for default" */
  groups?: readonly string[];
  /** seconds until this tab's next sweep: rate limiting then reads "Next sweep in 0:42." (DESIGN_BRIEF 6) */
  nextSweepInS?: number;
  /**
   * The sweeps' rate-limit back-off (P1-E01), as display times: since when, and until when no sweep calls Cribl. While
   * it runs, a countdown to the next tick would point at a sweep that skips, so the sentence names the resume time.
   */
  backoff?: { since: string; until: string };
}

/** One human sentence for a failed sweep, whoever ran it. Never the raw code (`rate_limited`, a JSON body). */
export function sweepErrorText(info: SweepErrorInfo, opts: SweepErrorTextOptions = {}): string {
  const countdown = opts.nextSweepInS !== undefined && Number.isFinite(opts.nextSweepInS) ? formatClock(Math.max(0, Math.ceil(opts.nextSweepInS))) : undefined;
  switch (info.kind) {
    case 'metrics-forbidden': {
      const groups = (opts.groups ?? []).filter((g) => g.trim() !== '');
      return groups.length > 0 ? t('errors.metricsForbidden', { group: groups.join(', ') }) : t('sweep.failure.metricsForbiddenGeneric');
    }
    case 'rate-limited':
      if (opts.backoff) return t('sweep.rateLimitedBackoff', { since: opts.backoff.since, time: opts.backoff.until });
      return countdown !== undefined ? t('sweep.rateLimited', { countdown }) : t('sweep.failure.rateLimited');
    case 'server':
      return info.status ? t('sweep.failure.server', { status: String(info.status) }) : t('sweep.failure.serverNoStatus');
    default:
      return t(FAILURE_COPY[info.kind]);
  }
}

/**
 * The sweeps' rate-limit back-off still running at `nowMs` (P1-E01: meta.rateLimitedUntil in the future), as epoch
 * ms, with since when (meta.rateLimitedSince, else `fallbackSince`). Undefined when none runs.
 */
export function meteringBackoff(meta: AppState['meta'], nowMs: number, fallbackSince?: number): { sinceMs: number; untilMs: number } | undefined {
  const untilMs = toMs(meta?.rateLimitedUntil);
  if (!Number.isFinite(untilMs) || !(untilMs > nowMs)) return undefined;
  const since = toMs(meta?.rateLimitedSince);
  const sinceMs = Number.isFinite(since) ? since : (fallbackSince ?? nowMs);
  return { sinceMs, untilMs };
}

/** `sweepErrorText` for a raw sweep error code (Settings → Runtime, the Sweep now result line). */
export function sweepErrorCodeText(code: string | undefined, status?: number, opts: SweepErrorTextOptions = {}): string {
  return sweepErrorText(classifySweepError(code, status), opts);
}

export type { MeteringFailure };

// ─── Who meters (Footer, Settings → Runtime) ──────────────────────────────────

/**
 * The footer's "who meters" line. `host` only for the runner when its owner id carries one; `ago` ("20 min
 * ago") for a meter that went quiet.
 */
export function meteredByLine(by: MeteredBy, runtime: Settings['runtime'], host?: string, ago?: string): string {
  switch (by) {
    case 'runner':
      return host ? t('footer.runtimeRunnerHost', { host }) : t('footer.runtimeRunner');
    case 'runner-silent':
      return host ? t('footer.runtimeRunnerSilentHost', { host, ago: ago ?? '' }).trim() : t('footer.runtimeRunnerSilent', { ago: ago ?? '' }).trim();
    case 'this-tab':
      return t('footer.runtimeThisTab');
    case 'other-tab':
      return t('footer.runtimeOtherTab');
    case 'backend':
      return t('footer.runtimeScheduledBackend');
    case 'backend-silent':
      return t('footer.runtimeBackendSilent', { ago: ago ?? '' }).trim();
    case 'no-prices':
      return t('footer.runtimeNoPrices');
    case 'unreadable':
      return t('footer.runtimeUnreadable');
    default:
      return runtime === 'ui' ? t('footer.runtimeUi') : t('footer.runtimeBackend');
  }
}
