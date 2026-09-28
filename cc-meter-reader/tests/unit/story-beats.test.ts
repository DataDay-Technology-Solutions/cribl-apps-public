// Story mode's beat table (src/story/beats.ts) and the three files it generates: demo/sample/story.json,
// VIDEO_SCRIPT.md and demo/sample/captions.srt (SPEC 15, PRD 8.9 / 15.3a). The committed files must be exactly
// what `npx tsx scripts/story.ts` writes, so the loop, the narration and the captions never drift.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Incident, StoryDoc, TourDoc } from '../../core/types.ts';
import { fmtDollars, fmtDuration, fmtPct, perYear } from '../../core/format.ts';
import { tLines } from '../../src/copy/en.ts';
import {
  BEATS,
  CALLOUT_IDS,
  MAX_CAPTION_WORDS,
  MAX_LINES_PER_BEAT,
  MIN_LINE_SECONDS,
  STORY_PATHS,
  VIEW_CALLOUTS,
  buildStoryDoc,
  serializeStory,
  storyFacts,
  storyMoments,
  wordCount,
} from '../../src/story/beats.ts';
import { captionsSrt, videoScript } from '../../src/story/render.ts';
import { captionLines, captionWindows, storySeconds } from '../../src/story/timeline.ts';

const ROOT = resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');
const TOUR = JSON.parse(read(STORY_PATHS.tour)) as TourDoc;
const COMMITTED = JSON.parse(read(STORY_PATHS.story)) as StoryDoc;
const DOC = buildStoryDoc(TOUR, 'tour');
const FACTS = storyFacts(storyMoments(TOUR));

