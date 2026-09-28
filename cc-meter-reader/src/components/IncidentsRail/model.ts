// src/components/IncidentsRail/model.ts — how the rail orders alerts (pure).

import type { Incident } from '../../../core/types.ts';

/** Split into open (most severe first, then newest) and recent (closed, newest first). */
export function partitionIncidents(incidents: readonly Incident[]): {
  open: Incident[];
  recent: Incident[];
} {
  const rank = (i: Incident) => (i.severity === 'high' ? 2 : i.severity === 'medium' ? 1 : 0);
  const byNewest = (a: Incident, b: Incident) => Date.parse(b.openedAt) - Date.parse(a.openedAt);
  const open = incidents.filter((i) => !i.closedAt).sort((a, b) => rank(b) - rank(a) || byNewest(a, b));
  const recent = incidents
    .filter((i) => !!i.closedAt)
    .sort((a, b) => Date.parse(b.closedAt ?? '') - Date.parse(a.closedAt ?? '') || byNewest(a, b));
  return { open, recent };
}
