// src/components/FlowDiagram/selection.ts — what the map highlights and what the receipt card derives.

import { tn } from '../../copy/en.ts';
import { isDrawable, type FlowLayout, type LayoutFlow, type NodeTotals } from './layout.ts';

export type FlowSelection = { kind: 'ribbon'; id: string } | { kind: 'node'; id: string } | null;

/** Flow keys on the highlighted path (empty = nothing highlighted). */
export function pathFlowKeys(layout: FlowLayout, selection: FlowSelection): Set<string> {
  if (!selection) return new Set();
  if (selection.kind === 'ribbon') {
    const r = layout.ribbons.find((x) => x.id === selection.id);
    return new Set(r ? [r.flowKey] : []);
  }
  const n = layout.nodes.find((x) => x.id === selection.id);
  return new Set(n ? n.flowKeys : []);
}

/** Whether a selection still points at something on the map. */
export function selectionExists(layout: FlowLayout | null, selection: FlowSelection): boolean {
  if (!layout || !selection) return false;
  return selection.kind === 'ribbon' ? layout.ribbons.some((r) => r.id === selection.id) : layout.nodes.some((n) => n.id === selection.id);
}

/** "Now" as a multiple of the stream's own hour average (paid / day ÷ 24). */
export function baselineMultiple(totals: Pick<NodeTotals, 'ratePerHourM' | 'paidPerDayM'>): number | null {
  const baseline = totals.paidPerDayM / 24;
  if (!(baseline > 0)) return null;
  return totals.ratePerHourM / baseline;
}

/** "6 flows" for a card eyebrow. */
export function flowCount(n: number): string {
  return tn('flow.card.flowCount', n);
}

/**
 * Why flows are not drawn (P1-I04), in three plain buckets: no traffic in the last hour (the per-day figures are
 * the last hour × 24), a destination without a price (the only one Settings can fix), and $0 a day (priced at
 * $0, e.g. DevNull at the internal preset).
 */
export function undrawnCounts(flows: readonly LayoutFlow[], unpricedOutputIds: readonly string[] = []): { noTraffic: number; unpriced: number; zero: number } {
  const unpriced = new Set(unpricedOutputIds);
  const out = { noTraffic: 0, unpriced: 0, zero: 0 };
  for (const f of flows) {
    if (isDrawable(f)) continue;
    if (!(f.inBPerDay > 0)) out.noTraffic++;
    else if (unpriced.has(f.outputId)) out.unpriced++;
    else out.zero++;
  }
  return out;
}
