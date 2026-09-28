// src/story/timeline.ts — where the story is at any second (pure; no DOM, no clock).
//
// The in-app loop, the Playwright video capture and the caption file all ask the same question — "at
// t seconds, which beat, which caption line, which callouts?" — and answer it here, from the story
// document alone. `beatAt(tSeconds)` in ./doc.ts is this with the bundled story.json.
//
// Caption timing: a beat's lines split its seconds evenly and play in sequence (PRD 15.3a: up to three
// lines, each ≥ 2.5 s). The SRT cues (render.ts) use exactly these windows.

import type { StoryBeat, StoryCallout, StoryDoc, TourStep } from '../../core/types.ts';

/** A beat's caption as lines (a string is one line; none is []). */
export function captionLines(beat: Pick<StoryBeat, 'caption'>): string[] {
  const c = beat.caption;
  if (Array.isArray(c)) return c.filter((l) => typeof l === 'string' && l.trim() !== '');
  return typeof c === 'string' && c.trim() !== '' ? [c] : [];
}

/** Total seconds of one pass. */
export function storySeconds(doc: Pick<StoryDoc, 'beats'>): number {
  return doc.beats.reduce((s, b) => s + Math.max(0, b.seconds), 0);
}

/** Second at which each beat starts. */
export function beatStarts(doc: Pick<StoryDoc, 'beats'>): number[] {
  const out: number[] = [];
  let t = 0;
  for (const b of doc.beats) {
    out.push(t);
    t += Math.max(0, b.seconds);
  }
  return out;
}

export interface CaptionWindow {
  /** 1-based cue number across the whole story (the SRT index) */
  cue: number;
  beatId: string;
  beatIndex: number;
  /** index of the line within its beat */
  line: number;
  text: string;
  start: number;
  end: number;
}

/** Every caption line with its window, in order. */
export function captionWindows(doc: Pick<StoryDoc, 'beats'>): CaptionWindow[] {
  const starts = beatStarts(doc);
  const out: CaptionWindow[] = [];
  doc.beats.forEach((b, beatIndex) => {
    const lines = captionLines(b);
    const each = lines.length > 0 ? b.seconds / lines.length : 0;
    lines.forEach((text, line) => {
      const start = starts[beatIndex] + line * each;
      out.push({ cue: out.length + 1, beatId: b.id, beatIndex, line, text, start, end: start + each });
    });
  });
  return out;
}

/** The story's steps on one clock (seconds from the start of the loop), in play order. */
export function flattenActions(doc: Pick<StoryDoc, 'beats'>): TourStep[] {
  const starts = beatStarts(doc);
  return doc.beats.flatMap((b, i) => b.actions.map((a) => ({ at: starts[i] + Math.min(Math.max(0, a.at), b.seconds), action: a.action, payload: a.payload })));
}

export interface StoryPosition {
  /** seconds into the current pass, [0, total) */
  t: number;
  /** which pass (0 for the first) */
  iteration: number;
  total: number;
  index: number;
  beat: StoryBeat;
  /** beat window, seconds from the start of the pass */
  start: number;
  end: number;
  /** seconds into this beat */
  tInBeat: number;
  /** 0 … 1 through this beat */
  progress: number;
  lines: string[];
  /** current caption line (-1 when the beat has none) */
  lineIndex: number;
  line: string | null;
  /**
   * Callouts on screen: from their `at`, for as long as the caption line they arrived with is up (a
   * number is called out at the moment it is spoken, then gives the screen back). In a beat with one
   * caption line or none, they stay to the end of the beat.
   */
  callouts: StoryCallout[];
  /**
   * Every callout of this caption line, up now or still to come in it (a beat with one line or none: all of the
   * beat's). The callout layer places them together, so a label that arrives later in the line finds room the
   * earlier ones left it, and none of them moves when it does (P1-C03).
   */
  lineCallouts: StoryCallout[];
  /**
   * Index of the first beat of the run of consecutive beats sharing this view (change → watching are
   * one scene): the stage keeps one mount across the run.
   */
  runStart: number;
}

/** Where the story is `tSeconds` after it started (wrapping: it loops). */
export function positionAt(doc: StoryDoc, tSeconds: number): StoryPosition {
  const total = storySeconds(doc);
  if (doc.beats.length === 0 || !(total > 0)) throw new Error('story: the document has no beats');
  const raw = Number.isFinite(tSeconds) && tSeconds > 0 ? tSeconds : 0;
  const iteration = Math.floor(raw / total);
  // Float-safe wrap: a value a hair under a multiple of `total` must not wrap into the next pass.
  let t = raw - iteration * total;
  if (t < 0) t = 0;
  if (t >= total) t = 0;
  const starts = beatStarts(doc);
  let index = doc.beats.length - 1;
  for (let i = 0; i < doc.beats.length; i++) {
    if (t < starts[i] + doc.beats[i].seconds) {
      index = i;
      break;
    }
  }
  const beat = doc.beats[index];
  const start = starts[index];
  const tInBeat = Math.min(Math.max(0, t - start), beat.seconds);
  const lines = captionLines(beat);
  const lineIndex = lines.length === 0 ? -1 : Math.min(lines.length - 1, Math.floor((tInBeat / beat.seconds) * lines.length));
  // The caption line a callout arrives with (every callout of a beat with one line or none).
  const inLine = (c: StoryCallout): boolean =>
    lines.length <= 1 || Math.min(lines.length - 1, Math.floor(((c.at ?? 0) / beat.seconds) * lines.length)) === lineIndex;
  let runStart = index;
  while (runStart > 0 && doc.beats[runStart - 1].view === beat.view) runStart--;
  return {
    t,
    iteration,
    total,
    index,
    beat,
    start,
    end: start + beat.seconds,
    tInBeat,
    progress: beat.seconds > 0 ? tInBeat / beat.seconds : 1,
    lines,
    lineIndex,
    line: lineIndex >= 0 ? lines[lineIndex] : null,
    callouts: beat.callouts.filter((c) => (c.at ?? 0) <= tInBeat + 1e-9 && inLine(c)),
    lineCallouts: beat.callouts.filter(inLine),
    runStart,
  };
}

/** Second (from the start of the pass) at which a beat starts, by id. */
export function beatStart(doc: StoryDoc, id: string): number {
  const i = doc.beats.findIndex((b) => b.id === id);
  if (i < 0) throw new Error(`story: no beat "${id}"`);
  return beatStarts(doc)[i];
}
