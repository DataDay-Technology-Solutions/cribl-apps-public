// src/views/Story/index.tsx — Story mode (PRD 8.9, SPEC 13 / 15 / 17): the demo that runs without anyone
// talking. `?story=1` on any route, key Y (the shell's keyboard map), the first-run link or the Demo
// Console's Story button; any key exits (the shell), as does the ×, and on a touch screen a tap anywhere on
// the frame or a swipe down (P1-C06: a judge who opened it from the phone's first-run card has more than
// one small way out).
//
// The source is named by the presenter's quiet chip beside the wordmark ("Sample data", or "Replay ·
// recorded Sep 26" for ?story=live), never by the tour's striped band: the loop is a stage, and a band
// with a "Clear sample data" button on every frame read as an app in a test state (P1-C02).
//
//   ┌──────────────────────────────────────────────────────────────────────────────┐
//   │ Meter Reader (Sample data)   ▬▬▬▬▬▬ beat progress, centred ▬▬▬▬▬▬   Press Esc … ×│
//   │   (phone: brand · Tap to exit ×, then the progress on its own full-width row)  │
//   │                                                                              │
//   │                 the beat's stage (stages.tsx) + callout labels               │
//   │                                                                              │
//   │               caption rail — one line at a time, bottom-center               │
//   └──────────────────────────────────────────────────────────────────────────────┘
//
// One engine, one table: the tour engine plays the story's actions (demo/sample/story.json, generated
// from src/story/beats.ts) through the store's sample path and loops; the frame is a pure function of
// `positionAt(doc, seconds)` and the store, so the loop, a seek, the video capture and the captions file
// (the same table) agree to the second. Reduced motion: no slides, fades or draw-ins — states switch.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import { CloseOutlined } from '@capra/icons';
import type { StoryDoc } from '../../../core/types.ts';
import { formatLocalMonthDay, isValidTimeZone } from '../../../core/time.ts';
import { t } from '../../copy/en.ts';
import { useAppParams } from '../../lib/params.ts';
import { prefersReducedMotion } from '../../lib/dom.ts';
import { useAppState } from '../../state/react.tsx';
import { beatStarts, positionAt, storySeconds, type StoryPosition } from '../../story/timeline.ts';
import { CalloutLayer } from './Callouts.tsx';
import { Stage } from './stages.tsx';
import { useStoryTestHook } from './testHook.ts';
import type { StorySourceData } from './source.ts';
import { useStoryClock, useStoryEngine, useStorySource } from './useStory.ts';
import './Story.css';

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

/** Under reduced motion the beat's bar still tells how far in it is, in quarters that switch rather than glide. */
const REDUCED_STEPS = 4;

function Progress({ doc, pos, reducedMotion }: { doc: StoryDoc; pos: StoryPosition; reducedMotion: boolean }) {
  return (
    <div className="mr-st-progress" aria-hidden="true">
      {doc.beats.map((b, i) => {
        const now = reducedMotion ? Math.min(1, (Math.floor(pos.progress * REDUCED_STEPS) + 1) / REDUCED_STEPS) : pos.progress;
        const fill = i < pos.index ? 1 : i > pos.index ? 0 : now;
        return (
          <span key={b.id} className="mr-st-seg" style={{ flexGrow: b.seconds } as CSSProperties} data-state={i < pos.index ? 'done' : i === pos.index ? 'now' : 'next'}>
            <span className="mr-st-seg-fill" style={{ transform: `scaleX(${fill})` }} />
          </span>
        );
      })}
    </div>
  );
}

/** What the frame is playing, as the presenter says it: a quiet chip, never a band with a button. */
function SourceChip({ data }: { data: StorySourceData }) {
  if (data.source === 'replay') {
    const at = Date.parse(data.fixture.anchor);
    const tz = isValidTimeZone(data.fixture.timezone) ? data.fixture.timezone : 'UTC';
    const date = Number.isFinite(at) ? formatLocalMonthDay(at, tz) : '';
    return (
      <span className="mr-st-chip" data-source="replay">
        {date ? t('story.replayChip', { date }) : t('presenter.replayChip')}
        <span className="mr-visually-hidden">{` ${t('sampleBand.replayText')}`}</span>
      </span>
    );
  }
  return (
    <span className="mr-st-chip" data-source="sample">
      {t('presenter.sampleChip')}
      <span className="mr-visually-hidden">{` ${t('sampleBand.text')}`}</span>
    </span>
  );
}

