// src/components/RatioWatch/series.ts — which series an incident's chart draws (P2-W15), pure: the flow the incident
// is about (its route, pipeline, input or output key; the costliest when several match), its per-minute savings
// ratio, the snapshot's window end, the change the clock starts at, and the close.

import type { FlowFigures, Incident, Snapshot } from '../../../core/types.ts';
import { flowObjectKeys } from '../../../core/flows.ts';
import { caughtStartMs } from '../IncidentCard/model.ts';

export interface IncidentSeries {
  values: number[];
  endMs: number;
  changeMs: number;
  closedMs?: number;
  baseline: number;
}

function flowFor(flows: readonly FlowFigures[], objectKey: string): FlowFigures | undefined {
  let best: FlowFigures | undefined;
  for (const f of flows) {
    const keys = flowObjectKeys(f);
    if (keys.route !== objectKey && keys.pipeline !== objectKey && keys.input !== objectKey && keys.output !== objectKey) continue;
    if (!best || f.whpPerDayM > best.whpPerDayM) best = f;
  }
  return best;
}

/** The chart's series for a savings drop, or null (another kind, no flow, too few minutes, no start). */
export function incidentSeries(
  snapshot: Pick<Snapshot, 'flows' | 'windowEnd'> | null | undefined,
  incident: Pick<Incident, 'type' | 'objectKey' | 'before' | 'commit' | 'caughtInSec' | 'openedAt' | 'closedAt'>,
): IncidentSeries | null {
  if (!snapshot || (incident.type !== 'regression' && incident.type !== 'goodnews')) return null;
  const flow = flowFor(snapshot.flows ?? [], incident.objectKey);
  const values = (flow?.sparkline ?? []).filter((v) => Number.isFinite(v));
  const endMs = Date.parse(snapshot.windowEnd);
  const changeMs = caughtStartMs(incident);
  if (values.length < 3 || !Number.isFinite(endMs) || !Number.isFinite(changeMs) || !Number.isFinite(incident.before)) return null;
  const closedMs = incident.closedAt ? Date.parse(incident.closedAt) : Number.NaN;
  return { values, endMs, changeMs, baseline: incident.before, ...(Number.isFinite(closedMs) ? { closedMs } : {}) };
}
