// src/components/Heatmap/Heatmap.tsx — when the savings happen (P2-W25): the last 168 hours as a 7 × 24 SVG grid,
// Monday first, one real hour per cell (core/heatmap.ts). Each cell is the money green at an opacity that follows
// the hour's saved dollars (a single-hue ramp: the saved tint is the only colour); an hour with nothing metered is
// an outline. The three biggest hours carry a rank and are listed under the grid with their figures; the weekend
// rows sit on a faint band. Pointer or arrow keys move a read-out of the hour's three figures. No canvas.

import { useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Heatmap as HeatmapData, HeatCell } from '../../../core/heatmap.ts';
import { footMoney } from '../../../core/format.ts';
import { t } from '../../copy/en.ts';
import { formatMoney } from '../../lib/format.ts';
import './Heatmap.css';

export interface HeatmapProps {
  data: HeatmapData;
  /** What the map is for ("siem-prod"): its accessible name. */
  label: string;
}

const CELL = 18;
const GAP = 2;
const LEFT = 36;
const TOP = 16;

/** Mon … Sun, short, in the viewer's locale (formatting, not copy). */
const DAYS = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 8, 21 + i))));

const HOUR_FMT = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'UTC' });
/** "12 AM", "6 PM" (formatting, not copy). */
function hourWords(hour: number): string {
  return HOUR_FMT.format(new Date(Date.UTC(2026, 0, 1, hour)));
}

function when(c: HeatCell): string {
  return `${DAYS[c.day]} ${hourWords(c.hour)}`;
}

/** The read-out's three figures add up to the dollar (core/format.ts footMoney), as every receipt in the App does. */
function readout(c: HeatCell): string {
  const shown = footMoney({ whpM: c.whpM, paidM: c.paidM, savedM: c.savedM });
  return t('receiptView.heatmap.readout', { when: when(c), saved: formatMoney(shown.savedM), whp: formatMoney(shown.whpM), paid: formatMoney(shown.paidM) });
}

export function Heatmap({ data, label }: HeatmapProps) {
  const [active, setActive] = useState<number | null>(null);
  const width = LEFT + 24 * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);
  const rank = useMemo(() => new Map(data.top.map((i, r) => [i, r + 1])), [data.top]);
  const topCell = data.top.length > 0 ? data.cells[data.top[0]] : undefined;
  const name = topCell
    ? t('receiptView.heatmap.label', { label, top: when(topCell), amount: formatMoney(topCell.savedM) })
    : t('receiptView.heatmap.labelEmpty');
  const cell = active !== null ? data.cells[active] : undefined;

  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * width - LEFT;
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * height - TOP;
    const hour = Math.floor(x / (CELL + GAP));
    const day = Math.floor(y / (CELL + GAP));
    setActive(hour >= 0 && hour < 24 && day >= 0 && day < 7 ? day * 24 + hour : null);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 24, ArrowUp: -24 };
    if (e.key in moves) {
      e.preventDefault();
      setActive((cur) => {
        const start = cur ?? data.top[0] ?? 0;
        const next = start + moves[e.key];
        return next < 0 || next > 167 ? start : next;
      });
    } else if (e.key === 'Escape') setActive(null);
  };

  return (
    <div className="mr-heat" data-testid="heatmap">
      <svg
        className="mr-heat-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={name}
        tabIndex={0}
        onPointerMove={onPointer}
        onPointerLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
        onKeyDown={onKey}
      >
        {[5, 6].map((d) => (
          <rect key={`w${d}`} className="mr-heat-weekend" x={0} y={TOP + d * (CELL + GAP) - GAP / 2} width={width} height={CELL + GAP} rx={3} />
        ))}
        {DAYS.map((d, i) => (
          <text key={d} className="mr-heat-day" x={LEFT - 6} y={TOP + i * (CELL + GAP) + CELL / 2} dy="0.35em" textAnchor="end" data-weekend={i >= 5 ? 'true' : undefined}>
            {d}
          </text>
        ))}
        {[0, 6, 12, 18].map((h) => (
          <text key={h} className="mr-heat-hour" x={LEFT + h * (CELL + GAP)} y={TOP - 5}>
            {hourWords(h)}
          </text>
        ))}
        {data.cells.map((c, i) => {
          const x = LEFT + c.hour * (CELL + GAP);
          const y = TOP + c.day * (CELL + GAP);
          const share = data.maxSavedM > 0 ? c.savedM / data.maxSavedM : 0;
          const r = rank.get(i);
          return (
            <g key={i} data-testid="heat-cell" data-rank={r}>
              <rect
                className={c.rows === 0 ? 'mr-heat-cell mr-heat-cell--empty' : 'mr-heat-cell'}
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                rx={3}
                style={c.rows === 0 ? undefined : { fillOpacity: 0.1 + 0.9 * share }}
              />
              {r !== undefined ? (
                <text className="mr-heat-rank" x={x + CELL / 2} y={y + CELL / 2} dy="0.35em" textAnchor="middle" data-dark={share > 0.55 ? 'true' : undefined}>
                  {r}
                </text>
              ) : null}
              {active === i ? <rect className="mr-heat-focus" x={x - 1.5} y={y - 1.5} width={CELL + 3} height={CELL + 3} rx={4} /> : null}
            </g>
          );
        })}
      </svg>
      <p className="mr-heat-readout" role="status" aria-live="polite" data-testid="heat-readout">
        {cell
          ? cell.rows === 0
            ? t('receiptView.heatmap.readoutEmpty', { when: when(cell) })
            : readout(cell)
          : t('receiptView.heatmap.hint')}
      </p>
      <div className="mr-heat-foot">
        {data.top.length > 0 ? (
          <ol className="mr-heat-top" aria-label={t('receiptView.heatmap.topLabel')}>
            {data.top.map((i, r) => (
              <li key={i}>{t('receiptView.heatmap.top', { rank: r + 1, when: when(data.cells[i]), amount: formatMoney(data.cells[i].savedM) })}</li>
            ))}
          </ol>
        ) : null}
        <span className="mr-heat-scale" aria-hidden="true">
          {t('receiptView.heatmap.scaleLow')}
          <span className="mr-heat-scale-ramp" />
          {t('receiptView.heatmap.scaleHigh')}
        </span>
      </div>
    </div>
  );
}