/** A touch that moved less than this is a tap; one that went this far down (and mostly down) is a swipe. */
const TAP_SLOP_PX = 12;
const SWIPE_DOWN_PX = 64;
/** Taps on these keep their own meaning (the × exits by itself; nothing else on the frame is interactive). */
const INTERACTIVE = 'a, button, input, select, textarea, [role="button"], [role="link"]';

/**
 * Touch exits (P1-C06): a tap anywhere on the frame, or a swipe down. The tap exits on its `click` (which the
 * browser sends right after the touch ends), so the click is spent here and never lands on the live screen
 * that replaces the frame; a swipe sends no click and exits when the finger lifts. A mouse click does nothing:
 * at a desk the keyboard and the × are the way out, and a stray click must not end a booth loop.
 */
function useTouchExit(exit: () => void) {
  const start = useRef<{ id: number; type: string; x: number; y: number } | null>(null);
  const onPointerDown = useCallback((e: PointerEvent<HTMLElement>) => {
    start.current = { id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY };
  }, []);
  const onPointerUp = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      const s = start.current;
      if (!s || s.id !== e.pointerId || s.type === 'mouse') return;
      const dx = e.clientX - s.x;
      const dy = e.clientY - s.y;
      if (dy > SWIPE_DOWN_PX && Math.abs(dx) < dy) {
        start.current = null;
        exit();
      }
    },
    [exit],
  );
  const onClick = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      const s = start.current;
      start.current = null;
      if (!s || s.type === 'mouse') return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_SLOP_PX) return;
      if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
      e.preventDefault();
      exit();
    },
    [exit],
  );
  const onPointerCancel = useCallback(() => {
    start.current = null;
  }, []);
  return { onPointerDown, onPointerUp, onPointerCancel, onClick };
}

/** How long an outgoing scene takes to fade (Story.css `mr-st-scene-out`); it is dropped after this. */
const SCENE_OUT_MS = 260;

/** The scene (one mount per run of beats sharing a view, per pass) that a position shows. */
const sceneKeyOf = (pos: StoryPosition): string => `${pos.runStart}:${pos.iteration}`;

/** The last moment of a scene (the end of its run of beats, in its pass): how a leaving scene is drawn. */
function sceneEnd(doc: StoryDoc, key: string): StoryPosition | null {
  const [runStart, iteration] = key.split(':').map(Number);
  if (!Number.isInteger(runStart) || !Number.isInteger(iteration) || !doc.beats[runStart]) return null;
  let last = runStart;
  while (last + 1 < doc.beats.length && doc.beats[last + 1].view === doc.beats[runStart].view) last++;
  const starts = beatStarts(doc);
  const pos = positionAt(doc, iteration * storySeconds(doc) + starts[last] + doc.beats[last].seconds - 0.05);
  return sceneKeyOf(pos) === key ? pos : null;
}

/**
 * The scene that is leaving: kept on the stage for SCENE_OUT_MS so the next one crossfades in over it rather
 * than cutting to an empty frame (P1-C05). It keeps its key, so React keeps its DOM (a drawn chart, a placed
 * card) and draws it at its own last moment; it is inert, hidden from assistive tech and ignored by the callout
 * layer. Reduced motion: no leaving scene — states switch.
 */
