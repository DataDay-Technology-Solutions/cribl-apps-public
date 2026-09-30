// core/range.ts — a custom time range on the Receipt (relative or absolute): the URL form, its resolution
// against the clock and the collecting-since bound, the read plan over the rollup documents, and the sum.
//
// Rows arrive already priced (whpM / paidM / savedM in millicents, priced when metered), so a range is a
// SUM over rows, never a re-pricing. Granularity follows the documents' retention (core/rollups.ts):
//   minute  the whole range lies inside the last 24 h  → roll/min/YYYY-MM-DDTHH (UTC hour docs, 25 h kept), exact
//   hour    the whole range lies inside the last 31 d  → roll/hour/YYYY-MM-DD (UTC day docs, 32 d kept), whole hours
//   day     anything older                             → roll/day/YYYY-MM (UTC month docs, 13 months kept), whole UTC days
// A coarse family only holds COMPLETED buckets: the sweep folds an hour once it has ended (core/sweep.ts
// foldsFor) and a UTC day once its last hour folded, and never writes a partial row. So a window summed in
// whole hours stops at the last whole hour, and one summed in whole UTC days at the last whole UTC day: what
// the figures describe is exactly what the rows cover, never an hour or a day that has not been folded yet.
//
// The hybrid read plan (api-budget F2): the granularity above is the PRECISION of the window; which documents
// are read is a separate choice. The folds are exact sums (core/rollups.ts foldHourRows / foldDayRows), so a
// whole hour the sweep has folded reads the same from its HourRow as from its sixty MinuteRows, and a whole
// UTC day the same from its DayRow as from its HourRows. Knowing the sweep's cursor (meta.meteredThrough,
// written last, after every fold of that sweep), the plan reads the fine family only at the two ragged edges
// and the coarse family in between: 24 h drops from 25 minute documents to ≤ 4, 30 days from 31 hour
// documents to ≤ 4 (5 across a month end), with the same money to the millicent. A coarse bucket that turns
// out to have no row at all (a day the sweep never folded: an outage longer than its 24 h catch-up across
// the day's end) is re-read from the finer family (refineRangePlan), so a hole never reads as zero.
// Pure: no I/O, no DOM. The UI reads the documents through src/state (rangeReader.ts) and sums them here.

import { roundToDollarsM } from './format.ts';
import type { DayRow, FlowKey, HourRow, MinuteRow, RollDayDoc, RollHourDoc, RollMinuteDoc } from './types.ts';
import { parseFlowKey } from './flows.ts';
import { ratio } from './pricing.ts';
import { dayDocKey, hourDocKey, minuteDocKey } from './rollups.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, fromIso, hourCeil, hourFloor, minuteFloor, toIso, utcDayCeil, utcDayFloor } from './time.ts';

// ─── The spec and its URL form ───────────────────────────────────────────────

export type RangeSpec = { kind: 'relative'; hours: number } | { kind: 'absolute'; fromMs: number; toMs: number };

export type RelativePresetKey = '1h' | '6h' | '24h' | '7d' | '30d';

/** The quick picks, in display order. */
export const RELATIVE_PRESETS: readonly { key: RelativePresetKey; hours: number }[] = [
  { key: '1h', hours: 1 },
  { key: '6h', hours: 6 },
  { key: '24h', hours: 24 },
  { key: '7d', hours: 7 * 24 },
  { key: '30d', hours: 30 * 24 },
];

/** `2026-09-26T10:00Z..2026-09-26T14:00Z` — UTC, minute precision, exclusive end. */
const ABSOLUTE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z\.\.(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})Z$/;

/** Epoch ms of a 'YYYY-MM-DDTHH:mm' UTC stamp, or NaN when it is not a real calendar minute. */
function parseUtcMinute(stamp: string): number {
  const ms = Date.parse(`${stamp}:00.000Z`);
  if (!Number.isFinite(ms) || toIso(ms).slice(0, 16) !== stamp) return Number.NaN;
  return ms;
}

/** `?range=` → a spec: a preset key ('6h', '7d') or the absolute form; anything else is undefined. */
export function parseRangeParam(raw: string | null): RangeSpec | undefined {
  if (raw === null) return undefined;
  const preset = RELATIVE_PRESETS.find((p) => p.key === raw);
  if (preset) return { kind: 'relative', hours: preset.hours };
  const m = ABSOLUTE_RE.exec(raw);
  if (!m) return undefined;
  const fromMs = parseUtcMinute(m[1]);
  const toMs = parseUtcMinute(m[2]);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return undefined;
  return { kind: 'absolute', fromMs, toMs };
}

/** The `?range=` value of a spec; round-trips through parseRangeParam (absolute instants floor to the minute). */
export function formatRangeParam(spec: RangeSpec): string {
  if (spec.kind === 'relative') {
    const preset = RELATIVE_PRESETS.find((p) => p.hours === spec.hours);
    if (preset) return preset.key;
    return spec.hours % 24 === 0 ? `${spec.hours / 24}d` : `${spec.hours}h`;
  }
  const stamp = (ms: number) => `${toIso(minuteFloor(ms)).slice(0, 16)}Z`;
  return `${stamp(spec.fromMs)}..${stamp(spec.toMs)}`;
}

/** The preset a spec is, if it is one (the quick-pick group's selection). */
export function presetKeyOf(spec: RangeSpec | undefined): RelativePresetKey | undefined {
  if (!spec || spec.kind !== 'relative') return undefined;
  return RELATIVE_PRESETS.find((p) => p.hours === spec.hours)?.key;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

export interface ResolvedRange {
  fromMs: number;
  /** exclusive */
  toMs: number;
  /** The start was moved forward to when collecting began. */
  clippedStart: boolean;
  /** The end was moved back to the last whole minute (the range asked for the future). */
  clippedEnd: boolean;
  /** The start was moved forward to the oldest history kept (RETENTION_MONTHS of day rows). */
  clippedRetention: boolean;
  /** The whole range lies at or after the last whole minute: nothing can have been metered in it yet. */
  future: boolean;
}

/** Day documents are kept for this many months, the current one included (core/rollups.ts expiredKeys). */
export const RETENTION_MONTHS = 13;

/** The oldest instant any rollup family still holds: the first day of the oldest kept month document. */
export function retentionStartMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (RETENTION_MONTHS - 1), 1);
}

/**
 * The window a spec means right now: whole minutes, never past the last completed minute, never before
 * collecting began or before the history kept. A relative range ends at the last whole minute; an absolute
 * range keeps its own end unless that is in the future. A range lying entirely in the future keeps its own
 * window and is flagged `future` (nothing to read). When clipping leaves nothing (the range lies entirely
 * before collecting began), the window is the one minute ending at `to`, still flagged clippedStart —
 * from < to always holds.
 */
