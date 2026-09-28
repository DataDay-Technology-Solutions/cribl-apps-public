// src/views/Story/source.ts — which story the view plays (SPEC 13 / 15).
//
//   release build   demo/sample/story.json over the tour fixture — the SAMPLE DATA band stays on
//   demo build      demo/sample/story-live.json over demo/sample/replay.json (the recorded real run, no
//                   band) once both exist; until the replay is recorded it plays the tour story too
//
// The live pair is found with a lazy glob, tested INLINE on the build flag (the src/router.tsx pattern):
// the release bundle folds the branch away, and a demo build without the files simply finds none.

import type { StoryDoc } from '../../../core/types.ts';
import { STORY_DOC, withBuildAsk } from '../../story/doc.ts';
import { storyFixture } from '../../story/fixture.ts';
import { TOUR_FIXTURE } from '../../tour/fixture.ts';
import type { TourFixture } from '../../tour/types.ts';

export interface StorySourceData {
  doc: StoryDoc;
  /** the fixture the tour engine plays: base state + the story's actions as its script */
  fixture: TourFixture;
  /** how the store shows it: 'sample' (the SAMPLE DATA band) or 'replay' (the recorded run) */
  source: 'sample' | 'replay';
}

type JsonModule = { default: unknown };

const LIVE: Record<string, () => Promise<JsonModule>> =
  import.meta.env.VITE_MR_BUILD === 'demo' ? import.meta.glob<JsonModule>(['../../../demo/sample/story-live.json', '../../../demo/sample/replay.json']) : {};

/** The tour story: bundled, always available. */
export function tourStory(): StorySourceData {
  return { doc: STORY_DOC, fixture: storyFixture(TOUR_FIXTURE, STORY_DOC), source: 'sample' };
}

/** The demo build's recorded story when it exists, else the tour story. Never rejects. */
export async function loadStorySource(): Promise<StorySourceData> {
  const storyLoader = Object.entries(LIVE).find(([path]) => path.endsWith('/story-live.json'))?.[1];
  const replayLoader = Object.entries(LIVE).find(([path]) => path.endsWith('/replay.json'))?.[1];
  if (!storyLoader || !replayLoader) return tourStory();
  try {
    const [story, replay] = await Promise.all([storyLoader(), replayLoader()]);
    const doc = withBuildAsk(story.default as StoryDoc);
    return { doc, fixture: storyFixture(replay.default as TourFixture, doc), source: 'replay' };
  } catch (err) {
    console.warn('[meter-reader] story-live.json could not be loaded; playing the tour story', err);
    return tourStory();
  }
}

/** True when this bundle can play the recorded run (demo build with both files present). */
export const HAS_LIVE_STORY = Object.keys(LIVE).length === 2;
