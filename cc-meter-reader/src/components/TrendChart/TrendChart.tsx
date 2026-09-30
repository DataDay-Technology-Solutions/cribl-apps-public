// src/components/TrendChart/TrendChart.tsx — "Saved over the last 30 days" (DESIGN_BRIEF 5.1 row 2):
// an SVG area of saved per day (d3-shape), faint diamonds on the x axis where a config deploy landed,
// and a hover / keyboard read-out. Only whole days are drawn: today is partial (the hero carries it), and
// a half-finished day would read as a crash. Fewer than two whole days → a designed learning state.
//
// The axis starts the day collecting began (P0-18): days before it are never drawn as $0, so a workspace a
// few days old shows those days across the chart, not four weeks of flat zero and a cliff. A first day that
// began mid-day is drawn with a hollow point and says "Partial day: metered from 2:20 AM" in its read-out.
// Days collected but nothing saved on any of them → a $0 / $50 / $100 grid and one sentence, not a flat line.
//
// Colours come from CSS classes over the --mr-* palette (money green for saved; chart chrome from the
// semantic tokens); the SVG sets its own font family (PRD 8.8 item 1). No canvas.

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { area, curveMonotoneX, line } from 'd3-shape';
import type { Commit, TrendPoint } from '../../../core/types.ts';
import { footMoney } from '../../../core/format.ts';
import { DAY_MS, formatLocalMonthDay, localDayStartMs } from '../../../core/time.ts';
import { t, tn } from '../../copy/en.ts';
import { commitAuthor } from '../../lib/author.ts';
import { formatAxisMoney, formatMoney, formatPct } from '../../lib/format.ts';
import { formatLocalTime } from '../../../core/time.ts';
import { EMPTY_AXIS_MAX, collectedDays, deployMarkers, linear, nearestIndex, niceMax, nothingSaved, type DeployMarker, type TrendAnnotation } from './trendMath.ts';
import './TrendChart.css';

export interface TrendChartProps {
  /** Last 30 local days, oldest first (snapshot.trend); the last may be today (partial). */
  points: TrendPoint[];
  /** Today's local day key, so the partial day is drawn as such. */
  todayKey?: string;
  /** Commits to mark (snapshot.timeline). */
  commits: Commit[];
  /** Display timezone for day labels and deploy placement. */
  tz: string;
  /** When collecting began (snapshot.collectingSince): no day before it is drawn, and a mid-day start is partial. */
  collectingSinceMs?: number;
  /** Plot height in px (default 200). */
  height?: number;
  /**
   * P2-W07 (c): the largest priced configuration change in the window (core/commitImpacts.ts largestImpact), labelled
   * at its diamond: "−$1,219 / day · 22d0a5e", red for a loss, green for a gain. Omitted: no label.
   */
  annotation?: TrendAnnotation;
}

/** 12 px Open Sans 600 runs about 6.6 px a character: the plate is sized from it (the text never is). */
const CHAR_PX = 6.6;
const PLATE_PAD = 6;
const PLATE_H = 22;

/** A diamond centred on (cx, cy). */
const diamond = (cx: number, cy: number, r = 4.5): string => `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`;

const M = { top: 12, right: 12, bottom: 34, left: 52 };
const DEFAULT_WIDTH = 720;