export function resolveRange(spec: RangeSpec, nowMs: number, collectingSinceMs?: number): ResolvedRange {
  const cap = minuteFloor(nowMs);
  const none = { clippedStart: false, clippedEnd: false, clippedRetention: false, future: false };
  let fromMs: number;
  let toMs: number;
  let clippedEnd = false;
  if (spec.kind === 'relative') {
    toMs = cap;
    fromMs = toMs - Math.max(1, spec.hours) * HOUR_MS;
  } else {
    toMs = minuteFloor(spec.toMs);
    fromMs = minuteFloor(spec.fromMs);
    if (toMs <= fromMs) toMs = fromMs + MINUTE_MS;
    if (fromMs >= cap) return { fromMs, toMs, ...none, future: true };
    if (toMs > cap) {
      toMs = cap;
      clippedEnd = true;
    }
  }
  // The window asked for, before it is clipped to the history (kept whole when none of it is metered: OQ-05).
  const requestedFromMs = fromMs;
  let clippedRetention = false;
  const kept = retentionStartMs(nowMs);
  if (fromMs < kept) {
    fromMs = kept;
    clippedRetention = true;
  }
  let clippedStart = false;
  if (collectingSinceMs !== undefined && Number.isFinite(collectingSinceMs)) {
    const since = minuteFloor(collectingSinceMs);
    if (fromMs < since) {
      fromMs = since;
      clippedStart = true;
    }
  }
  if (fromMs >= toMs) {
    // The range lies entirely before the history (or before collecting began): it stays the window asked for, and
    // its sum is nothing metered. (It used to become the one minute ending at `to`, which day snapping then widened
    // to a whole UTC day reaching past the requested end: a 30-day request read as 1 day outside it, OQ-05.)
    fromMs = requestedFromMs;
    if (!clippedRetention) clippedStart = true;
  }
  return { fromMs, toMs, ...none, clippedStart, clippedEnd, clippedRetention };
}

// ─── The read plan ───────────────────────────────────────────────────────────

export type RangeGranularity = 'minute' | 'hour' | 'day';

/** How far back each family reaches (its retention, less the bucket that may be expiring). */
export const MINUTE_REACH_MS = 24 * HOUR_MS;
export const HOUR_REACH_MS = 31 * DAY_MS;

/**
 * Founder-build r2 core-11 (b), r1's H8: the minute family's reach when the sweep keeps minute documents for fewer than
 * 25 hours (meta.minuteRetentionHours on a large estate, r1 core-7 / M11): that retention less the hour that may be
 * expiring, never under an hour. Unknown or the default 25 h: MINUTE_REACH_MS.
 */
export function minuteReachMs(minuteRetentionHours?: number): number {
  if (minuteRetentionHours === undefined || !Number.isFinite(minuteRetentionHours) || minuteRetentionHours >= 25) return MINUTE_REACH_MS;
  return Math.min(MINUTE_REACH_MS, Math.max(1, Math.floor(minuteRetentionHours) - 1) * HOUR_MS);
}

/** Options for a read plan. */
export interface RangePlanOptions {
  /** meta.minuteRetentionHours: the minute family is planned only within it (r2 core-11 b). */
  minuteRetentionHours?: number;
}

/** Documents one request may read (the Leader allows ~50 API calls a minute for the App). */
export const DOC_CAPS: Readonly<Record<RangeGranularity, number>> = { minute: 26, hour: 33, day: 14 };

/** One stretch of the window and the document family its rows are read from ([fromMs, toMs), whole buckets of that family at the inner edges). */
export interface RangeSegment {
  family: RangeGranularity;
  fromMs: number;
  toMs: number;
  /** The documents of `family` holding the stretch, oldest first. */
  keys: string[];
}

export interface RangePlan {
  /** The precision of the window: minute-exact, whole hours or whole UTC days (never changed by a hybrid read). */
  granularity: RangeGranularity;
  /** Every document to read, each once (`roll/min/2026-09-26T10`), in segment order; the KvDocs getters accept them as is. */
  keys: string[];
  /** The oldest documents were dropped to stay within DOC_CAPS (unreachable once resolveRange clipped to the retention). */
  truncated: boolean;
  /**
   * The window the rows are summed over — the requested one snapped to whole buckets and stopped at the last
   * completed bucket (the last whole hour / UTC day), and starting at the first kept document when truncated.
   * This is the window to hand to sumRange and to describe to the user.
   */
  window: { fromMs: number; toMs: number };
  /**
   * How the window is read, in time order, contiguous and disjoint: one segment of the window's own family, or
   * (a hybrid plan) the fine family at the edges and the coarse one between. sumRangePlan sums them.
   */
  segments: RangeSegment[];
}

function monthStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
function nextMonthStartMs(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** The last instant a family has a completed bucket for: the last whole minute, hour or UTC day before `nowMs`. */
export function granularityCapMs(granularity: RangeGranularity, nowMs: number): number {
  switch (granularity) {
    case 'hour':
      return hourFloor(nowMs);
    case 'day':
      return utcDayFloor(nowMs);
    default:
      return minuteFloor(nowMs);
  }
}

/**
 * Which documents hold [fromMs, toMs): minute docs when the whole range is inside the last 24 h, hour docs
 * inside the last 31 days, day docs otherwise. The reaches are measured from the last whole minute, the
 * same instant a relative range ends at, so "24 h" is minute-exact rather than 59 seconds too old for it.
 * The window is snapped outward to whole buckets, then stopped at the last completed bucket (a coarse family
 * never holds the bucket in progress); keys cover every bucket that window touches. A window that reaches
 * the hour family lies more than 24 h back, so its start is always before the last whole hour (and a day
 * window's start before the last whole UTC day): the summed window is never empty.
 *
 * `foldedThroughMs` is the sweep's cursor (meta.meteredThrough): every hour and UTC day that ended at or before
 * it has been folded. With it the plan may go hybrid (the file header): minute rows at the edges and hour rows
 * between, or hour rows at the edges and day rows between — the same window and the same money from far fewer
 * documents. It is chosen only when it reads fewer; without a cursor the plan is the single-family one.
 */
export function planRangeReads(fromMs: number, toMs: number, nowMs: number, foldedThroughMs?: number, opts: RangePlanOptions = {}): RangePlan {
  const granularity = granularityFor(fromMs, nowMs, opts.minuteRetentionHours);
  const snapped = snapRange(fromMs, toMs, granularity);
  const bucket = granularity === 'minute' ? MINUTE_MS : granularity === 'hour' ? HOUR_MS : DAY_MS;
  const window = { fromMs: snapped.fromMs, toMs: Math.max(snapped.fromMs + bucket, Math.min(snapped.toMs, granularityCapMs(granularity, nowMs))) };
  const keys = familyKeys(granularity, window.fromMs, window.toMs);
  const cap = DOC_CAPS[granularity];
  const truncated = keys.length > cap;
  if (truncated) {
    const kept = keys.slice(keys.length - cap);
    const first = docBucketStartMs(kept[0]) ?? window.fromMs;
    const cut = { fromMs: Math.max(window.fromMs, first), toMs: window.toMs };
    return { granularity, keys: kept, truncated, window: cut, segments: [{ family: granularity, ...cut, keys: kept }] };
  }
  const single: RangePlan = { granularity, keys, truncated, window, segments: [{ family: granularity, ...window, keys }] };
  if (foldedThroughMs === undefined || !Number.isFinite(foldedThroughMs)) return single;
  const segments = hybridSegments(granularity, window, foldedThroughMs);
  if (!segments) return single;
  const hybridKeys = uniqueKeys(segments);
  return hybridKeys.length < keys.length ? { granularity, keys: hybridKeys, truncated: false, window, segments } : single;
}

/** The coarser family a hybrid plan reads between the edges, and the bucket both it and the edges align to. */
const COARSER: Partial<Record<RangeGranularity, { family: RangeGranularity; floor: (ms: number) => number; ceil: (ms: number) => number; bucket: number }>> = {
  minute: { family: 'hour', floor: hourFloor, ceil: hourCeil, bucket: HOUR_MS },
  hour: { family: 'day', floor: utcDayFloor, ceil: utcDayCeil, bucket: DAY_MS },
};

/** The documents of `family` covering [fromMs, toMs): one per hour, per UTC day or per UTC month. */
function familyKeys(family: RangeGranularity, fromMs: number, toMs: number): string[] {
  const keys: string[] = [];
  if (toMs <= fromMs) return keys;
  const last = toMs - 1; // the last instant inside the stretch
  if (family === 'minute') for (let h = hourFloor(fromMs); h <= hourFloor(last); h += HOUR_MS) keys.push(minuteDocKey(h));
  else if (family === 'hour') for (let d = utcDayFloor(fromMs); d <= utcDayFloor(last); d += DAY_MS) keys.push(hourDocKey(d));
  else for (let m = monthStartMs(fromMs); m <= monthStartMs(last); m = nextMonthStartMs(m)) keys.push(dayDocKey(m));
  return keys;
}

function segment(family: RangeGranularity, fromMs: number, toMs: number): RangeSegment {
  return { family, fromMs, toMs, keys: familyKeys(family, fromMs, toMs) };
}

function uniqueKeys(segments: readonly RangeSegment[]): string[] {
  return [...new Set(segments.flatMap((s) => s.keys))];
}

/**
 * The hybrid split of a minute- or hour-precision window: the fine family from the start to the first whole
 * coarse bucket, the coarse family over every whole bucket the sweep has folded (ended at or before the
 * cursor), the fine family from there to the end. Undefined when no whole folded coarse bucket lies inside.
 */
function hybridSegments(granularity: RangeGranularity, window: { fromMs: number; toMs: number }, foldedThroughMs: number): RangeSegment[] | undefined {
  const coarse = COARSER[granularity];
  if (!coarse) return undefined;
  const bodyFrom = coarse.ceil(window.fromMs);
  const bodyTo = Math.min(coarse.floor(window.toMs), coarse.floor(foldedThroughMs));
  if (bodyTo - bodyFrom < coarse.bucket) return undefined;
  const out: RangeSegment[] = [];
  if (window.fromMs < bodyFrom) out.push(segment(granularity, window.fromMs, bodyFrom));
  out.push(segment(coarse.family, bodyFrom, bodyTo));
  if (bodyTo < window.toMs) out.push(segment(granularity, bodyTo, window.toMs));
  return out;
}

/** The family a rollup document key belongs to, or undefined for any other key. */
export function docFamily(key: string): RangeGranularity | undefined {
  const family = KEY_BUCKET.exec(key)?.[1];
  return family === 'min' ? 'minute' : family === 'hour' ? 'hour' : family === 'day' ? 'day' : undefined;
}

/**
 * After the plan's documents are read: a coarse bucket of a hybrid plan with no row in any flow (a UTC day the
 * sweep never folded — an outage longer than its 24 h catch-up across the day's end — or an hour nothing was
 * metered in) is read again from the finer family, whose documents are still kept for the whole window. Returns
 * the refined plan (its `keys` include the new documents) or undefined when every coarse bucket has a row.
 */
export function refineRangePlan(plan: RangePlan, docs: Record<string, RangeDoc | null | undefined>): RangePlan | undefined {
  const coarse = COARSER[plan.granularity];
  if (!coarse || plan.segments.length < 2) return undefined;
  const out: RangeSegment[] = [];
  let changed = false;
  for (const seg of plan.segments) {
    if (seg.family !== coarse.family) {
      out.push(seg);
      continue;
    }
    const seen = new Set<number>();
    for (const key of seg.keys) {
      const doc = docs[key];
      if (!doc) continue;
      for (const list of Object.values(doc.flows as Record<FlowKey, AnyRow[]>)) for (const r of list) seen.add(fromIso(r.t));
    }
    // Runs of buckets alike (has a row / has none), in order: the coarse family keeps the first, the fine family reads the second.
    let runStart = seg.fromMs;
    let runEmpty = !seen.has(seg.fromMs);
    for (let b = seg.fromMs; b <= seg.toMs; b += coarse.bucket) {
      const atEnd = b === seg.toMs;
      const empty = !atEnd && !seen.has(b);
      if (atEnd || empty !== runEmpty) {
        if (b > runStart) {
          if (runEmpty) changed = true;
          out.push(runEmpty ? segment(plan.granularity, runStart, b) : { ...segment(coarse.family, runStart, b), keys: seg.keys.filter((k) => overlaps(k, runStart, b)) });
        }
        runStart = b;
        runEmpty = empty;
      }
    }
  }
  if (!changed) return undefined;
  const merged = mergeAdjacent(out);
  return { ...plan, segments: merged, keys: [...new Set([...plan.keys, ...uniqueKeys(merged)])] };
}

/** Does the document `key` hold any instant of [fromMs, toMs)? */
function overlaps(key: string, fromMs: number, toMs: number): boolean {
  const start = docBucketStartMs(key);
  const end = docBucketEndMs(key);
  return start !== undefined && end !== undefined && start < toMs && end > fromMs;
}

/** Joins neighbouring segments of the same family (a fine run beside a fine edge reads as one stretch). */
function mergeAdjacent(segments: readonly RangeSegment[]): RangeSegment[] {
  const out: RangeSegment[] = [];
  for (const s of segments) {
    const prev = out.at(-1);
    if (prev && prev.family === s.family && prev.toMs === s.fromMs) out[out.length - 1] = { ...prev, toMs: s.toMs, keys: [...new Set([...prev.keys, ...s.keys])] };
    else out.push(s);
  }
  return out;
}

const KEY_BUCKET = /^roll\/(min|hour|day)\/(\d{4}-\d{2}(?:-\d{2}(?:T\d{2})?)?)$/;

/** The start of the bucket a rollup document key covers (the hour, the UTC day, the UTC month), or undefined. */
export function docBucketStartMs(key: string): number | undefined {
  const m = KEY_BUCKET.exec(key);
  if (!m) return undefined;
  const [, family, stamp] = m;
  if (family === 'min') return stamp.length === 13 ? fromIso(`${stamp}:00:00.000Z`) : undefined;
  if (family === 'hour') return stamp.length === 10 ? fromIso(`${stamp}T00:00:00.000Z`) : undefined;
  return stamp.length === 7 ? fromIso(`${stamp}-01T00:00:00.000Z`) : undefined;
}

/**
 * The exclusive end of the bucket a rollup document key covers (the hour, the UTC day, the UTC month), or
 * undefined for a key that is not a rollup document. A bucket whose end has passed is immutable, apart
 * from the sweep's late-minute rewrite and a catch-up, which touch it only briefly after it ends.
 */
export function docBucketEndMs(key: string): number | undefined {
  const start = docBucketStartMs(key);
  if (start === undefined) return undefined;
  const family = KEY_BUCKET.exec(key)?.[1];
  if (family === 'min') return start + HOUR_MS;
  if (family === 'hour') return start + DAY_MS;
  return nextMonthStartMs(start);
}

// ─── The sum ─────────────────────────────────────────────────────────────────

export interface Money {
  whpM: number;
  paidM: number;
  savedM: number;
}

export type RangeDoc = RollMinuteDoc | RollHourDoc | RollDayDoc;

export interface RangeFigures {
  /**
   * The window actually summed: the requested one snapped to whole hours / whole UTC days for those
   * granularities and stopped at the last completed bucket (planRangeReads `window`).
   */
  fromMs: number;
  toMs: number;
  granularity: RangeGranularity;
  savedM: number;
  whpM: number;
  paidM: number;
  /** saved ÷ would have paid, [0, 1] */
  ratio: number;
  /** Rows summed, across every flow. */
  rows: number;
  /**
   * Minutes in the window at least one flow was metered: exact at minute granularity (distinct row times);
   * at hour granularity the per-hour maximum of the flows' `samples`, summed (a lower bound that is exact
   * whenever one flow is metered every minute the workspace is); undefined at day granularity. A hybrid read
   * counts each stretch by its own family's rule; a whole UTC day read from its DayRow (which carries no sample
   * count) counts as 1,440 — the sweep backfills any outage shorter than 24 h, so a day with a row is a metered
   * day, the rule the day granularity already states.
   */
  minutesMetered: number | undefined;
  /** Whole minutes in the (snapped) window. */
  expectedMinutes: number;
  /** Day granularity only: UTC days in the window that have a row (distinct row days). */
  daysMetered?: number;
  byFlow: Record<FlowKey, Money>;
  /** keyed `${groupId}:${outputId}` */
  byOutput: Record<string, Money>;
  docsRead: number;
  docsMissing: number;
  /** Saved per day at this window's rate: saved ÷ minutes metered × 1,440, or saved ÷ days metered at day granularity. */
  ratePerDayM?: number;
  /**
   * The document families the rows came from, finest first, when that is not just the `granularity` family: a
   * hybrid read (`['minute', 'hour']`: minute rows at the edges, hour rows between), or a window of whole coarse
   * buckets read from the coarse family alone (`['day']`). Absent when every row came from the `granularity` family.
   */
  families?: RangeGranularity[];
}

/**
 * The window the rows of `granularity` are summed over: exact minutes, whole UTC hours, whole UTC days
 * (snapped outward). Idempotent, so a window planRangeReads already snapped and capped comes back unchanged.
 */
export function snapRange(fromMs: number, toMs: number, granularity: RangeGranularity): { fromMs: number; toMs: number } {
  switch (granularity) {
    case 'hour':
      return { fromMs: hourFloor(fromMs), toMs: hourCeil(toMs) };
    case 'day':
      return { fromMs: utcDayFloor(fromMs), toMs: utcDayCeil(toMs) };
    default:
      return { fromMs, toMs };
  }
}

type AnyRow = MinuteRow | HourRow | DayRow;

/**
 * Σ of every row whose t lies in the snapped window, per flow and per destination. `docs` maps each planned
 * key to its document, or null when the store has none (retention, or a bucket nothing was metered in).
 * Pass the plan's `window`, which already stops at the last completed bucket; a raw window is snapped
 * outward here, which is what a caller re-summing a published window wants. Every document is read as the
 * `granularity` family (a single-family plan); a hybrid plan is summed with sumRangePlan.
 */
export function sumRange(docs: Record<string, RangeDoc | null | undefined>, granularity: RangeGranularity, fromMs: number, toMs: number): RangeFigures {
  const window = snapRange(fromMs, toMs, granularity);
  return sumSegments(docs, granularity, window, [{ family: granularity, ...window, keys: Object.keys(docs) }]);
}

/**
 * Σ over a read plan (planRangeReads, refineRangePlan): each segment's rows are taken from its own documents
 * and only inside its own stretch, so the edges and the stretch between never count a row twice. `docs` maps
 * every key of `plan.keys` to its document (null when absent). Same figures as sumRange over the same window
 * whenever the coarse rows are the folds of the fine ones — which the sweep guarantees.
 */
export function sumRangePlan(docs: Record<string, RangeDoc | null | undefined>, plan: Pick<RangePlan, 'granularity' | 'window' | 'segments'>): RangeFigures {
  return sumSegments(docs, plan.granularity, plan.window, plan.segments);
}

function sumSegments(docs: Record<string, RangeDoc | null | undefined>, granularity: RangeGranularity, window: { fromMs: number; toMs: number }, segments: readonly RangeSegment[]): RangeFigures {
  const byFlow: Record<FlowKey, Money> = {};
  const byOutput: Record<string, Money> = {};
  const total: Money = { whpM: 0, paidM: 0, savedM: 0 };
  const minuteTimes = new Set<string>();
  const hourSamples = new Map<string, number>();
  const dayTimes = new Set<string>();
  const families = new Set<RangeGranularity>();
  let rows = 0;

  for (const seg of segments) {
    families.add(seg.family);
    for (const docKey of seg.keys) {
      const doc = docs[docKey];
      if (!doc) continue;
      for (const [key, list] of Object.entries(doc.flows as Record<FlowKey, AnyRow[]>)) {
        let acc: Money | undefined;
        for (const r of list) {
          const t = fromIso(r.t);
          if (!(t >= seg.fromMs && t < seg.toMs)) continue;
          acc ??= byFlow[key] ?? { whpM: 0, paidM: 0, savedM: 0 };
          acc.whpM += r.whpM;
          acc.paidM += r.paidM;
          acc.savedM += r.savedM;
          rows++;
          if (seg.family === 'minute') minuteTimes.add(r.t);
          else if (seg.family === 'hour') {
            const samples = (r as HourRow).samples;
            if (Number.isFinite(samples)) hourSamples.set(r.t, Math.max(hourSamples.get(r.t) ?? 0, samples));
          } else dayTimes.add(r.t);
        }
        if (acc) byFlow[key] = acc;
      }
    }
  }

  // Each document counts once, however many stretches read it.
  let docsRead = 0;
  let docsMissing = 0;
  for (const key of new Set(segments.flatMap((s) => s.keys))) {
    if (docs[key]) docsRead++;
    else docsMissing++;
  }

  for (const [key, m] of Object.entries(byFlow)) {
    total.whpM += m.whpM;
    total.paidM += m.paidM;
    total.savedM += m.savedM;
    const parts = parseFlowKey(key);
    const outputKey = parts ? `${parts.groupId}:${parts.outputId}` : key;
    const acc = byOutput[outputKey] ?? { whpM: 0, paidM: 0, savedM: 0 };
    acc.whpM += m.whpM;
    acc.paidM += m.paidM;
    acc.savedM += m.savedM;
    byOutput[outputKey] = acc;
  }

  const expectedMinutes = Math.max(0, Math.round((window.toMs - window.fromMs) / MINUTE_MS));
  const hourMinutes = [...hourSamples.values()].reduce((s, n) => s + n, 0);
  let minutesMetered: number | undefined;
  if (granularity === 'minute') minutesMetered = minuteTimes.size + hourMinutes;
  else if (granularity === 'hour') minutesMetered = hourMinutes + dayTimes.size * 1440;
  const daysMetered = granularity === 'day' ? dayTimes.size : undefined;

  // The rate divides by the time actually metered, so a gap lowers neither side of the fraction.
  let ratePerDayM: number | undefined;
  if (granularity === 'day') {
    if (daysMetered !== undefined && daysMetered > 0) ratePerDayM = Math.round(total.savedM / daysMetered);
  } else if (minutesMetered !== undefined && minutesMetered > 0) {
    ratePerDayM = Math.round((total.savedM * 1440) / minutesMetered);
  }

  const order: RangeGranularity[] = ['minute', 'hour', 'day'];
  const read = order.filter((f) => families.has(f));

  return {
    fromMs: window.fromMs,
    toMs: window.toMs,
    granularity,
    savedM: total.savedM,
    whpM: total.whpM,
    paidM: total.paidM,
    ratio: ratio(total.savedM, total.whpM),
    rows,
    minutesMetered,
    expectedMinutes,
    ...(daysMetered !== undefined ? { daysMetered } : {}),
    byFlow,
    byOutput,
    docsRead,
    docsMissing,
    ...(ratePerDayM !== undefined ? { ratePerDayM } : {}),
    // Named whenever the rows did not all come from the window's own family: a hybrid read, or a window of whole
    // coarse buckets read from the coarse family alone (30 days that start at midnight UTC: day rows only).
    ...(read.length > 1 || (read.length === 1 && read[0] !== granularity) ? { families: read } : {}),
  };
}

/** An empty sum over `window` (a range in the future: nothing to read). */
export function emptyRangeFigures(fromMs: number, toMs: number): RangeFigures {
  return sumRange({}, 'minute', fromMs, toMs);
}

// ─── Words ───────────────────────────────────────────────────────────────────

export interface RangeDuration {
  unit: 'minutes' | 'hours' | 'days';
  /** Whole minutes; hours and days to one decimal ('4', '4.5'). */
  value: string;
  /** For pluralization of days. */
  count: number;
}

/** '45 min' · '4 h' · '7 days' — the length of a window, in the unit that reads naturally. */
export function rangeDuration(fromMs: number, toMs: number): RangeDuration {
  const ms = Math.max(0, toMs - fromMs);
  const oneDecimal = (x: number): string => (Math.round(x * 10) / 10).toString();
  if (ms < HOUR_MS) {
    const n = Math.round(ms / MINUTE_MS);
    return { unit: 'minutes', value: String(n), count: n };
  }
  if (ms < DAY_MS) {
    const h = Math.round((ms / HOUR_MS) * 10) / 10;
    return { unit: 'hours', value: oneDecimal(h), count: h };
  }
  const d = Math.round((ms / DAY_MS) * 10) / 10;
  return { unit: 'days', value: oneDecimal(d), count: d };
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface WallParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();
function wallParts(ms: number, tz: string): WallParts {
  let f = wallFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    wallFormatters.set(tz, f);
  }
  const out: WallParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type === 'year') out.year = Number(p.value);
    else if (p.type === 'month') out.month = Number(p.value);
    else if (p.type === 'day') out.day = Number(p.value);
    else if (p.type === 'hour') out.hour = Number(p.value) % 24;
    else if (p.type === 'minute') out.minute = Number(p.value);
  }
  return out;
}

