// src/views/Story/RatioWatch.tsx — Story beats "a change ships" and "watching" (PRD 8.9 beats 3–4): the
// changed pipeline's savings ratio, minute by minute, drawn as the meter reads it — one flat step per
// minute (the snapshot's per-flow series, point i = the minute starting windowEnd − (N − i) min).
//
//   before the change   the line in saved green, the commit diamond landing on the time axis
//                       (data-callout="change-marker") with a dashed rule up through the chart
//   after the change    the line steps down in the incident red, revealed left to right as the beat
//                       plays ("a live 171-second wait becomes the 10-second watching beat", SPEC 15);
//                       the gap under the baseline is shaded — the money now being lost
//
// SVG only (no canvas), explicit font family (PRD 8.8 item 1), colours from the --mr-* palette classes.
// Reduced motion: no drop-in, no reveal animation — the reveal jumps to where the beat is.

import { useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { t } from '../../copy/en.ts';
import { formatPct, formatTimeOfDay } from '../../lib/format.ts';
import { changeIndex, watchWindow } from './watchWindow.ts';

const MINUTE = 60_000;
const M = { top: 20, right: 24, bottom: 48, left: 56 };

function useSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 960, h: 360 });
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

export interface RatioWatchProps {
  /** savings ratio per minute, oldest first */
  values: readonly number[];
  /** end of the last minute (snapshot.windowEnd), epoch ms */
  endMs: number;
  /** when the change went live (deploy, else commit), epoch ms */
  changeMs: number;
  /** the commit is on the change timeline (the diamond has landed) */
  landed: boolean;
  /** 0 … 1 of the after-the-change part drawn */
  reveal: number;
  /** the ratio the pipeline held before the change (the incident's baseline) */
  baseline: number;
  /** what the shaded loss costs ("Losing $1,250 a day"), written into it once the line is drawn */
  lossLabel?: string;
  tz?: string;
  /** accessible description */
  label: string;
}

