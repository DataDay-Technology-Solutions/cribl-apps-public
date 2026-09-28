// src/views/Flow/groups.ts — the worker groups the Flow map can show.

import type { Snapshot } from '../../../core/types.ts';
import { isDrawable } from '../../components/FlowDiagram/layout.ts';

/** Worker groups with priced traffic, largest would-have-paid first (then every other group the snapshot knows). */
export function groupsOf(snapshot: Snapshot | null): string[] {
  if (!snapshot) return [];
  const whp = new Map<string, number>();
  for (const f of snapshot.flows) {
    if (f.groupId === '-') continue;
    whp.set(f.groupId, (whp.get(f.groupId) ?? 0) + (isDrawable(f) ? f.whpPerDayM : 0));
  }
  return [...whp.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([g]) => g);
}
