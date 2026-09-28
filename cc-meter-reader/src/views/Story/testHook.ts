// src/views/Story/testHook.ts — lets the Playwright story spec (and the video capture) drive Story mode
// deterministically: jump to a second, pause, resume, read the engine's status. Mock/dev builds ONLY: the
// flag is tested inline (the src/views/Presenter/testHook.ts pattern), so a release build folds the
// condition to `false` and drops the body.

import { useEffect } from 'react';
import type { StoryDoc } from '../../../core/types.ts';
import type { TourEngine } from '../../tour/engine.ts';
import type { TourStatus } from '../../tour/types.ts';

export interface StoryTestApi {
  /** jump to a second of the current pass (0 … length) */
  seek(sec: number): void;
  pause(): void;
  resume(): void;
  status(): TourStatus;
  doc: StoryDoc;
}

interface TestWindow {
  __MR_STORY__?: StoryTestApi & { engine: TourEngine };
}

export function useStoryTestHook(engine: TourEngine | null, doc: StoryDoc | null): void {
  useEffect(() => {
    if (!(import.meta.env.DEV || import.meta.env.VITE_MR_MOCK === '1')) return;
    if (!engine || !doc) return;
    const w = window as unknown as TestWindow;
    w.__MR_STORY__ = {
      engine,
      doc,
      seek: (sec) => engine.seek(sec),
      pause: () => engine.pause(),
      resume: () => engine.resume(),
      status: () => engine.status(),
    };
    return () => {
      if (w.__MR_STORY__?.engine === engine) delete w.__MR_STORY__;
    };
  }, [engine, doc]);
}