export function RatioWatch({ values, endMs, changeMs, landed, reveal, baseline, lossLabel, tz, label }: RatioWatchProps) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const { w, h } = useSize(wrap);
  // The change, framed (watchWindow.ts): a few steady minutes, then the minutes after it on ≥ 30 % of the width.
  const win = watchWindow(values, endMs, changeMs, baseline);
  const shown = values.slice(win.first);
  const n = shown.length;
  const startMs = win.startMs;
  const iw = Math.max(10, w - M.left - M.right);
  const ih = Math.max(10, h - M.top - M.bottom);
  const x = (ms: number) => M.left + ((ms - startMs) / (n * MINUTE || 1)) * iw;
  const y = (r: number) => M.top + (1 - (Math.min(1, Math.max(win.lo, r)) - win.lo) / (1 - win.lo || 1)) * ih;
  const base = M.top + ih;

  const clipId = `mr-rw-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const geo = (() => {
    // One flat step per minute; the change's own minute steps down AT the change (the deploy's second), not
    // at the minute's start, so the drop never appears to come before the diamond that marks the change.
    const cut = changeIndex(values.length, endMs, changeMs);
    const k = cut === null ? n : Math.max(0, Math.min(n, cut - win.first));
    const endX = x(endMs);
    const cutX = cut === null ? endX : Math.min(endX, Math.max(M.left, x(changeMs)));
    const steps = shown.map((v, i) => ({ v, a: x(startMs + i * MINUTE), b: x(startMs + (i + 1) * MINUTE) }));
    if (k < n) {
      if (k > 0) steps[k - 1].b = cutX;
      steps[k].a = cutX;
    }
    let d = '';
    steps.forEach((s, i) => {
      d += `${i === 0 ? 'M' : 'L'}${s.a.toFixed(2)},${y(s.v).toFixed(2)}L${s.b.toFixed(2)},${y(s.v).toFixed(2)}`;
    });
    // The lost area: between the baseline and the line, after the change.
    const after = steps.slice(k);
    let lost = '';
    let lowest = baseline;
    if (after.length > 0) {
      lost = `M${cutX.toFixed(2)},${y(baseline).toFixed(2)}`;
      for (const s of after) {
        lowest = Math.min(lowest, s.v);
        lost += `L${s.a.toFixed(2)},${y(Math.min(s.v, baseline)).toFixed(2)}L${s.b.toFixed(2)},${y(Math.min(s.v, baseline)).toFixed(2)}`;
      }
      lost += `L${endX.toFixed(2)},${y(baseline).toFixed(2)}Z`;
    }
    const last = shown[n - 1] ?? 0;
    return { d, cutX, lost, lowest, hasAfter: after.length > 0, last, changeX: x(changeMs), endX };
  })();

  const r = Math.min(1, Math.max(0, reveal));
  const timeTicks = [startMs, startMs + (n / 2) * MINUTE, endMs];
  const drawn = r >= 0.999;
  // The loss is named inside its own shading (centred under the baseline, above the line's lowest step) when
  // it fits there; on a narrow plot it sits over the dashed baseline at the right, clear of the line.
  const lossTop = y(baseline);
  const lossBottom = y(Math.max(win.lo, geo.lowest));
  const lossRef = useRef<SVGTextElement | null>(null);
  const [lossInside, setLossInside] = useState(true);
  useLayoutEffect(() => {
    const el = lossRef.current;
    if (!el) return;
    let width = 0;
    try {
      width = typeof el.getComputedTextLength === 'function' ? el.getComputedTextLength() : el.getBBox().width;
    } catch {
      return; // not laid out (jsdom): keep the default
    }
    const font = parseFloat(getComputedStyle(el).fontSize) || 16;
    const fits = width + 24 <= geo.endX - geo.cutX && font * 1.2 + 8 <= lossBottom - lossTop;
    setLossInside((prev) => (prev === fits ? prev : fits));
    // Re-measured whenever the room or the words change (the label mounts once the line is drawn).
  }, [lossLabel, drawn, geo.cutX, geo.endX, lossTop, lossBottom]);

  return (
    <div className="mr-rw" ref={wrap}>
      <svg className="mr-rw-svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
        <defs>
          <clipPath id={`${clipId}-before`}>
            {/* Stops just short of the cut, so the step down at the change is drawn in the incident colour. */}
            <rect x={0} y={0} width={Math.max(0, geo.cutX - 3)} height={h} />
          </clipPath>
          <clipPath id={`${clipId}-after`}>
            {/*
              Revealed left to right as the beat plays: the full after-the-change rect, scaled from the cut (a transform,
              not an animated width, P1-C05); .mr-rw-reveal smooths the clock's 100 ms steps.
            */}
            <rect
              x={geo.cutX}
              y={0}
              width={Math.max(0, geo.endX - geo.cutX) + 2}
              height={h}
              className="mr-rw-reveal"
              style={{ transformOrigin: `${geo.cutX}px 0px`, transform: `scaleX(${r})` }}
            />
          </clipPath>
        </defs>

        {win.ticks.map((v) => (
          <g key={v} className="mr-rw-grid">
            <line x1={M.left} x2={M.left + iw} y1={y(v)} y2={y(v)} />
            <text x={M.left - 12} y={y(v)} textAnchor="end" dominantBaseline="middle">
              {formatPct(v)}
            </text>
          </g>
        ))}
        {timeTicks.map((ms, i) => (
          <text key={i} className="mr-rw-time" x={x(ms)} y={base + 30} textAnchor={i === 0 ? 'start' : i === timeTicks.length - 1 ? 'end' : 'middle'}>
            {formatTimeOfDay(ms, tz)}
          </text>
        ))}

        {/* The baseline the pipeline held: dashed on through the change, so the drop reads against it. */}
        <line className="mr-rw-baseline" x1={M.left} x2={M.left + iw} y1={y(baseline)} y2={y(baseline)} />

        <path className="mr-rw-line mr-rw-line--before" d={geo.d} clipPath={`url(#${clipId}-before)`} />
        <path className="mr-rw-lost" d={geo.lost} clipPath={`url(#${clipId}-after)`} />
        <path className="mr-rw-line mr-rw-line--after" d={geo.d} clipPath={`url(#${clipId}-after)`} />

        <text className="mr-rw-value mr-rw-value--before" x={M.left + 8} y={y(baseline) - 14}>
          {formatPct(baseline)}
        </text>
        {drawn ? (
          <text className="mr-rw-value mr-rw-value--after" x={geo.endX - 4} y={y(geo.last) + 34} textAnchor="end">
            {formatPct(geo.last)}
          </text>
        ) : null}
        {drawn && lossLabel && geo.hasAfter ? (
          lossInside ? (
            <text ref={lossRef} className="mr-rw-loss" data-place="inside" x={(geo.cutX + geo.endX) / 2} y={(lossTop + lossBottom) / 2} textAnchor="middle" dominantBaseline="middle">
              {lossLabel}
            </text>
          ) : (
            <text ref={lossRef} className="mr-rw-loss" data-place="above" x={geo.endX - 4} y={lossTop - 14} textAnchor="end">
              {lossLabel}
            </text>
          )
        ) : null}

        {landed ? (
          <g className="mr-rw-change">
            <line className="mr-rw-rule" x1={geo.changeX} x2={geo.changeX} y1={M.top} y2={base} />
            <path
              className="mr-rw-diamond"
              data-callout="change-marker"
              d={`M${geo.changeX},${base - 9}L${geo.changeX + 9},${base}L${geo.changeX},${base + 9}L${geo.changeX - 9},${base}Z`}
            />
          </g>
        ) : null}
      </svg>
      <span className="mr-visually-hidden">{t('ledger.timeline.legendRatio')}</span>
    </div>
  );
}
