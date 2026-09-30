// src/components/LedgerTable/LedgerTable.tsx — the Ledger's virtualized flow table (PRD 8.3, 8.8 item 6).
//
// One scroll container holds a sticky header, the virtualized rows (@tanstack/react-virtual, fixed row
// heights so scrolling never measures) and a sticky totals row. Three layouts follow the table's own
// width, not the viewport, so it behaves the same inside any Cribl frame:
//   wide    ≈ 1170 px+  Source · [Route] · Pipeline · Destination · [Worker group] · In · Out · Reduction ·
//                       Would have paid · Paid · Saved · Trend · Status  (SPEC 17 columns + PRD 8.3 figures)
//   medium  ≈ 760 px+   Flow (pipeline over "source → destination") · Reduction · [Would have paid] · Paid ·
//                       Saved · Trend · Status
//   narrow  < 760 px    one card per flow: pipeline + status, the path, saved / day, reduction, trend
// The bracketed columns come and go with the rows and the room (layout.ts planColumns, P1-K01): Route only where
// a listed route is named differently from its source, Worker group only across groups on a wide table, Would
// have paid in the medium layout from about 960 px. The plan's grid template is set once on the table
// (--mr-lt-cols), so the header, every row and the totals row line up to the pixel.
// Numbers are right-aligned tabular figures; units live in the header ("/ day"), never in the cells.
// Keyboard: rows are a roving tab stop — ↑ ↓ Home End PageUp PageDown move, Enter / Space select; Tab
// from a row reaches its "open in Cribl" link.

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUpRightFromSquare, CaretDownSolid, CaretUpSolid } from '@capra/icons';
import { footMoney } from '../../../core/format.ts';
import { t, tn } from '../../copy/en.ts';
import { formatInt, formatMoney, formatPct } from '../../lib/format.ts';
import { Bytes, Money, Pct } from '../common/Figures.tsx';
import { Sparkline, sparkEnds, type SparklineTone } from '../Sparkline/index.ts';
import { HEADER_HEIGHT, ROW_HEIGHT, TOTALS_HEIGHT, estimateLabelPx, estimateTwoLinePx, planColumns, sparkSplitIndex, type ColumnKey, type ColumnOptions, type TableLayout } from './layout.ts';
import { useDeepLinks } from '../../lib/deepLinks.ts';
import { nameColumnRows, nextSort, pipelineHref, routeAddsInfo, routeFold, rowMoney, showsMoney, spansGroups, type LedgerRow, type SortKey, type SortSpec, type Totals } from './model.ts';
import { statusText, statusTitle } from './status.ts';
import './LedgerTable.css';

// ─── Layout ──────────────────────────────────────────────────────────────────

