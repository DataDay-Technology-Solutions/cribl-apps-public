// src/state/rangeReader.ts — reads the rollup documents behind a custom range and sums them (core/range.ts).
//
//   plan     resolveRange → planRangeReads with the sweep's cursor (meta.meteredThrough): the window's own
//            family at the ragged edges and the next coarser one over every whole bucket the sweep has folded
//            (api-budget F2) — 24 h reads ≤ 4 documents instead of 25, 30 days ≤ 4 instead of 31, the same money.
//            A coarse bucket with no row at all is re-read from the finer family (refineRangePlan). Without a
//            cursor the plan is the single-family one (≤ 26 / 33 / 14 documents).
//   fetch    at most 4 reads in flight; the first failure, a 429 or an abort stops the queue (no read is started
//            for a plan that has already failed or been superseded). Cached for the life of the tab: a bucket
//            whose end passed more than IMMUTABLE_AFTER_MS ago by the clock AND by the sweep's cursor (the sweep's
//            late-minute rewrite and the fold it re-runs touch a bucket only in the sweep after it ends, so a tab
//            whose runner lags never caches a bucket before that sweep has run), and — while the sweep's cursor
//            stays inside one fold epoch — the
//            day's hour document and the month's day document, which change only when an hour folds (the
//            first two sweeps after each hour boundary). The current hour's minute document is re-read every
//            time. A catch-up (the tab's first sweep backfilling up to 24 h, the runner after downtime) rewrites
//            past buckets too: it shows as `meta.meteredThrough` jumping by more than a sweep's worth, and the
//            cache is dropped when it does. Never browser storage.
//   429      the Leader allows the App ~50 API calls a minute. A 429 stops the plan and holds every range read
//            for RATE_LIMIT_BACKOFF_MS (doubling on each consecutive 429, up to RATE_LIMIT_BACKOFF_MAX_MS): a
//            read inside that window answers `rate-limited` with the time to try again, without a single GET.
//            The view keeps the last figures on screen and retries at that time (useRange.ts).
//   sum      core sumRangePlan over the plan: rows are already priced; nothing is re-priced here. A range lying
//            in the future reads nothing and sums to zero.

import {
  docBucketEndMs,
  docFamily,
  emptyRangeFigures,
  planRangeReads,
  refineRangePlan,
  resolveRange,
  sumRangePlan,
  type RangeDoc,
  type RangeFigures,
  type RangeGranularity,
  type RangeSpec,
  type ResolvedRange,
} from '../../core/range.ts';
import { MINUTE_MS, hourFloor } from '../../core/time.ts';
import type { RollupDocs } from './ports.ts';
import { classifyError, type ApiErrorInfo } from './store.ts';

/** A bucket is treated as still in flight for this long after it ends. */
export const IMMUTABLE_AFTER_MS = 2 * MINUTE_MS;
/** `meteredThrough` moving by more than this between reads means a catch-up rewrote past buckets. */
export const CATCH_UP_JUMP_MS = IMMUTABLE_AFTER_MS + MINUTE_MS;
/** How long range reads hold off after a 429; doubles on each consecutive one, up to the max. */
export const RATE_LIMIT_BACKOFF_MS = 30_000;
export const RATE_LIMIT_BACKOFF_MAX_MS = 5 * 60_000;

export interface RangeReadOk {
  ok: true;
  spec: RangeSpec;
  resolved: ResolvedRange;
  figures: RangeFigures;
  /** Documents the plan asked for (before any cap, after any refinement). */
  planned: number;
  /** Reads answered from the tab's cache. */
  cached: number;
}
export type RangeReadFailure =
  | { ok: false; reason: 'not-live' | 'not-hydrated' | 'unavailable' }
  | { ok: false; reason: 'error'; error: ApiErrorInfo }
  /** The Leader answered 429 (now or within the backoff window): nothing more is read until `retryAtMs`. */
  | { ok: false; reason: 'rate-limited'; error: ApiErrorInfo; retryAtMs: number }
  /** The caller's signal aborted the read (a newer range, or the view went away); nothing further was fetched. */
  | { ok: false; reason: 'aborted' };
export type RangeReadResult = RangeReadOk | RangeReadFailure;

