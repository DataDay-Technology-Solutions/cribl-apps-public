// src/components/LedgerTable/layout.ts — the table's layouts, their columns and fixed row heights.
//
// A layout follows the table's own width. Inside the wide and medium layouts the columns follow what the rows say
// (P1-K01): Route is a column only where some listed route is named differently from its source (on most rigs it
// repeats the source, and the names then get the room); Worker group joins only when the rows span two or more
// groups and the table is wide enough that the names still read whole beside it; Would have paid returns to the
// medium layout from about 960 px. Each variant's minimum width is the sum of its columns' minimums, so a layout
// never needs horizontal scroll, and the grid template is handed to the CSS as --mr-lt-cols (LedgerTable.css).
//
// The name columns share the room in proportion to their labels (shareRoom): a column of short route names gives
// its room to the long pipeline names beside it. A name wraps to at most two lines rather than ending in an ellipsis
// (W3-LS-2), so the labels are two-line widths (estimateTwoLinePx); where every column's widest name fits the room
// the plan gives each column that much as its floor, so no name is cut short at all.

export type TableLayout = 'wide' | 'medium' | 'narrow';

export type ColumnKey =
  | 'source'
  | 'route'
  | 'pipeline'
  | 'destination'
  | 'group'
  | 'flow'
  | 'in'
  | 'out'
  | 'reduction'
  | 'whp'
  | 'paid'
  | 'saved'
  | 'trend'
  | 'status';

interface Track {
  key: ColumnKey;
  /** the width the track never goes below (px) */
  min: number;
  /** a fixed track's width, or a capped track's most (px); flexible tracks have none */
  max?: number;
  /** a flexible track's share of what the fixed tracks leave */
  fr?: number;
}

const flex = (key: ColumnKey, min: number, fr: number): Track => ({ key, min, fr });
const fixed = (key: ColumnKey, px: number): Track => ({ key, min: px, max: px });

function trackCss(c: Track): string {
  if (c.fr !== undefined) return `minmax(${c.min}px, ${c.fr}fr)`;
  if (c.max !== undefined && c.max !== c.min) return `minmax(${c.min}px, ${c.max}px)`;
  return `${c.min}px`;
}

/** Column gap and the rows' inline padding (LedgerTable.css: spacing.md, spacing.lg). */
const GAP = 8;
const PAD = 16;
/** Headroom for a classic scrollbar in the scroll box's stable gutter. */
const SCROLLBAR = 16;

/** The wide layout's figures, trend and status: each exactly as wide as its widest value and its header need. */
const WIDE_FIGURES: readonly Track[] = [
  fixed('in', 64),
  fixed('out', 64),
  fixed('reduction', 64),
  fixed('whp', 104),
  fixed('paid', 64),
  fixed('saved', 72),
  // The 30-minute line (56 px) and its last value (P2-W17).
  fixed('trend', 92),
  fixed('status', 124),
];

/**
 * The name columns of each wide variant: their floors, and their shares when the labels are not known. Without
 * Route the names share the room 1.6 : 1.6 : 0.8; with Route it is 1 : 1 : 1.4 : 0.6. With Worker group every name
 * keeps at least 200 px, so the group never costs a name its end.
 */
function wideNames(route: boolean, group: boolean): Track[] {
  const roomy = group ? 200 : 0;
  const names = route
    ? [
        flex('source', Math.max(roomy, 128), 1),
        flex('route', Math.max(roomy, 128), 1),
        flex('pipeline', Math.max(roomy, 160), 1.4),
        flex('destination', group ? 88 : 72, 0.6),
      ]
    : [flex('source', Math.max(roomy, 160), 1.6), flex('pipeline', Math.max(roomy, 176), 1.6), flex('destination', 88, 0.8)];
  if (group) names.push(flex('group', 96, 0.6));
  return names;
}

/**
 * Medium: the flow (pipeline over "source → destination") takes what the figures leave, and Status stops at
 * 160 px so no dead band opens beside it. With Would have paid the flow column keeps room for a whole path.
 */