/** '10:00 AM' / '2:30 PM' (the copy deck's 12-hour clock). */
function clock(p: WallParts): string {
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${h12}:${String(p.minute).padStart(2, '0')} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

const sameDay = (a: WallParts, b: WallParts): boolean => a.year === b.year && a.month === b.month && a.day === b.day;

/**
 * The window in words, in the display timezone: whole local days read as dates ('Sep 19–25', 'Sep 28–Oct 4',
 * 'Dec 28, 2026–Jan 3, 2027'; the last day shown is the day containing `toMs − 1`), anything else as
 * date-and-time ('Sep 26, 10:00 AM–2:00 PM', 'Sep 25, 10:00 PM–Sep 26, 2:00 PM'). Years appear when the window
 * crosses one, and — given `nowMs` — when it lies in another year than now ('Sep 11, 2025, 7:00 PM–Sep 12, 2025,
 * 7:00 PM', 'Sep 19–25, 2025'; OQ-05: without the year a window two years back read like one next month). Pass
 * the SNAPPED window so the words describe the rows that were summed.
 */
export function rangeSpanLabel(fromMs: number, toMs: number, tz: string, nowMs?: number): string {
  const a = wallParts(fromMs, tz);
  const e = wallParts(toMs, tz);
  const ma = MONTHS_SHORT[a.month - 1];
  const me = MONTHS_SHORT[e.month - 1];
  const thisYear = nowMs !== undefined && Number.isFinite(nowMs) ? wallParts(nowMs, tz).year : undefined;
  const wholeDays = a.hour === 0 && a.minute === 0 && e.hour === 0 && e.minute === 0 && toMs - fromMs >= DAY_MS;
  if (wholeDays) {
    const b = wallParts(toMs - 1, tz); // the last day inside the window
    const mb = MONTHS_SHORT[b.month - 1];
    if (a.year !== b.year) return `${ma} ${a.day}, ${a.year}–${mb} ${b.day}, ${b.year}`;
    const year = thisYear !== undefined && a.year !== thisYear ? `, ${a.year}` : '';
    if (a.month !== b.month) return `${ma} ${a.day}–${mb} ${b.day}${year}`;
    if (a.day !== b.day) return `${ma} ${a.day}–${b.day}${year}`;
    return `${ma} ${a.day}${year}`;
  }
  const otherYear = thisYear !== undefined && (a.year !== thisYear || e.year !== thisYear);
  if (sameDay(a, e)) return otherYear ? `${ma} ${a.day}, ${a.year}, ${clock(a)}–${clock(e)}` : `${ma} ${a.day}, ${clock(a)}–${clock(e)}`;
  if (a.year !== e.year || otherYear) return `${ma} ${a.day}, ${a.year}, ${clock(a)}–${me} ${e.day}, ${e.year}, ${clock(e)}`;
  return `${ma} ${a.day}, ${clock(a)}–${me} ${e.day}, ${clock(e)}`;
}

// ─── Compare with… (P2-W13) ──────────────────────────────────────────────────
//
// A single range answers "how much"; a comparison answers "better or worse". The range on screen (the current
// window) is set against a baseline window: the previous period of the same length, the same window a week
// earlier, or — for a commit — the same length before its deploy, the range itself being the time after it.
//
// Like with like. The baseline is always the older window, so it may lie in a coarser rollup family than the
// current one (24 h against the 24 h before reads hour rows for the older day), and a coarse window is summed in
// whole buckets. Both windows are therefore aligned to the coarsest bucket either of them needs, ending at the
// last whole bucket with the same number of buckets, so the two sums cover the same length of time; for a
// commit the bucket its deploy falls in is left out of both (it is neither before nor after). When the two
// windows still differ in length or in how much of them was metered (a baseline that starts before collecting
// began, a runner outage), the sums are not comparable and the delta is taken on the rate per day instead —
// and says so. URL: `?range=7d&vs=prev`, `&vs=week`, `&vs=<commit hash>`. Nothing is written anywhere.

export type CompareSpec = { kind: 'prev' } | { kind: 'week' } | { kind: 'commit'; hash: string };

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/;

/** `?vs=` → a comparison: 'prev', 'week' or a commit hash (7–40 hex digits); anything else is undefined. */
export function parseCompareParam(raw: string | null): CompareSpec | undefined {
  if (raw === null) return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'prev') return { kind: 'prev' };
  if (value === 'week') return { kind: 'week' };
  return COMMIT_HASH_RE.test(value) ? { kind: 'commit', hash: value } : undefined;
}

