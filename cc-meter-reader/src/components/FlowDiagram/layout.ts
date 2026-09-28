// src/components/FlowDiagram/layout.ts — the Flow map's geometry (PRD 8.2, 8.8 item 5; DESIGN_BRIEF 5.3).
// Pure: no DOM, no React, deterministic for a given input (the unit tests shuffle inputs and compare).
//
//   Source ─── ribbon 1 (would have paid) ───▶ Pipeline ═══ ribbon 2 (paid) ═══▶ Destination
//                                                        ╲▓▓ saved wedge ▓▓╲
//
// • d3-sankey places the three columns (custom align: Source 0 · Pipeline 1 · Destination 2) with node
//   padding ≥ 12 px. One ribbon PER FLOW (not per node pair), so a hovered path is exact.
// • Band width is DOLLARS (P1-I01: the view's subtitle is "This is dollars"): W_in = k·√(would-have-paid
//   $/day) — a square-root scale so a $7,000/day SIEM stream and a $30/day archive are both visible, and the
//   biggest shape is the biggest bill. The second ribbon keeps the exact dollar fraction inside that band:
//   W_out = W_in·(paid/would-have-paid), so the wedge's share of the band at the pipeline is exactly
//   saved ÷ would-have-paid (the "% saved at current rates" the receipt card prints). `weightBy: 'bytes'`
//   keeps the Insights-style byte map (W_in = k·√(in-bytes/day), W_out = W_in·out/in) for the later toggle.
// • The saved wedge is part of the SAME ribbon: leaving the pipeline the ribbon is still W_in wide; its lower
//   W_in − W_out is the hatched wedge, which tapers to nothing at the destination while the solid W_out part
//   docks. A flow that costs more after its pipeline (paid ≥ would-have-paid) is drawn full width, no wedge.
// • Labels — node names outside the bands, $/day on backing plates — are placed greedily by priority with
//   collision checks; a label that cannot fit is truncated (full text in a <title>) or dropped (the receipt
//   card still has every number). Money plates are gated by DOLLAR rank, not pixels: every ribbon worth at
//   least 2 % of the map's would-have-paid carries its figure (as does any ribbon at least 12 px thick).
// • Real workspaces have long tails (BEAUTY F9: 28 flows on the sample tour ran past the fold and stacked
//   $2–$9 plates). Flows under 2 % of the map's would-have-paid fold into ONE "n smaller flows" ribbon per
//   destination, from one shared source node through one shared pipeline node; a projected (What-if) flow
//   and any `keepKeys` flow are never folded, nor is a destination's lone small feeder.
// • On the byte map each ribbon carries a price weight, √($/GB ÷ the map's highest $/GB): the stylesheet maps
//   it to band opacity, so a 60 GB/day S3 passthrough at $0.03/GB fades behind a SIEM stream at $2.50/GB. The
//   dollar map needs no fade (a cheap flow is already a thin band): every weight is 1.

import { sankey, type SankeyGraph, type SankeyLink, type SankeyNode } from 'd3-sankey';
import { assignSourceHues } from './sourceColors.ts';

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** The per-flow figures the map reads (FlowFigures, or a projected copy of one). */
export interface LayoutFlow {
  key: string;
  groupId: string;
  inputId: string;
  routeId: string;
  pipelineId: string;
  outputId: string;
  inBPerDay: number;
  outBPerDay: number;
  whpPerDayM: number;
  paidPerDayM: number;
  savedPerDayM: number;
  ratePerHourM: number;
  /** drawn dashed / ghosted (What-if projection) */
  projected?: boolean;
  /** set on a synthetic "smaller flows" flow: how many flows it folds (see groupSmallFlows) */
  folded?: number;
}

export type NodeKind = 'in' | 'pipe' | 'out';

/** The raw id of the shared source and pipeline nodes that small flows fold into. */
export const OTHER_ID = '~other';
/** The raw id of the "Removed by Cribl" sink at the foot of the destination column (P2-W16). */
export const SINK_ID = '~removed';

/** An incident on a flow (P2-W16): open (its severity) or just recovered, and the plate that says so. */
export interface FlowMark {
  tone: 'high' | 'medium' | 'recovered';
  text: string;
  /** the plate's shorter form, where the long one does not fit ('−$25 / day · a1f3c9e') */
  short?: string;
  /** the shortest, for a phone's narrow band ('−$25 / day') */
  tiny?: string;
}

export interface LayoutText {
  /** Humanized name of a node. */
  name(kind: NodeKind, id: string): string;
  /** Caption under a Source / Destination name: e.g. '150.0 GB/day', '$1,234 / day' ('12.3 TB/day out' on the byte map). */
  caption(kind: 'in' | 'out', totals: NodeTotals, weightBy?: WeightBy): string;
  /** Plate text on ribbon 1: would-have-paid per day ('$375 / day'). */
  whp(mc: number): string;
  /** Plate text on the wedge: saved per day ('$124 saved'). */
  saved(mc: number): string;
  /** Name of a folded node: the shared source ('6 smaller flows') or pipeline ('Various pipelines'). */
  other(kind: 'in' | 'pipe', flows: number, weightBy?: WeightBy): string;
  /** The sink (P2-W16): its name ('Removed by Cribl') and caption ('$18,524 / day'). Absent: no sink is drawn. */
  sink?: { name: string; caption(totals: NodeTotals, weightBy?: WeightBy): string };
  /** The byte map's plate on ribbon 1: in-bytes per day ('3.1 TB / day', P2-W02). Absent: the dollar plate. */
  volume?(bytesPerDay: number): string;
  /** The byte map's plate on the wedge: bytes removed per day ('1.2 TB removed', P2-W02). Absent: the dollar plate. */
  removed?(bytesPerDay: number): string;
}

export interface LayoutOptions {
  width: number;
  /** Computed from the tallest column when absent. */
  height?: number;
  /** Labels above nodes, fewer flows (phones). Default: width < COMPACT_BELOW. */
  compact?: boolean;
  /** Most flows drawn (largest would-have-paid first). Default 24, compact 10. */
  maxFlows?: number;
  /** Fit: never taller than this (the viewport below the map's top), never shorter than MIN_FIT_HEIGHT. */
  maxHeight?: number;
  /** Fold flows under this share of the total would-have-paid (default 0.02; 0 = never fold). */
  groupBelowShare?: number;
  /** Flow keys that are never folded (the What-if's stream). Projected flows are never folded either. */
  keepKeys?: readonly string[];
  /** Destination ids in colour order (stable across views); unknown ids append: `colorIndex`, the destination ramp. */
  colorOrder?: readonly string[];
  /**
   * Each Source's hue slot, by source node id (`sourceHues`): computed from the LIVE flows by the caller, so a
   * projection, the byte map and the stage colour a source as the Flow does. Absent: computed from this input.
   */
  sourceColors?: ReadonlyMap<string, number>;
  /** What a band's width measures: would-have-paid dollars (default, the Flow view) or in-bytes (Insights). */
  weightBy?: WeightBy;
  /**
   * Pins the order of nodes within each column to this list of node ids (P1-I06: the What-if projection keeps the
   * live map's rows, so the "same map, ghosted" really is the same picture). A node not in the list sits among the
   * nodes it links to. Absent: d3-sankey orders each column to minimise crossings.
   */
  nodeOrder?: readonly string[];
  /**
   * Label and frame size (P2-W10): 1 on a screen (default); the stage passes ≈ 2 at 1080 rows so every name, caption
   * and plate reads from the back of a room. Clamped to [1, 3].
   */
  scale?: number;
  /** Fill `maxHeight` (the stage): the frame takes all the room, with no aspect cap. */
  fill?: boolean;
  /**
   * P2-W16: route every saved wedge into one "Removed by Cribl" sink at the foot of the destination column instead of
   * tapering it into its destination, so the savings are a place on the map. Desktop maps only; needs `text.sink`.
   */
  sink?: boolean;
  /** Incidents by flow key (P2-W16): the ribbon gets a dashed outline in its tone and a plate. Marked flows never fold. */
  marks?: Readonly<Record<string, FlowMark>>;
  text: LayoutText;
}

/** The band quantity: √(would-have-paid $/day) or √(in-bytes/day). */
export type WeightBy = 'dollars' | 'bytes';

// ─── Outputs ─────────────────────────────────────────────────────────────────

export interface NodeTotals {
  inBPerDay: number;
  outBPerDay: number;
  whpPerDayM: number;
  paidPerDayM: number;
  savedPerDayM: number;
  ratePerHourM: number;
}

export interface LayoutNode {
  /** `${kind}:${groupId}:${id}` */
  id: string;
  kind: NodeKind;
  rawId: string;
  groupId: string;
  name: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** the drawn flows through the node (what a hover highlights) */
  flowKeys: string[];
  /**
   * A Destination's WHOLE totals in the group (every drawable flow into it: drawn, capped or folded), so its
   * caption and card read the same money at every width (P1-I04): each flow's dollars are its own, so the sum is
   * exact. Sources, pipelines and the shared "smaller flows" nodes sum what is drawn through them: a Source's
   * flows can be clones of the same events (a full copy to S3 beside a trimmed one to the SIEM), so adding
   * their in-bytes would count the Source twice.
   */
  totals: NodeTotals;
  /** how many flows `totals` sums (the shared source node: how many flows it folds) */
  flows: number;
  /** true when every flow through the node is projected (a node that exists only in the after-state) */
  projected: boolean;
  /** the shared node small flows fold into (rawId OTHER_ID) */
  other: boolean;
  /** the "Removed by Cribl" sink (rawId SINK_ID, P2-W16) */
  sink?: boolean;
  /** a Source's hue slot (sourceColors.ts); absent on other kinds, on the folded source and on the tail */
  hue?: number;
}

/** Ribbon 1: a constant-width band from the source's right edge to the pipeline's left edge. */
export interface Segment1 {
  x0: number;
  x1: number;
  /** band top at each end */
  top0: number;
  top1: number;
  w: number;
}

/** Ribbon 2: leaves the pipeline W_in wide (solid W_out on top, wedge below) and docks W_out wide. */
export interface Segment2 {
  x0: number;
  x1: number;
  /** slot top at the pipeline */
  top0: number;
  /** band top at the destination */
  top1: number;
  wIn: number;
  wOut: number;
  /** P2-W16: the wedge runs to the sink instead of tapering: its left edge at the sink and its slot's top there */
  sinkX?: number;
  sinkTop?: number;
}

export interface LayoutRibbon {
  /** stable across pipeline changes: `${groupId}|${inputId}|${routeId}|${outputId}` */
  id: string;
  flowKey: string;
  flow: LayoutFlow;
  sourceId: string;
  pipeId: string;
  destId: string;
  /** index into the six-hue destination ramp (`--mr-dest-*`), for views that colour destinations; the Flow map draws them in ink (D55) */
  colorIndex: number;
  /**
   * The band's colour: its Source's hue slot (sourceColors.ts, `--mr-src-1..5`). Absent: a source past the coloured
   * ones (the neutral tail) or a folded "smaller flows" ribbon (the fold's own grey).
   */
  hue?: number;
  s1: Segment1;
  s2: Segment2;
  projected: boolean;
  /** √(this flow's $/GB ÷ the map's highest $/GB) in [0, 1]: the stylesheet's band opacity weight */
  weight: number;
  /** flows folded into this ribbon (a "smaller flows" ribbon) */
  folded?: number;
  /** the sink its wedge runs to (P2-W16) */
  sinkId?: string;
  /** an incident on this flow (P2-W16) */
  mark?: FlowMark['tone'];
}

export type LabelKind = 'node-in' | 'node-pipe' | 'node-out' | 'whp' | 'saved' | 'incident';

export interface LabelLine {
  text: string;
  /** 'name' (semibold 14) · 'caption' (12, subtle) · 'money' (semibold 12, tabular) */
  role: 'name' | 'caption' | 'money';
}

export interface LayoutLabel {
  id: string;
  kind: LabelKind;
  /** the ribbon or node it belongs to */
  ownerId: string;
  /** the box, top-left */
  x: number;
  y: number;
  w: number;
  h: number;
  anchor: 'start' | 'middle' | 'end';
  lines: LabelLine[];
  /** the untruncated text, for the <title> tooltip */
  full: string;
  truncated: boolean;
  /** money labels sit on a backing plate */
  plate: boolean;
  /** mid-tween only: a label new in the target fades in with its ribbon (0 → 1) instead of popping in */
  appear?: number;
  /**
   * A saved plate (P1-I02): whether its box sits on its own ribbon's band (the wedge or the solid part it is cut
   * from). A plate that had to move off its band carries a `leader` back to the wedge instead.
   */
  inBand?: boolean;
  /** A 1 px line in the ribbon's colour from a displaced plate's edge to its wedge (P1-I02). */
  leader?: { x1: number; y1: number; x2: number; y2: number };
  /** A node name over a ribbon keeps a halo in the panel colour; one on open panel needs none (P1-I02: no notches). */
  halo?: boolean;
  /** An incident plate's tone (P2-W16). */
  tone?: FlowMark['tone'];
}