describe('the beat table', () => {
  it('tells PRD 8.9 in order: title → hook → how it works → the dollar map → the Meter → a change ships → watching → the alert → Slack → Restore → the receipt → summary → the ask', () => {
    expect(DOC.beats.map((b) => b.id)).toEqual(['title', 'hook', 'how', 'flow', 'meter', 'change', 'watching', 'alert', 'slack', 'restore', 'receipt', 'summary', 'ask']);
    expect(new Set(DOC.beats.map((b) => b.id)).size).toBe(DOC.beats.length);
    expect(DOC).toMatchObject({ schemaVersion: 1, source: 'tour', loop: true });
  });

  it('runs about 90 seconds, and the beat durations sum to the pass the app loops and the captions end in', () => {
    const total = BEATS.reduce((s, b) => s + b.seconds, 0);
    expect(total).toBeGreaterThanOrEqual(85);
    expect(total).toBeLessThanOrEqual(95);
    expect(storySeconds(DOC)).toBe(total);
    expect(storySeconds(COMMITTED)).toBe(total);
    for (const b of DOC.beats) expect(b.seconds, b.id).toBeGreaterThan(0);
    // The last caption (the ask) ends exactly when the pass ends.
    expect(captionWindows(DOC).at(-1)?.end).toBe(total);
  });

  it('keeps every caption line at 12 words or fewer, up to three lines a beat, each on screen ≥ 2.5 s', () => {
    for (const b of DOC.beats) {
      const lines = captionLines(b);
      expect(lines.length, b.id).toBeLessThanOrEqual(MAX_LINES_PER_BEAT);
      if (lines.length > 0) expect(b.seconds / lines.length, b.id).toBeGreaterThanOrEqual(MIN_LINE_SECONDS);
      for (const line of lines) expect(wordCount(line), `${b.id}: ${line}`).toBeLessThanOrEqual(MAX_CAPTION_WORDS);
    }
    for (const w of captionWindows(DOC)) expect(w.end - w.start, w.text).toBeGreaterThanOrEqual(MIN_LINE_SECONDS);
  });

  it('counts words as a viewer reads them', () => {
    expect(wordCount('Meter Reader · Customer track · vote in the CriblCon app.')).toBe(9);
    expect(wordCount('$25 a day. $9,127 a year. Caught in 2:51.')).toBe(9);
    expect(wordCount('  ')).toBe(0);
  });

  it('only points at callout ids its view puts on screen, and uses every DESIGN_BRIEF §8 id', () => {
    const used = new Set<string>();
    for (const b of DOC.beats) {
      for (const c of b.callouts) {
        expect(CALLOUT_IDS as readonly string[], `${b.id} → ${c.target}`).toContain(c.target);
        expect(VIEW_CALLOUTS[b.view] as readonly string[], `${b.id} (${b.view}) → ${c.target}`).toContain(c.target);
        expect(c.label.trim().length, `${b.id} → ${c.target}`).toBeGreaterThan(0);
        expect(wordCount(c.label), c.label).toBeLessThanOrEqual(4);
        // It appears in time to be read before the beat ends.
        expect(c.at ?? 0, `${b.id} → ${c.target}`).toBeLessThanOrEqual(b.seconds - 2);
        used.add(c.target);
      }
    }
    expect([...used].sort()).toEqual([...CALLOUT_IDS].sort());
  });

  it('never speaks a number it has not formatted from the fixture', () => {
    const facts = new Set(Object.values(FACTS));
    const numbers = DOC.beats.flatMap((b) => captionLines(b)).flatMap((l) => l.match(/\$[\d,]+|\b\d+:\d{2}\b|\b\d[\d,]*\b/g) ?? []);
    expect(numbers.length).toBeGreaterThanOrEqual(7);
    for (const n of numbers) expect(facts, n).toContain(n);
  });

  it('formats the Meter beat from the base snapshot and the alert beat from the incident, as the screen does', () => {
    const h = TOUR.snapshot.headline;
    // The three figures add up in whole dollars (footMoney): would have paid and saved as shown, paid their difference.
    expect(FACTS).toMatchObject({ whp: fmtDollars(h.whpMtdM), saved: fmtDollars(h.mtdM) });
    const dollars = (s: string): number => Number(s.replace(/[$,]/g, ''));
    expect(dollars(FACTS.whp) - dollars(FACTS.paid)).toBe(dollars(FACTS.saved));
    expect(Math.abs(dollars(FACTS.paid) - dollars(fmtDollars(h.paidMtdM)))).toBeLessThanOrEqual(1);
    const incident = TOUR.script.find((s) => s.action === 'incident.open' && (s.payload as Incident).type === 'regression')!.payload as Incident;
    expect(FACTS.perDay).toBe(fmtDollars(incident.impactPerDayM));
    expect(FACTS.perYear).toBe(fmtDollars(perYear(incident.impactPerDayM)));
    expect(FACTS.caughtIn).toBe(fmtDuration(incident.caughtInSec!));
    expect(FACTS.hash).toBe(incident.commit!.hash.slice(0, 7));
    expect(FACTS.user).toBe(incident.commit!.author);
    expect(`${fmtPct(incident.before)} → ${fmtPct(incident.after)}`).toBe(`${Number(FACTS.points) + Number.parseInt(fmtPct(incident.after), 10)}% → ${fmtPct(incident.after)}`);
    const meter = DOC.beats.find((b) => b.id === 'meter')!;
    expect(captionLines(meter)).toEqual(tLines('story.captions.meter', FACTS));
    expect(captionLines(meter).join(' ')).toContain(FACTS.whp);
  });

  it('shows the strip for 3 s, then the dollar map, whose caption says what its group saves a day (P2-W11)', () => {
    const how = DOC.beats.find((b) => b.id === 'how')!;
    const flow = DOC.beats.find((b) => b.id === 'flow')!;
    expect(how.seconds).toBeLessThanOrEqual(3);
    expect(DOC.beats.indexOf(flow)).toBe(DOC.beats.indexOf(how) + 1);
    expect(flow.view).toBe('flow');
    // The group the Flow view opens on (largest would-have-paid): the tour's datacenter, 30 flows.
    const group = TOUR.snapshot.flows.filter((f) => f.groupId === 'datacenter');
    expect(group.length).toBe(30);
    const saved = group.reduce((s, f) => s + f.savedPerDayM, 0);
    expect(FACTS.flowSaved).toBe(fmtDollars(saved));
    expect(captionLines(flow)).toEqual(tLines('story.captions.flow', FACTS));
    expect(captionLines(flow).join(' ')).toContain(FACTS.flowSaved);
    expect(flow.callouts.map((c) => c.target)).toEqual(['flow-plate', 'flow-saved']);
  });

  it('takes its wording from src/copy/en.ts, and ends on the ask', () => {
    const byId = Object.fromEntries(DOC.beats.map((b) => [b.id, captionLines(b)]));
    expect(byId.hook).toEqual(tLines('story.captions.hook'));
    expect(byId.alert).toEqual(tLines('story.captions.alert', FACTS));
    // The ask signs the story first (the builder's name, held together by a no-break space), then asks. D54: the
    // generated documents (and this test, which runs without the demo flag) carry the release's join line; the vote
    // ask is the demo build's alone (tests/unit/story-ask-build.test.ts).
    expect(byId.ask).toEqual(['Meter Reader by Steve\u00a0Koelpin.', 'Join the Cribl Innovators Network.']);
    expect(byId.title).toEqual([]);
    expect(byId.summary).toEqual([]);
  });

  it('plays the fixture’s own steps: the change ships the commit the alert names; the alert lands delivered; restore closes it', () => {
    const beat = (id: string) => DOC.beats.find((b) => b.id === id)!;
    const change = beat('change').actions;
    expect(change.map((a) => a.action)).toEqual(['commit']);
    const alert = beat('alert').actions;
    expect(alert.map((a) => a.action)).toEqual(['snapshot', 'incident.open', 'delivery']);
    // Same second, delivery after the open: the card's "Caught in" is the measured 2:51 from its first frame.
    expect(new Set(alert.map((a) => a.at)).size).toBe(1);
    const opened = alert[1].payload as Incident;
    expect(opened).toMatchObject({ type: 'regression', cause: 'commit' });
    expect((change[0].payload as { hash: string }).hash).toBe(opened.commit!.hash);
    const restore = beat('restore').actions;
    expect(restore.map((a) => a.action)).toEqual(['commit', 'incident.close', 'delivery']);
    expect((restore[1].payload as Incident).closedAt).toBeTruthy();
    for (const b of DOC.beats) for (const a of b.actions) expect(a.at, b.id).toBeLessThan(b.seconds);
    // No other incident plays: nothing takes over that the captions don't talk about.
    const incidents = DOC.beats.flatMap((b) => b.actions).filter((a) => a.action.startsWith('incident.'));
    expect(new Set(incidents.map((a) => (a.payload as Incident).id))).toEqual(new Set([opened.id]));
  });

  it('throws plainly on a fixture without the story in it', () => {
    expect(() => buildStoryDoc({ ...TOUR, script: [] }, 'tour')).toThrow(/no regression that names a commit/);
  });
});