/** Width of the element, tracked with ResizeObserver (undefined until measured). */
function useElementWidth(ref: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth((prev) => (prev !== undefined && Math.abs(prev - w) < 0.5 ? prev : w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

// ─── Columns ─────────────────────────────────────────────────────────────────

interface ColumnDef {
  key: ColumnKey;
  label: string;
  /** second header line in secondary text ("/ day") */
  unit?: string;
  /** a two-word label that breaks onto two lines inside a figure column ("Volume reduced") instead of truncating */
  wrap?: boolean;
  sort?: SortKey;
  align: 'start' | 'end';
}

const PER_DAY = t('ledger.columnsExtra.perDay');

const COLUMN: Record<ColumnKey, ColumnDef> = {
  source: {
    key: 'source',
    label: t('ledger.columns.source'),
    sort: 'source',
    align: 'start',
  },
  route: {
    key: 'route',
    label: t('ledger.columns.route'),
    sort: 'route',
    align: 'start',
  },
  pipeline: {
    key: 'pipeline',
    label: t('ledger.columns.pipeline'),
    sort: 'pipeline',
    align: 'start',
  },
  destination: {
    key: 'destination',
    label: t('ledger.columns.destination'),
    sort: 'destination',
    align: 'start',
  },
  group: {
    key: 'group',
    label: t('ledger.columns.group'),
    sort: 'group',
    align: 'start',
  },
  flow: {
    key: 'flow',
    label: t('ledger.columnsExtra.flow'),
    sort: 'pipeline',
    align: 'start',
  },
  in: {
    key: 'in',
    label: t('ledger.columns.in'),
    unit: PER_DAY,
    sort: 'in',
    align: 'end',
  },
  out: {
    key: 'out',
    label: t('ledger.columns.out'),
    unit: PER_DAY,
    sort: 'out',
    align: 'end',
  },
  reduction: {
    key: 'reduction',
    label: t('ledger.columnsExtra.reduction'),
    wrap: true,
    sort: 'reduction',
    align: 'end',
  },
  whp: {
    key: 'whp',
    label: t('ledger.columnsExtra.whpPerDay'),
    unit: PER_DAY,
    sort: 'whp',
    align: 'end',
  },
  paid: {
    key: 'paid',
    label: t('ledger.columnsExtra.paidPerDay'),
    unit: PER_DAY,
    sort: 'paid',
    align: 'end',
  },
  saved: {
    key: 'saved',
    label: t('ledger.columnsExtra.savedPerDay'),
    unit: PER_DAY,
    sort: 'saved',
    align: 'end',
  },
  trend: { key: 'trend', label: t('ledger.columns.trend'), align: 'start' },
  status: {
    key: 'status',
    label: t('ledger.columnsExtra.status'),
    sort: 'status',
    align: 'start',
  },
};

/** Name columns (start-aligned text) — the totals row's label spans them. */
const NAME_COLUMNS: ReadonlySet<ColumnKey> = new Set(['source', 'route', 'pipeline', 'destination', 'group', 'flow']);

// ─── Status chip ─────────────────────────────────────────────────────────────

type ChipTone = 'high' | 'medium' | 'neutral';

function chipTone(row: Pick<LedgerRow, 'status' | 'severity'>): ChipTone | null {
  switch (row.status) {
    case 'regression':
    case 'spike':
    case 'budget':
      return row.severity === 'high' ? 'high' : 'medium';
    case 'goodnews':
    case 'muted':
    case 'unpriced':
    case 'learning':
      return 'neutral';
    default:
      return null;
  }
}

export function StatusChip({ row }: { row: Pick<LedgerRow, 'status' | 'severity' | 'mutedMinutes' | 'mutedByMember'> }) {
  const tone = chipTone(row);
  const text = statusText(row);
  if (!tone) return <span className="mr-lt-ok">{text}</span>;
  return (
    <span className={`mr-lt-chip mr-lt-chip--${tone}`} title={statusTitle(row)} data-status={row.status}>
      <span className="mr-lt-chip-dot" aria-hidden="true" />
      <span className="mr-lt-chip-text">{text}</span>
    </span>
  );
}

function sparkTone(row: Pick<LedgerRow, 'status' | 'severity'>): SparklineTone {
  if (row.status === 'regression' || row.status === 'spike' || row.status === 'budget')
    return row.severity === 'high' ? 'incident-high' : 'incident-medium';
  if (row.status === 'unpriced' || row.status === 'learning' || row.status === 'muted' || row.status === 'idle') return 'neutral';
  return 'saved';
}

function trendLabel(values: readonly number[]): string | undefined {
  const ends = sparkEnds(values);
  if (!ends) return undefined;
  return tn('ledger.trendLabel', values.length, {
    from: formatPct(ends.first),
    to: formatPct(ends.last),
  });
}

// ─── Cells ───────────────────────────────────────────────────────────────────

const DASH = t('common.dash');

function stop(e: MouseEvent) {
  e.stopPropagation();
}

/** A name in the wide table: it wraps to at most two lines instead of ending in an ellipsis (W3-LS-2). */
function TextCell({ text, id }: { text: string; id: string }) {
  if (!text) return <span className="mr-lt-dim">{DASH}</span>;
  return (
    <span className="mr-lt-name" title={text === id ? text : `${text} (${id})`}>
      {text}
    </span>
  );
}

function PipelineLink({ row, focusable, strong }: { row: LedgerRow; focusable: boolean; strong?: boolean }) {
  const linksOut = useDeepLinks();
  const href = pipelineHref(row.groupId, row.pipelineId);
  const text = row.pipeline || t('ledger.noPipeline');
  // The medium layout's flow line (strong) keeps its one line over the path; the wide table's name wraps (W3-LS-2).
  const nameClass = strong ? 'mr-truncate' : 'mr-lt-name';
  if (!href) return <span className="mr-lt-dim">{DASH}</span>;
  // Sample data (OQ-01): the name without a link out of the app.
  if (!linksOut)
    return (
      <span className={strong ? 'mr-lt-link mr-lt-link--strong mr-lt-link--static' : 'mr-lt-link mr-lt-link--static'} title={`${text} (${row.pipelineId})`}>
        <span className={nameClass}>{text}</span>
      </span>
    );
  return (
    <a
      className={strong ? 'mr-lt-link mr-lt-link--strong' : 'mr-lt-link'}
      href={href}
      target="_top"
      tabIndex={focusable ? 0 : -1}
      title={`${text} (${row.pipelineId})`}
      aria-label={t('ledger.openInCribl', { pipeline: text })}
      onClick={stop}
      data-pipeline-link={row.pipelineId}
    >
      <span className={nameClass}>{text}</span>
      <span className="mr-lt-link-icon" aria-hidden="true">
        <ArrowUpRightFromSquare size="xs" />
      </span>
    </a>
  );
}

/** The money columns: under the Receipt's range their unit is the window ("7 days") instead of "/ day" (P2-W14). */
const MONEY_COLUMNS: ReadonlySet<ColumnKey> = new Set(['whp', 'paid', 'saved']);

/** Money in a cell: an em dash when the destination is unpriced; zero reads quiet (subtle, no money colour). */
function MoneyCell({ row, value, tone }: { row: LedgerRow; value: number; tone?: 'saved' | 'whp' | 'paid' }) {
  if (!showsMoney(row)) return <Money value={null} className="mr-lt-zero" />;
  if (value === 0) return <Money value={0} className="mr-lt-zero" />;
  return <Money value={value} tone={tone ?? 'inherit'} />;
}

/** The largest saved figure among the table's rows: the scale of every row's SavedBar. */
const SavedScaleContext = createContext(0);

/**
 * The row's saved dollars against the column's largest as a 4 px bar under the Saved figure (P2-W17): green on a
 * neutral track, so the column reads as a chart and, sorted by Saved, the bars fall with the figures above them
 * (review W2: drawn as saved ÷ would-have-paid, a $124 row had a shorter bar than a $58 one). The share of
 * dollars stays in the Volume and Saved hovers. An unpriced row keeps the empty track.
 */
function SavedBar({ row }: { row: LedgerRow }) {
  const max = useContext(SavedScaleContext);
  const m = rowMoney(row);
  const priced = showsMoney(row);
  const share = priced && max > 0 ? Math.min(1, Math.max(0, m.savedM / max)) : 0;
  return (
    <span className="mr-lt-bar" aria-hidden="true" data-share={priced ? share.toFixed(4) : ''}>
      <span className="mr-lt-bar-fill" style={{ width: `${share * 100}%` }} />
    </span>
  );
}

function BytesCell({ value }: { value: number }) {
  return <Bytes value={value} className={value === 0 ? 'mr-lt-zero' : undefined} />;
}

/** The hover on a reduction figure: it is a share of bytes, so nobody reads it as the Receipt's "% saved". */
function reductionHint(reduction: number | null): string | undefined {
  if (reduction === null) return undefined;
  // P1-F03: negative — the pipeline sends out more than came in.
  if (reduction < 0) return t('ledger.columnsExtra.inflatingHint', { pct: formatPct(-reduction) });
  return t('ledger.columnsExtra.reductionHint', { pct: formatPct(reduction) });
}

/**
 * The Volume reduced cell. P1-F02: a diversion credit reads 'diverted' — its savings rest on another destination's
 * price, not on bytes dropped — with where the data would have gone in the hover. P1-F03: bytes grown read negative.
 */
function ReductionCell({ row }: { row: LedgerRow }) {
  if (row.divertedTo !== undefined) {
    return (
      <span className="mr-figure mr-lt-diverted" data-diverted="true" title={t('ledger.columnsExtra.divertedHint', { target: row.divertedTo })}>
        {t('ledger.columnsExtra.diverted')}
      </span>
    );
  }
  return (
    <Pct
      value={row.reduction}
      signed={row.reduction !== null && row.reduction < 0}
      className={row.reduction !== null && row.reduction < 0 ? 'mr-lt-inflating' : undefined}
      title={reductionHint(row.reduction)}
    />
  );
}

/** P1-F03: under the totals label, what flows that grow bytes cost beyond what they would have. */
function AddedLine({ totals }: { totals: Totals }) {
  const n = totals.addedFlows ?? 0;
  if (!(n > 0)) return null;
  return (
    <span className="mr-lt-added" data-testid="ledger-added">
      {tn('ledger.addedLine', n, { n: formatInt(n), amount: formatMoney(totals.addedPerDayM ?? 0) })}
    </span>
  );
}

function pathCaption(row: LedgerRow): string {
  const from = row.source || DASH;
  const to = row.destination || DASH;
  return `${from} → ${to}`;
}

// ─── Rows ────────────────────────────────────────────────────────────────────

interface RowProps {
  row: LedgerRow;
  index: number;
  layout: TableLayout;
  /** the plan's columns (wide / medium), in order */
  columns: readonly ColumnKey[];
  start: number;
  active: boolean;
  highlighted: boolean;
  onSelect: (index: number) => void;
  onActivate: (index: number) => void;
  /** a commit the timeline hovers names this flow (P2-W17) */
  linked: boolean;
  /** first sparkline point after the newest commit */
  splitAt?: number;
  onHover?: (index: number | null) => void;
  /** the Receipt's range, in words ("7 days"): the card's saved figure is that window's sum (P2-W14) */
  windowUnit?: string;
}

function RowImpl({ row, index, layout, columns, start, active, highlighted, onSelect, onActivate, linked, splitAt, onHover, windowUnit }: RowProps) {
  const f = row.flow;
  const money = rowMoney(row);
  // Each row's printed triple adds up to the dollar (core/format.ts footMoney), as the Total row and the strip do. The
  // rows are rounded on their own, never against the Total row: footing them to it would move a row's figure when a
  // filter changes which rows are listed (DECISIONS D53).
  const shown = footMoney(money);
  const priced = showsMoney(row);
  const className = [
    'mr-lt-row',
    `mr-lt-row--${layout}`,
    highlighted ? 'is-highlighted' : '',
    linked ? 'is-linked' : '',
    row.status === 'regression' || row.status === 'spike' || row.status === 'budget' ? 'is-alerting' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const common = {
    role: 'row',
    className,
    'aria-rowindex': index + (layout === 'narrow' ? 1 : 2),
    'aria-current': highlighted ? ('true' as const) : undefined,
    'data-index': index,
    'data-row-id': row.id,
    'data-status': row.status,
    tabIndex: active ? 0 : -1,
    style: { transform: `translateY(${start}px)`, height: ROW_HEIGHT[layout] },
    onClick: () => onSelect(index),
    onFocus: () => onActivate(index),
    onPointerEnter: onHover ? () => onHover(index) : undefined,
    onPointerLeave: onHover ? () => onHover(null) : undefined,
  } as const;

  const trend = (width: number) =>
    f.sparkline.length > 0 ? (
      <span className="mr-lt-trend">
        <Sparkline values={f.sparkline} tone={sparkTone(row)} width={width} height={24} label={trendLabel(f.sparkline)} toneFrom={splitAt} />
        <span className="mr-lt-trend-end mr-num" aria-hidden="true">
          {formatPct(f.sparkline[f.sparkline.length - 1])}
        </span>
      </span>
    ) : (
      <span className="mr-lt-dim" title={t('ledger.trendEmpty')}>
        {DASH}
      </span>
    );

  if (layout === 'narrow') {
    return (
      <div {...common}>
        <div role="cell" className="mr-lt-card">
          <div className="mr-lt-card-top">
            <PipelineLink row={row} focusable={active} strong />
            <StatusChip row={row} />
          </div>
          <div className="mr-lt-card-path mr-truncate">{pathCaption(row)}</div>
          <div className="mr-lt-card-figures">
            <span className="mr-lt-card-saved">
              <Money
                value={priced ? money.savedM : null}
                tone={priced && money.savedM !== 0 ? 'saved' : 'inherit'}
                className={priced && money.savedM !== 0 ? undefined : 'mr-lt-zero'}
                per={priced && !row.window ? 'day' : undefined}
              />
              {priced && row.window && windowUnit ? <span className="mr-lt-card-window">{windowUnit}</span> : null}
              <SavedBar row={row} />
            </span>
            <span className="mr-lt-card-reduction">
              <span className="mr-lt-card-caption">{t('ledger.columnsExtra.reduction')}</span> <ReductionCell row={row} />
            </span>
            {/* r2 ui-9: 48 px of line on a phone card, so a 360 px card holds the figure, the reduction and the trend whole. */}
            <span className="mr-lt-card-trend">{trend(48)}</span>
          </div>
        </div>
      </div>
    );
  }

  // A route named like its pipeline or its source is printed once (routeFold; W3-LS-2, P1-K01). Named like its
  // source, the Source cell spans the Route column. Named like its pipeline, the name reads under Pipeline (the cell
  // with the link) and the Route cell is left blank on screen, as a folded route looks beside its source; screen
  // readers still hear the route's name in its column.
  const fold = columns.includes('route') ? routeFold(row) : null;
  const routeInPipeline = fold === 'pipeline';
  const routeFolds = fold === 'source';
  const cell = (key: ColumnKey): ReactNode => {
    switch (key) {
      case 'source':
        return routeFolds ? (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--folds" aria-colspan={2} style={{ gridColumn: 'span 2' }} data-folds="route">
            <TextCell text={row.source} id={row.sourceId} />
          </div>
        ) : (
          <div key={key} role="cell" className="mr-lt-td">
            <TextCell text={row.source} id={row.sourceId} />
          </div>
        );
      case 'route':
        if (routeFolds) return null;
        if (routeInPipeline)
          return (
            <div key={key} role="cell" className="mr-lt-td" data-folds="pipeline">
              <span className="mr-visually-hidden">{row.route}</span>
            </div>
          );
        return (
          <div key={key} role="cell" className="mr-lt-td">
            <TextCell text={row.route} id={row.routeId} />
          </div>
        );
      case 'pipeline':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--pipeline">
            <PipelineLink row={row} focusable={active} />
          </div>
        );
      case 'destination':
        return (
          <div key={key} role="cell" className="mr-lt-td">
            <TextCell text={row.destination} id={row.outputId} />
          </div>
        );
      case 'group':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--group">
            <TextCell text={row.groupId} id={row.groupId} />
          </div>
        );
      case 'flow':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--flow">
            <PipelineLink row={row} focusable={active} strong />
            <span className="mr-lt-sub mr-truncate">{pathCaption(row)}</span>
          </div>
        );
      case 'in':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end">
            <BytesCell value={f.inBPerDay} />
          </div>
        );
      case 'out':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end">
            <BytesCell value={f.outBPerDay} />
          </div>
        );
      case 'reduction':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end">
            <ReductionCell row={row} />
          </div>
        );
      case 'whp':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end mr-lt-td--whp">
            <MoneyCell row={row} value={shown.whpM} tone="whp" />
          </div>
        );
      case 'paid':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end">
            <MoneyCell row={row} value={shown.paidM} tone="paid" />
          </div>
        );
      case 'saved':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end mr-lt-td--saved">
            <span className="mr-lt-saved-stack">
              <MoneyCell row={row} value={shown.savedM} tone="saved" />
              <SavedBar row={row} />
            </span>
          </div>
        );
      case 'trend':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--trend">
            {trend(layout === 'medium' ? 56 : 52)}
          </div>
        );
      case 'status':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--status">
            <StatusChip row={row} />
          </div>
        );
    }
  };

  return <div {...common}>{columns.map(cell)}</div>;
}

