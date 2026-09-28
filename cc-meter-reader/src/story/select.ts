// src/story/select.ts — what the Story view needs to know about its own document (pure).

import type { Commit, FlowFigures, Incident, Snapshot, StoryDoc } from '../../core/types.ts';
import { flowObjectKeys } from '../../core/flows.ts';
import { isDrawable } from '../components/FlowDiagram/layout.ts';
import { groupsOf } from '../views/Flow/groups.ts';

/** The incident the story tells (the first one its beats open). */
export function storyIncident(doc: Pick<StoryDoc, 'beats'>): Incident | undefined {
  for (const b of doc.beats) for (const a of b.actions) if (a.action === 'incident.open') return a.payload as Incident;
  return undefined;
}

/** The change the story ships (its first commit action). */
export function storyCommit(doc: Pick<StoryDoc, 'beats'>): Commit | undefined {
  for (const b of doc.beats) for (const a of b.actions) if (a.action === 'commit') return a.payload as Commit;
  return undefined;
}

/** The flow an incident is about (route, pipeline or input key), the costliest when several match. */
export function flowOf(flows: readonly FlowFigures[], objectKey: string): FlowFigures | undefined {
  let best: FlowFigures | undefined;
  for (const f of flows) {
    const keys = flowObjectKeys(f);
    if (keys.route !== objectKey && keys.pipeline !== objectKey && keys.input !== objectKey && keys.output !== objectKey) continue;
    if (!best || f.whpPerDayM > best.whpPerDayM) best = f;
  }
  return best;
}

/** The worker group the story's dollar map draws, with what it saves a day. */
export interface StoryFlowGroup {
  groupId: string;
  /** the group's priced flows with traffic (what the map can draw) */
  flows: FlowFigures[];
  /** their saved $ / day, summed: the figure the flow beat's caption says and its header shows */
  savedPerDayM: number;
}

/**
 * The group the Flow view opens on (the largest would-have-paid first, src/views/Flow/groups.ts), so the story's
 * map is the one a member lands on. Undefined when no group has priced traffic.
 */
export function storyFlowGroup(snapshot: Pick<Snapshot, 'flows'>): StoryFlowGroup | undefined {
  const groupId = groupsOf(snapshot as Snapshot)[0];
  if (!groupId) return undefined;
  const flows = snapshot.flows.filter((f) => f.groupId === groupId && isDrawable(f));
  if (flows.length === 0) return undefined;
  return { groupId, flows, savedPerDayM: flows.reduce((sum, f) => sum + f.savedPerDayM, 0) };
}
