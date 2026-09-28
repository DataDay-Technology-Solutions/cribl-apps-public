// src/components/Sparkline/Sparkline.tsx — a single-stroke trend line with no axes (PRD 8.8 item 6).
//
// Colour is semantic and comes from the money palette through CSS classes (never hard-coded):
// 'saved' green for a healthy savings ratio, the incident red / amber when the row is alerting,
// 'neutral' grey for unpriced or learning flows.

import { memo, useMemo } from 'react';
import { sparkPath, sparkTailPath } from './path.ts';
import './Sparkline.css';

export type SparklineTone = 'saved' | 'incident-high' | 'incident-medium' | 'neutral';

export interface SparklineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  /** value range drawn top to bottom; defaults to a savings ratio's [0, 1] */
  domain?: readonly [number, number];
  tone?: SparklineTone;
  /** Accessible name. Without one the sparkline is decorative (aria-hidden). */
  label?: string;
  strokeWidth?: number;
  /**
   * Index of the first point after the newest commit (P2-W17): the line before it is drawn neutral and only the
   * stretch after it in `tone`, so the row shows what the latest change did. Omitted, 0 or less: all in `tone`.
   */
  toneFrom?: number;
}

const RATIO_DOMAIN = [0, 1] as const;

function SparklineImpl({
  values,
  width = 88,
  height = 24,
  domain = RATIO_DOMAIN,
  tone = 'saved',
  label,
  strokeWidth = 1.5,
  toneFrom,
}: SparklineProps) {
  const d = useMemo(() => sparkPath(values, { width, height, domain, inset: strokeWidth }), [values, width, height, domain, strokeWidth]);
  const split = toneFrom !== undefined && toneFrom > 0;
  const tail = useMemo(
    () => (split ? sparkTailPath(values, { width, height, domain, inset: strokeWidth }, (toneFrom ?? 0) - 1) : ''),
    [split, values, width, height, domain, strokeWidth, toneFrom],
  );
  return (
    <svg
      className={`mr-sparkline mr-sparkline--${tone}${split ? ' mr-sparkline--split' : ''}`}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {d ? (
        <path
          className={split ? 'mr-sparkline-before' : undefined}
          d={d}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      {tail ? (
        <path
          className="mr-sparkline-after"
          d={tail}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}

/** Memoized: rows re-render on scroll, the path only when its values change. */
export const Sparkline = memo(SparklineImpl);
