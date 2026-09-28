// D54: the Story's closing ask is build-specific. The vote ask ("Customer track · vote in the CriblCon app.") belongs
// to the demo build alone (the stage and the hallway). The release build, and every document scripts/story.ts writes
// in plain Node (story.json, story-live.json, VIDEO_SCRIPT.md, captions.srt), signs off with the network to join.
// src/story/doc.ts swaps the build's own ask into the bundled document, so the demo build's Story still asks.
//
// The demo half re-imports the modules with VITE_MR_BUILD=demo (the demo-copy-keys.test.ts pattern).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoryDoc, TourDoc } from '../../core/types.ts';

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const SIGN = 'Meter Reader by Steve\u00a0Koelpin.';
const JOIN = 'Join the Cribl Innovators Network.';
const VOTE = 'Customer track · vote in the CriblCon app.';
const VOTE_WORDS = /vote in the CriblCon app/i;

const askOf = (doc: StoryDoc): string[] => {
  const beat = doc.beats.find((b) => b.id === 'ask');
  if (!beat) throw new Error('the story has no ask beat');
  return Array.isArray(beat.caption) ? beat.caption : [beat.caption];
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the release build (no demo flag) never asks for votes', () => {
  it('signs off with the network to join, in the copy and in the bundled Story document', async () => {
    vi.resetModules();
    const { tLines } = await import('../../src/copy/en.ts');
    const { STORY_DOC } = await import('../../src/story/doc.ts');
    expect(tLines('story.captions.ask')).toEqual([SIGN, JOIN]);
    expect(askOf(STORY_DOC)).toEqual([SIGN, JOIN]);
  });

  it('the generated documents carry the join line and no vote ask (they are the public ones)', () => {
    for (const p of ['demo/sample/story.json', 'demo/sample/story-live.json', 'demo/sample/captions.srt', 'VIDEO_SCRIPT.md']) {
      const text = read(p);
      expect(text, p).not.toMatch(VOTE_WORDS);
      expect(text, p).toContain(JOIN);
    }
    const committed = askOf(JSON.parse(read('demo/sample/story.json')) as StoryDoc);
    expect(committed).toHaveLength(2);
    expect(committed[1]).toBe(JOIN);
  });

  it("render.ts's script and captions quote the join line, never the vote ask", async () => {
    vi.resetModules();
    const { buildStoryDoc, storyFacts, storyMoments, STORY_PATHS } = await import('../../src/story/beats.ts');
    const { captionsSrt, videoScript } = await import('../../src/story/render.ts');
    const tour = JSON.parse(read(STORY_PATHS.tour)) as TourDoc;
    const doc = buildStoryDoc(tour, 'tour');
    const script = videoScript(doc, { facts: storyFacts(storyMoments(tour)), fixturePath: STORY_PATHS.tour });
    expect(script).not.toMatch(VOTE_WORDS);
    expect(script).toContain(JOIN);
    expect(captionsSrt(doc)).not.toMatch(VOTE_WORDS);
  });
});

describe('the demo build keeps the vote ask (the stage and the hallway)', () => {
  it('the copy, and the Story document the demo build plays, end on the vote ask; the timing does not move', async () => {
    const release = (await import('../../src/story/doc.ts')).STORY_DOC;
    const { captionWindows } = await import('../../src/story/timeline.ts');
    const releaseWindows = captionWindows(release).map((w) => [w.start, w.end]);

    vi.stubEnv('VITE_MR_BUILD', 'demo');
    vi.resetModules();
    const { tLines } = await import('../../src/copy/en.ts');
    const { STORY_DOC, withBuildAsk } = await import('../../src/story/doc.ts');
    expect(tLines('story.captions.ask')).toEqual([SIGN, VOTE]);
    expect(askOf(STORY_DOC)).toEqual([SIGN, VOTE]);
    // The recorded run (story-live.json, demo build only) is swapped the same way when src/views/Story/source.ts loads it.
    expect(askOf(withBuildAsk(JSON.parse(read('demo/sample/story-live.json')) as StoryDoc))).toEqual([SIGN, VOTE]);
    // Two lines either way: the caption windows, and so the ask's callout, keep their times.
    const timeline = await import('../../src/story/timeline.ts');
    expect(timeline.captionWindows(STORY_DOC).map((w) => [w.start, w.end])).toEqual(releaseWindows);
  });
});
