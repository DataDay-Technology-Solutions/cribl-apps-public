// src/components/RatioWatch/geometry.ts — the drawn drop for an incident card (P2-W15), pure: where each part of
// the chart goes in a plot of a given pixel size.
//
//   · the savings ratio minute by minute (one flat step per minute), framed around the change (watchWindow.ts);
//   · the baseline the pipeline held (incident.before), dashed on through the change;
//   · the change's diamond at the deploy's second on the time axis;
//   · after the change, the line in the incident red and the gap under the baseline shaded — the money being lost;
//   · after the close (a recovery), the line back in saved green and the shading ended.
//
// The chart draws the flow's own sparkline (snapshot.flows[].sparkline, point i = the minute starting
// windowEnd − (N − i) min), the same series the Story's "watching" beat draws.

import { changeIndex, watchWindow } from './watchWindow.ts';

const MINUTE = 60_000;

export interface RatioPlot {
  width: number;
  height: number;
  margin: { top: number; right: number; bottom: number; left: number };
  /**
   * 'quarters' (default): the axis starts a quarter-step below the lowest reading and ends at 100 %, as the Story's
   * chart reads. 'tight': the axis spans only the readings and the baseline (a sixth of that span above and below),
   * so a drop fills a small chart's height — the takeover's, which names the levels in its figures above.
   */
  axis?: 'quarters' | 'tight';
}

export interface RatioGeometryInput {
  /** savings ratio per minute, oldest first */
  values: readonly number[];
  /** end of the last minute (snapshot.windowEnd), epoch ms */
  endMs: number;
  /** when the change went live (deploy, else commit, else the first minute that showed the drop), epoch ms */
  changeMs: number;
  /** when the incident closed, epoch ms (a recovery); NaN or absent while open */
  closedMs?: number;
  /** the ratio held before the change */
  baseline: number;
}

export interface RatioGeometry {
  /** the whole line, one flat step per minute */
  line: string;
  /** the shaded loss: between the baseline and the line, from the change to the close (or the end) */
  lost: string;
  /** x of the change (the diamond), and of the close (or the end) */
  changeX: number;
  closeX: number;
  endX: number;
  startMs: number;
  /** y of the baseline */
  baselineY: number;
  /** the plot's bottom (the time axis) */
  axisY: number;
  /** the lowest reading shown after the change */
  lowest: number;
  lo: number;
}

/** The geometry, or null when there is nothing to draw (fewer than 3 minutes, or the change is not in the series). */
export function ratioGeometry(input: RatioGeometryInput, plot: RatioPlot): RatioGeometry | null {
  const { values, endMs, changeMs, baseline } = input;
  if (values.length < 3 || !Number.isFinite(endMs) || !Number.isFinite(changeMs) || !Number.isFinite(baseline)) return null;
  const cut = changeIndex(values.length, endMs, changeMs);
  if (cut === null) return null;
  const win = watchWindow(values, endMs, changeMs, baseline);
  const shown = values.slice(win.first);
  const n = shown.length;
  const { top, right, bottom, left } = plot.margin;
  const iw = Math.max(10, plot.width - left - right);
  const ih = Math.max(10, plot.height - top - bottom);
  const x = (ms: number) => left + ((ms - win.startMs) / (n * MINUTE || 1)) * iw;
  let lo = win.lo;
  let hi = 1;
  if (plot.axis === 'tight') {
    const readings = [...shown.filter((v) => Number.isFinite(v)), baseline];
    const min = Math.min(...readings);
    const max = Math.max(...readings);
    const pad = Math.max(0.01, (max - min) / 6);
    lo = Math.max(0, min - pad);
    hi = Math.min(1, max + pad);
  }
  const y = (r: number) => top + (1 - (Math.min(hi, Math.max(lo, r)) - lo) / (hi - lo || 1)) * ih;
  const endX = x(endMs);
  const changeX = Math.min(endX, Math.max(left, x(changeMs)));
  const closedMs = input.closedMs;
  const closeX = closedMs !== undefined && Number.isFinite(closedMs) && closedMs < endMs ? Math.max(changeX, x(closedMs)) : endX;

  // Steps, with the change's own minute split at the change so the drop never appears before the diamond.
  const k = Math.max(0, Math.min(n, cut - win.first));
  const steps = shown.map((v, i) => ({ v, a: x(win.startMs + i * MINUTE), b: x(win.startMs + (i + 1) * MINUTE) }));
  if (k < n) {
    if (k > 0) steps[k - 1].b = changeX;
    steps[k].a = changeX;
  }
  let line = '';
  steps.forEach((s, i) => {
    line += `${i === 0 ? 'M' : 'L'}${s.a.toFixed(2)},${y(s.v).toFixed(2)}L${s.b.toFixed(2)},${y(s.v).toFixed(2)}`;
  });

  // The loss: under the baseline, from the change to the close.
  let lost = '';
  let lowest = baseline;
  const inLoss = steps.slice(k).filter((s) => s.a < closeX);
  if (inLoss.length > 0) {
    lost = `M${changeX.toFixed(2)},${y(baseline).toFixed(2)}`;
    for (const s of inLoss) {
      const b = Math.min(s.b, closeX);
      lowest = Math.min(lowest, s.v);
      const yy = y(Math.min(s.v, baseline)).toFixed(2);
      lost += `L${s.a.toFixed(2)},${yy}L${b.toFixed(2)},${yy}`;
    }
    lost += `L${closeX.toFixed(2)},${y(baseline).toFixed(2)}Z`;
  }
  return { line, lost, changeX, closeX, endX, startMs: win.startMs, baselineY: y(baseline), axisY: top + ih, lowest, lo };
}
