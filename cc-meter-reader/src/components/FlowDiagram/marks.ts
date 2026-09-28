// src/components/FlowDiagram/marks.ts — incidents on the Flow map (P2-W16): which ribbons an alert marks, in what
// tone, and the plate that says what it costs and since when.

import { flowObjectKeys, parseObjectKey } from '../../../core/flows.ts';
import type { Incident } from '../../../core/types.ts';
import { t } from '../../copy/en.ts';
import { formatMoney, formatTimeOfDay } from '../../lib/format.ts';
import type { FlowMark, LayoutFlow } from './layout.ts';

/** How long a recovered incident stays green on its ribbon (P2-W16). */
const RECOVERY_WINDOW_MS = 10_000;

/**
 * The incident marks for these flows (P2-W16): an open regression or spike on a source, route or pipeline marks every
 * flow through it, in its severity; one closed in the last ten seconds marks them green. Budget alerts (a destination's
 * month) and good news are not a ribbon's.
 */
export function incidentMarks(flows: readonly LayoutFlow[], incidents: readonly Incident[] = [], nowMs: number, timeZone?: string): Record<string, FlowMark> {
  const marks: Record<string, FlowMark> = {};
  for (const inc of incidents) {
    if (inc.type !== 'regression' && inc.type !== 'spike') continue;
    const kind = parseObjectKey(inc.objectKey)?.kind;
    if (!kind || kind === 'out') continue;
    const closedMs = inc.closedAt ? Date.parse(inc.closedAt) : Number.NaN;
    const recovered = Number.isFinite(closedMs) && nowMs - closedMs <= RECOVERY_WINDOW_MS && nowMs >= closedMs;
    if (inc.closedAt && !recovered) continue;
    const text = recovered
      ? t('flow.incident.recovered', { time: formatTimeOfDay(inc.closedAt!, timeZone) })
      : inc.commit
        ? t('flow.incident.openCommit', { amount: formatMoney(Math.abs(inc.impactPerDayM)), time: formatTimeOfDay(inc.openedAt, timeZone), commit: inc.commit.hash.slice(0, 7) })
        : t('flow.incident.open', { amount: formatMoney(Math.abs(inc.impactPerDayM)), time: formatTimeOfDay(inc.openedAt, timeZone) });
    const tone: FlowMark['tone'] = recovered ? 'recovered' : inc.severity === 'high' ? 'high' : 'medium';
    const short = recovered
      ? text
      : inc.commit
        ? t('flow.incident.short', { amount: formatMoney(Math.abs(inc.impactPerDayM)), commit: inc.commit.hash.slice(0, 7) })
        : t('flow.incident.shortNoCommit', { amount: formatMoney(Math.abs(inc.impactPerDayM)) });
    for (const f of flows) {
      const keys = flowObjectKeys(f);
      if (keys.input !== inc.objectKey && keys.route !== inc.objectKey && keys.pipeline !== inc.objectKey) continue;
      // an open alert outranks a recovered one on the same flow
      if (marks[f.key] && marks[f.key].tone !== 'recovered' && tone === 'recovered') continue;
      marks[f.key] = { tone, text, short, tiny: recovered ? text : t('flow.incident.shortNoCommit', { amount: formatMoney(Math.abs(inc.impactPerDayM)) }) };
    }
  }
  return marks;
}
