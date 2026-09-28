// @vitest-environment jsdom
// Story mode's clock (src/story/timeline.ts, beatAt in src/story/doc.ts) and its script for the tour engine
// (src/story/fixture.ts): which beat, caption line and callouts are on screen at any second; the loop; and
// the tour engine playing the story's actions through the store's sample path, pass after pass.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, mergeSettings } from '../../core/settings.ts';
import type { Incident, Settings, StoryDoc } from '../../core/types.ts';
import type { AppDocs } from '../../src/state/ports.ts';
import { createAppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';
import { STORY_DOC, beatAt } from '../../src/story/doc.ts';
import { shippedCommits, storyFixture } from '../../src/story/fixture.ts';
import { flowOf, storyCommit, storyIncident } from '../../src/story/select.ts';
import { beatStart, beatStarts, captionLines, captionWindows, flattenActions, positionAt, storySeconds } from '../../src/story/timeline.ts';
import { createTourEngine } from '../../src/tour/engine.ts';
import type { TourFixture } from '../../src/tour/types.ts';

const TOUR = JSON.parse(readFileSync(resolve(__dirname, '../../demo/sample/tour.json'), 'utf8')) as TourFixture;
const DOC: StoryDoc = STORY_DOC;
const TOTAL = storySeconds(DOC);

describe('beatAt / positionAt', () => {
  it('starts on the title and walks the beats in order', () => {
    const starts = beatStarts(DOC);
    DOC.beats.forEach((b, i) => {
      expect(beatAt(starts[i]).beat.id).toBe(b.id);
      expect(beatAt(starts[i] + b.seconds - 0.01).beat.id).toBe(b.id);
    });
    expect(beatAt(0)).toMatchObject({ index: 0, iteration: 0, tInBeat: 0, lineIndex: -1, line: null });
  });

  it('loops: one pass later it is the title again, one iteration on', () => {
    const p = beatAt(TOTAL + 0.5);
    expect(p).toMatchObject({ index: 0, iteration: 1 });
    expect(p.t).toBeCloseTo(0.5, 6);
    expect(beatAt(TOTAL * 3 + beatStart(DOC, 'alert') + 1)).toMatchObject({ iteration: 3, beat: { id: 'alert' } });
    // A hair under a whole pass stays in this pass (float safety).
    expect(beatAt(TOTAL - 1e-9).beat.id).toBe('ask');
  });

  it('treats negative and non-finite seconds as the start', () => {
    expect(beatAt(-5).index).toBe(0);
    expect(beatAt(Number.NaN).index).toBe(0);
    expect(beatAt(Number.POSITIVE_INFINITY).index).toBe(0);
  });

  it('plays a beat’s caption lines in sequence over equal windows', () => {
    const alert = beatStart(DOC, 'alert');
    const lines = captionLines(DOC.beats.find((b) => b.id === 'alert')!);
    expect(lines).toHaveLength(3);
    expect(beatAt(alert + 0.1)).toMatchObject({ lineIndex: 0, line: lines[0] });
    expect(beatAt(alert + 4.1)).toMatchObject({ lineIndex: 1, line: lines[1] });
    expect(beatAt(alert + 11.9)).toMatchObject({ lineIndex: 2, line: lines[2] });
    // …and the SRT uses the same windows.
    const w = captionWindows(DOC).filter((c) => c.beatId === 'alert');
    expect(w.map((c) => c.start - alert)).toEqual([0, 4, 8]);
  });

  it('shows a callout from its `at`, while the caption line it arrived with is up', () => {
    const meter = beatStart(DOC, 'meter');
    expect(beatAt(meter + 0.2).callouts).toEqual([]);
    expect(beatAt(meter + 0.5).callouts.map((c) => c.target)).toEqual(['whp']);
    expect(beatAt(meter + 2).callouts.map((c) => c.target)).toEqual(['whp', 'paid']);
    // Line 2 ("Saved by Cribl: …"): the bar's labels give way to the Meter's.
    expect(beatAt(meter + 7.9).callouts.map((c) => c.target)).toEqual(['saved']);
    const alert = beatStart(DOC, 'alert');
    expect(beatAt(alert + 5).callouts.map((c) => c.target)).toEqual(['commit', 'author']);
    expect(beatAt(alert + 9).callouts.map((c) => c.target)).toEqual(['per-day']);
    // A one-line beat keeps its callout to the end.
    expect(beatAt(beatStart(DOC, 'slack') + 5.9).callouts.map((c) => c.target)).toEqual(['slack-message']);
  });

  it('keeps one scene across consecutive beats with the same view (a change ships → watching)', () => {
    const change = DOC.beats.findIndex((b) => b.id === 'change');
    expect(beatAt(beatStart(DOC, 'watching') + 3).runStart).toBe(change);
    expect(beatAt(beatStart(DOC, 'alert') + 1).runStart).toBe(DOC.beats.findIndex((b) => b.id === 'alert'));
  });

  it('beatAt equals positionAt over the bundled document', () => {
    for (const t of [0, 7.3, 44, 90.9, 200]) expect(beatAt(t)).toEqual(positionAt(DOC, t));
  });
});

describe('the story as a tour script', () => {
  it('lays every beat’s actions on one clock inside its beat', () => {
    const flat = flattenActions(DOC);
    const starts = beatStarts(DOC);
    let i = 0;
    DOC.beats.forEach((b, bi) => {
      for (const a of b.actions) {
        expect(flat[i].at).toBeCloseTo(starts[bi] + a.at, 9);
        expect(flat[i].action).toBe(a.action);
        i++;
      }
    });
    expect(flat).toHaveLength(i);
  });

  it('keeps the shipped commit off the base timeline so it can land on screen, and changes nothing else', () => {
    const fx = storyFixture(TOUR, DOC);
    const shipped = storyCommit(DOC)!;
    // The change and, on Restore, its revert.
    expect([...shippedCommits(DOC)]).toEqual([shipped.hash, ...DOC.beats.find((b) => b.id === 'restore')!.actions.filter((a) => a.action === 'commit').map((a) => (a.payload as { hash: string }).hash)]);
    expect(TOUR.snapshot.timeline.some((c) => c.hash === shipped.hash)).toBe(true);
    expect(fx.snapshot.timeline.some((c) => c.hash === shipped.hash)).toBe(false);
    expect(fx.snapshot.timeline).toHaveLength(TOUR.snapshot.timeline.length - 1);
    expect(fx.snapshot.headline).toEqual(TOUR.snapshot.headline);
    expect(fx.durationSec).toBe(TOTAL);
    expect(fx.anchor).toBe(TOUR.anchor);
  });

  it('finds the story’s incident, commit and flow', () => {
    const incident = storyIncident(DOC)!;
    expect(incident).toMatchObject({ type: 'regression', label: 'Payments API sampling' });
    expect(storyCommit(DOC)?.hash).toBe(incident.commit?.hash);
    const flow = flowOf(TOUR.snapshot.flows, incident.objectKey);
    expect(flow?.routeId).toBe('r_payments');
    expect(flow?.sparkline.length).toBeGreaterThan(10);
    expect(flowOf(TOUR.snapshot.flows, 'route:default:nope')).toBeUndefined();
  });
});

describe('the tour engine plays the story (loop)', () => {
  const WALL = Date.parse('2027-03-09T20:15:07.000Z');
  const DEFAULTS: Settings = defaultSettings('2027-03-01T00:00:00.000Z', 'UTC');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(WALL);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function rig() {
    const store = createAppStore(DEFAULTS);
    const docs: AppDocs = {
      readSettings: async () => null,
      readPrices: async () => null,
      readSnapshot: async () => null,
      readMeta: async () => null,
      readDemoState: async () => null,
      readInventory: async () => null,
      writeSettings: async () => {},
      writePrices: async () => {},
    };
    const sweep = { runLocal: vi.fn(async () => ({ ok: true, mode: 'ui' as const, calls: 1, durationMs: 1 })), invokeBackend: vi.fn() };
    const services = createAppServices({ store, docs, engine: sweep as never, mergeSettings: (s) => mergeSettings(s, DEFAULTS) });
    await services.start();
    const engine = createTourEngine({ store, actions: services.actions, doc: storyFixture(TOUR, DOC), source: 'sample', loop: true });
    return { store, engine, sweep };
  }

  it('lands the commit, opens the alert already delivered, closes it on Restore, and does it again next pass', async () => {
    const { store, engine, sweep } = await rig();
    const incident = storyIncident(DOC)!;
    const commit = storyCommit(DOC)!;
    const find = (): Incident | undefined => store.getState().snapshot?.incidents.find((i) => i.id === incident.id);
    const hasCommit = () => store.getState().snapshot?.timeline.some((c) => c.hash === commit.hash) ?? false;
    engine.start();
    expect(store.getState().source).toBe('sample');

    for (let pass = 0; pass < 2; pass++) {
      expect(hasCommit()).toBe(false);
      expect(find()).toBeUndefined();
      await vi.advanceTimersByTimeAsync((beatStart(DOC, 'change') + 1) * 1000);
      expect(hasCommit()).toBe(true);
      await vi.advanceTimersByTimeAsync((beatStart(DOC, 'alert') - beatStart(DOC, 'change')) * 1000);
      const opened = find()!;
      expect(opened.closedAt).toBeUndefined();
      expect(opened.deliveries.map((d) => d.status)).toEqual([200]);
      await vi.advanceTimersByTimeAsync((beatStart(DOC, 'restore') + 3 - beatStart(DOC, 'alert') - 1) * 1000);
      expect(find()?.closedAt).toBeTruthy();
      expect(engine.status().iteration).toBe(pass);
      // To the end of the pass: the engine loops back to the base state.
      await vi.advanceTimersByTimeAsync((TOTAL - beatStart(DOC, 'restore') - 3) * 1000 + 50);
      expect(engine.status().iteration).toBe(pass + 1);
    }
    // Sample data: nothing metered, nothing written.
    expect(sweep.runLocal).not.toHaveBeenCalled();
    engine.stop();
    expect(store.getState().source).toBe('live');
  });
});
