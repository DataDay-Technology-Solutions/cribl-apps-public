// src/components/RatioWatch/RatioWatch.tsx — the drop, drawn, on the incident cards (P2-W15). The alert is told in
// numbers ("75% → 50%"); this is the picture the Story's "watching" beat draws, one click away in the product:
// the savings ratio minute by minute, the baseline it held (dashed), the change's diamond on the time axis, the line
// stepping down in the incident red after it with the loss shaded — and, on the green card, back up in green.
//
//   variant 'takeover'  under the before → after figures on the stage card: the shape alone (the figures above it
//                       name the levels; the card names the deploy), stage-scaled strokes
//   variant 'card'      the full incident card (Demo Console, the gallery): the baseline's value and the window's
//                       first and last times as labels
//
// SVG only, drawn in real pixels (a ResizeObserver measures the box, so the diamond is never stretched), an explicit
// font family, colours from the --mr-* palette; nothing moves (reduced motion needs nothing). IncidentRatioWatch
// reads the snapshot from the store when there is one (a card rendered outside the app shows no chart).

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { Incident, Snapshot } from '../../../core/types.ts';
import { t } from '../../copy/en.ts';
import { formatPct, formatTimeOfDay } from '../../lib/format.ts';
import { useOptionalStoreApi } from '../../state/react.tsx';
import { ratioGeometry, type RatioPlot } from './geometry.ts';
import { incidentSeries, type IncidentSeries } from './series.ts';
import './RatioWatch.css';

export type RatioWatchVariant = 'takeover' | 'card';

const PLOT_MARGIN: Record<RatioWatchVariant, RatioPlot['margin']> = {
  takeover: { top: 6, right: 6, bottom: 10, left: 6 },
  card: { top: 10, right: 8, bottom: 22, left: 40 },
};

function useSize(ref: RefObject<HTMLElement | null>, fallback: { w: number; h: number }): { w: number; h: number } {
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize((s) => (Math.abs(s.w - r.width) < 0.5 && Math.abs(s.h - r.height) < 0.5 ? s : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export interface RatioWatchCardProps {
  series: IncidentSeries;
  variant?: RatioWatchVariant;
  tz?: string;
}

/** The chart for a series (presentational). Renders nothing when the change is outside the series. */
export function RatioWatchCard({ series, variant = 'card', tz }: RatioWatchCardProps) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const { w, h } = useSize(wrap, variant === 'takeover' ? { w: 480, h: 64 } : { w: 360, h: 120 });
  const margin = PLOT_MARGIN[variant];
  const g = ratioGeometry(series, { width: w, height: h, margin, axis: variant === 'takeover' ? 'tight' : 'quarters' });
  const recovered = series.closedMs !== undefined;
  const label = t(recovered ? 'incidents.watch.labelRecovered' : 'incidents.watch.label', {
    before: formatPct(series.baseline),
    time: formatTimeOfDay(series.changeMs, tz),
  });
  const clip = `mr-rwc-${variant}-${Math.round(series.changeMs)}`;
  return (
    <div
      ref={wrap}
      className={`mr-rw mr-rw--card mr-rw--${variant}`}
      data-testid="ratio-watch"
      data-start-ms={g ? Math.round(g.startMs) : undefined}
      data-end-ms={Math.round(series.endMs)}
      data-change-ms={Math.round(series.changeMs)}
    >
      {g ? (
        <svg className="mr-rw-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
          <defs>
            <clipPath id={`${clip}-before`}>
              <rect x={0} y={0} width={Math.max(0, g.changeX - 2)} height={h} />
            </clipPath>
            <clipPath id={`${clip}-after`}>
              <rect x={g.changeX - 2} y={0} width={Math.max(0, g.closeX - g.changeX + 2)} height={h} />
            </clipPath>
            <clipPath id={`${clip}-back`}>
              <rect x={g.closeX} y={0} width={Math.max(0, w - g.closeX)} height={h} />
            </clipPath>
          </defs>
          <line className="mr-rw-axis" x1={margin.left} x2={w - margin.right} y1={g.axisY} y2={g.axisY} />
          <line className="mr-rw-baseline" x1={margin.left} x2={w - margin.right} y1={g.baselineY} y2={g.baselineY} />
          {g.lost ? <path className="mr-rw-lost" d={g.lost} /> : null}
          <path className="mr-rw-line mr-rw-line--before" d={g.line} clipPath={`url(#${clip}-before)`} />
          <path className="mr-rw-line mr-rw-line--after" d={g.line} clipPath={`url(#${clip}-after)`} />
          {recovered ? <path className="mr-rw-line mr-rw-line--before" d={g.line} clipPath={`url(#${clip}-back)`} /> : null}
          <line className="mr-rw-rule" x1={g.changeX} x2={g.changeX} y1={margin.top} y2={g.axisY} />
          <path
            className="mr-rw-diamond"
            data-x={g.changeX.toFixed(2)}
            d={`M${g.changeX},${g.axisY - 6}L${g.changeX + 6},${g.axisY}L${g.changeX},${g.axisY + 6}L${g.changeX - 6},${g.axisY}Z`}
          />
          {variant === 'card' ? (
            <>
              <text className="mr-rw-value mr-rw-value--before" x={margin.left - 6} y={g.baselineY} textAnchor="end" dominantBaseline="middle">
                {formatPct(series.baseline)}
              </text>
              <text className="mr-rw-time" x={margin.left} y={h - 4} textAnchor="start">
                {formatTimeOfDay(g.startMs, tz)}
              </text>
              <text className="mr-rw-time" x={w - margin.right} y={h - 4} textAnchor="end">
                {formatTimeOfDay(series.endMs, tz)}
              </text>
            </>
          ) : null}
        </svg>
      ) : null}
    </div>
  );
}

const noopUnsubscribe = () => {};

/** The chart for an incident, from the store's snapshot; nothing outside the app or without a series. */
export function IncidentRatioWatch({
  incident,
  variant = 'card',
  tz,
}: {
  incident: Pick<Incident, 'type' | 'objectKey' | 'before' | 'commit' | 'caughtInSec' | 'openedAt' | 'closedAt'>;
  variant?: RatioWatchVariant;
  tz?: string;
}) {
  const store = useOptionalStoreApi();
  const subscribe = useCallback((listener: () => void) => (store ? store.subscribe(listener) : noopUnsubscribe), [store]);
  const getSnapshot = useCallback((): Snapshot | null => store?.getState().snapshot ?? null, [store]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const series = incidentSeries(snapshot, incident);
  return series ? <RatioWatchCard series={series} variant={variant} tz={tz} /> : null;
}