export interface RangeReaderDeps {
  rollups: RollupDocs;
  now: () => number;
  /** Parallel document reads. Default 4. */
  concurrency?: number;
  /**
   * meta.minuteRetentionHours (r1 core-7 / M11): on a large estate the sweep keeps minute documents for fewer than 25 h,
   * and the plan reads the minute family only within it (core/range.ts, r2 core-11 b; wired here by r3 ui-5, H9).
   * Read at each read, so a retention the sweep changes applies to the next one. Undefined: the default reach.
   */
  minuteRetentionHours?: () => number | undefined;
}

export interface RangeReader {
  /**
   * Reads and sums `spec`. `collectingSinceMs` clips the start; `meteredThroughMs` (meta.meteredThrough, the
   * sweep's cursor) lets the plan read folded hours and days from their coarse documents, and tells a catch-up
   * from a normal sweep, so cached history is dropped after a backfill. `signal` stops the queue when aborted.
   */
  read(spec: RangeSpec, collectingSinceMs?: number, meteredThroughMs?: number, signal?: AbortSignal): Promise<Exclude<RangeReadResult, { reason: 'not-live' | 'not-hydrated' | 'unavailable' }>>;
  /** Cached documents held right now. */
  cacheSize(): number;
  clearCache(): void;
}

interface CacheEntry {
  doc: RangeDoc | null;
  /** The bucket had ended (plus the in-flight margin) when it was read: it never changes again. */
  immutable: boolean;
  /** For a coarse document still being folded into: the fold epoch it was read in. */
  epoch?: number;
}

/**
 * The fold epoch of a sweep cursor: the hour boundary the last fold happened at, once the rewrite sweep after
 * it (which re-folds that hour with its late last minute) is also behind it. Hour and day documents change only
 * when an hour folds, so one read inside an epoch holds for the whole epoch. Undefined right after a boundary.
 */
export function foldEpoch(meteredThroughMs: number | undefined): number | undefined {
  if (meteredThroughMs === undefined || !Number.isFinite(meteredThroughMs)) return undefined;
  const boundary = hourFloor(meteredThroughMs);
  return meteredThroughMs - boundary >= IMMUTABLE_AFTER_MS ? boundary : undefined;
}

class Aborted extends Error {}

