// src/components/IncidentTakeover/IncidentTakeover.tsx — the presenter's incident takeover (PRD 8.1).
//
// Mounted by the Presenter view. What to show comes from the tab's takeover feed (tracker.ts), which the
// shell starts at mount: a NEW high-severity incident (see tracker.ts for exactly what counts as new) the
// tab saw in the last 45 s lands the moment the stage opens (P1-A01). The TakeoverCard slides up over the
// lower half of the frame. It stays until any key, the close button, or 45 s; when a watched incident closes, the same card
// returns in green for 10 s. The Meter keeps ticking above it and the QR stays in its corner (the presenter
// layout reserves the corner through --mr-takeover-inset-right).
//
// Alert → recovery (P1-B01): when a watched incident closes while its red card is on stage, the card is not
// replaced — it is the SAME element (keyed by the incident, not the event), so it neither leaves nor slides up
// again: the box stays put and the red card turns into the green one over MORPH_MS. A frozen copy of the red
// card, taken the moment the closing snapshot reaches the store (before React paints the green card), is laid
// over the green card and fades out while the tints blend; the green card's words then fade in, so the two
// cards' words never show on top of each other. Reduced motion: the green card simply replaces the red one.
//
// Keys: any non-modifier key dismisses, and that keypress is CONSUMED (REVIEW-3a #7): the listener runs in
// the capture phase on window — ahead of the shell's one bubble-phase dispatcher — and stops the event, so
// the key that clears the card never also pulls a demo lever (0 = reset everything, R = restore …) or
// leaves presenter mode. The next press does what it says. Keys aimed at a text field or an open dialog
// (the Break-the-trim confirmation) are left alone.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isTypingTarget, prefersReducedMotion } from '../../lib/dom.ts';
import { useAppState, useStoreApi } from '../../state/react.tsx';
import { LandedCard } from '../WhatIf/LandedCard.tsx';
import { landedAllowed } from '../WhatIf/landing.ts';
import { TakeoverCard, TAKEOVER_FADE_MS } from './TakeoverCard.tsx';
import { playChime } from './chime.ts';
import { MORPH_IN_DELAY_MS, MORPH_IN_MS, MORPH_OUT_MS, freezeCard } from './morph.ts';
import { restoringCommit } from './restore.ts';
import { TAKEOVER_MS, enqueue, takeoverFeed, type TakeoverEvent } from './tracker.ts';

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'Hyper', 'Super', 'OS', 'Tab']);

const DIALOG = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

/**
 * A key meant for an open dialog (focus inside it, or any modal up) is not the takeover's to take. Assumes
 * `aria-modal` is only in the DOM while a modal is open (true of Capra's Modal; nothing in src/ keeps a
 * hidden aria-modal element mounted — re-check if a drawer or sheet ever does).
 */
function isDialogKey(target: EventTarget | null): boolean {
  if (typeof document === 'undefined') return false;
  if (target instanceof Element && target.closest(DIALOG)) return true;
  return document.querySelector('[aria-modal="true"]') !== null;
}

export interface IncidentTakeoverProps {
  /** Override how long each mode stays up (tests, Story). */
  durations?: Partial<typeof TAKEOVER_MS>;
  /** Chime when a card lands: two rising notes for an alert, one lower note for its recovery (P2-W19). */
  chime?: boolean;
}

