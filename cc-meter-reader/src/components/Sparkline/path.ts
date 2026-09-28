// src/components/Sparkline/path.ts — the sparkline's geometry, pure (PRD 8.8 item 6: a single stroke, no axes).

import { curveMonotoneX, line } from 'd3-shape';

export interface SparkGeometry {
  width: number;
  height: number;
  /** value range mapped to the full height; values outside are clamped */
  domain: readonly [number, number];
  /** inset so a 1.5 px stroke is never clipped at the edges */
  inset: number;
}

const builder = line<[number, number]>()
  .x((p) => p[0])
  .y((p) => p[1])
  .curve(curveMonotoneX);

/**
 * SVG path data for `values` in a width × height box. Non-finite values are dropped. One value draws a
 * flat line across the box (a steady flow is still a trend); none returns ''.
 */
export function sparkPath(values: readonly number[], g: SparkGeometry): string {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return '';
  const [lo, hi] = g.domain[0] <= g.domain[1] ? g.domain : [g.domain[1], g.domain[0]];
  const span = hi - lo || 1;
  const top = g.inset;
  const bottom = g.height - g.inset;
  const left = g.inset;
  const right = g.width - g.inset;
  const y = (v: number): number => {
    const clamped = Math.min(hi, Math.max(lo, v));
    return round(bottom - ((clamped - lo) / span) * (bottom - top));
  };
  if (finite.length === 1) {
    const yy = y(finite[0]);
    return `M${round(left)},${yy}L${round(right)},${yy}`;
  }
  const step = (right - left) / (finite.length - 1);
  const points = finite.map((v, i) => [round(left + i * step), y(v)] as [number, number]);
  return builder(points) ?? '';
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The path of the stretch from index `from` to the end (P2-W17: the segment after the newest commit, drawn in the
 * row's colour over a neutral whole). Same geometry as sparkPath; '' when the stretch has fewer than two points.
 */
export function sparkTailPath(values: readonly number[], g: SparkGeometry, from: number): string {
  const finite = values.filter((v) => Number.isFinite(v));
  const start = Math.max(0, Math.floor(from));
  if (finite.length < 2 || start >= finite.length - 1) return '';
  const [lo, hi] = g.domain[0] <= g.domain[1] ? g.domain : [g.domain[1], g.domain[0]];
  const span = hi - lo || 1;
  const top = g.inset;
  const bottom = g.height - g.inset;
  const left = g.inset;
  const right = g.width - g.inset;
  const step = (right - left) / (finite.length - 1);
  const y = (v: number): number => round(bottom - ((Math.min(hi, Math.max(lo, v)) - lo) / span) * (bottom - top));
  const points = finite.map((v, i) => [round(left + i * step), y(v)] as [number, number]).slice(start);
  return builder(points) ?? '';
}

/** First and last finite values (the sparkline's accessible summary). */
export function sparkEnds(values: readonly number[]): { first: number; last: number } | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  return { first: finite[0], last: finite[finite.length - 1] };
}