export interface FlowLayout {
  width: number;
  height: number;
  compact: boolean;
  nodes: LayoutNode[];
  ribbons: LayoutRibbon[];
  labels: LayoutLabel[];
  /** flows drawn (a folded ribbon counts each flow it holds) / flows eligible (priced, with traffic) */
  shown: number;
  eligible: number;
  /** flows folded into "smaller flows" ribbons */
  folded: number;
  /** the would-have-paid share under which flows were folded (the default 2 %, or higher on a fitted map) */
  foldShare: number;
  /** what the band widths measure */
  weightBy: WeightBy;
  /** the map's whole would-have-paid per day (every drawable flow, drawn or folded): the base of the plates' dollar rank */
  totalWhpPerDayM: number;
  /** pixels per √(unit): √($/day) on the dollar map, √(GB/day) on the byte map */
  k: number;
  /** the label scale it was laid out at (the renderer scales line heights and plate padding by it) */
  scale: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const COMPACT_BELOW = 720;
export const NODE_WIDTH = 10;
export const MIN_NODE_PADDING = 12;
export const GB = 1_000_000_000;
/** Millicents in a dollar: the dollar map's band unit is √($/day). */
export const DOLLAR_M = 100_000;
/**
 * A ribbon at least this thick always carries its $ plate; a thinner one carries it when it is worth at least
 * PLATE_MIN_SHARE of the map's would-have-paid (P1-I01: plates by dollar rank, not by pixels).
 */
export const PLATE_MIN_RIBBON = 12;
/** Every ribbon worth at least this share of the map's would-have-paid carries its $ plate (the fold share). */
export const PLATE_MIN_SHARE = 0.02;
/** A fitted map never gets shorter than this. */
export const MIN_FIT_HEIGHT = 380;
/** A fitted desktop map grows into the room left in the viewport up to this share of its width (P1-I07). */
export const FILL_ASPECT = 0.66;
/** Default fold threshold: flows under 2 % of the map's would-have-paid. */
export const GROUP_BELOW_SHARE = 0.02;
/**
 * A fitted desktop map folds further, in these steps, until every Source has a row for its two-line label
 * (ROW_PX each): a squeezed column otherwise pushes labels off their nodes or drops them (BEAUTY F9).
 */
const FOLD_STEPS = [0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15];
const ROW_PX = 46;
const WIDE_TOP = 30;
const WIDE_BOTTOM = 12;
const WIDE_PADDING = 30;
const NAME_PX = 14;
const CAPTION_PX = 12;
const MONEY_PX = 12;
const LINE_NAME = 19;
const LINE_CAPTION = 16;
const PLATE_H = 20;
const PLATE_PAD_X = 6;
const LABEL_GAP = 10;
/** A label never comes closer than this to another. */
const LABEL_MARGIN = 3;
/** An incident flag's first pass keeps this far (× the label scale) from every name already placed. */
const INCIDENT_LABEL_CLEAR = 10;
/**
 * A pipeline's name sits this close to its own bar (P1-I02) and at least PIPE_CLEAR[0] (else PIPE_CLEAR[1]) from any
 * other node (else the usual 3 px), so it never reads as the caption of the node above.
 */
const PIPE_OWN_GAP = 2;
const PIPE_CLEAR = [10, 5, LABEL_MARGIN] as const;
/** A saved plate starts this far right of its pipeline (P1-I02), on its own band, before the ribbons cross. */
const SAVED_DX = [8, 40, 76] as const;

/**
 * Every size the layout measures labels and frames with, at a scale: 1 on a screen, ≈ 2 on a projector (P2-W10: the
 * stage draws names at 28 px and captions and plates at 24). computeFlowLayout sets them for its own (synchronous) run
 * and restores them, so the layout stays a pure function of its inputs.
 */
interface Metrics {
  s: number;
  rowPx: number;
  wideTop: number;
  wideBottom: number;
  widePadding: number;
  namePx: number;
  captionPx: number;
  moneyPx: number;
  lineName: number;
  lineCaption: number;
  plateH: number;
  platePadX: number;
  labelGap: number;
  pipeOwnGap: number;
  savedDx: readonly number[];
  nodeWidth: number;
  minRibbon: number;
  pipeMax: number;
  plateMax: number;
}

function metricsFor(s: number): Metrics {
  return {
    s,
    rowPx: ROW_PX * s,
    wideTop: WIDE_TOP * s,
    wideBottom: WIDE_BOTTOM * s,
    widePadding: WIDE_PADDING * s,
    namePx: NAME_PX * s,
    captionPx: CAPTION_PX * s,
    moneyPx: MONEY_PX * s,
    lineName: LINE_NAME * s,
    lineCaption: LINE_CAPTION * s,
    plateH: PLATE_H * s,
    platePadX: PLATE_PAD_X * s,
    labelGap: LABEL_GAP * s,
    pipeOwnGap: PIPE_OWN_GAP * s,
    savedDx: SAVED_DX.map((dx) => dx * s),
    nodeWidth: Math.round(NODE_WIDTH * Math.min(s, 1.6)),
    minRibbon: PLATE_MIN_RIBBON * s,
    pipeMax: 240 * s,
    plateMax: 400 * s,
  };
}

const BASE_METRICS = metricsFor(1);
/** The metrics of the layout being computed (BASE_METRICS at rest). */
let M: Metrics = BASE_METRICS;

// ─── Small helpers ───────────────────────────────────────────────────────────

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

export const nodeId = (kind: NodeKind, groupId: string, id: string): string => `${kind}:${groupId}:${id}`;
export const ribbonId = (f: Pick<LayoutFlow, 'groupId' | 'inputId' | 'routeId' | 'outputId'>): string => `${f.groupId}|${f.inputId}|${f.routeId}|${f.outputId}`;

/** Fraction of the in-bytes that leave the pipeline, clamped to [0, 1] (growth draws full width). */
export function keepFraction(f: Pick<LayoutFlow, 'inBPerDay' | 'outBPerDay'>): number {
  if (!(f.inBPerDay > 0)) return 1;
  return clamp(Math.max(0, f.outBPerDay) / f.inBPerDay, 0, 1);
}

/** Fraction of the would-have-paid still paid after the pipeline, clamped to [0, 1] (a costlier flow draws full width). */
export function paidFraction(f: Pick<LayoutFlow, 'whpPerDayM' | 'paidPerDayM'>): number {
  if (!(f.whpPerDayM > 0)) return 1;
  return clamp(Math.max(0, f.paidPerDayM) / f.whpPerDayM, 0, 1);
}

/** A ribbon's slot at the pipeline, in band units: √($/day) (dollars) or √(GB/day) (bytes). */
export function bandSlot(f: Pick<LayoutFlow, 'whpPerDayM' | 'inBPerDay'>, weightBy: WeightBy = 'dollars'): number {
  const v = weightBy === 'bytes' ? f.inBPerDay / GB : f.whpPerDayM / DOLLAR_M;
  return v > 0 ? Math.sqrt(v) : 0;
}

/** The share of the slot that docks at the destination: paid ÷ would-have-paid (dollars) or out ÷ in (bytes). */
export function bandKeep(f: Pick<LayoutFlow, 'whpPerDayM' | 'paidPerDayM' | 'inBPerDay' | 'outBPerDay'>, weightBy: WeightBy = 'dollars'): number {
  return weightBy === 'bytes' ? keepFraction(f) : paidFraction(f);
}

/** A flow the map can price and draw. */
export function isDrawable(f: LayoutFlow): boolean {
  return f.inBPerDay > 0 && f.whpPerDayM > 0 && f.outputId !== '-' && f.outputId !== '';
}

/**
 * Each Source's hue slot, by source node id (`in:group:input`): the top SOURCE_HUES sources of each group by
 * would-have-paid $/day over every drawable flow (drawn, capped or folded alike), assigned by id, not by rank
 * (sourceColors.ts). Pass the LIVE flows: a projection only changes what a flow pays, but a new stream must not
 * repaint the map it is compared with. The folded source never takes a hue.
 */
export function sourceHues(flows: readonly LayoutFlow[]): Map<string, number> {
  const byGroup = new Map<string, Map<string, number>>();
  for (const f of flows) {
    if (!isDrawable(f) || f.inputId === OTHER_ID || f.folded) continue;
    const totals = byGroup.get(f.groupId) ?? new Map<string, number>();
    const id = nodeId('in', f.groupId, f.inputId);
    totals.set(id, (totals.get(id) ?? 0) + f.whpPerDayM);
    byGroup.set(f.groupId, totals);
  }
  const out = new Map<string, number>();
  for (const totals of byGroup.values()) for (const [id, slot] of assignSourceHues(totals)) out.set(id, slot);
  return out;
}

/**
 * Estimated rendered width of `text` in Open Sans at `px` (semibold ≈ 4 % wider). Deliberately a little
 * generous so an estimate never lets two labels touch.
 */
export function textWidth(text: string, px: number, semibold = false): number {
  let em = 0;
  for (const ch of text) {
    if (/[iljtfr.,:;|!'’ ()[\]]/.test(ch)) em += 0.32;
    else if (/[mwMW@%]/.test(ch)) em += 0.86;
    else if (/[0-9$]/.test(ch)) em += 0.59;
    else if (/[A-Z]/.test(ch)) em += 0.66;
    else if (ch === '…') em += 0.9;
    else em += 0.56;
  }
  return Math.ceil(em * px * (semibold ? 1.05 : 1));
}

/**
 * Truncates with an ellipsis to fit `maxWidth` (never below 3 visible characters + '…'). `keepTail` puts the ellipsis
 * in the middle, keeping the name's end: two long names sharing their start would otherwise truncate to the same text
 * (OQ-08: every source read 'Extremely long destination or pipeline n…').
 */
export function truncateToWidth(text: string, maxWidth: number, px: number, semibold = false, keepTail = false): { text: string; truncated: boolean } {
  if (textWidth(text, px, semibold) <= maxWidth) return { text, truncated: false };
  const chars = [...text];
  for (let n = chars.length - 1; n >= 3; n--) {
    const tail = keepTail && n >= 6 ? Math.floor(n / 2) : 0;
    const head = chars.slice(0, n - tail).join('').trimEnd();
    const candidate = tail > 0 ? `${head}…${chars.slice(chars.length - tail).join('').trimStart()}` : `${head}…`;
    if (textWidth(candidate, px, semibold) <= maxWidth) return { text: candidate, truncated: true };
  }
  return { text: `${chars.slice(0, 3).join('')}…`, truncated: true };
}

/**
 * Node ids whose names another node of the same column shares most of its start with (at least half the shorter
 * name, 12 characters or more): truncated at their end they could read the same, so they keep their tails.
 */
export function namesSharingStarts(nodes: readonly { id: string; kind: string; name: string }[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (a.kind !== b.kind || a.name === b.name) continue;
      let k = 0;
      while (k < a.name.length && k < b.name.length && a.name[k] === b.name[k]) k++;
      if (k >= 12 && k >= Math.min(a.name.length, b.name.length) / 2) {
        out.add(a.id);
        out.add(b.id);
      }
    }
  }
  return out;
}

// ─── Paths (shared by the renderer and the tests) ────────────────────────────

const f1 = (n: number): string => (Math.round(n * 10) / 10).toString();

/** A horizontal cubic band of constant vertical width `w` from (x0, top0) to (x1, top1). */
export function bandPath(x0: number, top0: number, x1: number, top1: number, w: number): string {
  const xm = (x0 + x1) / 2;
  return (
    `M${f1(x0)},${f1(top0)}C${f1(xm)},${f1(top0)} ${f1(xm)},${f1(top1)} ${f1(x1)},${f1(top1)}` +
    `L${f1(x1)},${f1(top1 + w)}C${f1(xm)},${f1(top1 + w)} ${f1(xm)},${f1(top0 + w)} ${f1(x0)},${f1(top0 + w)}Z`
  );
}

/** Ribbon 2's solid part: W_out wide from the top of the pipeline slot to the destination. */
export function solidPath(s: Segment2): string {
  return bandPath(s.x0, s.top0, s.x1, s.top1, s.wOut);
}

/**
 * The saved wedge: between the solid part's lower edge and the full band's lower edge, which tapers from
 * W_in at the pipeline to W_out (i.e. to the solid edge) at the destination. Empty when nothing is saved.
 */
export function wedgePath(s: Segment2): string {
  if (!(s.wIn - s.wOut > 0.05)) return '';
  // P2-W16: a constant band from the lower part of the slot to its slot in the sink
  if (s.sinkTop !== undefined) return bandPath(s.x0, s.top0 + s.wOut, s.sinkX ?? s.x1, s.sinkTop, s.wIn - s.wOut);
  const xm = (s.x0 + s.x1) / 2;
  const a = s.top0 + s.wOut; // solid lower edge at the pipeline
  const b = s.top0 + s.wIn; // full band lower edge at the pipeline
  const end = s.top1 + s.wOut; // both meet here, at the destination
  return (
    `M${f1(s.x0)},${f1(a)}C${f1(xm)},${f1(a)} ${f1(xm)},${f1(end)} ${f1(s.x1)},${f1(end)}` +
    `C${f1(xm)},${f1(end)} ${f1(xm)},${f1(b)} ${f1(s.x0)},${f1(b)}Z`
  );
}

/** The centre line of a band (the drift dashes run along it). */
export function centerLinePath(x0: number, y0: number, x1: number, y1: number): string {
  const xm = (x0 + x1) / 2;
  return `M${f1(x0)},${f1(y0)}C${f1(xm)},${f1(y0)} ${f1(xm)},${f1(y1)} ${f1(x1)},${f1(y1)}`;
}

/** The smoothstep these cubic bands follow vertically: s(t) = 3t² − 2t³. */
const ease = (t: number): number => 3 * t * t - 2 * t * t * t;
/** And horizontally, with both control points at the midpoint: x(t) = x0 + (x1 − x0)(1.5 t(1 − t) + t³). */
const xAt = (x0: number, x1: number, t: number): number => x0 + (x1 - x0) * (1.5 * t * (1 - t) + t * t * t);

/** Wedge thickness at parameter t ∈ [0, 1] (W_in − W_out at the pipeline, 0 at the destination; constant to a sink). */
export function wedgeThicknessAt(s: Segment2, t: number): number {
  if (s.sinkTop !== undefined) return Math.max(0, s.wIn - s.wOut);
  return Math.max(0, s.wIn - s.wOut) * (1 - ease(clamp(t, 0, 1)));
}

/** A point on the middle of the wedge at parameter t. */
export function wedgePointAt(s: Segment2, t: number): { x: number; y: number; thickness: number } {
  const e = ease(clamp(t, 0, 1));
  if (s.sinkTop !== undefined) {
    const w = Math.max(0, s.wIn - s.wOut);
    const top = s.top0 + s.wOut + (s.sinkTop - (s.top0 + s.wOut)) * e;
    return { x: xAt(s.x0, s.sinkX ?? s.x1, t), y: top + w / 2, thickness: w };
  }
  const solidLower = s.top0 + s.wOut + (s.top1 - s.top0) * e;
  const thickness = wedgeThicknessAt(s, t);
  return { x: xAt(s.x0, s.x1, t), y: solidLower + thickness / 2, thickness };
}

/** A point on the centre of a constant-width band at parameter t. */
export function bandPointAt(x0: number, top0: number, x1: number, top1: number, w: number, t: number): { x: number; y: number } {
  return { x: xAt(x0, x1, t), y: top0 + (top1 - top0) * ease(clamp(t, 0, 1)) + w / 2 };
}

/** The parameter t at which a band from x0 to x1 passes x (x(t) is strictly increasing, so a bisection finds it). */
export function tAtX(x0: number, x1: number, x: number): number {
  if (!(x1 > x0)) return 0;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (xAt(x0, x1, mid) < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The vertical extent of a ribbon's whole band at x (P1-I02): ribbon 1 between the source and the pipeline; after the
 * pipeline the solid part plus the saved wedge cut from it. null where the ribbon does not pass x.
 */
export function ribbonSpanAt(r: Pick<LayoutRibbon, 's1' | 's2'>, x: number): { top: number; bottom: number } | null {
  const { s1, s2 } = r;
  if (x >= s1.x0 && x <= s1.x1) {
    const t = tAtX(s1.x0, s1.x1, x);
    const top = s1.top0 + (s1.top1 - s1.top0) * ease(t);
    return { top, bottom: top + s1.w };
  }
  if (x >= s2.x0 && x <= s2.x1) {
    const t = tAtX(s2.x0, s2.x1, x);
    const top = s2.top0 + (s2.top1 - s2.top0) * ease(t);
    if (s2.sinkTop !== undefined) return { top, bottom: top + s2.wOut };
    return { top, bottom: top + s2.wOut + wedgeThicknessAt(s2, t) };
  }
  return null;
}

/** Every vertical extent a ribbon covers at x: its band, and its wedge where the wedge runs apart to the sink (P2-W16). */
export function ribbonSpansAt(r: Pick<LayoutRibbon, 's1' | 's2'>, x: number): { top: number; bottom: number }[] {
  const out: { top: number; bottom: number }[] = [];
  const band = ribbonSpanAt(r, x);
  if (band) out.push(band);
  const s = r.s2;
  if (s.sinkTop !== undefined && x >= s.x0 && x <= (s.sinkX ?? s.x1) && s.wIn - s.wOut > 0) {
    const p = wedgePointAt(s, tAtX(s.x0, s.sinkX ?? s.x1, x));
    out.push({ top: p.y - p.thickness / 2, bottom: p.y + p.thickness / 2 });
  }
  return out;
}

/** Whether a box overlaps a ribbon's band anywhere along its width (sampled every ≤ 8 px). */
export function boxOnRibbon(box: { x: number; y: number; w: number; h: number }, r: Pick<LayoutRibbon, 's1' | 's2'>): boolean {
  const steps = Math.max(2, Math.ceil(box.w / 8));
  for (let i = 0; i <= steps; i++) {
    for (const span of ribbonSpansAt(r, box.x + (box.w * i) / steps)) {
      if (span.bottom - span.top > 0.25 && span.top < box.y + box.h && span.bottom > box.y) return true;
    }
  }
  return false;
}

// ─── Layout ──────────────────────────────────────────────────────────────────

interface NodeDatum {
  id: string;
  kind: NodeKind;
  rawId: string;
  groupId: string;
}
interface LinkDatum {
  source: string;
  target: string;
  value: number;
  flowKey: string;
  seg: 1 | 2;
  /** the flow's band slot (bandSlot: √($/day) or √(GB/day)) — the room a segment-2 link takes at the pipeline */
  slot: number;
}
type SNode = SankeyNode<NodeDatum, LinkDatum>;
type SLink = SankeyLink<NodeDatum, LinkDatum>;

const emptyTotals = (): NodeTotals => ({ inBPerDay: 0, outBPerDay: 0, whpPerDayM: 0, paidPerDayM: 0, savedPerDayM: 0, ratePerHourM: 0 });

function addTotals(t: NodeTotals, f: LayoutFlow): void {
  t.inBPerDay += f.inBPerDay;
  t.outBPerDay += f.outBPerDay;
  t.whpPerDayM += f.whpPerDayM;
  t.paidPerDayM += f.paidPerDayM;
  t.savedPerDayM += f.savedPerDayM;
  t.ratePerHourM += f.ratePerHourM;
}

/** Sums flows into one set of totals (the receipt card's "all flows" and node views). */
export function sumTotals(flows: readonly LayoutFlow[]): NodeTotals {
  const t = emptyTotals();
  for (const f of flows) addTotals(t, f);
  return t;
}

/** The flows the map draws: drawable, largest would-have-paid first, capped. Deterministic. */
export function selectFlows(flows: readonly LayoutFlow[], max: number): { shown: LayoutFlow[]; eligible: number } {
  const eligible = flows.filter(isDrawable);
  const sorted = [...eligible].sort((a, b) => b.whpPerDayM - a.whpPerDayM || cmp(a.key, b.key));
  return { shown: sorted.slice(0, Math.max(1, max)), eligible: eligible.length };
}

/** The key of a destination's folded flow. */
export const otherFlowKey = (groupId: string, outputId: string): string => `${groupId}|${OTHER_ID}|${OTHER_ID}|${OTHER_ID}|${outputId}`;

/**
 * Folds the long tail: drawable flows under `share` of the total would-have-paid become one synthetic flow
 * per (group, destination), from the shared OTHER_ID source through the shared OTHER_ID pipeline. Never
 * folded: projected flows, `keep` keys, and a destination's lone small flow (folding one flow only hides
 * its name). Undrawable flows pass through untouched. Deterministic: members are summed in key order.
 */
export function groupSmallFlows(flows: readonly LayoutFlow[], share = GROUP_BELOW_SHARE, keep: readonly string[] = []): { flows: LayoutFlow[]; folded: number } {
  const drawable = flows.filter(isDrawable);
  const total = drawable.reduce((a, f) => a + f.whpPerDayM, 0);
  if (!(share > 0) || !(total > 0)) return { flows: [...flows], folded: 0 };
  const keepSet = new Set(keep);
  const small = drawable.filter((f) => f.whpPerDayM < share * total && !f.projected && !keepSet.has(f.key) && !f.folded);
  const byDest = new Map<string, LayoutFlow[]>();
  for (const f of small) {
    const k = `${f.groupId}|${f.outputId}`;
    byDest.set(k, [...(byDest.get(k) ?? []), f]);
  }
  const foldedKeys = new Set<string>();
  const synthetic: LayoutFlow[] = [];
  for (const members of [...byDest.values()]) {
    if (members.length < 2) continue;
    members.sort((a, b) => cmp(a.key, b.key));
    const t = sumTotals(members);
    const { groupId, outputId } = members[0];
    for (const m of members) foldedKeys.add(m.key);
    synthetic.push({ key: otherFlowKey(groupId, outputId), groupId, inputId: OTHER_ID, routeId: OTHER_ID, pipelineId: OTHER_ID, outputId, ...t, folded: members.length });
  }
  if (synthetic.length === 0) return { flows: [...flows], folded: 0 };
  return { flows: [...flows.filter((f) => !foldedKeys.has(f.key)), ...synthetic.sort((a, b) => cmp(a.key, b.key))], folded: foldedKeys.size };
}

/** √(price ÷ highest price) in [0, 1], rounded to 0.01; 1 when there is no price to compare with. */
export function priceWeight(f: Pick<LayoutFlow, 'whpPerDayM' | 'inBPerDay'>, maxPricePerByte: number): number {
  if (!(maxPricePerByte > 0) || !(f.inBPerDay > 0)) return 1;
  const w = Math.sqrt(clamp(f.whpPerDayM / f.inBPerDay / maxPricePerByte, 0, 1));
  return Math.round(w * 100) / 100;
}

/** Height that gives the tallest column room for its nodes and their labels. */
export function autoHeight(maxColumnNodes: number, compact: boolean): number {
  const per = compact ? 104 : 66;
  return Math.round(clamp(96 + per * maxColumnNodes, compact ? 380 : 420, compact ? 1100 : 900));
}

/** Nodes per column of the flows a map would draw. */
function columnCounts(flows: readonly LayoutFlow[]): { in: number; pipe: number; out: number } {
  const ids = { in: new Set<string>(), pipe: new Set<string>(), out: new Set<string>() };
  for (const f of flows) {
    ids.in.add(`${f.groupId}|${f.inputId}`);
    ids.pipe.add(`${f.groupId}|${f.pipelineId}`);
    ids.out.add(`${f.groupId}|${f.outputId}`);
  }
  return { in: ids.in.size, pipe: ids.pipe.size, out: ids.out.size };
}

/** The frame height for these columns: natural (autoHeight / aspect), capped by `maxHeight` but ≥ MIN_FIT_HEIGHT. */
function frameHeight(counts: { in: number; pipe: number; out: number }, width: number, compact: boolean, maxHeight: number | undefined, fill = false): number {
  const maxColumn = Math.max(1, counts.in, counts.pipe, counts.out);
  // Wide maps also keep a calm aspect (≈ 0.46 of the width, ≤ 760 px) so ribbons have room to curve.
  const aspect = compact ? 0 : Math.min(760, Math.round(width * 0.46));
  const natural = Math.max(autoHeight(maxColumn, compact), aspect);
  // Fit (BEAUTY F9): no taller than the room left in the viewport, but never squeezed below MIN_FIT_HEIGHT.
  // A compact map (labels above nodes) is never fitted: its node padding holds three-line labels, and on a
  // phone the fitted answer is the list (FlowList), with this map one tap away.
  if (compact || maxHeight === undefined || !Number.isFinite(maxHeight)) return natural;
  // The stage (P2-W10) takes all the room it is given.
  if (fill) return Math.max(MIN_FIT_HEIGHT, maxHeight);
  // P1-I07: a fitted map also GROWS into the room (up to FILL_ASPECT of its width), so a projector's 1080 rows are the
  // map's, not 350 px of blank card under a 567 px one.
  const room = Math.max(MIN_FIT_HEIGHT, maxHeight);
  return Math.min(room, Math.max(natural, Math.round(width * FILL_ASPECT)));
}

/**
 * The long-tail fold for this frame: the requested share, raised step by step on a fitted desktop map until
 * the Source and Destination columns have a label row per node. Never folds the kept or projected flows.
 */
function foldFor(input: readonly LayoutFlow[], opts: LayoutOptions, width: number, compact: boolean, max: number): { flows: LayoutFlow[]; folded: number; share: number } {
  const base = opts.groupBelowShare ?? GROUP_BELOW_SHARE;
  let grouped = { ...groupSmallFlows(input, base, opts.keepKeys), share: base };
  if (compact || !(base > 0) || opts.maxHeight === undefined || opts.height !== undefined) return grouped;
  const fits = (flows: readonly LayoutFlow[]): boolean => {
    const counts = columnCounts(selectFlows(flows, max).shown);
    const rows = Math.floor((frameHeight(counts, width, compact, opts.maxHeight, opts.fill) - M.wideTop - M.wideBottom + M.widePadding) / M.rowPx);
    return Math.max(counts.in, counts.out) <= Math.max(4, rows);
  };
  for (const share of FOLD_STEPS) {
    if (fits(grouped.flows)) break;
    if (share <= grouped.share) continue;
    grouped = { ...groupSmallFlows(input, share, opts.keepKeys), share };
  }
  return grouped;
}

export function computeFlowLayout(input: readonly LayoutFlow[], opts: LayoutOptions): FlowLayout {
  const scale = clamp(opts.scale ?? 1, 1, 3);
  const previous = M;
  M = scale === 1 ? BASE_METRICS : metricsFor(scale);
  try {
    return layoutAt(input, opts, scale);
  } finally {
    M = previous;
  }
}

function layoutAt(input: readonly LayoutFlow[], optsIn: LayoutOptions, scale: number): FlowLayout {
  // a flow with an incident on it keeps its own ribbon (P2-W16): folded, its mark would have nowhere to go
  const marked = Object.keys(optsIn.marks ?? {});
  const opts: LayoutOptions = marked.length > 0 ? { ...optsIn, keepKeys: [...(optsIn.keepKeys ?? []), ...marked] } : optsIn;
  const width = Math.max(280, Math.floor(opts.width));
  const compact = opts.compact ?? width < COMPACT_BELOW;
  const max = opts.maxFlows ?? (compact ? 10 : 24);
  const weightBy: WeightBy = opts.weightBy ?? 'dollars';
  const grouped = foldFor(input, opts, width, compact, max);
  const { shown } = selectFlows(grouped.flows, max);
  const drawableInput = input.filter(isDrawable);
  const eligible = drawableInput.length;
  const flows = [...shown].sort((a, b) => cmp(a.key, b.key));
  const maxPrice = flows.reduce((m, f) => (f.inBPerDay > 0 ? Math.max(m, f.whpPerDayM / f.inBPerDay) : m), 0);
  // The map's whole would-have-paid (every drawable flow, drawn or not): the base of the plates' dollar rank.
  const totalWhp = drawableInput.reduce((a, f) => a + f.whpPerDayM, 0);

  // Colour: a destination's index in the stable order (then any unknown ids, sorted).
  const order = [...new Set([...(opts.colorOrder ?? []), ...[...new Set(flows.map((f) => f.outputId))].sort(cmp)])];
  const colorIndex = (outputId: string): number => Math.max(0, order.indexOf(outputId)) % 6;
  // A band wears its Source's hue (the owner, 9/27: not its destination's, which made one slab of the SIEM's feeds).
  const hues = opts.sourceColors ?? sourceHues(input);

  // A Destination's whole totals in the group, from every drawable flow into it (P1-I04).
  const whole = new Map<string, { totals: NodeTotals; flows: number }>();
  for (const f of drawableInput) {
    const id = nodeId('out', f.groupId, f.outputId);
    const w = whole.get(id) ?? { totals: emptyTotals(), flows: 0 };
    addTotals(w.totals, f);
    w.flows += f.folded ?? 1;
    whole.set(id, w);
  }

  // Nodes, inserted in a stable order: kind, then would-have-paid desc, then id.
  const byNode = new Map<string, { datum: NodeDatum; totals: NodeTotals; flowKeys: string[]; projected: boolean; folded: number; count: number }>();
  const pipeKey = splitSharedPipes(flows);
  const touch = (kind: NodeKind, f: LayoutFlow, raw: string, key = raw) => {
    const id = nodeId(kind, f.groupId, key);
    let n = byNode.get(id);
    if (!n) {
      n = { datum: { id, kind, rawId: raw, groupId: f.groupId }, totals: emptyTotals(), flowKeys: [], projected: true, folded: 0, count: 0 };
      byNode.set(id, n);
    }
    addTotals(n.totals, f);
    n.flowKeys.push(f.key);
    n.projected = n.projected && !!f.projected;
    n.folded += f.folded ?? 0;
    n.count += f.folded ?? 1;
    return id;
  };
  /** What a node's caption and card read: a Destination's whole group totals (P1-I04), otherwise what is drawn. */
  const shownTotals = (meta: { datum: NodeDatum; totals: NodeTotals; count: number }): { totals: NodeTotals; flows: number } => {
    const w = meta.datum.kind === 'out' ? whole.get(meta.datum.id) : undefined;
    return w ?? { totals: meta.totals, flows: meta.count };
  };
  const nameOf = (kind: NodeKind, raw: string, folded: number): string =>
    raw === OTHER_ID && kind !== 'out' ? opts.text.other(kind, folded, weightBy) : opts.text.name(kind, raw);
  const links: LinkDatum[] = [];
  for (const f of flows) {
    const s = touch('in', f, f.inputId);
    const p = touch('pipe', f, f.pipelineId, pipeKey(f));
    const d = touch('out', f, f.outputId);
    const slot = bandSlot(f, weightBy);
    links.push({ source: s, target: p, value: slot, flowKey: f.key, seg: 1, slot });
    links.push({ source: p, target: d, value: slot * bandKeep(f, weightBy), flowKey: f.key, seg: 2, slot });
  }
  const kindRank: Record<NodeKind, number> = { in: 0, pipe: 1, out: 2 };
  const nodeData = [...byNode.values()]
    .sort((a, b) => kindRank[a.datum.kind] - kindRank[b.datum.kind] || b.totals.whpPerDayM - a.totals.whpPerDayM || cmp(a.datum.id, b.datum.id))
    .map((n) => ({ ...n.datum }));

  // Geometry frame. Wide: labels live in side gutters. Compact: labels sit above nodes.
  const columns = { in: 0, pipe: 0, out: 0 };
  for (const n of nodeData) columns[n.kind]++;
  const height = Math.max(240, Math.floor(opts.height ?? frameHeight(columns, width, compact, opts.maxHeight, opts.fill)));
  // Wide: side gutters sized to the widest Source / Destination label (name or caption), capped at 22 % of the
  // width — a longer name wraps to a second line instead. Compact: no gutters; labels sit above their nodes,
  // so the padding between nodes holds a label of up to three lines.
  const gutterFor = (kind: 'in' | 'out'): number => {
    if (compact) return 0;
    let need = 0;
    for (const n of byNode.values()) {
      if (n.datum.kind !== kind) continue;
      const name = textWidth(nameOf(kind, n.datum.rawId, n.folded), M.namePx, true);
      const caption = textWidth(opts.text.caption(kind, shownTotals(n).totals, weightBy), M.captionPx);
      need = Math.max(need, name, caption);
    }
    if (kind === 'out' && opts.sink && !compact && opts.text.sink) {
      const saving = sumTotals(flows.filter((f) => bandKeep(f, weightBy) < 1));
      need = Math.max(need, textWidth(opts.text.sink.name, M.namePx, true), textWidth(opts.text.sink.caption(saving, weightBy), M.captionPx));
    }
    return Math.round(clamp(need + M.labelGap + 4, 96 * M.s, width * 0.22));
  };
  const gutterIn = gutterFor('in');
  const gutterOut = gutterFor('out');
  const top = compact ? 62 : M.wideTop;
  const bottom = M.wideBottom;
  const padding = compact ? 66 : M.widePadding;

  const shownCount = flows.reduce((a, f) => a + (f.folded ?? 1), 0);
  const result: FlowLayout = { width, height, compact, nodes: [], ribbons: [], labels: [], shown: shownCount, eligible, folded: grouped.folded, foldShare: grouped.share, weightBy, totalWhpPerDayM: totalWhp, k: 0, scale };
  if (flows.length === 0) return result;

  const generator = sankey<NodeDatum, LinkDatum>()
    .nodeId((d) => d.id)
    .nodeSort(pinnedSort(opts.nodeOrder, links))
    .nodeAlign((node) => kindRank[(node as SNode).kind])
    .nodeWidth(M.nodeWidth)
    .nodePadding(Math.max(MIN_NODE_PADDING, padding))
    .iterations(24)
    .extent([
      [gutterIn, top],
      [width - gutterOut, height - bottom],
    ]);
  const graph: SankeyGraph<NodeDatum, LinkDatum> = generator({ nodes: nodeData.map((d) => ({ ...d })), links: links.map((l) => ({ ...l })) });
  const nodes = graph.nodes as SNode[];
  const glinks = graph.links as SLink[];

  // Pixels per band unit (√($/day) or √(GB/day)): d3 made widths = value·ky.
  const any1 = glinks.find((l) => l.seg === 1 && l.value > 0);
  const k = any1 && any1.width !== undefined ? any1.width / any1.value : 0;
  result.k = k;

  // Re-stack each pipeline's outgoing ribbons into slots W_in wide (solid W_out on top, wedge below),
  // keeping d3's crossing-minimizing order.
  const s2Top0 = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind !== 'pipe') continue;
    let y = n.y0 ?? 0;
    for (const l of (n.sourceLinks ?? []) as SLink[]) {
      s2Top0.set(l.flowKey, y);
      y += l.slot * k;
    }
  }

  const flowByKey = new Map(flows.map((f) => [f.key, f]));
  for (const n of nodes) {
    const meta = byNode.get(n.id)!;
    result.nodes.push({
      id: n.id,
      kind: n.kind,
      rawId: n.rawId,
      groupId: n.groupId,
      name: nameOf(n.kind, n.rawId, meta.folded),
      x0: n.x0 ?? 0,
      x1: n.x1 ?? 0,
      y0: n.y0 ?? 0,
      y1: n.y1 ?? 0,
      flowKeys: [...meta.flowKeys].sort(cmp),
      ...shownTotals(meta),
      // Sources and destinations exist before and after; only a pipeline can be new in the after-state.
      projected: n.kind === 'pipe' && meta.projected,
      other: n.rawId === OTHER_ID,
      ...(n.kind === 'in' && hues.has(n.id) ? { hue: hues.get(n.id)! } : {}),
    });
  }

  const seg1 = new Map<string, SLink>();
  const seg2 = new Map<string, SLink>();
  for (const l of glinks) (l.seg === 1 ? seg1 : seg2).set(l.flowKey, l);
  for (const f of flows) {
    const l1 = seg1.get(f.key)!;
    const l2 = seg2.get(f.key)!;
    const src = l1.source as SNode;
    const pipe = l1.target as SNode;
    const dst = l2.target as SNode;
    const w = l1.width ?? 0;
    const wOut = l2.width ?? 0;
    result.ribbons.push({
      id: ribbonId(f),
      flowKey: f.key,
      flow: flowByKey.get(f.key)!,
      sourceId: src.id,
      pipeId: pipe.id,
      destId: dst.id,
      colorIndex: colorIndex(f.outputId),
      ...(hues.has(src.id) ? { hue: hues.get(src.id)! } : {}),
      s1: { x0: src.x1 ?? 0, x1: pipe.x0 ?? 0, top0: (l1.y0 ?? 0) - w / 2, top1: (l1.y1 ?? 0) - w / 2, w },
      s2: { x0: pipe.x1 ?? 0, x1: dst.x0 ?? 0, top0: s2Top0.get(f.key) ?? (l2.y0 ?? 0) - wOut / 2, top1: (l2.y1 ?? 0) - wOut / 2, wIn: w, wOut },
      projected: !!f.projected,
      // The byte map fades cheap flows; on the dollar map the width already is the price.
      weight: weightBy === 'bytes' ? priceWeight(f, maxPrice) : 1,
      ...(f.folded ? { folded: f.folded } : {}),
      ...(opts.marks?.[f.key] ? { mark: opts.marks[f.key].tone } : {}),
    });
  }
  result.ribbons.sort((a, b) => cmp(a.flowKey, b.flowKey));
  if (opts.sink && !compact && opts.text.sink) addSink(result, { padding: Math.max(MIN_NODE_PADDING, padding), top, bottom: height - bottom, sink: opts.text.sink });
  result.nodes.sort((a, b) => kindRank[a.kind] - kindRank[b.kind] || a.y0 - b.y0 || cmp(a.id, b.id));
  result.labels = placeLabels(result, opts.text, opts.marks);
  return result;
}

/**
 * P2-W16: savings as a place. Every saved wedge leaves its pipeline as today and runs, at its full width, into one
 * "Removed by Cribl" node at the foot of the destination column, whose height is the sum of the wedges: what the
 * pipelines removed, pooled. The destinations above it move up just enough to make room (their ribbons dock where
 * they moved); when the column cannot hold it the wedges taper into their destinations as before.
 */
function addSink(L: FlowLayout, frame: { padding: number; top: number; bottom: number; sink: NonNullable<LayoutText['sink']> }): void {
  const feeding = L.ribbons.filter((r) => r.s2.wIn - r.s2.wOut > 0.5);
  const dests = L.nodes.filter((n) => n.kind === 'out').sort((a, b) => a.y0 - b.y0 || cmp(a.id, b.id));
  if (feeding.length === 0 || dests.length === 0) return;
  const height = feeding.reduce((a, r) => a + (r.s2.wIn - r.s2.wOut), 0);
  const sinkTop = frame.bottom - height;
  // lift the destinations, lowest first, only as far as the sink and their padding need
  const lift = new Map<string, number>();
  let limit = sinkTop - frame.padding;
  for (let i = dests.length - 1; i >= 0; i--) {
    const n = dests[i];
    const d = Math.min(0, limit - n.y1);
    lift.set(n.id, d);
    limit = n.y0 + d - frame.padding;
  }
  if (dests[0].y0 + (lift.get(dests[0].id) ?? 0) < frame.top - 0.5) return;
  for (const n of dests) {
    const d = lift.get(n.id) ?? 0;
    n.y0 += d;
    n.y1 += d;
  }
  const id = nodeId('out', dests[0].groupId, SINK_ID);
  // each wedge's slot in the sink, in the order the wedges leave their pipelines (fewest crossings among them)
  const order = [...feeding].sort((a, b) => a.s2.top0 + a.s2.wOut - (b.s2.top0 + b.s2.wOut) || cmp(a.id, b.id));
  let y = sinkTop;
  const slot = new Map<string, number>();
  for (const r of order) {
    slot.set(r.id, y);
    y += r.s2.wIn - r.s2.wOut;
  }
  L.ribbons = L.ribbons.map((r) => {
    const d = lift.get(r.destId) ?? 0;
    const at = slot.get(r.id);
    const s2 = { ...r.s2, top1: r.s2.top1 + d, ...(at !== undefined ? { sinkX: dests[0].x0, sinkTop: at } : {}) };
    return at !== undefined ? { ...r, s2, sinkId: id } : { ...r, s2 };
  });
  const flows = feeding.map((r) => r.flow);
  L.nodes.push({
    id,
    kind: 'out',
    rawId: SINK_ID,
    groupId: dests[0].groupId,
    name: frame.sink.name,
    x0: dests[0].x0,
    x1: dests[0].x1,
    y0: sinkTop,
    y1: frame.bottom,
    flowKeys: flows.map((f) => f.key).sort(cmp),
    totals: sumTotals(flows),
    flows: flows.reduce((a, f) => a + (f.folded ?? 1), 0),
    projected: false,
    other: false,
    sink: true,
  });
}

/**
 * P1-I07: one pipeline feeding two destinations drew one node, so a small flow to the far destination left from the
 * middle of the big one's node and crossed every ribbon between them. A shared pipeline is drawn once per destination:
 * the destination with the most would-have-paid through it keeps the plain node id; each other destination gets its own
 * node (`<pipelineId>><outputId>`, same name, same pipeline link), placed by its own flows. The shared "smaller flows"
 * pipeline stays one node.
 */
export function splitSharedPipes(flows: readonly LayoutFlow[]): (f: LayoutFlow) => string {
  const whp = new Map<string, Map<string, number>>();
  for (const f of flows) {
    if (f.pipelineId === OTHER_ID) continue;
    const k = `${f.groupId}|${f.pipelineId}`;
    const byDest = whp.get(k) ?? new Map<string, number>();
    byDest.set(f.outputId, (byDest.get(f.outputId) ?? 0) + f.whpPerDayM);
    whp.set(k, byDest);
  }
  const dominant = new Map<string, string>();
  for (const [k, byDest] of whp) {
    const [top] = [...byDest.entries()].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]));
    dominant.set(k, top[0]);
  }
  return (f) => {
    const top = dominant.get(`${f.groupId}|${f.pipelineId}`);
    return top === undefined || top === f.outputId ? f.pipelineId : `${f.pipelineId}>${f.outputId}`;
  };
}

