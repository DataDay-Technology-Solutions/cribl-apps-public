// src/components/IncidentTakeover/restore.ts — the change that fixed it (P1-B02), for the green recovery card.
//
// The alert card names the commit that broke the savings; the recovery card names the one that restored them,
// when the timeline shows it: a commit after the breaking one and before the close, on the same object (its
// files, or its message naming the object — core/timeline.ts matchCommit). A merely nearby change is not
// claimed as the fix; then the card says the savings are back at their baseline instead. Pure, no React.

import type { Commit, CommitRef, Incident } from '../../../core/types.ts';
import { commitTimeMs, matchCommit, sameHash } from '../../../core/timeline.ts';

/** The commit that restored a closed incident's savings, when the timeline names one; else undefined. */
export function restoringCommit(
  incident: Pick<Incident, 'objectKey' | 'openedAt' | 'closedAt' | 'commit'>,
  commits: readonly Commit[] | null | undefined,
): CommitRef | undefined {
  if (!incident.closedAt || !commits || commits.length === 0) return undefined;
  const closedMs = Date.parse(incident.closedAt);
  const breakMs = incident.commit ? commitTimeMs(incident.commit) : Date.parse(incident.openedAt);
  if (!Number.isFinite(closedMs) || !Number.isFinite(breakMs) || closedMs <= breakMs) return undefined;
  const own = incident.commit?.hash;
  const later = commits.filter((c) => !(own && sameHash(c.hash, own)));
  const ref = matchCommit([...later], incident.objectKey, { sinceMs: breakMs + 1, untilMs: closedMs });
  return ref && ref.match !== 'nearby' ? ref : undefined;
}
