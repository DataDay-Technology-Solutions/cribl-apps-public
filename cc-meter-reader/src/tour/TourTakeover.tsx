// src/tour/TourTakeover.tsx — the tour's savings drop as the takeover card (FOUNDER_PLAN row 11, founder-build r1 ui-11).
//
// Tour beat 2 (+25 s): the narration's regression beat (narration.ts → status.ts showTourTakeover) puts the presenter's
// takeover card on the Receipt, at the top of the view right under the SAMPLE DATA band, beside the beat's toast. The
// stage's card is a fixed overlay over the lower half of the frame that any key dismisses; here it sits in the page
// (placement 'inline'), so it never covers the bottom-right toasts the tour's later beats offer ("View message" at
// 31 s, "View receipt" at 130 s), and a phone scrolls it with the rest of the Receipt.
//
//   lands   a fade and a short drop (450 ms); reduced motion: the 200 ms fade only. It never takes focus: the card is
//           role="alert", so assistive tech announces it as it lands.
//   goes    its close button (focus then goes to the view), Escape (unless a dialog, drawer or menu is open, or a field
//           is being typed in: src/lib/shortcuts.ts), 45 s after it landed, the regression's toast closed by hand
//           (narration.ts), or the tour stopping. Once gone it does not come back for that landing.
//   words   the stage card's own; the hint beside the close button says Esc (the stage's says any key), and the foot
//           labels it sample ("Sample data. Nothing is written to your workspace."). No capture callouts: the Receipt
//           keeps its own, one of each per page.
//
// A lazy chunk of its own: the Receipt loads it only when a tour card lands, so a metering workspace never pays for it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../copy/en.ts';
import { TAKEOVER_ENTER_MS, TAKEOVER_FADE_MS, TakeoverCard } from '../components/IncidentTakeover/TakeoverCard.tsx';
import { prefersReducedMotion } from '../lib/dom.ts';
import { useShortcut } from '../lib/shortcuts.ts';
import { useAppState } from '../state/react.tsx';
import { dismissTourTakeover, TOUR_TAKEOVER_MS, type TourTakeover as Landing } from './status.ts';
import './tour.css';

const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Anything that owns Escape before the card does: a dialog or a drawer (modal or not). */
const ESCAPE_OWNER = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';

export interface TourTakeoverProps {
  landing: Landing;
}

export default function TourTakeover({ landing }: TourTakeoverProps) {
  const { incidentId, landedAt } = landing;
  // The live copy, so the delivery landing at 31 s stops the card's clock and names where it went. A closed incident
  // (the recovery at 110 s, or a seek) has no card.
  const incident = useAppState((s) => s.snapshot?.incidents.find((i) => i.id === incidentId && !i.closedAt));
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const shown = incident !== undefined;

  const dismiss = useCallback(() => {
    // The close button had focus: it is about to go, so focus goes to the view (never to <body>).
    if (ref.current?.contains(document.activeElement)) document.getElementById('main')?.focus({ preventScroll: true });
    if (prefersReducedMotion()) {
      dismissTourTakeover(incidentId);
      return;
    }
    setLeaving(true);
    window.setTimeout(() => dismissTourTakeover(incidentId), TAKEOVER_FADE_MS);
  }, [incidentId]);

  // 45 s after it landed, wherever the member has been meanwhile.
  const latest = useRef(dismiss);
  useEffect(() => {
    latest.current = dismiss;
  });
  useEffect(() => {
    const left = TOUR_TAKEOVER_MS - (Date.now() - landedAt);
    if (left <= 0) {
      dismissTourTakeover(incidentId);
      return;
    }
    const timer = window.setTimeout(() => latest.current(), left);
    return () => window.clearTimeout(timer);
  }, [incidentId, landedAt]);

  // Escape, through the app's one key dispatcher (typing, menus and modals keep their keys there); declined while a
  // dialog or drawer is open, so its own Escape closes it first.
  useShortcut(
    'Escape',
    () => {
      if (document.querySelector(ESCAPE_OWNER)) return false;
      latest.current();
    },
    shown && !leaving,
  );

  // Lands: a fade with a short drop into place; reduced motion, the fade alone.
  useEffect(() => {
    const el = ref.current;
    if (!shown || !el || typeof el.animate !== 'function') return;
    const anim = prefersReducedMotion()
      ? el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TAKEOVER_FADE_MS, easing: 'ease-out' })
      : el.animate(
          [
            { opacity: 0, transform: 'translateY(-12px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: TAKEOVER_ENTER_MS, easing: EASE_OUT },
        );
    return () => anim.cancel();
  }, [shown, incidentId, landedAt]);

  if (!incident) return null;
  return (
    <div ref={ref} className="mr-tour-takeover" data-testid="tour-takeover" data-leaving={leaving ? 'true' : undefined} role="region" aria-label={t('tour.takeover.label')}>
      <TakeoverCard
        incident={incident}
        mode="alert"
        placement="inline"
        animate={false}
        onDismiss={dismiss}
        dismissHint={t('tour.takeover.dismissHint')}
        callouts={false}
        note={t('tour.takeover.note')}
      />
    </div>
  );
}