function mediumTracks(whp: boolean): Track[] {
  return [
    flex('flow', whp ? 280 : 200, 1),
    fixed('reduction', 80),
    ...(whp ? [fixed('whp', 104)] : []),
    fixed('paid', 80),
    fixed('saved', 92),
    fixed('trend', 96),
    { key: 'status', min: 128, max: 160 },
  ];
}

export interface ColumnOptions {
  /** some listed route is named differently from its source (routeAddsInfo) */
  route: boolean;
  /** the listed rows span two or more worker groups */
  groups: boolean;
  /** each name column's label widths, in px (two-line widths: estimateTwoLinePx), one per listed row */
  labels?: Partial<Record<ColumnKey, readonly number[]>>;
  /** the same labels on one line (estimateLabelPx): where the room allows, a column keeps its names on one line */
  oneLine?: Partial<Record<ColumnKey, readonly number[]>>;
}

export interface ColumnPlan {
  layout: TableLayout;
  /** the columns, in order ([] for narrow: one card per flow) */
  columns: ColumnKey[];
  /** grid-template-columns for the header, every row and the totals row */
  template: string;
  /** the table width this plan needs (px) */
  minWidth: number;
}

interface Variant {
  layout: TableLayout;
  tracks: Track[];
  minWidth: number;
}

function variant(layout: TableLayout, tracks: Track[]): Variant {
  const minWidth = tracks.reduce((s, c) => s + c.min, 0) + GAP * Math.max(0, tracks.length - 1) + 2 * PAD + SCROLLBAR;
  return { layout, tracks, minWidth };
}

