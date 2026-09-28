// src/views/Story/useStory.ts — Story mode's engine and clock.
//
//   useStorySource()   the story to play (tour now; the recorded run in the demo build once it exists)
//   useStoryEngine()   the tour engine (src/tour/engine.ts), unchanged, in loop mode over that story's
//                      fixture: it shows the fixture through the store's sample path (no Cribl call, no
//                      KV write), plays the beats' actions on their seconds and loops. Unmount stops it,
//                      which hands the screen back to the member's live data.
//   useStoryClock()    seconds since the story started (pass × length + elapsed), read from the engine
//                      ~10× a second and on every step it applies; `positionAt` turns it into the beat,
//                      caption line and callouts (src/story/timeline.ts).

import { useEffect, useMemo, useRef, useState } from 'react';
import { suspendSampleTourForStory } from '../../tour/controller.ts';
import { createTourEngine, type TourEngine } from '../../tour/engine.ts';
import { useServices } from '../../state/react.tsx';
import { loadStorySource, tourStory, HAS_LIVE_STORY, type StorySourceData } from './source.ts';

/**
 * D44: the enterprise sample story is the default in BOTH builds (it is the stage/booth loop and the
 * video); the demo build's recorded real run plays only when asked for with `?story=live`.
 */
export function useStorySource(live = false): StorySourceData | null {
  const wantLive = live && HAS_LIVE_STORY;
  // Synchronous for the sample, so the first frame is already the story; derived, never set from an effect.
  const sample = useMemo(() => (wantLive ? null : tourStory()), [wantLive]);
  // The recorded run loads on demand (an external source: the one thing the effect is for).
  const [recorded, setRecorded] = useState<StorySourceData | null>(null);
  useEffect(() => {
    if (!wantLive) return;
    let alive = true;
    void loadStorySource().then((d) => {
      if (alive) setRecorded(d);
    });
    return () => {
      alive = false;
    };
  }, [wantLive]);
  return wantLive ? recorded : sample;
}

export function useStoryEngine(data: StorySourceData | null, onCleared: () => void): TourEngine | null {
  const services = useServices();
  const [engine, setEngine] = useState<TourEngine | null>(null);
  const cleared = useRef(onCleared);
  useEffect(() => {
    cleared.current = onCleared;
  });

  useEffect(() => {
    if (!data) return;
    // One engine owns the sample screen at a time: a running "Tour with sample data" ends here, remembering its
    // beat; when Story closes, TourParamSync starts it again at that beat on the same page (OQ-02).
    suspendSampleTourForStory();
    const engine = createTourEngine({
      store: services.store,
      actions: services.actions,
      doc: data.fixture,
      source: data.source,
      loop: true,
      // The captions quote the recording's month to date (story.json): the screen shows the same money.
      rebaseMoney: false,
      onStop: (reason) => {
        // "Clear sample data" (the band's button) ends the story too.
        if (reason === 'cleared') cleared.current();
      },
    });
    engine.start();
    setEngine(engine);
    return () => {
      engine.stop('user');
      setEngine((e) => (e === engine ? null : e));
    };
  }, [data, services]);

  return engine;
}

const TICK_MS = 100;

/** Seconds since the story started, across passes. */
export function useStoryClock(engine: TourEngine | null): { seconds: number; paused: boolean } {
  const [state, setState] = useState({ seconds: 0, paused: false });
  useEffect(() => {
    if (!engine) return;
    const read = () => {
      const s = engine.status();
      const total = s.durationSec > 0 ? s.durationSec : 1;
      const seconds = s.iteration * total + Math.min(s.elapsedSec, total - 1e-6);
      const paused = s.phase === 'paused';
      setState((prev) => (Math.abs(prev.seconds - seconds) < 0.01 && prev.paused === paused ? prev : { seconds, paused }));
    };
    read();
    const timer = window.setInterval(read, TICK_MS);
    const unsubscribe = engine.subscribe(read);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [engine]);
  return state;
}