const Row = memo(RowImpl);

// ─── Header and totals ───────────────────────────────────────────────────────

function HeaderCell({ col, sort, onSortChange }: { col: ColumnDef; sort: SortSpec; onSortChange: (s: SortSpec) => void }) {
  const active = col.sort !== undefined && sort.key === col.sort;
  const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : col.sort ? 'none' : undefined;
  // The caret sits on the label's line (P1-K05), not between the label and its unit, out of flow so a column never
  // gives up width to it.
  const icon = col.sort ? (
    <span className={`mr-lt-sort-icon${active ? ' is-active' : ''}`} aria-hidden="true">
      {active && sort.dir === 'asc' ? <CaretUpSolid size="xs" /> : <CaretDownSolid size="xs" />}
    </span>
  ) : null;
  const text = (
    <span className="mr-lt-th-text">
      <span className="mr-lt-th-line">
        <span className={`mr-lt-th-label${col.wrap ? ' mr-lt-th-label--wrap' : ''}`}>{col.label}</span>
        {icon}
      </span>
      {col.unit ? <span className="mr-lt-th-unit">{col.unit}</span> : null}
    </span>
  );
  const className = `mr-lt-th mr-lt-th--${col.align}${active ? ' is-sorted' : ''}`;
  if (!col.sort) {
    return (
      <div role="columnheader" className={className}>
        {text}
      </div>
    );
  }
  const sortKey = col.sort;
  return (
    <div role="columnheader" className={className} aria-sort={ariaSort}>
      <button
        type="button"
        className="mr-lt-sort"
        onClick={() => onSortChange(nextSort(sort, sortKey))}
        title={t('ledger.sortBy', {
          column: col.unit ? `${col.label} ${col.unit}` : col.label,
        })}
        data-sort-key={sortKey}
      >
        {text}
      </button>
    </div>
  );
}