/** The `?vs=` value of a comparison; round-trips through parseCompareParam. */
export function formatCompareParam(vs: CompareSpec): string {
  return vs.kind === 'commit' ? vs.hash.toLowerCase() : vs.kind;
}

/** A commit a comparison can pivot on: its hash and the instant it changed the data (deployed, else committed). */
export interface CompareCommit {
  hash: string;
  atMs: number;
}

/** When a commit changed the data: its deploy, else its commit time (a commit without a deploy time). */
export function commitAtMs(c: { deployedAt?: string; committedAt: string }): number {
  const deployed = c.deployedAt ? fromIso(c.deployedAt) : Number.NaN;
  return Number.isFinite(deployed) ? deployed : fromIso(c.committedAt);
}

/** The timeline entry a (possibly abbreviated) hash names: either one may be the other's prefix. */
export function findCommit<T extends { hash: string }>(timeline: readonly T[], hash: string): T | undefined {
  const h = hash.toLowerCase();
  return timeline.find((c) => {
    const own = c.hash.toLowerCase();
    return own.length >= 7 && (own.startsWith(h) || h.startsWith(own));
  });
}

export const WEEK_MS = 7 * DAY_MS;
/** How long after (and before) a commit the picker compares. */
export const COMMIT_COMPARE_MS = 24 * HOUR_MS;
/** Documents a comparison may read, both windows together: the most one range may read (DOC_CAPS.hour). */
export const COMPARE_DOC_CAP = Math.max(...Object.values(DOC_CAPS));