/**
 * The in-column order for `nodeOrder` (undefined without one: d3's own crossing-minimising order). A known node sits
 * at its place in its column of the list, as a fraction of that column; a node the list does not know (a pipeline
 * only the projection routes through, a stream the live map had folded) at the mean place of the known nodes it
 * links to. With a sort set, d3-sankey keeps it through every relaxation pass.
 */
function pinnedSort(order: readonly string[] | undefined, links: readonly LinkDatum[]): ((a: SNode, b: SNode) => number) | undefined {
  if (!order || order.length === 0) return undefined;
  const place = new Map<string, number>();
  for (const kind of ['in', 'pipe', 'out'] as const) {
    const column = order.filter((id) => id.startsWith(`${kind}:`));
    column.forEach((id, i) => place.set(id, (i + 0.5) / column.length));
  }
  const neighbours = new Map<string, string[]>();
  for (const l of links) {
    neighbours.set(l.source, [...(neighbours.get(l.source) ?? []), l.target]);
    neighbours.set(l.target, [...(neighbours.get(l.target) ?? []), l.source]);
  }
  const at = (id: string): number => {
    const known = place.get(id);
    if (known !== undefined) return known;
    const near = (neighbours.get(id) ?? []).map((n) => place.get(n)).filter((x): x is number => x !== undefined);
    return near.length > 0 ? near.reduce((a, b) => a + b, 0) / near.length : 1;
  };
  return (a, b) => at(a.id) - at(b.id) || cmp(a.id, b.id);
}