export function IncidentTakeover({ durations, chime = false }: IncidentTakeoverProps) {
  const store = useStoreApi();
  const incidents = useAppState((s) => s.snapshot?.incidents ?? null);
  const timeline = useAppState((s) => s.snapshot?.timeline ?? null);
  const [queue, setQueue] = useState<TakeoverEvent[]>([]);
  const [leaving, setLeaving] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const ghostHostRef = useRef<HTMLDivElement | null>(null);
  /** The red card as it looked when its incident closed (P1-B01), waiting for the green card to paint. */
  const frozenRef = useRef<{ incidentId: string; el: HTMLElement } | null>(null);

  // The tab's takeover feed (tracker.ts, P1-A01): its baseline is the first snapshot the TAB saw, and it
  // hands over at once what the tab saw open in the last 45 s, so a late P still lands the card. Good news
  // (P2-W06) lands only when the member's switch — or the demo profile, in the demo build — allows it.
  useEffect(
    () =>
      takeoverFeed(store).subscribe((all) => {
        const events = landedAllowed(store.getState().settings) ? all : all.filter((e) => e.mode !== 'landed');
        if (events.length === 0) return;
        // A recovery for the red card on stage: copy the card now, while it is still red on screen (P1-B01).
        if (!prefersReducedMotion()) {
          for (const e of events) {
            if (e.mode !== 'recovery') continue;
            const card = hostRef.current?.querySelector<HTMLElement>(`.mr-takeover[data-mode="alert"][data-incident-id="${CSS.escape(e.incident.id)}"]`);
            if (card) frozenRef.current = { incidentId: e.incident.id, el: freezeCard(card) };
          }
        }
        setQueue((q) => enqueue(q, events));
      }),
    [store],
  );

  const current = queue[0];
  const currentKey = current?.key;
  const currentMode = current?.mode;

  const dismiss = useCallback(() => {
    if (!currentKey) return;
    const done = () => {
      setQueue((q) => (q[0]?.key === currentKey ? q.slice(1) : q));
      setLeaving(null);
    };
    if (prefersReducedMotion()) {
      done();
      return;
    }
    setLeaving(currentKey);
    window.setTimeout(done, TAKEOVER_FADE_MS);
  }, [currentKey]);

  // Auto-dismiss: 45 s for an alert, 10 s for a recovery. Restarts only when a different takeover comes
  // up — a delivery landing while the card is showing must not reset the 45 s.
  const latest = useRef({ dismiss, durations });
  useEffect(() => {
    latest.current = { dismiss, durations };
  });
  useEffect(() => {
    if (!currentKey || !currentMode) return;
    const ms = latest.current.durations?.[currentMode] ?? TAKEOVER_MS[currentMode];
    const timer = window.setTimeout(() => latest.current.dismiss(), ms);
    return () => window.clearTimeout(timer);
  }, [currentKey, currentMode]);

  // The green card has painted over the red one's box: lay the frozen red card over it and fade it out.
  useLayoutEffect(() => {
    const frozen = frozenRef.current;
    const host = ghostHostRef.current;
    if (!frozen || !host) return;
    if (currentMode !== 'recovery' || current?.incident.id !== frozen.incidentId) {
      if (currentMode !== 'alert') frozenRef.current = null; // the moment passed (dismissed, or another card)
      return;
    }
    frozenRef.current = null;
    const ghost = frozen.el;
    host.appendChild(ghost);
    if (typeof ghost.animate !== 'function') {
      ghost.remove();
      return;
    }
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MORPH_OUT_MS, easing: 'ease-in', fill: 'forwards' });
    const done = () => ghost.remove();
    fade.onfinish = done;
    fade.oncancel = done;
    // The green card's words wait for the red ones to leave, then fade in (the card itself never fades).
    const card = hostRef.current?.querySelector<HTMLElement>(`.mr-takeover[data-incident-id="${CSS.escape(frozen.incidentId)}"]`);
    const words = card ? [...card.children].map((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MORPH_IN_MS, delay: MORPH_IN_DELAY_MS, easing: 'ease-out', fill: 'backwards' })) : [];
    return () => {
      fade.cancel();
      for (const a of words) a.cancel();
    };
  }, [currentKey, currentMode, current?.incident.id]);

  // The chime (P2-W19): once per card that lands — not when a delivery updates it, not when the chime is toggled.
  const chimeRef = useRef(chime);
  useEffect(() => {
    chimeRef.current = chime;
  });
  useEffect(() => {
    if (!currentKey || !currentMode || !chimeRef.current) return;
    playChime(currentMode === 'alert' ? 'alert' : 'recovery');
  }, [currentKey, currentMode]);

  // Any key dismisses, and is consumed (capture phase, ahead of the shell's shortcut dispatcher).
  useEffect(() => {
    if (!currentKey) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || MODIFIER_KEYS.has(event.key) || event.ctrlKey || event.metaKey) return;
      if (isTypingTarget(event.target) || isDialogKey(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      latest.current.dismiss();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [currentKey]);

  // The freshest copy of the incident, so a delivery landing flips the clock while the card is up.
  const fresh = !current
    ? undefined
    : current.mode === 'alert'
      ? (incidents?.find((i) => i.id === current.incident.id && !i.closedAt) ?? current.incident)
      : current.incident;
  return (
    <div ref={hostRef} className="mr-takeover-host" data-leaving={current && leaving === current.key ? 'true' : undefined}>
      {/* Keyed by the incident, not the event: its recovery is the same card turning green (P1-B01). Good news
          (P2-W06) is its own card. */}
      {current && current.mode === 'landed' ? (
        <LandedCard key={current.key} incident={current.incident} onDismiss={dismiss} placement="overlay" />
      ) : current && fresh ? (
        <TakeoverCard
          key={current.incident.id}
          incident={fresh}
          was={current.was}
          mode={current.mode}
          restoredBy={current.mode === 'recovery' ? restoringCommit(fresh, timeline) : undefined}
          onDismiss={dismiss}
          placement="overlay"
        />
      ) : null}
      {/* The crossfade's frozen red card goes here (outside React's children, never rendered by React). */}
      <div ref={ghostHostRef} className="mr-tk-ghost-host" aria-hidden="true" />
    </div>
  );
}