/** The window the picker proposes after a commit: from its deploy, 24 h or up to the last whole minute. */
export function commitAfterWindow(atMs: number, nowMs: number): { fromMs: number; toMs: number } | undefined {
  const fromMs = minuteFloor(atMs);
  const toMs = Math.min(fromMs + COMMIT_COMPARE_MS, minuteFloor(nowMs));
  return toMs > fromMs ? { fromMs, toMs } : undefined;
}

export type CompareRefusalReason =
  /** The range lies in the future: nothing to compare. */
  | 'future'
  /** "A week earlier" of a window longer than a week would overlap it. */
  | 'week-too-long'
  /** The range starts before the commit's deploy: it holds time from before the change. */
  | 'overlap'
  /** The commit is not in the snapshot's change timeline. */
  | 'no-commit'
  /** The aligned windows hold no whole bucket (a window shorter than the whole hours it must be compared in). */
  | 'too-short'
  /** The baseline lies entirely before collecting began (or before the history kept). */
  | 'before-collecting'
  /** Both windows together would read more than COMPARE_DOC_CAP documents. */
  | 'too-many-reads';

export interface ComparisonRefusal {
  ok: false;
  vs: CompareSpec;
  reason: CompareRefusalReason;
  /** too-many-reads: the documents both windows would read, and the cap. */
  reads?: number;
  cap?: number;
}

