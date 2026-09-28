// src/components/ChangeTimeline/model.ts — the change timeline's pure logic (PRD 8.3, DESIGN_BRIEF 5.4, SPEC 10).
//
//   series      24 h: snapshot.ratioSeries (5-minute buckets, the whole workspace's savings ratio)
//               7 d:  snapshot.trend (one point per local day: saved ÷ would have paid)
//   fit         24 h zoomed to the window around its commits (BEAUTY F12): when every commit falls in the last
//               quarter of the day, the story — the commits, the dip, the recovery — would otherwise sit in the
//               last few pixels, so the view opens on [first commit − padding, now] instead
//   markers     snapshot.timeline commits at their deploy time (else commit time), stacked when they collide
//   what moved  the objects whose savings ratio changed after a commit: alerts that name the commit first
//               (exact before → after), then flows the commit touched or whose sparkline shifted across it
// No React and no DOM, so the unit tests pin every rule.

import { movedAfter, type MovedLine, type MovedOptions } from '../../../core/commitImpacts.ts';
import { commitTimeMs, sameHash } from '../../../core/timeline.ts';
import { addDaysToKey, localDayKey, localDayStartMs } from '../../../core/time.ts';
import type { Commit, Incident, Snapshot } from '../../../core/types.ts';

export type TimelineRange = '24h' | '7d';
export const TIMELINE_RANGES: readonly TimelineRange[] = ['24h', '7d'];