/**
 * Runs `fn` over `items` with at most `limit` in flight. The first rejection (or `signal` aborting) stops the
 * queue: no further item is started, the calls already in flight settle, and the result rejects with it.
 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !failure) {
      if (signal?.aborted) {
        failure ??= { error: new Aborted('aborted') };
        break;
      }
      const i = next++;
      try {
        out[i] = await fn(items[i]);
      } catch (error) {
        failure ??= { error };
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure.error;
  if (signal?.aborted) throw new Aborted('aborted');
  return out;
}

export function createRangeReader(deps: RangeReaderDeps): RangeReader {
  const concurrency = deps.concurrency ?? 4;
  const cache = new Map<string, CacheEntry>();
  /** The sweep cursor at the last read, to notice a catch-up. */
  let lastMeteredThrough: number | undefined;
  /** No range read before this instant (a 429 was answered); `strikes` consecutive 429s so far. */
  let backoffUntil = 0;
  let strikes = 0;
  let lastRateLimit: ApiErrorInfo | undefined;

  const noteCursor = (meteredThroughMs: number | undefined): void => {
    if (meteredThroughMs === undefined || !Number.isFinite(meteredThroughMs)) return;
    if (lastMeteredThrough !== undefined && (meteredThroughMs - lastMeteredThrough > CATCH_UP_JUMP_MS || meteredThroughMs < lastMeteredThrough)) cache.clear();
    lastMeteredThrough = meteredThroughMs;
  };

  /**
   * The bucket has ended and the sweep has moved IMMUTABLE_AFTER_MS past it (its late-minute rewrite and the fold
   * it re-runs are behind it): by the clock, and by the sweep's cursor when there is one, since a lagging runner
   * writes a bucket well after the clock says it ended.
   */
  const isImmutable = (key: string, nowMs: number, cursorMs: number | undefined): boolean => {
    const end = docBucketEndMs(key);
    if (end === undefined || end + IMMUTABLE_AFTER_MS > nowMs) return false;
    return cursorMs === undefined || !Number.isFinite(cursorMs) || end + IMMUTABLE_AFTER_MS <= cursorMs;
  };

  const fetchDoc = (family: RangeGranularity, key: string): Promise<RangeDoc | null> => {
    switch (family) {
      case 'minute':
        return deps.rollups.readMinute(key);
      case 'hour':
        return deps.rollups.readHour(key);
      default:
        return deps.rollups.readDay(key);
    }
  };

  /**
   * Reads `keys` into `docs` (cache first) and returns the cache hits. Each document is cached as it lands, so
   * the reads a failed or superseded plan did complete still serve the next one. Rejects on the first failure
   * or an abort.
   */
  const load = async (
    keys: readonly string[],
    docs: Record<string, RangeDoc | null>,
    nowMs: number,
    cursorMs: number | undefined,
    epoch: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<number> => {
    let cached = 0;
    const toFetch: string[] = [];
    for (const key of keys) {
      if (key in docs) continue;
      const hit = cache.get(key);
      if (hit && (hit.immutable || (hit.epoch !== undefined && hit.epoch === epoch))) {
        docs[key] = hit.doc;
        cached++;
      } else toFetch.push(key);
    }
    await mapLimit(
      toFetch,
      concurrency,
      async (key) => {
        const doc = await fetchDoc(docFamily(key) ?? 'minute', key);
        docs[key] = doc;
        if (isImmutable(key, nowMs, cursorMs)) cache.set(key, { doc, immutable: true });
        else if (epoch !== undefined && docFamily(key) !== 'minute') cache.set(key, { doc, immutable: false, epoch });
        else cache.delete(key);
      },
      signal,
    );
    return cached;
  };

  const rateLimited = (error: ApiErrorInfo): { ok: false; reason: 'rate-limited'; error: ApiErrorInfo; retryAtMs: number } => ({
    ok: false,
    reason: 'rate-limited',
    error,
    retryAtMs: backoffUntil,
  });

  return {
    async read(spec, collectingSinceMs, meteredThroughMs, signal) {
      const nowMs = deps.now();
      if (signal?.aborted) return { ok: false, reason: 'aborted' };
      noteCursor(meteredThroughMs);
      const resolved = resolveRange(spec, nowMs, collectingSinceMs);
      if (resolved.future) return { ok: true, spec, resolved, figures: emptyRangeFigures(resolved.fromMs, resolved.toMs), planned: 0, cached: 0 };
      // Inside a 429's backoff nothing is read at all: another GET now would only extend the limit.
      if (nowMs < backoffUntil && lastRateLimit) return rateLimited(lastRateLimit);

      const retention = deps.minuteRetentionHours?.();
      let plan = planRangeReads(resolved.fromMs, resolved.toMs, nowMs, meteredThroughMs, retention !== undefined ? { minuteRetentionHours: retention } : {});
      const epoch = foldEpoch(meteredThroughMs);
      const docs: Record<string, RangeDoc | null> = {};
      let cached = 0;
      try {
        cached += await load(plan.keys, docs, nowMs, meteredThroughMs, epoch, signal);
        const refined = refineRangePlan(plan, docs);
        if (refined) {
          plan = refined;
          cached += await load(plan.keys, docs, nowMs, meteredThroughMs, epoch, signal);
        }
      } catch (error) {
        if (error instanceof Aborted) return { ok: false, reason: 'aborted' };
        const info = classifyError(error, deps.now());
        if (info.kind === 'rate-limited') {
          strikes++;
          backoffUntil = deps.now() + Math.min(RATE_LIMIT_BACKOFF_MAX_MS, RATE_LIMIT_BACKOFF_MS * 2 ** (strikes - 1));
          lastRateLimit = info;
          return rateLimited(info);
        }
        return { ok: false, reason: 'error', error: info };
      }
      strikes = 0;
      lastRateLimit = undefined;
      const figures = sumRangePlan(docs, plan);
      return { ok: true, spec, resolved, figures, planned: plan.keys.length + (plan.truncated ? 1 : 0), cached };
    },
    cacheSize: () => cache.size,
    clearCache() {
      cache.clear();
      lastMeteredThrough = undefined;
    },
  };
}