/** Every variant this data allows, richest first. */
function variants(opts: ColumnOptions): Variant[] {
  const out: Variant[] = [];
  if (opts.groups) out.push(variant('wide', [...wideNames(opts.route, true), ...WIDE_FIGURES]));
  out.push(variant('wide', [...wideNames(opts.route, false), ...WIDE_FIGURES]));
  out.push(variant('medium', mediumTracks(true)));
  out.push(variant('medium', mediumTracks(false)));
  out.push({ layout: 'narrow', tracks: [], minWidth: 0 });
  return out;
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Headroom on a column's widest label before it becomes the column's floor: the per-character estimate is an average. */
const FIT_HEADROOM = 1.05;

/**
 * The name columns' shares by their labels (px, one per listed row). A name wraps to two lines rather than being cut
 * short (W3-LS-2), so each column asks for its WIDEST label's two-line width. Where every column's ask (with headroom
 * for the estimate) fits what the fixed tracks, gaps, padding and a classic scrollbar leave of `width`, the ask is the
 * column's floor and the rest of the room is shared in the same proportion: no name is cut short at all. Otherwise the
 * room is shared in proportion to the asks (never under a floor), which is as close as the room allows; a uniform
 * error in the per-character estimate scales every share alike. Columns without labels keep their default shares.
 */
function shareRoom(tracks: readonly Track[], labels: ColumnOptions['labels'], width?: number, oneLine?: ColumnOptions['oneLine']): Track[] {
  const flexes = tracks.filter((c) => c.fr !== undefined);
  if (!labels || flexes.some((c) => !labels[c.key]?.length)) return [...tracks];
  const ask = (c: Track): number => Math.max(c.min, ...(labels[c.key] ?? []));
  if (width !== undefined) {
    const fixedPx = tracks.reduce((sum, c) => sum + (c.fr === undefined ? c.min : 0), 0);
    const room = width - fixedPx - GAP * Math.max(0, tracks.length - 1) - 2 * PAD - SCROLLBAR;
    const need = new Map(flexes.map((c) => [c.key, Math.max(c.min, Math.ceil(ask(c) * FIT_HEADROOM))]));
    let spare = room - [...need.values()].reduce((sum, n) => sum + n, 0);
    if (spare >= 0) {
      // Room to spare: the columns that cost least to keep on one line get it first (a wrapped name reads whole,
      // one line reads faster).
      const upgrades = flexes
        .map((c) => {
          const line = oneLine?.[c.key];
          const one = line?.length ? Math.max(c.min, Math.ceil(Math.max(...line) * FIT_HEADROOM)) : 0;
          return { key: c.key, one, cost: one - (need.get(c.key) ?? 0) };
        })
        .filter((u) => u.one > 0 && u.cost > 0)
        .sort((a, b) => a.cost - b.cost);
      for (const u of upgrades) {
        if (u.cost > spare) break;
        need.set(u.key, u.one);
        spare -= u.cost;
      }
      return tracks.map((c) => {
        const n = need.get(c.key);
        return n === undefined ? c : { ...c, min: n, fr: round(n / 100) };
      });
    }
  }
  return tracks.map((c) => (c.fr === undefined ? c : { ...c, fr: round(ask(c) / 100) }));
}

/**
 * The richest layout and columns that fit `width` (the table's width, px). `only` pins the layout (tests), and
 * still picks the richest of its variants that fits (or its plainest, when none does).
 */
export function planColumns(width: number, opts: ColumnOptions, only?: TableLayout): ColumnPlan {
  const all = variants(opts).filter((v) => !only || v.layout === only);
  const v = all.find((c) => width >= c.minWidth) ?? all[all.length - 1];
  const tracks = shareRoom(v.tracks, opts.labels, v.layout === 'wide' ? width : undefined, opts.oneLine);
  return {
    layout: v.layout,
    columns: tracks.map((c) => c.key),
    template: tracks.length > 0 ? tracks.map(trackCss).join(' ') : 'none',
    minWidth: v.minWidth,
  };
}

/** The layout alone, for the given rows' columns (defaults: a Route column, one group — the most demanding wide). */
export function layoutForWidth(width: number, opts: ColumnOptions = { route: true, groups: false }): TableLayout {
  return planColumns(width, opts).layout;
}

/** Table widths (px) at which each layout starts, for the most demanding columns (a Route column, one group). */
export const LAYOUT_MIN_WIDTH = {
  wide: variant('wide', [...wideNames(true, false), ...WIDE_FIGURES]).minWidth,
  medium: variant('medium', mediumTracks(false)).minWidth,
} as const;

/**
 * About how wide a label renders in the table's body text (px), without measuring (no canvas, and the rows are
 * virtualized): 7.6 px a character, between the median (7.2) and the 90th percentile (7.8) of the sample
 * workspace's labels at body.md. Only the columns' proportions use it, so a uniform error cancels out.
 */
export function estimateLabelPx(text: string): number {
  return Math.ceil(text.length * 7.6);
}

/**
 * About how narrow a column can be while a label still reads whole in at most two lines (px), breaking only between
 * words (W3-LS-2): the best split's longer line. "Palo Alto firewall east" needs "firewall east"; one word needs itself.
 */
export function estimateTwoLinePx(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return estimateLabelPx(text.trim());
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i += 1) {
    best = Math.min(best, Math.max(estimateLabelPx(words.slice(0, i).join(' ')), estimateLabelPx(words.slice(i).join(' '))));
  }
  return best;
}

/** Fixed row heights per layout (virtualization never measures); keep in step with LedgerTable.css. */
export const ROW_HEIGHT: Record<TableLayout, number> = {
  wide: 48,
  medium: 60,
  narrow: 104,
};
export const HEADER_HEIGHT: Record<TableLayout, number> = {
  wide: 52,
  medium: 52,
  narrow: 0,
};
export const TOTALS_HEIGHT: Record<TableLayout, number> = {
  wide: 48,
  medium: 48,
  narrow: 0,
};

/**
 * Index of the first sparkline point after the newest commit (P2-W17), or undefined when the commit is outside the
 * line (older: the whole line is after it; none: nothing to split at). Points are minutes ending at `endMs`.
 */
export function sparkSplitIndex(n: number, endMs: number | undefined, commitMs: number | undefined): number | undefined {
  if (!n || endMs === undefined || commitMs === undefined || !Number.isFinite(endMs) || !Number.isFinite(commitMs)) return undefined;
  const start = endMs - n * 60_000;
  if (commitMs <= start || commitMs >= endMs) return undefined;
  return Math.ceil((commitMs - start) / 60_000);
}
