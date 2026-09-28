// src/views/Ledger/strip.ts — the money strip's one derived figure (P2-W17): the workspace savings ratio's change
// over 24 h, from the snapshot's 5-minute ratio series. Pure, so the view and the tests share it.

import type { Snapshot } from '../../../core/types.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The "yesterday" bucket must sit within this of exactly 24 h before the newest one. */
const DELTA_SLACK = 15 * MINUTE;

/** The workspace savings ratio's change over 24 h from the ratio series, or undefined when the series is too short. */
export function ratioDayDelta(series: Snapshot['ratioSeries'] | undefined): number | undefined {
  const points = (series ?? []).map((p) => ({ t: Date.parse(p.t), r: p.ratio })).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.r));
  if (points.length < 2) return undefined;
  const last = points.reduce((a, b) => (b.t > a.t ? b : a));
  let best: { t: number; r: number } | undefined;
  for (const p of points) {
    const off = Math.abs(last.t - DAY - p.t);
    if (off <= DELTA_SLACK && (!best || off < Math.abs(last.t - DAY - best.t))) best = p;
  }
  return best ? last.r - best.r : undefined;
}