describe('the generated files are current (npx tsx scripts/story.ts)', () => {
  it('demo/sample/story.json', () => {
    expect(read(STORY_PATHS.story)).toBe(serializeStory(DOC));
  });

  it('demo/sample/captions.srt', () => {
    expect(read(STORY_PATHS.captions)).toBe(captionsSrt(DOC));
  });

  it('VIDEO_SCRIPT.md', () => {
    expect(read(STORY_PATHS.videoScript)).toBe(videoScript(DOC, { facts: FACTS, fixturePath: STORY_PATHS.tour }));
  });

  it('captions.srt carries every caption line at its in-app window', () => {
    const srt = read(STORY_PATHS.captions);
    const cues = srt.trim().split(/\n\n/);
    const windows = captionWindows(COMMITTED);
    expect(cues).toHaveLength(windows.length);
    cues.forEach((cue, i) => {
      const [n, times, ...text] = cue.split('\n');
      expect(Number(n)).toBe(i + 1);
      expect(times).toMatch(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/);
      expect(text.join(' ')).toBe(windows[i].text);
      for (const line of text) expect(line.length, line).toBeLessThanOrEqual(42);
    });
  });

  it('VIDEO_SCRIPT.md numbers every narration line with its window, and has the title and end cards', () => {
    const md = read(STORY_PATHS.videoScript);
    for (const w of captionWindows(COMMITTED)) expect(md).toContain(`| ${w.cue} |`);
    expect(md).toContain(tLines('story.title')[0]);
    expect(md).toContain(`Caught a bad change in ${FACTS.caughtIn}`);
    expect(md).not.toMatch(/closed tab|tab closed|even when closed/i);
  });
});
