// src/components/FlowDiagram/text.ts — every word and number the map draws, from the copy table and the one
// formatter (core/format.ts via src/lib/format.ts). Names go through core/humanize.ts.

import { humanize } from '../../../core/humanize.ts';
import { t, tn } from '../../copy/en.ts';
import { formatBytes, formatMoney } from '../../lib/format.ts';
import { OTHER_ID, type LayoutText, type NodeKind, type WeightBy } from './layout.ts';

/** A node's plain-words name ('mrd_pay_sample' → 'Payments API sampling'); '-' gets a designed label. */
export function nodeName(kind: NodeKind, id: string, overrides?: Record<string, string>): string {
  if (id === '-' || id === '') return kind === 'pipe' ? t('flow.noPipeline') : t('flow.unattributed');
  if (id === OTHER_ID) return kind === 'pipe' ? t('flow.other.pipe') : tn('flow.other.source', 2);
  return humanize(id, overrides) || id;
}

/**
 * The name of a folded node: '6 smaller flows' (the shared source) or 'Their pipelines'. On the byte map (P2-W02) the
 * fold can be the widest band of all — the flows are small in dollars, not in bytes — so it reads '6 low-cost flows'.
 */
export function otherName(kind: 'in' | 'pipe', flows: number, weightBy: WeightBy = 'dollars'): string {
  if (kind === 'pipe') return t('flow.other.pipe');
  return weightBy === 'bytes' ? tn('flow.other.sourceBytes', flows) : tn('flow.other.source', flows);
}

export function layoutText(overrides?: Record<string, string>): LayoutText {
  return {
    name: (kind, id) => nodeName(kind, id, overrides),
    caption: (kind, totals, weightBy) =>
      kind === 'in'
        ? t('flow.captionIn', { volume: formatBytes(totals.inBPerDay) })
        : weightBy === 'bytes'
          ? t('flow.captionOutBytes', { volume: formatBytes(totals.outBPerDay) })
          : t('flow.captionOut', { amount: formatMoney(totals.paidPerDayM) }),
    whp: (mc) => t('flow.plateWhp', { amount: formatMoney(mc) }),
    saved: (mc) => t('flow.plateSaved', { amount: formatMoney(mc) }),
    other: otherName,
    volume: (b) => t('flow.plateVolume', { volume: formatBytes(b) }),
    removed: (b) => t('flow.plateRemoved', { volume: formatBytes(b) }),
    // P2-W16: what the pipelines removed, pooled at the foot of the destinations
    sink: {
      name: t('flow.sink.name'),
      caption: (totals, weightBy) =>
        weightBy === 'bytes'
          ? t('flow.sink.captionBytes', { volume: formatBytes(Math.max(0, totals.inBPerDay - totals.outBPerDay)) })
          : t('flow.sink.caption', { amount: formatMoney(totals.savedPerDayM) }),
    },
  };
}

/** Cribl UI page of a pipeline, opened with target _top (the Leader serves the App's frame). */
export function pipelineHref(groupId: string, pipelineId: string): string {
  return `/stream/m/${encodeURIComponent(groupId)}/pipelines/${encodeURIComponent(pipelineId)}`;
}