// ─── Labels ──────────────────────────────────────────────────────────────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const overlaps = (a: Box, b: Box, m = LABEL_MARGIN): boolean =>
  a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

type Segment = { x1: number; y1: number; x2: number; y2: number };
/**
 * Whether a leader line runs through a box (App QA 9/27: the "$1,244 saved" plate's leader struck through the
 * "$1,224 saved" plate at 1440 × 900; the Story's P1-C03 rule, "a leader never crosses words it does not point at",
 * now holds on the Flow map too). Sampled every ≤ 2 px, with a 1 px margin; the segment's own end on its plate's edge
 * is never tested against that plate (callers test other boxes only).
 */
export function segmentHitsBox(l: Segment, b: Box, m = 1): boolean {
  const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
  const steps = Math.max(1, Math.ceil(len / 2));
  for (let i = 0; i <= steps; i++) {
    const x = l.x1 + ((l.x2 - l.x1) * i) / steps;
    const y = l.y1 + ((l.y2 - l.y1) * i) / steps;
    if (x > b.x - m && x < b.x + b.w + m && y > b.y - m && y < b.y + b.h + m) return true;
  }
  return false;
}

interface Candidate {
  /** anchor point: x per `anchor` */
  x: number;
  /** box top; or the box bottom (`yBottom`); or its centre (`yCenter`, clamped into the frame) */
  y?: number;
  yBottom?: number;
  yCenter?: number;
  anchor: LayoutLabel['anchor'];
  maxWidth: number;
  /** the least distance from any node but the label's own (default LABEL_MARGIN) */
  clear?: number;
  /** how many lines a wrapping name may take here (default 2; a phone's map tries 3 first, P1-I05) */
  nameLines?: number;
  /** the last resort for a squeezed column: the name alone, one line, its caption left to the receipt card */
  nameOnly?: boolean;
  /** the words to fit here instead of the request's (a shorter form of an incident plate, P2-W16) */
  lines?: LabelLine[];
  /** a saved plate's first pass (W3-FLOW-1): clear of every other route's band, not only of an incident's */
  clearOfRibbons?: boolean;
  /** the least distance from every label already placed (default LABEL_MARGIN); an incident's first pass keeps more */
  labelClear?: number;
}