export interface ComparisonPlan {
  ok: true;
  vs: CompareSpec;
  /** The current window as it is read for the comparison (aligned; whole minutes at least). */
  current: { fromMs: number; toMs: number };
  /** The baseline window, before any clipping to when collecting began (the reader clips it). */
  baseline: { fromMs: number; toMs: number };
  /** The bucket both windows are aligned to: 'minute' means neither moved. */
  alignedTo: RangeGranularity;
  /** The current window differs from the range's own (aligned to whole hours or UTC days, or moved past a deploy). */
  realigned: boolean;
  /** Commit mode: the bucket holding the deploy, left out of both windows (absent when the deploy is on a boundary). */
  gap?: { fromMs: number; toMs: number };
  /** The baseline starts before collecting began or before the history kept: it is clipped (and compared per day). */
  baselineClipped: boolean;
  /** Distinct documents both windows read (the reader's hybrid plans). */
  reads: number;
  commit?: CompareCommit;
}

const BUCKETS: Record<RangeGranularity, { ms: number; floor: (ms: number) => number; ceil: (ms: number) => number }> = {
  minute: { ms: MINUTE_MS, floor: minuteFloor, ceil: (ms) => minuteFloor(ms + MINUTE_MS - 1) },
  hour: { ms: HOUR_MS, floor: hourFloor, ceil: hourCeil },
  day: { ms: DAY_MS, floor: utcDayFloor, ceil: utcDayCeil },
};
const RANK: Record<RangeGranularity, number> = { minute: 0, hour: 1, day: 2 };

/**
 * The granularity planRangeReads gives a window starting at `fromMs` (its reach rule, measured from the last whole
 * minute); the minute family's reach follows the sweep's minute retention when it is shorter (r2 core-11 b).
 */
export function granularityFor(fromMs: number, nowMs: number, minuteRetentionHours?: number): RangeGranularity {
  const anchor = minuteFloor(nowMs);
  return fromMs >= anchor - minuteReachMs(minuteRetentionHours) ? 'minute' : fromMs >= anchor - HOUR_REACH_MS ? 'hour' : 'day';
}

interface AlignedPair {
  current: { fromMs: number; toMs: number };
  baseline: { fromMs: number; toMs: number };
  gap?: { fromMs: number; toMs: number };
}

/** Both windows aligned to whole buckets of `g`, or undefined when they would hold no whole bucket. */
function alignPair(vs: CompareSpec, cur: { fromMs: number; toMs: number }, g: RangeGranularity, commitAt: number | undefined): AlignedPair | undefined {
  const b = BUCKETS[g];
  if (vs.kind === 'commit' && commitAt !== undefined) {
    // After: from the first whole bucket after the deploy; before: the same number of buckets ending at the last
    // whole bucket before it. The bucket the deploy falls in belongs to neither.
    const start = Math.max(b.ceil(commitAt), b.ceil(cur.fromMs));
    const n = Math.floor((b.floor(cur.toMs) - start) / b.ms);
    if (n < 1) return undefined;
    const end = b.floor(commitAt);
    return {
      current: { fromMs: start, toMs: start + n * b.ms },
      baseline: { fromMs: end - n * b.ms, toMs: end },
      ...(b.ceil(commitAt) > end ? { gap: { fromMs: end, toMs: b.ceil(commitAt) } } : {}),
    };
  }
  const n = Math.max(1, Math.round((cur.toMs - cur.fromMs) / b.ms));
  const end = b.floor(cur.toMs);
  const current = { fromMs: end - n * b.ms, toMs: end };
  if (current.fromMs >= current.toMs) return undefined;
  const baseline = vs.kind === 'week' ? { fromMs: current.fromMs - WEEK_MS, toMs: current.toMs - WEEK_MS } : { fromMs: current.fromMs - n * b.ms, toMs: current.fromMs };
  return { current, baseline };
}

/**
 * The two windows a comparison reads, or why it can't be made — decided before a single document is read. The
 * current window is the range resolved now (resolveRange); both windows are aligned to the finest bucket that
 * both of their rollup families can sum exactly (minute, whole hours, whole UTC days); the plan counts the
 * documents both reads will take with the sweep's cursor (the reader's hybrid plans) and refuses beyond
 * COMPARE_DOC_CAP.
 */
export interface ComparisonContext {
  nowMs: number;
  /** When collecting began: the current window is clipped to it, and a baseline before it is refused or clipped. */
  collectingSinceMs?: number;
  /** The sweep's cursor (meta.meteredThrough): the documents are counted with the reader's hybrid plans. */
  foldedThroughMs?: number;
  /** Commit mode: the timeline entry `vs` names (absent → 'no-commit'). */
  commit?: CompareCommit;
  /** Documents both windows may read together (default COMPARE_DOC_CAP). */
  docCap?: number;
  /** meta.minuteRetentionHours: both windows plan the minute family only within it (r2 core-11 b). */
  minuteRetentionHours?: number;
}

