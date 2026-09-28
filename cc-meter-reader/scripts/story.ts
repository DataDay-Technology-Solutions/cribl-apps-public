// scripts/story.ts — Story mode, the video script and the captions, from ONE beat table.
//
//   npx tsx scripts/story.ts           write demo/sample/story.json, VIDEO_SCRIPT.md, demo/sample/captions.srt
//                                      (and demo/sample/story-live.json when demo/sample/replay.json exists)
//   npx tsx scripts/story.ts --check   exit 1 if any of them is stale (the unit tests hold the same line)
//
// The table is src/story/beats.ts: beat order, seconds, view, caption copy key, callouts and which of
// the fixture's own steps each beat plays. Caption wording comes from src/copy/en.ts; every number in
// a caption is formatted from the fixture here, at generation time (SPEC 15, PRD 8.9 / 15).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TourDoc } from '../core/types.ts';
import { STORY_PATHS, buildStoryDoc, serializeStory, storyFacts, storyMoments } from '../src/story/beats.ts';
import { captionsSrt, clockTime, videoScript } from '../src/story/render.ts';
import { captionWindows, storySeconds } from '../src/story/timeline.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

function readFixture(path: string): TourDoc {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as TourDoc;
}

interface Output {
  path: string;
  text: string;
}

const tour = readFixture(STORY_PATHS.tour);
const story = buildStoryDoc(tour, 'tour');
const facts = storyFacts(storyMoments(tour));
const outputs: Output[] = [
  { path: STORY_PATHS.story, text: serializeStory(story) },
  { path: STORY_PATHS.videoScript, text: videoScript(story, { facts, fixturePath: STORY_PATHS.tour }) },
  { path: STORY_PATHS.captions, text: captionsSrt(story) },
];

// The demo build plays the recorded run (SPEC 15). Only once it has been recorded.
const hasReplay = existsSync(resolve(root, STORY_PATHS.replay));
if (hasReplay) {
  const replay = readFixture(STORY_PATHS.replay);
  outputs.push({ path: STORY_PATHS.storyLive, text: serializeStory(buildStoryDoc(replay, 'replay')) });
}

const summary = `${story.beats.length} beats · ${clockTime(storySeconds(story))} · ${captionWindows(story).length} caption lines · saved ${facts.saved} MTD · caught in ${facts.caughtIn}`;

if (check) {
  const stale = outputs.filter((o) => {
    try {
      return readFileSync(resolve(root, o.path), 'utf8') !== o.text;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(`stale: ${stale.map((o) => o.path).join(', ')}. Run: npx tsx scripts/story.ts`);
    process.exit(1);
  }
  console.log(`story outputs are current (${summary})${hasReplay ? '' : ` · ${STORY_PATHS.storyLive} waits for ${STORY_PATHS.replay}`}`);
} else {
  for (const o of outputs) {
    const out = resolve(root, o.path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, o.text);
    console.log(`wrote ${o.path}`);
  }
  console.log(summary);
  if (!hasReplay) console.log(`skipped ${STORY_PATHS.storyLive}: ${STORY_PATHS.replay} has not been recorded yet`);
}