function useLeavingScene(key: string, reducedMotion: boolean): string | null {
  // "Storing information from previous renders": the scene on screen, and the one it replaced.
  const [shown, setShown] = useState(key);
  const [leaving, setLeaving] = useState<string | null>(null);
  if (shown !== key) {
    setShown(key);
    setLeaving(reducedMotion || shown === '' || key === '' ? null : shown);
  }
  useEffect(() => {
    if (leaving === null) return;
    const timer = window.setTimeout(() => setLeaving(null), SCENE_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  return leaving !== null && leaving !== key ? leaving : null;
}

export default function StoryView() {
  const [params, setParams] = useAppParams();
  const exit = useCallback(() => setParams({ story: false }), [setParams]);
  const touchExit = useTouchExit(exit);
  const data = useStorySource(params.storyLive);
  const engine = useStoryEngine(data, exit);
  const { seconds, paused } = useStoryClock(engine);
  const reducedMotion = useReducedMotion();
  const source = useAppState((s) => s.source);
  useStoryTestHook(engine, data?.doc ?? null);

  const stageRef = useRef<HTMLElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLElement | null>(null);

  const doc = data?.doc ?? null;
  const pos = doc ? positionAt(doc, seconds) : null;
  const sceneKey = pos ? sceneKeyOf(pos) : '';
  const leavingKey = useLeavingScene(sceneKey, reducedMotion);

  if (!data || !doc || !pos) return <div className="mr-story" data-ready="false" />;
  const beat = pos.beat;
  const ready = engine !== null && source !== 'live';
  const leavingPos = leavingKey ? sceneEnd(doc, leavingKey) : null;

  return (
    <div
      className="mr-story"
      data-ready={ready ? 'true' : 'false'}
      data-beat={beat.id}
      data-view={beat.view}
      data-line={pos.lineIndex}
      data-iteration={pos.iteration}
      data-paused={paused ? 'true' : 'false'}
      data-reduced={reducedMotion ? 'true' : 'false'}
      aria-keyshortcuts="Escape"
      {...touchExit}
    >
      <header className="mr-st-top" ref={topRef}>
        <div className="mr-st-brand">
          <span className="mr-st-wordmark">{t('app.name')}</span>
          <SourceChip data={data} />
        </div>
        <Progress doc={doc} pos={pos} reducedMotion={reducedMotion} />
        <div className="mr-st-exit">
          {/* One of the two shows (Story.css): the keys at a desk, the tap on a touch screen. */}
          <span className="mr-st-hint" data-input="keys">
            {t('story.exitHint')}
          </span>
          <span className="mr-st-hint" data-input="touch">
            {t('story.exitHintTouch')}
          </span>
          {/*
            Ours, not Capra's IconButton: its largest size is 40 px, under the 44 px touch target. tabIndex 0 keeps it
            in Safari's Tab order, which skips a plain button by default (Capra's react-aria button set it for us).
          */}
          <button type="button" className="mr-st-close" tabIndex={0} aria-label={t('common.close')} aria-keyshortcuts="Escape" onClick={exit}>
            <CloseOutlined size="md" aria-hidden />
          </button>
        </div>
      </header>

      <main className="mr-st-stage" id="main" ref={stageRef} data-view={beat.view}>
        {/*
          One mount per scene (consecutive beats with one view share it) and per pass, so entrances replay each loop.
          The scene it replaced fades out over it: one keyed list, so React keeps the leaving scene's DOM, and the
          live scene comes first, so every query finds it before the leaving one.
        */}
        {[
          <div className="mr-st-scene" key={sceneKey} data-scene={doc.beats[pos.runStart].id}>
            <Stage doc={doc} pos={pos} engine={engine} reducedMotion={reducedMotion} />
          </div>,
          leavingKey && leavingPos ? (
            <div className="mr-st-scene" key={leavingKey} data-scene={doc.beats[leavingPos.runStart].id} data-leaving="true" aria-hidden="true" inert>
              <Stage doc={doc} pos={leavingPos} engine={engine} reducedMotion={reducedMotion} />
            </div>
          ) : null,
        ]}
      </main>

      <div className="mr-st-rail" ref={railRef} aria-live="polite">
        {pos.line ? (
          <p className="mr-st-caption" key={`${pos.iteration}:${pos.index}:${pos.lineIndex}`}>
            {pos.line}
          </p>
        ) : null}
      </div>

      <CalloutLayer
        visible={pos.callouts}
        all={beat.callouts}
        group={pos.lineCallouts}
        beatKey={`${pos.iteration}:${pos.index}`}
        stageRef={stageRef}
        avoidRefs={[railRef, topRef]}
        reducedMotion={reducedMotion}
      />
    </div>
  );
}