interface Request {
  id: string;
  kind: LabelKind;
  ownerId: string;
  lines: LabelLine[];
  plate: boolean;
  priority: number;
  candidates: Candidate[];
  /** A pipeline name's spots off every band, tried after everything is placed when it landed on one (craft r2). */
  offBands?: Candidate[];
  /** allow truncation of the first line (names); money never truncates */
  truncatable: boolean;
  /** a name may wrap onto a second line before it is truncated */
  wrap?: boolean;
  /** a name that shares its start with another in its column: truncated in the middle (OQ-08) */
  keepTail?: boolean;
  /** a saved plate: the ribbon it belongs to (P1-I02: kept on its band, or joined to it by a leader) */
  ribbon?: LayoutRibbon;
  /** an incident plate's tone */
  tone?: FlowMark['tone'];
  /** a saved plate: its pipeline's row, which a plate with no leader stays in (W3-FLOW-3) */
  row?: { y0: number; y1: number };
}

/** Greedy word wrap into at most `maxLines` lines; the last line is truncated if words remain (at its middle with `keepTail`). */
export function wrapToWidth(text: string, maxWidth: number, px: number, semibold = false, maxLines = 2, keepTail = false): { lines: string[]; truncated: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && textWidth(candidate, px, semibold) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (lines.length === 0) return { lines: [''], truncated: false };
  const kept = lines.slice(0, maxLines);
  if (lines.length > maxLines) kept[maxLines - 1] = `${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`;
  let truncated = false;
  const out = kept.map((line, i) => {
    const t = truncateToWidth(line, maxWidth, px, semibold, keepTail && i === kept.length - 1);
    truncated = truncated || t.truncated;
    return t.text;
  });
  return { lines: out, truncated };
}

function lineMetrics(line: LabelLine): { px: number; semibold: boolean; lh: number } {
  if (line.role === 'name') return { px: M.namePx, semibold: true, lh: M.lineName };
  if (line.role === 'money') return { px: M.moneyPx, semibold: true, lh: M.plateH };
  return { px: M.captionPx, semibold: false, lh: M.lineCaption };
}

function fit(req: Request, c: Candidate): { lines: LabelLine[]; w: number; h: number; truncated: boolean } | null {
  let truncated = false;
  const own = c.lines ?? req.lines;
  const source = c.nameOnly ? own.filter((l) => l.role === 'name') : own;
  const lines = source.flatMap((line): LabelLine[] => {
    const m = lineMetrics(line);
    const inner = c.maxWidth - (req.plate ? M.platePadX * 2 : 0);
    if (!req.truncatable || line.role === 'money') return [{ ...line }];
    if (req.wrap && line.role === 'name') {
      const w = wrapToWidth(line.text, inner, m.px, m.semibold, c.nameOnly ? 1 : (c.nameLines ?? 2), req.keepTail === true);
      truncated = truncated || w.truncated;
      return w.lines.map((text) => ({ ...line, text }));
    }
    const t = truncateToWidth(line.text, inner, m.px, m.semibold, req.keepTail === true && line.role === 'name');
    truncated = truncated || t.truncated;
    return [{ ...line, text: t.text }];
  });
  const widths = lines.map((l) => {
    const m = lineMetrics(l);
    return textWidth(l.text, m.px, m.semibold);
  });
  const w = Math.max(...widths) + (req.plate ? M.platePadX * 2 : 0);
  if (w > c.maxWidth + 0.5 && !req.truncatable) return null;
  const h = lines.reduce((acc, l) => acc + lineMetrics(l).lh, 0);
  return { lines, w, h, truncated };
}

