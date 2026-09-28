// src/views/Presenter/savers.ts — the stage's saver lines (the presenter view, the Story's presenter beats and the
// Demo Console's miniature): their names, and what an open regression has taken off them.

import type { Incident, ObjectKey, TopSaver } from '../../../core/types.ts';
import { parseObjectKey } from '../../../core/flows.ts';
import { humanize } from '../../../core/humanize.ts';

export function saverLabel(s: TopSaver, labels: Record<string, string>): string {
  return s.label?.trim() ? s.label : humanize(s.pipelineId, labels);
}

/** The separator a saver's label puts between the route it names and the pipeline ("Windows DC security events · Windows XML pack"). */
const ROUTE_SEP = ' · ';

/**
 * The stage's saver labels (review W2): the pipeline part alone when that tells the savers apart, as the stage read
 * in wave 1 ("Windows XML pack"), the whole route-prefixed label only for the ones it doesn't. At stage size the
 * prefixed label ran out of room and ended in an ellipsis followed by the dot leader.
 */
export function stageSaverLabels(savers: readonly TopSaver[], labels: Record<string, string>): string[] {
  const full = savers.map((s) => saverLabel(s, labels));
  const at = (l: string) => l.lastIndexOf(ROUTE_SEP);
  const pipeline = full.map((l) => (at(l) >= 0 ? l.slice(at(l) + ROUTE_SEP.length) : l));
  const route = full.map((l) => (at(l) >= 0 ? l.slice(0, at(l)) : l));
  const unique = (xs: string[], i: number) => xs.filter((x) => x === xs[i]).length === 1;
  // The pipeline when it is the only one of its name on the list, else the route it runs on (two routes through
  // one pipeline differ there), else the whole label.
  return full.map((l, i) => (unique(pipeline, i) ? pipeline[i] : unique(route, i) ? route[i] : l));
}

/**
 * W3-STAGE-1: what an open regression has taken off each saver's line, by the saver's objectKey ($ / day,
 * millicents). The stage keeps a saver's own figure (the last hour's rate × 24, the figure the Ledger shows) and sets
 * the open incident's drop beside it; it never subtracts one from the other, since the two are on different bases
 * (the impact is the ratio drop × the volume) and the result would agree with nothing else in the App.
 *
 * Which saver an incident names: the one whose objectKey is the incident's; else, for an incident keyed by a
 * pipeline (`pipe:<group>:<id>`) or a route (`route:<group>:<id>`), the first saver on the list in that group
 * carrying that pipeline or on that route. The first, not every one: two routes through one pipeline share its
 * drop, and a chip on both would read as twice the loss. Only open regressions with an impact count (a spike, a
 * budget warning, good news and a closed incident leave the line plain). Two incidents on one saver (its route and
 * its pipeline) usually describe the same drop, so the larger stands, never their sum.
 */
export function saverDrops(savers: readonly TopSaver[], incidents: readonly Incident[] | null | undefined): Map<ObjectKey, number> {
  const drops = new Map<ObjectKey, number>();
  const open = (incidents ?? []).filter((i) => i.type === 'regression' && !i.closedAt && i.impactPerDayM > 0);
  const note = (key: ObjectKey, impactM: number) => drops.set(key, Math.max(drops.get(key) ?? 0, impactM));
  for (const incident of open) {
    const exact = savers.find((s) => s.objectKey === incident.objectKey);
    if (exact) {
      note(exact.objectKey, incident.impactPerDayM);
      continue;
    }
    const key = parseObjectKey(incident.objectKey);
    if (!key || (key.kind !== 'pipe' && key.kind !== 'route')) continue;
    const named = savers.find((s) => {
      if (s.groupId !== key.groupId) return false;
      if (key.kind === 'pipe') return s.pipelineId === key.id;
      const own = parseObjectKey(s.objectKey);
      return own?.kind === 'route' && own.id === key.id;
    });
    if (named) note(named.objectKey, incident.impactPerDayM);
  }
  return drops;
}
