// src/story — Story mode's one beat table and everything derived from it (PRD 8.9, SPEC 13/15/17).
//
//   beats.ts     the beat table · buildStoryDoc(fixture) · caption facts · callout ids per view
//   timeline.ts  positionAt(doc, t) · caption windows · the flattened script (pure)
//   doc.ts       the bundled story.json · beatAt(tSeconds) for the video capture
//   fixture.ts   the tour fixture re-cut as the story's script, for the tour engine
//   layout.ts    callout label + leader-line placement (pure geometry)
//   render.ts    demo/sample/captions.srt and VIDEO_SCRIPT.md text
//   select.ts    the story's incident, commit and flow
// Node scripts import the files directly (doc.ts imports JSON, which plain Node needs attributes for).

export { BEATS, CALLOUT_IDS, MAX_CAPTION_WORDS, MAX_LINES_PER_BEAT, MIN_LINE_SECONDS, STORY_PATHS, VIEW_CALLOUTS, buildStoryDoc, serializeStory, storyFacts, storyMoments, wordCount } from './beats.ts';
export type { BeatDef, CalloutId, StoryFacts, StoryMoments, StorySource } from './beats.ts';
export { beatStart, beatStarts, captionLines, captionWindows, flattenActions, positionAt, storySeconds, type CaptionWindow, type StoryPosition } from './timeline.ts';
export { STORY_DOC, beatAt } from './doc.ts';
export { shippedCommits, storyFixture } from './fixture.ts';
export { layoutCallouts, leader, type CalloutInput, type LayoutOptions, type Placement, type Rect, type Side } from './layout.ts';
export { captionsSrt, clockTime, srtTime, videoScript, wrapCaption } from './render.ts';
export { flowOf, storyCommit, storyIncident } from './select.ts';
