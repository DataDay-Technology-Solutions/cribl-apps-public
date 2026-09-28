// src/views/Presenter/trend.ts — the stage's 30-day savings line (P2-W04), pure: the path of the daily saved figures,
// the highest day at 90 % of the height, the area under it closed along the baseline.

import type { Snapshot, TrendPoint } from '../../../core/types.ts';
import { completeDays } from '../../components/TrendChart/trendMath.ts';
import { fromIso, isValidTimeZone, localDayKey } from '../../../core/time.ts';

export const TREND_W = 1000;
export const TREND_H = 200;
const W = TREND_W;
const H = TREND_H;

/** The trend as an SVG path pair (the line and the area under it), max at 90 % of the height. */
export function trendPaths(points: readonly Pick<TrendPoint, 'savedM'>[]): { line: string; area: string; max: number } | null {
  const values = points.map((p) => (Number.isFinite(p.savedM) ? Math.max(0, p.savedM) : 0));
  if (values.length < 2) return null;
  const max = Math.max(...values);
  if (!(max > 0)) return null;
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - (v / max) * H * 0.9;
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return { line, area: `${line}L${W},${H}L0,${H}Z`, max };
}

/**
 * The days the stage's line draws: completed days only. Today is partial (the Receipt's trend leaves it out too,
 * trendMath completeDays), and drawn as a whole day it made the line dive at its right edge on every stage at
 * rest (review W2). The caption counts what is drawn.
 */
export function restTrendDays(snapshot: Pick<Snapshot, 'trend' | 'sweepAt'>, tz: string | undefined): TrendPoint[] {
  const sweepMs = fromIso(snapshot.sweepAt);
  const zone = tz && isValidTimeZone(tz) ? tz : 'UTC';
  const todayKey = Number.isFinite(sweepMs) ? localDayKey(sweepMs, zone) : undefined;
  return completeDays(snapshot.trend ?? [], todayKey);
}
