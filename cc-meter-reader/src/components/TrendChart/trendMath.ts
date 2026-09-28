// src/components/TrendChart/trendMath.ts — scales and markers for the 30-day savings chart, pure.

import type { Commit, TrendPoint } from '../../../core/types.ts';
import { DAY_MS, localDayKey, localDayStartMs } from '../../../core/time.ts';
import { commitTimeMs } from '../../../core/timeline.ts';

/**
 * The axis of a chart whose whole days all saved nothing: $0 / $50 / $100 (P0-18), never "$0 / $1 / $1". Only
 * the chart's empty state uses it; niceMax itself stays the rule the report card's PDF mirrors (core/report-pdf.ts
 * niceAxisMax, held equal by tests/unit/report-render.test.ts).
 */
export const EMPTY_AXIS_MAX = 10_000_000;

/**
 * A "nice" upper bound for a money axis (millicents): 1, 2, 3, 4, 5, 6 or 8 × 10^k at or above `max`,
 * chosen so the midline tick is a round figure too ($1.5k, $3k, $4k — never $1.3k).
 */
export function niceMax(max: number): number {
  if (!(max > 0) || !Number.isFinite(max)) return 100_000; // $1 — an empty axis still has a scale
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  for (const step of [1, 2, 3, 4, 5, 6, 8, 10]) {
    if (step * base >= max) return step * base;
  }
  return 10 * base;
}

/** Linear map from [d0, d1] to [r0, r1]; a zero-width domain maps to the range's midpoint. */
export function linear(d0: number, d1: number, r0: number, r1: number): (x: number) => number {
  if (d1 === d0) return () => (r0 + r1) / 2;
  const k = (r1 - r0) / (d1 - d0);
  return (x) => r0 + (x - d0) * k;
}

export interface DeployMarker {
  hash: string;
  message: string;
  author: string;
  atMs: number;
  /** Fractional day index on the chart's x axis (0 = first point's local midnight). */
  x: number;
  /** Index of the point (day) it belongs to. */
  day: number;
}

/**
 * Places each commit that shipped inside the charted days on the day axis: day index + fraction of the
 * local day. Commits outside the range are dropped; the newest first order of the timeline is kept.
 */
export function deployMarkers(points: TrendPoint[], commits: Commit[], tz: string): DeployMarker[] {
  if (points.length === 0) return [];
  const starts = points.map((p) => localDayStartMs(p.day, tz));
  const first = starts[0];
  const endMs = localDayStartMs(points[points.length - 1].day, tz) + DAY_MS;
  const out: DeployMarker[] = [];
  for (const c of commits ?? []) {
    const at = commitTimeMs(c);
    if (!Number.isFinite(at) || at < first || at >= endMs) continue;
    const key = localDayKey(at, tz);
    const day = points.findIndex((p) => p.day === key);
    if (day < 0) continue;
    const next = day + 1 < starts.length ? starts[day + 1] : starts[day] + DAY_MS;
    const frac = Math.min(0.999, Math.max(0, (at - starts[day]) / Math.max(1, next - starts[day])));
    out.push({ hash: c.hash, message: c.message, author: c.author, atMs: at, x: day + frac, day });
  }
  return out;
}

/** The index of the point nearest to a fractional position on the day axis. */
export function nearestIndex(x: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, Math.round(x)));
}

/** Whole days in the trend (excludes a trailing partial "today"). */
export function completeDays(points: TrendPoint[], todayKey: string | undefined): TrendPoint[] {
  return todayKey && points.length > 0 && points[points.length - 1].day === todayKey ? points.slice(0, -1) : points;
}

export interface CollectedDays {
  /** The completed days to draw: from the day collecting began (never a $0 day before it), today excluded. */
  days: TrendPoint[];
  /** When collecting began after the first drawn day's midnight: that day is partial, metered from here. */
  firstPartialFromMs?: number;
  /** The day collecting began (local key), when known. */
  sinceKey?: string;
}

/**
 * The days the savings chart draws (P0-18): the completed days on or after the day collecting began. A snapshot
 * may carry days before metering began as $0 (an older build, a fixture, a seeded workspace); drawn, they read
 * as "Cribl saved nothing for weeks" and then a cliff. Collecting may also begin mid-day: that first day is
 * kept (its savings are real) and flagged partial, so its short bar is explained rather than read as a drop.
 */
export function collectedDays(points: TrendPoint[], todayKey: string | undefined, collectingSinceMs: number | undefined, tz: string): CollectedDays {
  const known = collectingSinceMs !== undefined && Number.isFinite(collectingSinceMs);
  const sinceKey = known ? localDayKey(collectingSinceMs, tz) : undefined;
  const days = completeDays(sinceKey ? points.filter((p) => p.day >= sinceKey) : points, todayKey);
  const out: CollectedDays = { days, sinceKey };
  if (known && sinceKey && days.length > 0 && days[0].day === sinceKey && collectingSinceMs > localDayStartMs(sinceKey, tz)) out.firstPartialFromMs = collectingSinceMs;
  return out;
}

/** True when every drawn day saved nothing: the chart shows a sentence instead of a flat line. */
export function nothingSaved(days: TrendPoint[]): boolean {
  return days.length > 0 && days.every((p) => !(p.savedM > 0));
}

/** The trend's one annotation (P2-W07 part c): the largest priced configuration change in the charted window. */
export interface TrendAnnotation {
  /** The commit's full hash (the chart prints its first seven characters, as the Ledger does). */
  hash: string;
  /** When it took effect (deploy time, else commit time), epoch ms. */
  t: number;
  /** Signed $/day in millicents (+ savings rose), exactly the Ledger's Changes row figure. */
  perDayM: number;
}

/**
 * The window the trend annotates: from the first drawn day's local midnight to `nowMs` (the sweep), so a change
 * that landed today, after the last whole day the line draws, is still the chart's biggest news. Undefined when
 * the chart draws no line (under two whole days, or nothing saved on any).
 */
export function annotationDomain(days: TrendPoint[], tz: string, nowMs: number): [number, number] | undefined {
  if (days.length < 2 || nothingSaved(days) || !Number.isFinite(nowMs)) return undefined;
  return [localDayStartMs(days[0].day, tz), nowMs];
}