function boxFor(c: Candidate, w: number, h: number, frameHeight: number): Box {
  const x = c.anchor === 'start' ? c.x : c.anchor === 'end' ? c.x - w : c.x - w / 2;
  const y = c.y !== undefined ? c.y : c.yBottom !== undefined ? c.yBottom - h : clamp((c.yCenter ?? 0) - h / 2, 0, frameHeight - h);
  return { x, y, w, h };
}

/**
 * Whether a ribbon carries its $ plates: worth at least PLATE_MIN_SHARE of the map's would-have-paid (dollar
 * rank, P1-I01), or thick enough for a plate anyway.
 */
export function earnsPlate(r: Pick<LayoutRibbon, 'flow' | 's1'>, totalWhpPerDayM: number): boolean {
  if (r.s1.w >= M.minRibbon) return true;
  return totalWhpPerDayM > 0 && r.flow.whpPerDayM >= PLATE_MIN_SHARE * totalWhpPerDayM;
}

/** The byte map's plate rule (P2-W02): a ribbon worth PLATE_MIN_SHARE of the map's in-bytes, or thick enough anyway. */
export function earnsBytePlate(r: Pick<LayoutRibbon, 'flow' | 's1'>, totalInBPerDay: number): boolean {
  if (r.s1.w >= M.minRibbon) return true;
  return totalInBPerDay > 0 && r.flow.inBPerDay >= PLATE_MIN_SHARE * totalInBPerDay;
}

function placeLabels(layout: FlowLayout, text: LayoutText, marks?: Readonly<Record<string, FlowMark>>): LayoutLabel[] {
  const { width, height, compact, totalWhpPerDayM: totalWhp } = layout;
  const requests: Request[] = [];
  const pipeXs = layout.nodes.filter((n) => n.kind === 'pipe').map((n) => (n.x0 + n.x1) / 2);
  const inX = layout.nodes.find((n) => n.kind === 'in')?.x0 ?? 0;
  const pipeX = pipeXs.length > 0 ? pipeXs[0] : width / 2;
  const colGap = Math.max(40, pipeX - inX);

  // Node labels.
  const sharesStart = namesSharingStarts(layout.nodes);
  for (const n of layout.nodes) {
    const name: LabelLine = { text: n.name, role: 'name' };
    const cy = (n.y0 + n.y1) / 2;
    const cx = (n.x0 + n.x1) / 2;
    if (n.kind === 'pipe') {
      // Compact: each column owns a lane (sources left, pipelines centre, destinations right) so labels in
      // different columns never meet; wide: the pipeline label spans most of the gap to its neighbours.
      // (wide: one line may reach past the columns' midpoints, still clear of the Source and Destination bars, W3-FLOW-2)
      const maxWidth = compact ? Math.max(60, colGap * 0.68) : Math.max(60, Math.min(M.pipeMax * 1.25, colGap * 1.3 - 24));
      // P1-I02: the name hugs its own bar (2 px) and keeps clear of every other node, so it never sits nearer the node
      // above than its own: above its bar first (a heading), then below it, at 10 px clearance, else 5, else 3.
      const above = (w: number, clear: number): Candidate => ({ x: cx, yBottom: n.y0 - M.pipeOwnGap, anchor: 'middle', maxWidth: w, clear });
      const below = (w: number, clear: number): Candidate => ({ x: cx, y: n.y1 + M.pipeOwnGap, anchor: 'middle', maxWidth: w, clear });
      const [wide, tight, last] = PIPE_CLEAR;
      // W3-FLOW-2 (OQ-08): one line, truncated in the middle (its whole name is in the <title> and the node's aria), so a
      // long name never wraps over the ribbons and plates below it; narrower before it is dropped
      // (a phone's map first tries the room over the neighbouring lanes, where the Source and Destination labels leave it:
      // touch cannot show a <title>, P1-I05)
      const widths = [...(compact ? [colGap * 1.5, colGap * 1.1] : []), maxWidth, maxWidth * 0.8, maxWidth * 0.6, maxWidth * 0.45].filter((w) => w >= 48 * M.s);
      const sets = widths.flatMap((w) => [above(w, wide), above(w, tight), below(w, wide), below(w, tight), above(w, last), below(w, last)]);
      // a phone's map, before it narrows a name: the name starting at its bar, over the flows going out (the Source's
      // name sits over the flows coming in)
      if (compact) {
        const out = (clear: number): Candidate[] => [
          { x: n.x0, yBottom: n.y0 - M.pipeOwnGap, anchor: 'start', maxWidth: width - n.x0, clear },
          { x: n.x0, y: n.y1 + M.pipeOwnGap, anchor: 'start', maxWidth: width - n.x0, clear },
        ];
        sets.splice(12, 0, ...out(wide), ...out(tight), ...out(last));
      }
      // the last resort, before a name is dropped (W3-FLOW-1: a plate goes before a name, never the reverse): beside its
      // own bar, over the flows coming in, else going out, on a halo
      const beside = widths.flatMap((w): Candidate[] => [
        { x: n.x0 - M.labelGap, yCenter: cy, anchor: 'end', maxWidth: w },
        { x: n.x1 + M.labelGap, yCenter: cy, anchor: 'start', maxWidth: w },
      ]);
      // a pipeline whose flow carries an open incident: its name starts at its bar, leaving the band coming in to the
      // incident's plate (placed after the names), which says what the regression costs and which commit
      const incident = !compact && marks !== undefined && layout.ribbons.some((r) => r.pipeId === n.id && marks[r.flowKey] !== undefined);
      const right = incident
        ? widths.flatMap((w): Candidate[] => [
            { x: n.x0, yBottom: n.y0 - M.pipeOwnGap, anchor: 'start', maxWidth: w, clear: wide },
            { x: n.x0, y: n.y1 + M.pipeOwnGap, anchor: 'start', maxWidth: w, clear: wide },
            { x: n.x0, yBottom: n.y0 - M.pipeOwnGap, anchor: 'start', maxWidth: w, clear: tight },
            { x: n.x0, y: n.y1 + M.pipeOwnGap, anchor: 'start', maxWidth: w, clear: tight },
          ])
        : [];
      // Craft review, round 2: where the name is left on another route's band (on its pill), the pass after placement
      // moves it off to one of these — above or below its own bar, centred or from either end of it, at the two widest
      // widths — when that spot is free.
      const offBands = compact
        ? []
        : widths.slice(0, 2).flatMap((w) =>
            [wide, tight].flatMap((clear): Candidate[] => [
              above(w, clear),
              below(w, clear),
              { x: n.x0, yBottom: n.y0 - M.pipeOwnGap, anchor: 'start', maxWidth: w, clear },
              { x: n.x1, yBottom: n.y0 - M.pipeOwnGap, anchor: 'end', maxWidth: w, clear },
              { x: n.x0, y: n.y1 + M.pipeOwnGap, anchor: 'start', maxWidth: w, clear },
              { x: n.x1, y: n.y1 + M.pipeOwnGap, anchor: 'end', maxWidth: w, clear },
            ]),
          );
      requests.push({
        id: `label:${n.id}`,
        kind: 'node-pipe',
        ownerId: n.id,
        lines: [name],
        plate: false,
        priority: 2,
        truncatable: true,
        keepTail: true,
        candidates: [...right, ...sets, ...beside],
        offBands,
      });
      continue;
    }
    const caption: LabelLine = { text: n.sink && text.sink ? text.sink.caption(n.totals, layout.weightBy) : text.caption(n.kind, n.totals, layout.weightBy), role: 'caption' };
    const isIn = n.kind === 'in';
    const lane = Math.max(60, colGap * 0.64);
    // A phone's map shows a whole name (three lines) where there is room, for touch cannot show a <title> (P1-I05).
    const candidates: Candidate[] = compact
      ? [3, 2].flatMap((nameLines): Candidate[] => [
          { x: isIn ? n.x0 : n.x1, yBottom: n.y0 - 4, anchor: isIn ? 'start' : 'end', maxWidth: lane, nameLines },
          { x: isIn ? n.x0 : n.x1, y: n.y1 + 4, anchor: isIn ? 'start' : 'end', maxWidth: lane, nameLines },
        ])
      : [false, true].flatMap((nameOnly) =>
          // a column squeezed by one wide node (the byte map's long tail, P2-W02) keeps every name: its caption goes
          // first, on the receipt card, before the name would
          [0, -1, 1, -2, 2, -3, 3].map((step) => ({
            x: isIn ? n.x0 - M.labelGap : n.x1 + M.labelGap,
            yCenter: cy + step * (nameOnly ? 10 : 20) * M.s,
            anchor: isIn ? ('end' as const) : ('start' as const),
            maxWidth: isIn ? n.x0 - M.labelGap : width - n.x1 - M.labelGap,
            nameOnly,
          })),
        );
    requests.push({
      id: `label:${n.id}`,
      kind: isIn ? 'node-in' : 'node-out',
      ownerId: n.id,
      lines: [name, caption],
      plate: false,
      priority: isIn ? 1 : 0,
      truncatable: true,
      wrap: true,
      keepTail: sharesStart.has(n.id),
      candidates,
    });
  }

  // Incident plates (P2-W16): above (else below) the ribbon's first band, before any money plate, so a regression is
  // never the label that got dropped; then its short form ('−$25 / day · a1f3c9e'); last, on the band itself.
  for (const r of layout.ribbons) {
    const mark = marks?.[r.flowKey];
    if (!mark) continue;
    const full: LabelLine[] = [{ text: mark.text, role: 'money' }];
    const short: LabelLine[] = [{ text: mark.short ?? mark.text, role: 'money' }];
    const tiny: LabelLine[] = [{ text: mark.tiny ?? mark.short ?? mark.text, role: 'money' }];
    const ts = [0.5, 0.35, 0.65, 0.2, 0.8];
    const around = (lines: LabelLine[]): Candidate[] =>
      ts.flatMap((t): Candidate[] => {
        const p = bandPointAt(r.s1.x0, r.s1.top0, r.s1.x1, r.s1.top1, r.s1.w, t);
        return [
          { x: p.x, yBottom: p.y - r.s1.w / 2 - 3, anchor: 'middle', maxWidth: M.plateMax * 1.5, lines },
          { x: p.x, y: p.y + r.s1.w / 2 + 3, anchor: 'middle', maxWidth: M.plateMax * 1.5, lines },
        ];
      });
    // on the band itself: along its top edge, else its bottom edge (a phone's source label sits right above the band)
    const on = (lines: LabelLine[]): Candidate[] =>
      r.s1.w >= M.plateH + 4
        ? ts.flatMap((t): Candidate[] => {
            const p = bandPointAt(r.s1.x0, r.s1.top0, r.s1.x1, r.s1.top1, r.s1.w, t);
            const edge = r.s1.w / 2 - M.plateH / 2 - 2;
            return [
              { x: p.x, yCenter: p.y - edge, anchor: 'middle', maxWidth: M.plateMax * 1.5, lines },
              { x: p.x, yCenter: p.y + edge, anchor: 'middle', maxWidth: M.plateMax * 1.5, lines },
            ];
          })
        : [];
    requests.push({
      id: `incident:${r.id}`,
      kind: 'incident',
      ownerId: r.id,
      lines: full,
      plate: true,
      priority: 2.5,
      truncatable: false,
      // craft review, round 1: a first pass keeps the flag a clear gap from every name already placed (it sat
      // against the Source's name), then the same places at the usual margin, so a flag is never dropped for it
      candidates: [...around(full).map((c) => ({ ...c, labelClear: INCIDENT_LABEL_CLEAR * M.s })), ...around(full), ...around(short), ...on(full), ...on(short), ...around(tiny), ...on(tiny)],
      tone: mark.tone,
    });
  }

  // Money plates: the saved wedge first (the point of the view), then would-have-paid on ribbon 1. The byte map
  // (P2-W02) labels the same places in bytes (in per day, removed per day), gated by byte rank, as Insights would.
  const bytes = layout.weightBy === 'bytes';
  const totalIn = layout.ribbons.reduce((a, r) => a + r.flow.inBPerDay, 0);
  const earns = (r: LayoutRibbon): boolean => (bytes ? earnsBytePlate(r, totalIn) : earnsPlate(r, totalWhp));
  const cut = (r: LayoutRibbon): number => (bytes ? Math.max(0, r.flow.inBPerDay - r.flow.outBPerDay) : r.flow.savedPerDayM);
  const savedText = (r: LayoutRibbon): string => (bytes && text.removed ? text.removed(cut(r)) : text.saved(r.flow.savedPerDayM));
  const whpText = (r: LayoutRibbon): string => (bytes && text.volume ? text.volume(r.flow.inBPerDay) : text.whp(r.flow.whpPerDayM));
  // App QA 9/27: the folded "N smaller flows" row is one source band, so it carries one plate of each kind, with the
  // row's total, on its largest ribbon, however many destinations it feeds (it read as one source with two prices).
  const foldedOf = (r: LayoutRibbon): string | undefined => (r.flow.inputId === OTHER_ID ? r.flow.groupId : undefined);
  const foldedSum = (r: LayoutRibbon, value: (x: LayoutRibbon) => number): number => {
    const g = foldedOf(r);
    return g === undefined ? value(r) : layout.ribbons.filter((x) => foldedOf(x) === g).reduce((a, x) => a + value(x), 0);
  };
  const firstOfFold = new Set<string>();
  const leadsFold = (r: LayoutRibbon, kind: string): boolean => {
    const g = foldedOf(r);
    if (g === undefined) return true;
    if (firstOfFold.has(`${kind}|${g}`)) return false;
    firstOfFold.add(`${kind}|${g}`);
    return true;
  };
  const byValue = [...layout.ribbons].sort((a, b) => cut(b) - cut(a) || cmp(a.flowKey, b.flowKey));
  for (const r of byValue) {
    if (!(cut(r) > 0) || !(r.s2.wIn - r.s2.wOut > 0.5) || !earns(r)) continue;
    if (!leadsFold(r, 'saved')) continue;
    const label = foldedOf(r) === undefined ? savedText(r) : bytes && text.removed ? text.removed(foldedSum(r, cut)) : text.saved(foldedSum(r, (x) => x.flow.savedPerDayM));
    const row = layout.nodes.find((n) => n.id === r.pipeId);
    requests.push({
      id: `saved:${r.id}`,
      kind: 'saved',
      ownerId: r.id,
      lines: [{ text: label, role: 'money' }],
      plate: true,
      priority: 3,
      truncatable: false,
      candidates: savedCandidates(r, textWidth(label, M.moneyPx, true) + M.platePadX * 2, row),
      ribbon: r,
      row,
    });
  }
  const size = (r: LayoutRibbon): number => (bytes ? r.flow.inBPerDay : r.flow.whpPerDayM);
  const byWhp = [...layout.ribbons].sort((a, b) => size(b) - size(a) || cmp(a.flowKey, b.flowKey));
  for (const r of byWhp) {
    if (!earns(r)) continue;
    if (!leadsFold(r, 'whp')) continue;
    const label = foldedOf(r) === undefined ? whpText(r) : bytes && text.volume ? text.volume(foldedSum(r, (x) => x.flow.inBPerDay)) : text.whp(foldedSum(r, (x) => x.flow.whpPerDayM));
    const cands: Candidate[] = [0.5, 0.38, 0.62, 0.28, 0.72, 0.2, 0.8].map((t) => {
      const p = bandPointAt(r.s1.x0, r.s1.top0, r.s1.x1, r.s1.top1, r.s1.w, t);
      return { x: p.x, yCenter: p.y, anchor: 'middle' as const, maxWidth: M.plateMax };
    });
    requests.push({ id: `whp:${r.id}`, kind: 'whp', ownerId: r.id, lines: [{ text: label, role: 'money' }], plate: true, priority: 4, truncatable: false, candidates: cands });
  }

  // Obstacles: nodes (labels never cover a node bar; a pipeline's name keeps its clearance from every other node).
  const nodeBoxes = layout.nodes.map((n) => ({ id: n.id, box: { x: n.x0 - 2, y: n.y0, w: n.x1 - n.x0 + 4, h: n.y1 - n.y0 } }));
  const placed: Box[] = [];
  const leaders: Segment[] = [];
  const out: LayoutLabel[] = [];
  // W3-FLOW-1: a money plate never sits on another route's incident (its dashed outline says what it costs); a saved
  // plate's first pass keeps clear of every other route's band too. Each ribbon's bounding box rejects most tests early.
  const reach = new Map(layout.ribbons.map((r) => [r.id, ribbonBounds(r)]));
  const marked = layout.ribbons.filter((r) => marks?.[r.flowKey] !== undefined);
  const onRoute = (box: Box, r: LayoutRibbon): boolean => overlaps(reach.get(r.id)!, box, 0) && boxOnRibbon(box, r);
  const onMark = (box: Box, r: LayoutRibbon): boolean => overlaps(reach.get(r.id)!, box, 0) && boxOnOutline(box, r);
  // a saved plate is drawn only beside its pipeline's name (a plate is dropped before a name, never the reverse)
  const named = new Set<string>();
  requests.sort((a, b) => a.priority - b.priority);
  for (const req of requests) {
    if (req.kind === 'saved' && req.ribbon && !named.has(req.ribbon.pipeId)) continue;
    const money = req.kind === 'saved' || req.kind === 'whp';
    for (const c of req.candidates) {
      const f = fit(req, c);
      if (!f) continue;
      const box = boxFor(c, f.w, f.h, height);
      if (box.x < -0.5 || box.x + box.w > width + 0.5 || box.y < -0.5 || box.y + box.h > height + 0.5) continue;
      if (nodeBoxes.some((nb) => overlaps(nb.box, box, nb.id === req.ownerId ? 0 : (c.clear ?? LABEL_MARGIN)))) continue;
      if (placed.some((p) => overlaps(p, box, c.labelClear))) continue;
      // a label never sits on another plate's leader
      if (leaders.some((l) => segmentHitsBox(l, box))) continue;
      if (money && marked.some((r) => r.id !== req.ownerId && onMark(box, r))) continue;
      if (c.clearOfRibbons && layout.ribbons.some((r) => r.id !== req.ownerId && onRoute(box, r))) continue;
      // W3-FLOW-3: a saved plate with no leader keeps its centre in its pipeline's row (± half a plate)
      const tie = req.ribbon ? plateTie(req.ribbon, box) : undefined;
      if (tie?.inBand && req.row && !(box.y + box.h / 2 >= req.row.y0 - box.h / 2 && box.y + box.h / 2 <= req.row.y1 + box.h / 2)) continue;
      // and a leader never crosses a label it does not point at (the Story's P1-C03 rule)
      if (tie?.leader && placed.some((p) => segmentHitsBox(tie.leader!, p))) continue;
      placed.push(box);
      if (tie?.leader) leaders.push(tie.leader);
      if (req.kind === 'node-pipe') named.add(req.ownerId);
      const label: LayoutLabel = {
        id: req.id,
        kind: req.kind,
        ownerId: req.ownerId,
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        anchor: c.anchor,
        lines: f.lines,
        full: req.lines.map((l) => l.text).join(' · '),
        truncated: f.truncated,
        plate: req.plate,
      };
      if (tie) Object.assign(label, tie);
      else if (!req.plate) label.halo = layout.ribbons.some((r) => boxOnRibbon(box, r));
      if (req.tone) label.tone = req.tone;
      out.push(label);
      break;
    }
  }

  // Craft review, round 2 (names on ribbons on the Flow and What-if maps): a pipeline name the pass above left on a
  // band moves off every band to a free spot above or below its own bar. It runs after everything is placed, so the
  // move never takes another label's room; a spot that would truncate a whole name is not taken.
  for (let i = 0; i < out.length; i++) {
    const label = out[i];
    if (label.kind !== 'node-pipe' || !label.halo) continue;
    const req = requests.find((r) => r.id === label.id);
    // only a name on ANOTHER route's band moves: its own flows run into and out of its bar, under any spot beside it
    if (!req || !layout.ribbons.some((r) => r.pipeId !== req.ownerId && onRoute({ x: label.x, y: label.y, w: label.w, h: label.h }, r))) continue;
    for (const c of req?.offBands ?? []) {
      const f = req ? fit(req, c) : undefined;
      if (!req || !f || (f.truncated && !label.truncated)) continue;
      const box = boxFor(c, f.w, f.h, height);
      if (box.x < -0.5 || box.x + box.w > width + 0.5 || box.y < -0.5 || box.y + box.h > height + 0.5) continue;
      if (nodeBoxes.some((nb) => overlaps(nb.box, box, nb.id === req.ownerId ? 0 : (c.clear ?? LABEL_MARGIN)))) continue;
      // (an incident flag keeps the clearance its first pass kept from every name: a moved name keeps it too)
      if (placed.some((p, j) => j !== i && overlaps(p, box, out[j].kind === 'incident' ? INCIDENT_LABEL_CLEAR * M.s : c.labelClear))) continue;
      if (leaders.some((l) => segmentHitsBox(l, box))) continue;
      if (layout.ribbons.some((r) => r.pipeId !== req.ownerId && onRoute(box, r))) continue;
      placed[i] = box;
      out[i] = { ...label, x: box.x, y: box.y, w: box.w, h: box.h, anchor: c.anchor, lines: f.lines, truncated: f.truncated, halo: false };
      break;
    }
  }
  return out.sort((a, b) => cmp(a.id, b.id));
}

