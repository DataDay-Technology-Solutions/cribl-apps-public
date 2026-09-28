// src/components/IncidentTakeover/lost.ts — what the incident has cost so far (P2-W03), pure.
//
// The red card says "$25 a day"; the lost counter makes it felt: the money the drop has cost since the change
// went live, at the incident's own rate (impactPerDayM, the worst reading's $/day — D45), counting in red while
// the card is up, and frozen on the green card at the close ("Cost $1.23 before it recovered"). The start is the
// "Caught in" clock's (IncidentCard/model.ts caughtStartMs: the matched commit's deploy, else the first minute
// that showed the drop), so the two figures on the card measure from the same moment. Savings drops and cost
// spikes lose money; a budget pace or good news has no counter. Integer millicents at the ends.

import type { Incident } from '../../../core/types.ts';
import { caughtStartMs } from '../IncidentCard/model.ts';

const DAY_MS = 86_400_000;

export interface LostClock {
  /** when the loss started, epoch ms */
  startMs: number;
  /** millicents lost per second */
  ratePerSecM: number;
  /** whether the start is a matched commit's deploy ("Lost since the deploy") */
  sinceDeploy: boolean;
}

/** The loss clock for an incident, or null when it has none (no rate, no start, not a money-losing kind). */
export function lostClock(incident: Pick<Incident, 'type' | 'impactPerDayM' | 'commit' | 'caughtInSec' | 'openedAt'>): LostClock | null {
  if (incident.type !== 'regression' && incident.type !== 'spike') return null;
  const perDay = incident.impactPerDayM;
  if (!Number.isFinite(perDay) || perDay <= 0) return null;
  const startMs = caughtStartMs(incident);
  if (!Number.isFinite(startMs)) return null;
  return { startMs, ratePerSecM: (perDay * 1000) / DAY_MS, sinceDeploy: !!incident.commit };
}

/** Millicents lost by `atMs` (0 before the start). */
export function lostAt(clock: LostClock, atMs: number): number {
  return Math.round(clock.ratePerSecM * Math.max(0, atMs - clock.startMs) / 1000);
}