function dayLabel(dayKey: string, tz: string): string {
  return formatLocalMonthDay(localDayStartMs(dayKey, tz) + DAY_MS / 2, tz);
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export function TrendChart({ points, todayKey, commits, tz, collectingSinceMs, height = 200, annotation }: TrendChartProps) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const noteId = useId();
  const collected = useMemo(() => collectedDays(points, todayKey, collectingSinceMs, tz), [points, todayKey, collectingSinceMs, tz]);
  const whole = collected.days;
  const learning = whole.length < 2;
  const empty = !learning && nothingSaved(whole);

  const geo = useMemo(() => {
    const innerW = Math.max(10, width - M.left - M.right);
    const n = whole.length;
    const x = linear(0, Math.max(1, n - 1), M.left, M.left + innerW);
    const top = Math.max(0, ...whole.map((p) => p.savedM));
    // Nothing saved on any day: a $0 / $50 / $100 grid under the empty state's sentence (P0-18).
    const max = top > 0 ? niceMax(top) : EMPTY_AXIS_MAX;
    const y = linear(0, max, M.top + height, M.top);
    const base = M.top + height;
    const areaPath =
      area<TrendPoint>()
        .x((_, i) => x(i))
        .y0(base)
        .y1((p) => y(p.savedM))
        .curve(curveMonotoneX)(whole) ?? '';
    const linePath =
      line<TrendPoint>()
        .x((_, i) => x(i))
        .y((p) => y(p.savedM))
        .curve(curveMonotoneX)(whole) ?? '';
    const ticks = [0, max / 2, max];
    const markers: DeployMarker[] = deployMarkers(whole, commits, tz);
    // A few days (a young workspace) label every day; a month labels its ends and middle.
    const labelIdx = n <= 1 ? [0] : n <= 5 ? Array.from({ length: n }, (_, i) => i) : [...new Set([0, Math.round((n - 1) / 2), n - 1])];
    return { x, y, base, areaPath, linePath, ticks, markers, labelIdx, innerW };
  }, [whole, width, height, commits, tz]);

  // The annotation (P2-W07 c): at the change's diamond, or — a change that landed today, after the last whole day
  // — at a diamond just past the line's end. The plate sits beside the diamond's rule, at the first height where it
  // clears the line (above it, else inside the area under it), never over the axis or the line's points.
  const note = useMemo(() => {
    if (!annotation || !(annotation.perDayM !== 0) || whole.length < 2 || nothingSaved(whole)) return undefined;
    const hash = annotation.hash.slice(0, 7);
    const marker = geo.markers.find((m) => m.hash === annotation.hash) ?? geo.markers.find((m) => m.hash.slice(0, 7) === hash);
    const lastEndMs = localDayStartMs(whole[whole.length - 1].day, tz) + DAY_MS;
    const plotRight = M.left + geo.innerW;
    let ax: number;
    let today = false;
    if (marker) ax = geo.x(Math.min(whole.length - 1, marker.x));
    else if (annotation.t >= lastEndMs) {
      ax = plotRight + 6;
      today = true;
    } else return undefined;
    const amount = formatMoney(annotation.perDayM, { signed: true });
    const text = t(today ? 'receiptView.trend.annotationToday' : 'receiptView.trend.annotation', { amount, hash });
    const labelW = Math.ceil(text.length * CHAR_PX) + 2 * PLATE_PAD;
    // The line, sampled every few pixels (the monotone curve stays within its points' span).
    const samples: [number, number][] = [];
    for (let i = 0; i < whole.length; i++) {
      const x0 = geo.x(i);
      const y0 = geo.y(whole[i].savedM);
      samples.push([x0, y0]);
      if (i + 1 < whole.length) {
        const x1 = geo.x(i + 1);
        const y1 = geo.y(whole[i + 1].savedM);
        const steps = Math.max(1, Math.ceil((x1 - x0) / 4));
        for (let k = 1; k < steps; k++) samples.push([x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps]);
      }
    }
    const clamp = (x: number) => Math.max(M.left + 2, Math.min(plotRight - labelW, x));
    const xs = [...new Set([clamp(ax - 8 - labelW), clamp(ax + 8)])];
    const under = (x: number) => samples.filter(([px]) => px >= x - 4 && px <= x + labelW + 4).map(([, py]) => py);
    const top = M.top + 2;
    const bottom = geo.base - 4 - PLATE_H;
    let spot: { x: number; y: number } | undefined;
    // Above the line: the highest plate whose whole span keeps clear of it.
    for (const x of xs) {
      const ys = under(x);
      const highest = ys.length > 0 ? Math.min(...ys) : geo.base;
      if (highest - 4 - PLATE_H >= top) {
        spot = { x, y: top };
        break;
      }
    }
    // Else inside the area under it (the plate covers green, never the line or the axis).
    if (!spot) {
      for (const x of xs) {
        const ys = under(x);
        const lowest = ys.length > 0 ? Math.max(...ys) : M.top;
        if (lowest + 4 <= bottom) {
          spot = { x, y: bottom };
          break;
        }
      }
    }
    if (!spot) return undefined;
    return { ax, today, amount, hash, text, labelW, plateX: spot.x, plateY: spot.y, tone: annotation.perDayM > 0 ? 'up' : 'down' } as const;
  }, [annotation, whole, geo, tz]);

  const svgH = M.top + height + M.bottom;
  const count = whole.length;
  const activePoint = active !== null && active >= 0 && active < count ? whole[active] : null;

  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / Math.max(1, rect.width)) * width;
    const frac = ((px - M.left) / Math.max(1, geo.innerW)) * Math.max(1, count - 1);
    setActive(nearestIndex(frac, count));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setActive((cur) => {
        const start = cur ?? count - 1;
        return Math.min(count - 1, Math.max(0, start + (e.key === 'ArrowRight' ? 1 : -1)));
      });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : count - 1);
    } else if (e.key === 'Escape') setActive(null);
  };

  if (learning) {
    // The dashed ghost runs through the lower half and the sentence sits in the empty band above the midline, so
    // nothing needs a plate: the ghost stays one continuous line and the gridlines stay whole (P1-H06).
    const days = whole.length;
    const band = { left: M.left, right: M.right, top: M.top, height: height / 2 };
    return (
      <div className="mr-trend mr-trend--learning" ref={wrapRef} data-state="learning" data-testid="trend-learning">
        <svg
          className="mr-trend-svg"
          width="100%"
          height={svgH}
          viewBox={`0 0 ${width} ${svgH}`}
          role="img"
          aria-label={t('receiptView.trend.chartLabel', { days: tn('receiptView.trend.chartDays', days) })}
          focusable="false"
        >
          {[0, 0.5, 1].map((f) => (
            <line key={f} className="mr-trend-grid" x1={M.left} x2={width - M.right} y1={M.top + height * f} y2={M.top + height * f} />
          ))}
          <path
            className="mr-trend-ghost"
            data-testid="trend-ghost"
            d={`M${M.left},${M.top + height * 0.9} C${M.left + geo.innerW * 0.3},${M.top + height * 0.84} ${M.left + geo.innerW * 0.6},${M.top + height * 0.74} ${width - M.right},${M.top + height * 0.6}`}
          />
        </svg>
        <div className="mr-trend-learning" style={{ left: band.left, right: band.right, top: band.top, height: band.height }}>
          <p className="mr-trend-learning-title">{t('receiptView.trend.learningTitle')}</p>
          <p className="mr-type-caption">
            {days > 0 ? tn('receiptView.trend.learningBody', days) : t('receiptView.trend.learningBodyNone')}
          </p>
        </div>
      </div>
    );
  }

  if (empty) {
    // Whole days are in and every one saved $0: the real axis ($0 / $50 / $100) and the days, one sentence, no line.
    return (
      <div className="mr-trend mr-trend--empty" ref={wrapRef} data-state="empty" data-testid="trend-empty" data-days={count}>
        <svg className="mr-trend-svg" width="100%" height={svgH} viewBox={`0 0 ${width} ${svgH}`} aria-hidden="true" focusable="false">
          {geo.ticks.map((v, i) => (
            <g key={i}>
              <line className="mr-trend-grid" x1={M.left} x2={width - M.right} y1={geo.y(v)} y2={geo.y(v)} />
              <text className="mr-trend-ylabel mr-num" x={M.left - 10} y={geo.y(v)} dy="0.32em" textAnchor="end">
                {formatAxisMoney(v, geo.ticks[geo.ticks.length - 1] ?? 0)}
              </text>
            </g>
          ))}
          {geo.labelIdx.map((i) => (
            <text key={i} className="mr-trend-xlabel" x={geo.x(i)} y={geo.base + 26} textAnchor={i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle'}>
              {dayLabel(whole[i].day, tz)}
            </text>
          ))}
        </svg>
        <div className="mr-trend-learning mr-trend-empty">
          <p className="mr-trend-learning-title">{t('receiptView.trend.emptyTitle')}</p>
          <p className="mr-type-caption">{t('receiptView.trend.emptyBody')}</p>
        </div>
      </div>
    );
  }

  const tipDeploys = activePoint ? geo.markers.filter((m) => m.day === active) : [];
  // The read-out's money adds up: would have paid − paid = saved, to the dollar (core/format.ts footMoney).
  const tipMoney = activePoint ? footMoney({ whpM: activePoint.whpM, paidM: activePoint.paidM, savedM: activePoint.savedM }) : { whpM: 0, paidM: 0, savedM: 0 };
  const tipLeft = active !== null ? geo.x(active) : 0;
  const partialFrom = collected.firstPartialFromMs;

  return (
    <div className="mr-trend" ref={wrapRef} data-state="ready">
      <svg
        className="mr-trend-svg"
        width="100%"
        height={svgH}
        viewBox={`0 0 ${width} ${svgH}`}
        role="img"
        aria-label={t('receiptView.trend.chartLabel', { days: tn('receiptView.trend.chartDays', count) })}
        aria-describedby={note ? noteId : undefined}
        tabIndex={0}
        onPointerMove={onPointer}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
        data-testid="trend-chart"
        data-first-day={whole[0]?.day}
        data-days={count}
        data-partial-first={partialFrom !== undefined ? 'true' : undefined}
      >
        {geo.ticks.map((v, i) => (
          <g key={i}>
            <line className="mr-trend-grid" x1={M.left} x2={width - M.right} y1={geo.y(v)} y2={geo.y(v)} />
            <text className="mr-trend-ylabel mr-num" x={M.left - 10} y={geo.y(v)} dy="0.32em" textAnchor="end">
              {formatAxisMoney(v, geo.ticks[geo.ticks.length - 1] ?? 0)}
            </text>
          </g>
        ))}
        <path className="mr-trend-area" d={geo.areaPath} />
        <path className="mr-trend-line" d={geo.linePath} />
        {geo.labelIdx.map((i) => (
          <text
            key={i}
            className="mr-trend-xlabel"
            x={geo.x(i)}
            y={geo.base + 26}
            textAnchor={i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle'}
          >
            {dayLabel(whole[i].day, tz)}
          </text>
        ))}
        {note ? (
          <line className={`mr-trend-annotation-rule is-${note.tone}`} x1={note.ax} x2={note.ax} y1={note.plateY + PLATE_H / 2} y2={geo.base + 3} aria-hidden="true" />
        ) : null}
        {geo.markers.map((m) => {
          const cx = geo.x(Math.min(count - 1, m.x));
          const cy = geo.base + 8;
          const annotated = note && !note.today && m.hash.slice(0, 7) === note.hash;
          return (
            <path
              key={`${m.hash}-${m.atMs}`}
              className={annotated ? `mr-trend-deploy mr-trend-deploy--annotated is-${note.tone}` : 'mr-trend-deploy'}
              data-callout="change-marker"
              d={diamond(cx, cy)}
            />
          );
        })}
        {note ? (
          <g
            className={`mr-trend-annotation is-${note.tone}`}
            data-testid="trend-annotation"
            data-hash={note.hash}
            data-amount={note.amount}
            data-tone={note.tone}
            data-today={note.today ? 'true' : undefined}
            aria-hidden="true"
          >
            {note.today ? <path className={`mr-trend-deploy mr-trend-deploy--annotated is-${note.tone}`} d={diamond(note.ax, geo.base + 8)} /> : null}
            <rect className="mr-trend-annotation-plate" x={note.plateX} y={note.plateY} width={note.labelW} height={PLATE_H} rx={4} />
            <text className="mr-trend-annotation-text mr-num" x={note.plateX + PLATE_PAD} y={note.plateY + PLATE_H / 2} dy="0.35em">
              {note.text}
            </text>
          </g>
        ) : null}
        {partialFrom !== undefined ? <circle className="mr-trend-partial" data-testid="trend-partial" cx={geo.x(0)} cy={geo.y(whole[0].savedM)} r={4} /> : null}
        {activePoint ? (
          <g className="mr-trend-cursor" aria-hidden="true">
            <line x1={tipLeft} x2={tipLeft} y1={M.top} y2={geo.base} />
            <circle cx={tipLeft} cy={geo.y(activePoint.savedM)} r={4.5} />
          </g>
        ) : null}
      </svg>
      {note ? (
        <p id={noteId} className="mr-visually-hidden" data-testid="trend-annotation-text">
          {t('receiptView.trend.annotationAria', { amount: note.amount, hash: note.hash })}
        </p>
      ) : null}
      {activePoint ? (
        <div
          className="mr-trend-tip"
          role="status"
          data-testid="trend-tip"
          data-side={tipLeft > width / 2 ? 'left' : 'right'}
          style={{ left: `${(tipLeft / width) * 100}%` }}
        >
          <p className="mr-trend-tip-day">{dayLabel(activePoint.day, tz)}</p>
          {active === 0 && partialFrom !== undefined ? (
            <p className="mr-trend-tip-partial mr-type-caption">{t('receiptView.trend.tipPartial', { time: formatLocalTime(partialFrom, tz) })}</p>
          ) : null}
          <dl className="mr-trend-tip-rows">
            <div className="mr-trend-tip-saved">
              <dt>{t('receiptView.trend.tipSaved')}</dt>
              <dd className="mr-num">{formatMoney(tipMoney.savedM)}</dd>
            </div>
            <div>
              <dt>{t('receiptView.trend.tipWhp')}</dt>
              <dd className="mr-num">{formatMoney(tipMoney.whpM)}</dd>
            </div>
            <div>
              <dt>{t('receiptView.trend.tipPaid')}</dt>
              <dd className="mr-num">{formatMoney(tipMoney.paidM)}</dd>
            </div>
          </dl>
          <p className="mr-trend-tip-ratio mr-num">
            {t('receiptView.trend.tipRatio', { pct: formatPct(activePoint.whpM > 0 ? activePoint.savedM / activePoint.whpM : 0) })}
          </p>
          {tipDeploys.length > 0 ? (
            <ul className="mr-trend-tip-deploys">
              {tipDeploys.slice(0, 2).map((m) => (
                <li key={`${m.hash}-${m.atMs}`}>
                  <span className="mr-trend-tip-diamond" aria-hidden="true" />
                  {t('receiptView.trend.tipDeploy', { hash: m.hash.slice(0, 7), message: m.message, author: commitAuthor(m.author) })}
                </li>
              ))}
              {tipDeploys.length > 2 ? <li className="mr-type-caption">{tn('receiptView.trend.tipMoreDeploys', tipDeploys.length - 2)}</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}
      <div className="mr-trend-legend" aria-hidden="true">
        <span className="mr-trend-legend-item">
          <span className="mr-trend-legend-swatch" />
          {t('receiptView.trend.legendSaved')}
        </span>
        {geo.markers.length > 0 ? (
          <span className="mr-trend-legend-item">
            <span className="mr-trend-legend-diamond" />
            {t('receiptView.trend.legendDeploy')}
          </span>
        ) : null}
        {partialFrom !== undefined ? (
          <span className="mr-trend-legend-item" data-testid="trend-legend-partial">
            <span className="mr-trend-legend-partial" />
            {t('receiptView.trend.legendPartial')}
          </span>
        ) : null}
      </div>
    </div>
  );
}
