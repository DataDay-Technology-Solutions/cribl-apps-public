// src/story/fixture.ts — the tour fixture re-cut as the Story's script, for the tour engine (pure).
//
// Story mode reuses the tour engine (src/tour/engine.ts) unchanged: same store path (the SAMPLE DATA
// band, no Cribl call, no KV write), same rebasing onto the wall clock, loop mode. What changes is the
// script: the story document's beat actions, laid end to end on one clock, and the pass length.
//
// One rule keeps the base state honest: a commit the story SHIPS (a 'commit' action, "a change ships")
// is not already on the base change timeline — otherwise it could not land on screen — so it is taken
// out of the base snapshot and the fixture's own timeline. Everything else is the fixture as recorded.

import type { Commit, StoryDoc } from '../../core/types.ts';
import type { TourFixture } from '../tour/types.ts';
import { flattenActions, storySeconds } from './timeline.ts';

/** Hashes of the commits the story's actions ship. */
export function shippedCommits(doc: Pick<StoryDoc, 'beats'>): Set<string> {
  const out = new Set<string>();
  for (const b of doc.beats)
    for (const a of b.actions) {
      const hash = a.action === 'commit' ? (a.payload as Partial<Commit> | null)?.hash : undefined;
      if (typeof hash === 'string' && hash) out.add(hash);
    }
  return out;
}

/** The fixture the Story view hands the tour engine: the story's script, the story's pass length. */
export function storyFixture(tour: TourFixture, doc: StoryDoc): TourFixture {
  const shipped = shippedCommits(doc);
  const unshipped = (list: readonly Commit[]): Commit[] => list.filter((c) => !shipped.has(c.hash));
  return {
    ...tour,
    snapshot: { ...tour.snapshot, timeline: unshipped(tour.snapshot.timeline) },
    timeline: unshipped(tour.timeline),
    script: flattenActions(doc),
    durationSec: storySeconds(doc),
  };
}