function TotalsRow({ layout, columns, totals }: { layout: Exclude<TableLayout, 'narrow'>; columns: readonly ColumnKey[]; totals: Totals }) {
  const label = tn('ledger.totalFlows', totals.flows, {
    n: formatInt(totals.flows),
  });
  const money = (v: number, tone: 'saved' | 'whp' | 'paid') => <Money value={v} tone={tone} />;
  // Under a range the money columns total the window (P2-W14). The printed triple adds up to the dollar (footMoney),
  // and prints exactly as the money strip above the table does.
  const exact = totals.window ?? { whpM: totals.whpPerDayM, paidM: totals.paidPerDayM, savedM: totals.savedPerDayM };
  const m = footMoney(exact);
  const names = columns.filter((k) => NAME_COLUMNS.has(k)).length;
  const cell = (key: ColumnKey): ReactNode => {
    switch (key) {
      case 'in':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end">
            <Bytes value={totals.inBPerDay} />
          </div>
        );
      case 'out':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end">
            <Bytes value={totals.outBPerDay} />
          </div>
        );
      case 'reduction':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end">
            <Pct value={totals.reduction} title={reductionHint(totals.reduction)} />
          </div>
        );
      case 'whp':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end mr-lt-td--whp">
            {money(m.whpM, 'whp')}
          </div>
        );
      case 'paid':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end">
            {money(m.paidM, 'paid')}
          </div>
        );
      case 'saved':
        return (
          <div key={key} role="cell" className="mr-lt-td mr-lt-td--end mr-lt-td--saved" data-value-m={exact.savedM}>
            {money(m.savedM, 'saved')}
          </div>
        );
      default:
        return <div key={key} role="cell" className="mr-lt-td" />;
    }
  };
  return (
    <div role="row" className={`mr-lt-totals mr-lt-totals--${layout}`} aria-rowindex={totals.flows + 2}>
      {/* The label spans the name columns (one in medium, three to five in wide). */}
      <div role="cell" className="mr-lt-td mr-lt-totals-label" style={{ gridColumn: `span ${Math.max(1, names)}` }}>
        <span className="mr-lt-totals-line">
          <span className="mr-lt-totals-text">{label}</span>
          <span className="mr-lt-leader" aria-hidden="true" />
        </span>
        <AddedLine totals={totals} />
      </div>
      {columns.filter((k) => !NAME_COLUMNS.has(k)).map(cell)}
    </div>
  );
}