/**
 * Where a saved plate may sit (P1-I02, W3-FLOW-1/3), best first: just right of its pipeline (+8 px, then +40, +76) on its
 * own band — centred on the wedge, held inside the band when the band is taller than the plate — before the ribbons
 * curve and cross; then just above or below its band there, joined back by a leader (plateTie); then along the wedge,
 * but only while the wedge is still in its pipeline's row (a plate never drifts down to the sink, several rows below
 * its pipeline); last, a plate's height further above or below the band, still at the pipeline, with its leader. Each
 * of those is tried first clear of every other route's band, then over one (never over an incident: placeLabels).
 */
function savedCandidates(r: LayoutRibbon, plateW: number, row?: { y0: number; y1: number }): Candidate[] {
  const s = r.s2;
  const on: Candidate[] = [];
  const off: Candidate[] = [];
  const far: Candidate[] = [];
  // a plate with no leader keeps its centre in its pipeline's row (± half a plate)
  const inRow = (y: number): boolean => row === undefined || (y >= row.y0 - M.plateH / 2 && y <= row.y1 + M.plateH / 2);
  for (const dx of M.savedDx) {
    const x = s.x0 + dx;
    if (x + plateW > s.x1) continue;
    // where the plate meets its wedge: under its middle where the wedge tapers along its band; under its left end where
    // the wedge runs apart to the sink (P2-W16), for that wedge falls away at once and under the plate's middle it
    // would already sit at the next pipeline's wedge (W3-FLOW-1: two plates each read as the other's)
    const probe = s.sinkTop !== undefined ? x : x + plateW / 2;
    const t = tAtX(s.x0, s.sinkTop !== undefined ? (s.sinkX ?? s.x1) : s.x1, probe);
    // the plate labels the wedge: where the wedge runs apart to the sink (P2-W16), its own span; else the band's, of
    // which the wedge is the lower part
    let span: { top: number; bottom: number } | null;
    if (s.sinkTop !== undefined) {
      const w = wedgePointAt(s, t);
      span = { top: w.y - w.thickness / 2, bottom: w.y + w.thickness / 2 };
    } else span = ribbonSpanAt(r, probe);
    if (!span) continue;
    const mid = wedgePointAt(s, t).y;
    const room = span.bottom - span.top;
    const yCenter = room >= M.plateH ? clamp(mid, span.top + M.plateH / 2, span.bottom - M.plateH / 2) : mid;
    if (inRow(yCenter)) on.push({ x, yCenter, anchor: 'start', maxWidth: M.plateMax });
    // beside the band where it leaves the pipeline: for a wedge that runs apart to the sink, the solid band, and the
    // wedge only while it is still in the row (its run down to the sink is no place for its plate)
    const band = ribbonSpanAt(r, probe) ?? span;
    let top = band.top;
    let bottom = band.bottom;
    if (s.sinkTop !== undefined && inRow((span.top + span.bottom) / 2)) {
      top = Math.min(top, span.top);
      bottom = Math.max(bottom, span.bottom);
    }
    off.push({ x, y: bottom + 3, anchor: 'start', maxWidth: M.plateMax }, { x, yBottom: top - 3, anchor: 'start', maxWidth: M.plateMax });
    for (const k of [1, 2]) {
      const step = k * (M.plateH + 3);
      far.push({ x, y: bottom + 3 + step, anchor: 'start', maxWidth: M.plateMax }, { x, yBottom: top - 3 - step, anchor: 'start', maxWidth: M.plateMax });
    }
  }
  // level with its pipeline, further right where the names above and below it leave no room at the bar (a leader back)
  const level: Candidate[] = [];
  if (row !== undefined) {
    // every height that keeps the plate's centre in the row, nearest its middle first (a thin row sits between two
    // names: the plate slots between them)
    const mid = (row.y0 + row.y1) / 2;
    const reach = (row.y1 - row.y0) / 2 + M.plateH / 2 - 1;
    const step = Math.max(2, M.plateH / 5);
    const ys = [mid];
    for (let d = step; d <= reach; d += step) ys.push(mid + d, mid - d);
    for (const yCenter of ys) {
      for (const dx of [...M.savedDx, 110 * M.s, 140 * M.s]) {
        const x = s.x0 + dx;
        if (x + plateW <= s.x1) level.push({ x, yCenter, anchor: 'start', maxWidth: M.plateMax });
      }
    }
  }
  const along: Candidate[] = [0.22, 0.32, 0.42, 0.52].flatMap((t): Candidate[] => {
    const p = wedgePointAt(s, t);
    return inRow(p.y) ? [{ x: p.x, yCenter: p.y, anchor: 'middle', maxWidth: M.plateMax }] : [];
  });
  // a plate off its band stays in its pipeline's row while it can (W3-FLOW-3): beside a row with no savings of its own
  // it would read as that pipeline's, leader or not
  const centre = (c: Candidate): number => c.yCenter ?? (c.y !== undefined ? c.y + M.plateH / 2 : (c.yBottom ?? 0) - M.plateH / 2);
  const leadered = [...off, ...level, ...far];
  const near = leadered.filter((c) => inRow(centre(c)));
  const away = leadered.filter((c) => !inRow(centre(c)));
  const clear = (cs: Candidate[]): Candidate[] => cs.map((c) => ({ ...c, clearOfRibbons: true }));
  return [...clear(on), ...on, ...clear(near), ...near, ...clear(along), ...along, ...clear(away), ...away];
}