export function parseRange(raw: string | null | undefined): TimelineRange {
  return raw === '7d' ? '7d' : '24h';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface SeriesPoint {
  t: number;
  ratio: number;
  /** 7 d only: the live ratio (the 24 h series' latest sample) appended after the daily points, so the line runs to now */
  live?: true;
}

export interface TimelineSeries {
  /** contiguous runs of points; a gap in the data starts a new segment (the line breaks, never bridges) */
  segments: SeriesPoint[][];
  /** all points, oldest first (hover readout) */
  points: SeriesPoint[];
  /** x domain, epoch ms */
  domain: [number, number];
  /** y domain (a savings ratio, zoomed to the data on a 10-point grid) */
  yDomain: [number, number];
  /** when the data starts later than the range's nominal start ("since 9:41 PM") */
  since?: number;
  /** zoomed to the commits (fitDomain); the domain's start is where the window begins */
  fitted?: true;
}

/** A tidy y range: the data ± 2 points, snapped to 10-point steps, at least 20 points tall, inside [0, 1]. */
export function niceRatioDomain(values: readonly number[]): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return [0, 1];
  let lo = Math.floor((Math.min(...finite) - 0.02) * 10) / 10;
  let hi = Math.ceil((Math.max(...finite) + 0.02) * 10) / 10;
  lo = Math.max(0, lo);
  hi = Math.min(1, hi);
  if (hi - lo < 0.2) {
    const mid = (hi + lo) / 2;
    lo = Math.max(0, Math.round((mid - 0.1) * 10) / 10);
    hi = Math.min(1, lo + 0.2);
    lo = Math.max(0, hi - 0.2);
  }
  return [round3(lo), round3(hi)];
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Splits points where consecutive samples are further apart than `maxGapMs`. */
export function segmentize(points: readonly SeriesPoint[], maxGapMs: number): SeriesPoint[][] {
  const out: SeriesPoint[][] = [];
  let current: SeriesPoint[] = [];
  for (const p of points) {
    const prev = current[current.length - 1];
    if (prev && p.t - prev.t > maxGapMs) {
      out.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length) out.push(current);
  return out;
}

function snapshotEnd(snapshot: Pick<Snapshot, 'windowEnd' | 'sweepAt'>): number {
  const end = Date.parse(snapshot.windowEnd);
  return Number.isFinite(end) ? end : Date.parse(snapshot.sweepAt);
}

/** When a commit took effect: its deploy time, else its commit time. */
export function markerTime(c: Pick<Commit, 'committedAt' | 'deployedAt'>): number {
  return commitTimeMs(c);
}

/** Only commits in the last quarter of the range are worth zooming to; earlier ones already read at full range. */
const FIT_TRIGGER_SHARE = 0.25;
/** Context kept before the first commit: at least 30 min, or 60 % of the commits-to-now span. */
const FIT_MIN_PAD = 30 * MINUTE;
const FIT_PAD_SHARE = 0.6;
/** Never zoom tighter than an hour, and never "zoom" by less than half an hour. */
const FIT_MIN_SPAN = HOUR;
const FIT_MIN_GAIN = 30 * MINUTE;

/**
 * The zoomed domain for commits at `markerTimes` inside `domain` (BEAUTY F12), or null when zooming wouldn't
 * help: no commits, commits spread over more than the last quarter, or a zoom that trims under half an hour.
 */
export function fitDomain(markerTimes: readonly number[], domain: [number, number]): [number, number] | null {
  const [a, b] = domain;
  if (!(b > a)) return null;
  const inRange = markerTimes.filter((t) => Number.isFinite(t) && t >= a && t <= b);
  if (inRange.length === 0) return null;
  const first = Math.min(...inRange);
  if (b - first > (b - a) * FIT_TRIGGER_SHARE) return null;
  let start = Math.max(a, first - Math.max(FIT_MIN_PAD, (b - first) * FIT_PAD_SHARE));
  if (b - start < FIT_MIN_SPAN) start = Math.max(a, b - FIT_MIN_SPAN);
  if (start - a < FIT_MIN_GAIN) return null;
  return [start, b];
}

export interface BuildSeriesOptions {
  /** 24 h only: zoom to the commits when fitDomain says it helps (the Ledger's default "Changes" view). */
  fit?: boolean;
}

export function buildSeries(
  range: TimelineRange,
  snapshot: Pick<Snapshot, 'ratioSeries' | 'trend' | 'windowEnd' | 'sweepAt' | 'timeline'>,
  timeZone: string,
  opts: BuildSeriesOptions = {},
): TimelineSeries {
  const end = snapshotEnd(snapshot);
  if (range === '7d') {
    // The window runs from local midnight six days ago to now (P1-K03: like 24 h, the line reaches the right edge
    // instead of stopping short of it with today's commits beyond it). Each day's point sits at local noon; today's
    // is "today so far", at noon or now, whichever is earlier.
    const today = localDayKey(end, timeZone);
    const firstDay = addDaysToKey(today, -6);
    const start = localDayStartMs(firstDay, timeZone);
    const points: SeriesPoint[] = (snapshot.trend ?? [])
      .filter((d) => d.day >= firstDay && d.day <= today && d.whpM > 0)
      .map((d) => ({
        t: Math.min(end, localDayStartMs(d.day, timeZone) + 12 * HOUR),
        ratio: clamp01(d.savedM / d.whpM),
      }))
      .sort((a, b) => a.t - b.t);
    // Then the live ratio (the 24 h series' latest sample), so today's commits sit on the line, not past its end.
    const live = latestRatio(snapshot.ratioSeries, start, end);
    const last = points[points.length - 1];
    if (live && (!last || live.t - last.t >= LIVE_MIN_GAP)) points.push({ ...live, live: true });
    return {
      segments: segmentize(points, 1.5 * DAY),
      points,
      domain: [start, Math.max(end, start + HOUR)],
      yDomain: niceRatioDomain(points.map((p) => p.ratio)),
    };
  }

  const nominalStart = end - DAY;
  const points = (snapshot.ratioSeries ?? [])
    .map((p) => ({ t: Date.parse(p.t), ratio: clamp01(p.ratio) }))
    .filter((p) => Number.isFinite(p.t) && p.t >= nominalStart && p.t <= end)
    .sort((a, b) => a.t - b.t);
  const commitTimes = (snapshot.timeline ?? []).map(markerTime).filter((t) => Number.isFinite(t) && t >= nominalStart && t <= end);
  const earliest = Math.min(points[0]?.t ?? end, ...commitTimes);
  let start = Math.max(nominalStart, earliest - 10 * MINUTE);
  if (end - start < HOUR) start = end - HOUR;
  if (opts.fit) {
    const fitted = fitDomain(commitTimes, [start, end]);
    if (fitted) {
      // Keep one sample before the window so the line enters from the left edge instead of starting mid-plot.
      const firstIn = points.findIndex((p) => p.t >= fitted[0]);
      const visible = firstIn < 0 ? [] : points.slice(Math.max(0, firstIn - 1));
      const inside = visible.filter((p) => p.t >= fitted[0]);
      return {
        segments: segmentize(visible, 16 * MINUTE),
        points: inside,
        domain: fitted,
        yDomain: niceRatioDomain(inside.map((p) => p.ratio)),
        fitted: true,
      };
    }
  }
  const series: TimelineSeries = {
    segments: segmentize(points, 16 * MINUTE),
    points,
    domain: [start, end],
    yDomain: niceRatioDomain(points.map((p) => p.ratio)),
  };
  if (start > nominalStart + 30 * MINUTE && points.length > 0) series.since = points[0].t;
  return series;
}

/** Whether the 24 h view of this snapshot has a zoomed "Changes" window (the toggle offers it only then). */
export function canFit(snapshot: Pick<Snapshot, 'ratioSeries' | 'trend' | 'windowEnd' | 'sweepAt' | 'timeline'>, timeZone: string): boolean {
  return buildSeries('24h', snapshot, timeZone, { fit: true }).fitted === true;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** The live point joins the 7 d line only when it adds something: at least half an hour after the last daily point. */
const LIVE_MIN_GAP = 30 * MINUTE;

/** The newest ratio sample inside [start, end], or undefined. */
function latestRatio(series: Snapshot['ratioSeries'] | undefined, start: number, end: number): SeriesPoint | undefined {
  let best: SeriesPoint | undefined;
  for (const p of series ?? []) {
    const t = Date.parse(p.t);
    if (!Number.isFinite(t) || t < start || t > end) continue;
    if (!best || t > best.t) best = { t, ratio: clamp01(p.ratio) };
  }
  return best;
}

// ─── Axis ticks ──────────────────────────────────────────────────────────────

/** Offset of `timeZone` from UTC at `ms`, in ms (wall clock − UTC). Falls back to 0 for a bad zone. */
export function tzOffsetMs(ms: number, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(ms);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return wall - Math.floor(ms / 1000) * 1000;
  } catch {
    return 0;
  }
}

const TICK_STEPS = [15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 6 * HOUR, 12 * HOUR];

/**
 * Time ticks for a 24 h domain, aligned to local wall-clock boundaries (every 4 hours → 12 AM, 4 AM, …),
 * using the smallest step that keeps at most `maxTicks`.
 */
export function timeTicks(domain: [number, number], timeZone: string, maxTicks: number): number[] {
  const [a, b] = domain;
  if (!(b > a) || maxTicks < 1) return [];
  const step = TICK_STEPS.find((s) => (b - a) / s <= maxTicks) ?? 24 * HOUR;
  const offset = tzOffsetMs(b, timeZone);
  const first = Math.ceil((a + offset) / step) * step - offset;
  const ticks: number[] = [];
  for (let t = first; t <= b; t += step) ticks.push(t);
  return ticks;
}

/**
 * Day ticks (local noon of each day) for the 7 d domain. With room for fewer than all of them (`maxTicks`, the
 * chart passes plot width ÷ 64 px), every 2nd or 3rd day is kept, counted back from the newest so today's (or the
 * latest) label always shows (P1-K03: at 390 px the seven labels ran into each other).
 */
export function dayTicks(domain: [number, number], timeZone: string, maxTicks = 8): number[] {
  const [a, b] = domain;
  const all: number[] = [];
  let key = localDayKey(a + HOUR, timeZone);
  for (let i = 0; i < 8; i++) {
    const noon = localDayStartMs(key, timeZone) + 12 * HOUR;
    if (noon > b) break;
    if (noon >= a) all.push(noon);
    key = addDaysToKey(key, 1);
  }
  const step = Math.max(1, Math.ceil(all.length / Math.max(1, Math.floor(maxTicks))));
  return all.filter((_, i) => (all.length - 1 - i) % step === 0);
}

/**
 * Where to draw commit markers that share the strip under the axis (P1-K03). `xs` are the commits' true positions
 * in pixels; markers closer than `gap` fan out sideways — never upward into the plot, where a stack of diamonds
 * reads as values — each run centred on its members' mean, in time order, kept inside `bounds`. The chart joins a
 * moved marker to its true position with a short leader.
 */
export function spreadMarkers(xs: readonly number[], gap: number, bounds: [number, number]): number[] {
  const [lo, hi] = bounds;
  const order = xs.map((x, i) => ({ x, i })).sort((p, q) => p.x - q.x || p.i - q.i);
  interface Run {
    first: number; // index into `order`
    n: number;
    sum: number;
    start: number; // x of the run's first marker
    step: number;
  }
  const place = (run: Run) => {
    const room = Math.max(0, hi - lo);
    run.step = run.n > 1 ? Math.min(gap, room / (run.n - 1)) : gap;
    const span = (run.n - 1) * run.step;
    run.start = Math.min(Math.max(run.sum / run.n - span / 2, lo), hi - span);
  };
  const runs: Run[] = [];
  order.forEach(({ x }, k) => {
    const run: Run = { first: k, n: 1, sum: x, start: x, step: gap };
    place(run);
    runs.push(run);
    // Merge with the run before while the two would sit closer than `gap`.
    while (runs.length > 1) {
      const b = runs[runs.length - 1];
      const a = runs[runs.length - 2];
      if (a.start + (a.n - 1) * a.step + gap <= b.start + 1e-6) break;
      a.n += b.n;
      a.sum += b.sum;
      runs.pop();
      place(a);
    }
  });
  const out = new Array<number>(xs.length).fill(0);
  for (const run of runs) for (let j = 0; j < run.n; j++) out[order[run.first + j].i] = run.start + j * run.step;
  return out;
}

// ─── Markers ─────────────────────────────────────────────────────────────────

export interface TimelineMarker {
  commit: Commit;
  t: number;
  /** named by an open alert (the commit Meter Reader blames) */
  cause: boolean;
  newest: boolean;
}

/** Commits inside the domain, oldest first; the newest carries the story callout. */
export function buildMarkers(commits: readonly Commit[], incidents: readonly Incident[], domain: [number, number]): TimelineMarker[] {
  const blamed = incidents.filter((i) => !i.closedAt && i.commit).map((i) => i.commit!.hash);
  const inRange = commits
    .map((commit) => ({ commit, t: markerTime(commit) }))
    .filter((m) => Number.isFinite(m.t) && m.t >= domain[0] && m.t <= domain[1])
    .sort((a, b) => a.t - b.t);
  return inRange.map((m, i) => ({
    commit: m.commit,
    t: m.t,
    cause: blamed.some((h) => sameHash(h, m.commit.hash)),
    newest: i === inRange.length - 1,
  }));
}

// ─── What moved ──────────────────────────────────────────────────────────────
//
// The logic lives in core/commitImpacts.ts (P2-W07), which also prices each move; the card shows the first five.

/** An object whose savings ratio changed after a commit (core/commitImpacts.ts MovedLine, priced where it can be). */
export type MovedItem = MovedLine;

export interface WhatMovedOptions extends MovedOptions {
  limit?: number;
}

const FILE_PREFIX = /^groups\/[^/]+\/local\/cribl\//;

/** 'groups/default/local/cribl/pipelines/x/conf.yml' → 'pipelines/x/conf.yml'. */
export function fileLabel(path: string): string {
  return path.replace(FILE_PREFIX, '');
}

/**
 * Objects whose savings ratio changed after `commit`, biggest move first:
 *  1. alerts that name this commit — their own before → after (exact);
 *  2. flows whose per-minute sparkline covers the commit and shifted by at least the threshold
 *     (a lower bar for flows the commit touched);
 *  3. flows the commit touched that only exist after it (a pack applied = a new pipeline): "now N %".
 */
export function whatMoved(
  commit: Commit,
  snapshot: Pick<Snapshot, 'flows' | 'incidents' | 'windowEnd' | 'sweepAt'>,
  opts: WhatMovedOptions = {},
): MovedItem[] {
  return movedAfter(commit, snapshot, opts).slice(0, opts.limit ?? 5);
}