// ─── Table ───────────────────────────────────────────────────────────────────

export interface LedgerTableProps {
  /** rows to show, already filtered and sorted */
  rows: LedgerRow[];
  sort: SortSpec;
  onSortChange: (next: SortSpec) => void;
  /** row ids drawn as selected (the ?object= deep link) */
  highlighted?: ReadonlySet<string>;
  /** scroll this row into view (center) whenever `nonce` changes */
  scrollTo?: { rowId: string; nonce: number };
  /** a row was clicked, or Enter / Space pressed on it */
  onRowSelect?: (row: LedgerRow) => void;
  /** sums of `rows` for the sticky totals row (wide / medium layouts) */
  totals?: Totals;
  /** shown under the header when `rows` is empty (designed empty / filtered-to-zero state) */
  empty?: ReactNode;
  /** accessible name of the table */
  label?: string;
  /** force a layout (tests); otherwise it follows the table's width */
  layout?: TableLayout;
  /** notified when the measured layout changes (the view shows a narrow summary line) */
  onLayoutChange?: (layout: TableLayout) => void;
  /** row ids a hovered commit names (P2-W17: the timeline's diamond lights its rows) */
  linked?: ReadonlySet<string>;
  /** the pointer entered (a row) or left (null) a row: the timeline lights that flow (P2-W17) */
  onRowHover?: (row: LedgerRow | null) => void;
  /** the newest commit's effect time and the sparklines' end (epoch ms): each trend colours only what came after it */
  newestCommitMs?: number;
  sparkEndMs?: number;
  /**
   * The Receipt's custom range in words ("7 days", P2-W14): the money columns' unit, when the rows carry window sums.
   */
  windowUnit?: string;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** The pipeline cell also holds the "open in Cribl" icon and its gap. */
const LINK_ICON_PX = 20;

/**
 * What the listed rows ask of the columns: Route and Worker group only where they say something, and how wide each
 * name column's labels are, on two lines (a name wraps rather than end in an ellipsis, W3-LS-2) and on one.
 */
function columnOptions(rows: readonly LedgerRow[]): ColumnOptions {
  const route = routeAddsInfo(rows);
  // Where the Route column shows, a folded route asks nothing of it (nameColumnRows, routeFold).
  const named = nameColumnRows(rows, route);
  const picks: [ColumnKey, (r: LedgerRow) => string, number, readonly LedgerRow[]][] = [
    ['source', (r) => r.source, 0, named.source],
    ['route', (r) => r.route, 0, named.route],
    ['pipeline', (r) => r.pipeline || t('ledger.noPipeline'), LINK_ICON_PX, rows],
    ['destination', (r) => r.destination, 0, rows],
    ['group', (r) => r.groupId, 0, rows],
  ];
  const widths = (estimate: (text: string) => number) =>
    Object.fromEntries(picks.map(([key, pick, extra, from]) => [key, from.map((r) => estimate(pick(r)) + extra)])) as Partial<Record<ColumnKey, number[]>>;
  return { route, groups: spansGroups(rows), labels: widths(estimateTwoLinePx), oneLine: widths(estimateLabelPx) };
}

export function LedgerTable(props: LedgerTableProps) {
  const {
    rows,
    sort,
    onSortChange,
    highlighted = EMPTY_SET,
    scrollTo,
    onRowSelect,
    totals,
    empty,
    label,
    onLayoutChange,
    linked = EMPTY_SET,
    onRowHover,
    newestCommitMs,
    sparkEndMs,
    windowUnit,
  } = props;
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(wrapRef);
  // The columns follow the listed rows (P1-K01): Route only where it says something the Source does not, Worker
  // group only across groups. Until the table is measured it plans for a 1280 px page.
  const opts = useMemo(() => columnOptions(rows), [rows]);
  const plan = useMemo(() => planColumns(width ?? 1278, opts, props.layout), [width, opts, props.layout]);
  const layout: TableLayout = plan.layout;
  // One array per column set, so a sort or a filter that keeps the columns does not re-render every memoized row.
  const columnsKey = plan.columns.join(',');
  const columns = useMemo(() => (columnsKey ? (columnsKey.split(',') as ColumnKey[]) : []), [columnsKey]);
  // Sorted by route while Route repeats the Source (a pasted link): the Source header shows that order.
  const shownSort: SortSpec = sort.key === 'route' && !columns.includes('route') ? { key: 'source', dir: sort.dir } : sort;
  const rowHeight = ROW_HEIGHT[layout];
  const headerHeight = HEADER_HEIGHT[layout];
  const totalsHeight = totals && rows.length > 0 ? TOTALS_HEIGHT[layout] : 0;

  useEffect(() => {
    onLayoutChange?.(layout);
  }, [layout, onLayoutChange]);

  // TanStack Virtual returns a mutable instance; this app does not use the React Compiler, so the
  // compiler-compatibility warning does not apply (rows re-render from `items` each render).
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    scrollMargin: headerHeight,
    scrollPaddingStart: headerHeight,
    scrollPaddingEnd: totalsHeight,
    getItemKey: (index) => rows[index]?.id ?? index,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight, headerHeight]);

  // ── Roving focus ──
  const [activeIndex, setActiveIndex] = useState(0);
  const pendingFocus = useRef<number | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const clampedActive = rows.length === 0 ? -1 : Math.min(activeIndex, rows.length - 1);

  const onActivate = useCallback((index: number) => setActiveIndex(index), []);
  const onHover = useCallback((index: number | null) => onRowHover?.(index === null ? null : (rowsRef.current[index] ?? null)), [onRowHover]);
  const onSelect = useCallback(
    (index: number) => {
      setActiveIndex(index);
      const row = rowsRef.current[index];
      if (row) onRowSelect?.(row);
    },
    [onRowSelect],
  );

  const focusRow = useCallback(
    (index: number) => {
      const n = rowsRef.current.length;
      if (n === 0) return;
      const i = Math.max(0, Math.min(n - 1, index));
      setActiveIndex(i);
      pendingFocus.current = i;
      virtualizer.scrollToIndex(i, { align: 'auto' });
    },
    [virtualizer],
  );

  useEffect(() => {
    const i = pendingFocus.current;
    if (i === null) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[role="row"][data-index="${i}"]`);
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const rowEl = target.closest<HTMLElement>('[role="row"][data-index]');
    if (!rowEl) return;
    const index = Number(rowEl.dataset.index);
    const onRow = target === rowEl;
    const page = Math.max(1, Math.floor(((scrollRef.current?.clientHeight ?? 480) - headerHeight - totalsHeight) / rowHeight) - 1);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(index + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        focusRow(index - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusRow(0);
        break;
      case 'End':
        e.preventDefault();
        focusRow(rowsRef.current.length - 1);
        break;
      case 'PageDown':
        e.preventDefault();
        focusRow(index + page);
        break;
      case 'PageUp':
        e.preventDefault();
        focusRow(index - page);
        break;
      case 'Enter':
      case ' ':
        if (!onRow) return; // Enter on the pipeline link follows the link
        e.preventDefault();
        onSelect(index);
        break;
      default:
        break;
    }
  };

  // ── Deep link: scroll a row into view ──
  const scrollRowId = scrollTo?.rowId;
  const scrollNonce = scrollTo?.nonce;
  useEffect(() => {
    if (scrollRowId === undefined) return;
    const index = rowsRef.current.findIndex((r) => r.id === scrollRowId);
    if (index < 0) return;
    setActiveIndex(index);
    virtualizer.scrollToIndex(index, { align: 'center' });
    // Bring the table itself into the page's view as well (the Ledger page scrolls too).
    wrapRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [scrollRowId, scrollNonce, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const bodyHeight = virtualizer.getTotalSize();
  const tableLabel = label ?? t('ledger.tableLabel');
  const savedMax = useMemo(() => rows.reduce((max, r) => (showsMoney(r) ? Math.max(max, rowMoney(r).savedM) : max), 0), [rows]);

  // Rows running on under the sticky totals get a fade above them (P1-K05); at the end of the list, none. Derived from
  // the virtualizer's own scroll state (it re-renders on scroll anyway), so scrolling never reads layout for it.
  const viewport = virtualizer.scrollRect?.height ?? 0;
  const moreBelow = totalsHeight > 0 && viewport > 0 && headerHeight + bodyHeight + totalsHeight - ((virtualizer.scrollOffset ?? 0) + viewport) > 1;

  return (
    <SavedScaleContext.Provider value={savedMax}>
    <div
      ref={wrapRef}
      className={`mr-lt mr-lt--${layout}`}
      data-layout={layout}
      data-columns={columnsKey}
      data-more-below={moreBelow ? 'true' : 'false'}
      data-window={windowUnit ? 'true' : undefined}
      style={{ '--mr-lt-cols': plan.template } as CSSProperties}
    >
      <div
        ref={scrollRef}
        className="mr-lt-scroll"
        role="table"
        aria-label={tableLabel}
        aria-rowcount={rows.length + (layout === 'narrow' ? 0 : 1) + (totalsHeight && layout !== 'narrow' ? 1 : 0)}
        data-testid="ledger-scroll"
      >
        {layout !== 'narrow' ? (
          <div role="rowgroup" className="mr-lt-head">
            <div role="row" className={`mr-lt-header mr-lt-header--${layout}`} aria-rowindex={1}>
              {columns.map((key) => (
                <HeaderCell
                  key={key}
                  col={windowUnit && MONEY_COLUMNS.has(key) ? { ...COLUMN[key], unit: windowUnit } : COLUMN[key]}
                  sort={shownSort}
                  onSortChange={onSortChange}
                />
              ))}
            </div>
          </div>
        ) : null}
        {rows.length === 0 ? (
          <div className="mr-lt-empty">{empty}</div>
        ) : (
          <div role="rowgroup" className="mr-lt-body" style={{ height: bodyHeight }} onKeyDown={onKeyDown}>
            {items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <Row
                  key={item.key}
                  row={row}
                  index={item.index}
                  layout={layout}
                  columns={columns}
                  start={item.start - headerHeight}
                  active={item.index === clampedActive}
                  highlighted={highlighted.has(row.id)}
                  onSelect={onSelect}
                  onActivate={onActivate}
                  linked={linked.has(row.id)}
                  splitAt={sparkSplitIndex(row.flow.sparkline.length, sparkEndMs, newestCommitMs)}
                  onHover={onRowHover ? onHover : undefined}
                  windowUnit={windowUnit}
                />
              );
            })}
          </div>
        )}
        {totals && rows.length > 0 && layout !== 'narrow' ? (
          <div role="rowgroup" className="mr-lt-foot">
            <TotalsRow layout={layout} columns={columns} totals={totals} />
          </div>
        ) : null}
      </div>
    </div>
    </SavedScaleContext.Provider>
  );
}