/**
 * Whether a box overlaps what an incident outlines (P2-W16): the ribbon's band to its pipeline and the paid part on to
 * its destination — not its saved wedge (sampled every ≤ 8 px).
 */
export function boxOnOutline(box: { x: number; y: number; w: number; h: number }, r: Pick<LayoutRibbon, 's1' | 's2'>): boolean {
  const { s1, s2 } = r;
  const steps = Math.max(2, Math.ceil(box.w / 8));
  for (let i = 0; i <= steps; i++) {
    const x = box.x + (box.w * i) / steps;
    let span: { top: number; bottom: number } | null = null;
    if (x >= s1.x0 && x <= s1.x1) {
      const top = s1.top0 + (s1.top1 - s1.top0) * ease(tAtX(s1.x0, s1.x1, x));
      span = { top, bottom: top + s1.w };
    } else if (x >= s2.x0 && x <= s2.x1) {
      const top = s2.top0 + (s2.top1 - s2.top0) * ease(tAtX(s2.x0, s2.x1, x));
      span = { top, bottom: top + s2.wOut };
    }
    if (span && span.bottom - span.top > 0.25 && span.top < box.y + box.h && span.bottom > box.y) return true;
  }
  return false;
}

/** A ribbon's bounding box (its band, its wedge and its run to a sink): the cheap first test before boxOnRibbon. */
function ribbonBounds(r: LayoutRibbon): Box {
  const { s1, s2 } = r;
  const x0 = Math.min(s1.x0, s2.x0);
  const x1 = Math.max(s1.x1, s2.x1, s2.sinkX ?? s2.x1);
  const y0 = Math.min(s1.top0, s1.top1, s2.top0, s2.top1, s2.sinkTop ?? Infinity);
  const y1 = Math.max(s1.top0 + s1.w, s1.top1 + s1.w, s2.top0 + s2.wIn, s2.top1 + s2.wIn, (s2.sinkTop ?? -Infinity) + Math.max(0, s2.wIn - s2.wOut));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Whether a box overlaps a ribbon's saved wedge (W3-FLOW-1): the part of the band a saved plate labels, down to the
 * destination or along its run to the sink (sampled every ≤ 8 px).
 */
export function boxOnWedge(box: { x: number; y: number; w: number; h: number }, r: Pick<LayoutRibbon, 's2'>): boolean {
  const s = r.s2;
  if (!(s.wIn - s.wOut > 0.25)) return false;
  const end = s.sinkTop !== undefined ? (s.sinkX ?? s.x1) : s.x1;
  const steps = Math.max(2, Math.ceil(box.w / 8));
  for (let i = 0; i <= steps; i++) {
    const x = box.x + (box.w * i) / steps;
    if (x < s.x0 || x > end) continue;
    const p = wedgePointAt(s, tAtX(s.x0, end, x));
    if (p.thickness > 0.25 && p.y - p.thickness / 2 < box.y + box.h && p.y + p.thickness / 2 > box.y) return true;
  }
  return false;
}

/** Whether a placed saved plate sits on its own wedge; if it does not, the leader that joins it to the wedge. */
function plateTie(r: LayoutRibbon, box: Box): Pick<LayoutLabel, 'inBand' | 'leader'> {
  if (boxOnWedge(box, r)) return { inBand: true };
  // the leader drops from the plate's edge, at its left end (nearest the pipeline), to the middle of the wedge
  const end = r.s2.sinkTop !== undefined ? (r.s2.sinkX ?? r.s2.x1) : r.s2.x1;
  const x = clamp(box.x + 10, r.s2.x0, end);
  const wedge = wedgePointAt(r.s2, tAtX(r.s2.x0, end, x));
  const below = wedge.y > box.y + box.h / 2;
  const drop: LayoutLabel['leader'] = { x1: x, y1: below ? box.y + box.h : box.y, x2: x, y2: wedge.y };
  if (r.s2.sinkTop === undefined) return { inBand: false, leader: drop };
  // a wedge that runs apart to the sink falls away steeply: under the plate it may be rows below, so the leader may
  // instead run from the plate's left edge back to where the wedge leaves its pipeline, whichever is shorter (W3-FLOW-3)
  const xs = r.s2.x0 + Math.min(3 * M.s, Math.max(0, box.x - r.s2.x0));
  const start = wedgePointAt(r.s2, tAtX(r.s2.x0, end, xs));
  const back = { x1: box.x, y1: clamp(start.y, box.y, box.y + box.h), x2: xs, y2: start.y };
  const length = (l: { x1: number; y1: number; x2: number; y2: number }): number => Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
  return { inBand: false, leader: length(back) < length(drop) ? back : drop };
}

// ─── Interpolation (the live 1.2 s ease, the 200 ms re-fit, the 400 ms What-if morph) ──

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Interpolates two layouts by id. Items new in `to` grow from zero width; items gone from `to` vanish. */
export function interpolateLayout(from: FlowLayout, to: FlowLayout, t: number): FlowLayout {
  if (t >= 1) return to;
  const tt = clamp(t, 0, 1);
  const fromNodes = new Map(from.nodes.map((n) => [n.id, n]));
  const fromRibbons = new Map(from.ribbons.map((r) => [r.id, r]));
  const fromLabels = new Map(from.labels.map((l) => [l.id, l]));
  return {
    ...to,
    height: lerp(from.height, to.height, tt),
    nodes: to.nodes.map((n) => {
      const a = fromNodes.get(n.id);
      if (!a) {
        const mid = (n.y0 + n.y1) / 2;
        return { ...n, y0: lerp(mid, n.y0, tt), y1: lerp(mid, n.y1, tt) };
      }
      return { ...n, x0: lerp(a.x0, n.x0, tt), x1: lerp(a.x1, n.x1, tt), y0: lerp(a.y0, n.y0, tt), y1: lerp(a.y1, n.y1, tt) };
    }),
    ribbons: to.ribbons.map((r) => {
      const a = fromRibbons.get(r.id);
      if (!a) {
        return {
          ...r,
          s1: { ...r.s1, w: r.s1.w * tt },
          s2: { ...r.s2, wIn: r.s2.wIn * tt, wOut: r.s2.wOut * tt },
        };
      }
      return {
        ...r,
        s1: {
          x0: lerp(a.s1.x0, r.s1.x0, tt),
          x1: lerp(a.s1.x1, r.s1.x1, tt),
          top0: lerp(a.s1.top0, r.s1.top0, tt),
          top1: lerp(a.s1.top1, r.s1.top1, tt),
          w: lerp(a.s1.w, r.s1.w, tt),
        },
        s2: {
          x0: lerp(a.s2.x0, r.s2.x0, tt),
          x1: lerp(a.s2.x1, r.s2.x1, tt),
          top0: lerp(a.s2.top0, r.s2.top0, tt),
          top1: lerp(a.s2.top1, r.s2.top1, tt),
          wIn: lerp(a.s2.wIn, r.s2.wIn, tt),
          wOut: lerp(a.s2.wOut, r.s2.wOut, tt),
          // a wedge running to the sink glides with it (one that only now reaches the sink starts there)
          ...(r.s2.sinkTop !== undefined
            ? {
                sinkX: a.s2.sinkX !== undefined ? lerp(a.s2.sinkX, r.s2.sinkX ?? r.s2.x1, tt) : r.s2.sinkX,
                sinkTop: a.s2.sinkTop !== undefined ? lerp(a.s2.sinkTop, r.s2.sinkTop, tt) : r.s2.sinkTop,
              }
            : {}),
        },
      };
    }),
    labels: to.labels.map((l) => {
      const a = fromLabels.get(l.id);
      // a plate new in `to` (a wedge that is only now growing) fades in with it rather than popping in at full size
      if (!a) return { ...l, appear: tt };
      const x = lerp(a.x, l.x, tt);
      const y = lerp(a.y, l.y, tt);
      // a leader keeps its end on the moving plate
      const leader = l.leader ? { ...l.leader, x1: l.leader.x1 + x - l.x, x2: l.leader.x2 + x - l.x, y1: l.leader.y1 + y - l.y } : undefined;
      return { ...l, x, y, ...(leader ? { leader } : {}) };
    }),
  };
}

/**
 * Whether `to` shows different figures from `from` (a live snapshot moved a flow's dollars or bytes, or the set of
 * ribbons changed), as opposed to the same figures re-fitted to a new frame height. Drives the tween length.
 */
export function figuresChanged(from: FlowLayout, to: FlowLayout): boolean {
  if (from.ribbons.length !== to.ribbons.length) return true;
  const before = new Map(from.ribbons.map((r) => [r.id, r.flow]));
  for (const r of to.ribbons) {
    const f = before.get(r.id);
    if (!f) return true;
    if (f.whpPerDayM !== r.flow.whpPerDayM || f.paidPerDayM !== r.flow.paidPerDayM || f.inBPerDay !== r.flow.inBPerDay || f.outBPerDay !== r.flow.outBPerDay) return true;
  }
  return false;
}

/** Whether two layouts draw exactly the same picture (a re-read of the same snapshot): nothing to animate. */
export function sameGeometry(a: FlowLayout, b: FlowLayout): boolean {
  if (a.width !== b.width || a.height !== b.height || a.nodes.length !== b.nodes.length || a.ribbons.length !== b.ribbons.length || a.labels.length !== b.labels.length) return false;
  const eq = (x: object, y: object): boolean => JSON.stringify(x) === JSON.stringify(y);
  for (let i = 0; i < a.nodes.length; i++) {
    const [m, n] = [a.nodes[i], b.nodes[i]];
    if (m.id !== n.id || m.x0 !== n.x0 || m.x1 !== n.x1 || m.y0 !== n.y0 || m.y1 !== n.y1 || m.name !== n.name) return false;
  }
  for (let i = 0; i < a.ribbons.length; i++) {
    const [q, r] = [a.ribbons[i], b.ribbons[i]];
    if (q.id !== r.id || q.colorIndex !== r.colorIndex || q.hue !== r.hue || q.projected !== r.projected || !eq(q.s1, r.s1) || !eq(q.s2, r.s2)) return false;
  }
  for (let i = 0; i < a.labels.length; i++) {
    const [k, l] = [a.labels[i], b.labels[i]];
    if (k.id !== l.id || k.x !== l.x || k.y !== l.y || !eq(k.lines, l.lines)) return false;
  }
  return true;
}