export function planComparison(spec: RangeSpec, vs: CompareSpec, ctx: ComparisonContext): ComparisonPlan | ComparisonRefusal {
  const { nowMs, collectingSinceMs, foldedThroughMs, commit, minuteRetentionHours } = ctx;
  const planOpts: RangePlanOptions = minuteRetentionHours !== undefined ? { minuteRetentionHours } : {};
  const docCap = ctx.docCap ?? COMPARE_DOC_CAP;
  const refuse = (reason: CompareRefusalReason, extra: Partial<ComparisonRefusal> = {}): ComparisonRefusal => ({ ok: false, vs, reason, ...extra });
  const resolved = resolveRange(spec, nowMs, collectingSinceMs);
  if (resolved.future) return refuse('future');
  const cur = { fromMs: resolved.fromMs, toMs: resolved.toMs };
  if (vs.kind === 'week' && cur.toMs - cur.fromMs > WEEK_MS) return refuse('week-too-long');
  let commitAt: number | undefined;
  if (vs.kind === 'commit') {
    if (!commit || !Number.isFinite(commit.atMs)) return refuse('no-commit');
    commitAt = commit.atMs;
    if (cur.fromMs < minuteFloor(commitAt)) return refuse('overlap');
  }

  let pair: AlignedPair | undefined;
  let alignedTo: RangeGranularity = 'minute';
  for (const g of ['minute', 'hour', 'day'] as const) {
    const p = alignPair(vs, cur, g, commitAt);
    if (!p) continue;
    // Accept the finest alignment both windows' own families sum exactly at.
    if (RANK[granularityFor(p.baseline.fromMs, nowMs, minuteRetentionHours)] <= RANK[g] && RANK[granularityFor(p.current.fromMs, nowMs, minuteRetentionHours)] <= RANK[g]) {
      pair = p;
      alignedTo = g;
      break;
    }
  }
  if (!pair) return refuse('too-short');

  const since = collectingSinceMs !== undefined && Number.isFinite(collectingSinceMs) ? minuteFloor(collectingSinceMs) : undefined;
  const kept = retentionStartMs(nowMs);
  const floorOfHistory = Math.max(kept, since ?? kept);
  if (pair.baseline.toMs <= floorOfHistory) return refuse('before-collecting');
  const baselineClipped = pair.baseline.fromMs < floorOfHistory;

  // What both reads will cost: the same resolution and hybrid plan the reader makes for each window.
  const planOf = (w: { fromMs: number; toMs: number }): RangePlan => {
    const r = resolveRange({ kind: 'absolute', fromMs: w.fromMs, toMs: w.toMs }, nowMs, collectingSinceMs);
    return planRangeReads(r.fromMs, r.toMs, nowMs, foldedThroughMs, planOpts);
  };
  const a = planOf(pair.current);
  const b = planOf(pair.baseline);
  const reads = new Set([...a.keys, ...b.keys]).size;
  if (a.truncated || b.truncated || reads > docCap) return refuse('too-many-reads', { reads: reads + (a.truncated || b.truncated ? 1 : 0), cap: docCap });

  // Moved when the window read differs from the one the range alone would sum (24 h minute-exact → whole hours).
  const own = planRangeReads(cur.fromMs, cur.toMs, nowMs, undefined, planOpts).window;
  const realigned = pair.current.fromMs !== own.fromMs || pair.current.toMs !== own.toMs;
  return {
    ok: true,
    vs,
    current: pair.current,
    baseline: pair.baseline,
    alignedTo,
    realigned,
    ...(pair.gap ? { gap: pair.gap } : {}),
    baselineClipped,
    reads,
    ...(commit && vs.kind === 'commit' ? { commit } : {}),
  };
}

/** Share of a summed window that was metered: minutes metered of the minutes in it, or days metered of its days. */
export function meteredShare(f: Pick<RangeFigures, 'granularity' | 'minutesMetered' | 'expectedMinutes' | 'daysMetered' | 'fromMs' | 'toMs'>): number {
  if (f.granularity === 'day') {
    const days = Math.max(1, Math.round((f.toMs - f.fromMs) / DAY_MS));
    return (f.daysMetered ?? 0) / days;
  }
  return (f.minutesMetered ?? 0) / Math.max(1, f.expectedMinutes);
}

/** An amount summed over a window as a day at that window's rate (the rule ratePerDayM follows), or undefined. */
export function perDayAtRate(f: Pick<RangeFigures, 'granularity' | 'minutesMetered' | 'daysMetered'>, amountM: number): number | undefined {
  if (f.granularity === 'day') return f.daysMetered !== undefined && f.daysMetered > 0 ? Math.round(amountM / f.daysMetered) : undefined;
  return f.minutesMetered !== undefined && f.minutesMetered > 0 ? Math.round((amountM * 1440) / f.minutesMetered) : undefined;
}

/** Two windows' metered shares closer than this read as equally metered (a minute or two of a long window). */
export const COVERAGE_TOLERANCE = 0.01;

/**
 * How the two windows are compared: 'sum' when they are the same length and equally metered (their sums are like
 * for like), 'rate' when not (each window's saved per day at its own rate), 'none' when the baseline has nothing
 * to compare with (no row metered in it, or no rate on one side).
 */
export type CompareBasis = 'sum' | 'rate' | 'none';

export interface RangeComparison {
  current: RangeFigures;
  baseline: RangeFigures;
  basis: CompareBasis;
  /** Saved in the current and the baseline window: sums ('sum'), saved per day at each window's rate ('rate'). */
  currentM: number;
  baselineM: number;
  /** currentM − baselineM (0 when basis is 'none'). */
  deltaM: number;
  /** deltaM ÷ baselineM, signed; undefined when the baseline saved nothing (no percentage of zero). */
  pct?: number;
  /** 'flat' when the change rounds to $0. */
  direction: 'up' | 'down' | 'flat';
}

const HALF_DOLLAR_M = 50_000;

/**
 * The change as printed (founder-build r1 ui-8, FINDINGS_R1 m11): the difference of the two figures as they print in
 * whole dollars, so "$169,136 → $183,130 · +$13,994" always foots (the exact delta could print a dollar off). 0 when
 * there is nothing to compare.
 */
export function printedDeltaM(cmp: Pick<RangeComparison, 'currentM' | 'baselineM' | 'basis'>): number {
  if (cmp.basis === 'none') return 0;
  return roundToDollarsM(cmp.currentM) - roundToDollarsM(cmp.baselineM);
}

/** The current window against the baseline: both sums, the signed delta and its basis (P2-W13). Pure. */
export function compareRanges(current: RangeFigures, baseline: RangeFigures): RangeComparison {
  const sameLength = current.toMs - current.fromMs === baseline.toMs - baseline.fromMs;
  const equallyMetered = Math.abs(meteredShare(current) - meteredShare(baseline)) <= COVERAGE_TOLERANCE;
  let basis: CompareBasis;
  if (baseline.rows === 0) basis = 'none';
  else if (sameLength && equallyMetered) basis = 'sum';
  else if (current.ratePerDayM !== undefined && baseline.ratePerDayM !== undefined) basis = 'rate';
  else basis = 'none';
  const currentM = basis === 'rate' ? (current.ratePerDayM ?? 0) : current.savedM;
  const baselineM = basis === 'rate' ? (baseline.ratePerDayM ?? 0) : baseline.savedM;
  const deltaM = basis === 'none' ? 0 : currentM - baselineM;
  const pct = basis !== 'none' && baselineM > 0 ? deltaM / baselineM : undefined;
  const direction = Math.abs(deltaM) < HALF_DOLLAR_M ? 'flat' : deltaM > 0 ? 'up' : 'down';
  return { current, baseline, basis, currentM, baselineM, deltaM, ...(pct !== undefined ? { pct } : {}), direction };
}
