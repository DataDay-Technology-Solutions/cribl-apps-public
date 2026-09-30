// src/tour/narration.ts — what the tour says while it plays: one toast per beat, each tied to what just
// changed on screen, so a judge who is looking at the Receipt still notices the alert that fired.
//
// Budget (DESIGN_BRIEF 4): five toasts in 130 s, the Capra notification idiom, nothing that loops or
// pulses. Seeks and fast-forwards are silent. The copy lives in src/copy/en.ts (`tour.toast.*`, plus
// the shared incident titles).

import { createElement } from 'react';
import { Toast } from '@capra/core';
import type { DeliveryLog, Incident } from '../../core/types.ts';
import { canonicalPayload } from '../../core/payloads.ts';
import { renderAlert } from '../../core/delivery.ts';
import { perYear } from '../../core/format.ts';
import { incidentReadings, titleFor } from '../../core/incidents.ts';
import { t } from '../copy/en.ts';
import { commitAuthor } from '../lib/author.ts';
import { notify } from '../components/common/notify.tsx';
import { formatClock, formatMoney, formatPct, formatTimeOfDay } from '../lib/format.ts';
import type { AppStore } from '../state/store.ts';
import type { TourEngine } from './engine.ts';
import type { TourCaption, TourEvent } from './types.ts';
import { openTourDialog } from './dialogs.ts';
import { dismissTourTakeover, showTourTakeover } from './status.ts';
import { TourToastBody } from './TourToast.tsx';

export interface NarrationContext {
  store: AppStore;
  engine: TourEngine;
  /** In-app navigation (react-router's navigate), for "View in Ledger". */
  navigate?: (to: string) => void;
}

const DURATION_MS = 9_000;

/** Founder-build r2 ui-6 (IC-3): every tour toast is tagged, so any tour exit closes them (controller.ts onStop). */
export const TOUR_TOAST_TAG = 'tour';
const tourToast = notify.tagged(TOUR_TOAST_TAG);

/**
 * A toast that closes this much before its DURATION_MS was closed by hand (its close button, or its action), not by its
 * timer: Capra calls onClose for both, and a toast timing out by itself must leave the takeover card up.
 */
const CLOSED_BY_HAND_MARGIN_MS = 1_000;

const toastBody = (title: string, body?: string) => createElement(TourToastBody, { title, body });

function incidentById(store: AppStore, id: string | undefined): Incident | undefined {
  if (!id) return undefined;
  return store.getState().snapshot?.incidents.find((i) => i.id === id);
}

function endpointName(store: AppStore, endpointId: string): string {
  return store.getState().settings.notifications.find((e) => e.id === endpointId)?.name ?? endpointId;
}

function ledgerPath(objectKey: string): string {
  return `/ledger?object=${encodeURIComponent(objectKey).replace(/%3A/gi, ':')}`;
}

/**
 * What a Cribl notification target received for the regression (founder-build r1 ui-7, FINDINGS_R1 m1): the plain
 * text the relay hands Cribl (core/delivery.ts renderAlert, as Settings' "What the target receives" shows it), rebuilt
 * from the live (rebased) incident. A target never receives a Slack Block Kit card from Meter Reader.
 */
export function targetTextFor(store: AppStore, incident: Incident, log: DeliveryLog): string {
  const { settings } = store.getState();
  // r2 ui-11 (FINDINGS_R2 #13): in the zone the toast prints its time in, as the target receives it.
  const tz = settings.displayTimezone || 'UTC';
  const canonical = canonicalPayload('incident.opened', {
    incident,
    workspace: 'sample-enterprise',
    linkBase: '',
    labels: settings.humanize,
    sentAt: log.at,
  });
  return renderAlert(canonical, tz).text;
}

/** Turns one (non-silent) tour event into its toast. */
export function narrate(event: TourEvent, ctx: NarrationContext): void {
  if (event.silent) return;
  const { store, navigate } = ctx;
  const tz = store.getState().settings.displayTimezone || 'UTC';

  switch (event.step.action) {
    case 'incident.open': {
      const inc = event.payload as Incident;
      const title = titleFor(inc);
      // A toast of a tour that has stopped opens nothing (its exit closes it too, IC-3).
      const action = navigate
        ? {
            label: t('tour.toast.viewInLedger'),
            onClick: () => {
              if (ctx.engine.isActive()) navigate(ledgerPath(inc.objectKey));
            },
          }
        : undefined;
      if (inc.type === 'regression') {
        const body = t('tour.toast.regressionBody', {
          perDay: formatMoney(inc.impactPerDayM),
          perYear: formatMoney(perYear(inc.impactPerDayM)),
          hash: inc.commit ? inc.commit.hash.slice(0, 7) : t('common.dash'),
          author: inc.commit ? commitAuthor(inc.commit.author) : t('common.dash'),
          caughtIn: formatClock(inc.caughtInSec ?? 0),
        });
        // FOUNDER_PLAN row 11: the drop lands as the takeover card on the Receipt too (src/tour/TourTakeover.tsx). The
        // toast stays (its "View in Ledger"); closing it by hand closes the card with it, so a closed toast leaves a
        // clean Receipt (the capture harness's h.closeToast), while its timing out leaves the card to its own 45 s.
        const landedAt = Date.now();
        showTourTakeover(inc.id, landedAt);
        tourToast.warning(toastBody(title, body), {
          duration: DURATION_MS,
          action,
          onClose: () => {
            if (Date.now() - landedAt < DURATION_MS - CLOSED_BY_HAND_MARGIN_MS) dismissTourTakeover(inc.id);
          },
        });
      } else {
        tourToast.warning(toastBody(title, t('tour.toast.spikeBody', { perDay: formatMoney(inc.impactPerDayM) })), { duration: DURATION_MS, action });
      }
      return;
    }
    case 'incident.close': {
      const inc = event.payload as Incident;
      // The reading at close (D47), never the low the incident keeps as `after`.
      const to = incidentReadings(inc).recoveredTo;
      const body = to === undefined ? t('incidents.recoveredGeneric') : t('incidents.recovered', { pct: formatPct(to) });
      tourToast.success(toastBody(t('tour.toast.recoveredTitle', { label: inc.label }), body), {
        duration: DURATION_MS,
      });
      return;
    }
    case 'delivery': {
      const log = event.payload as DeliveryLog;
      if (log.event !== 'incident.opened') return;
      const inc = incidentById(store, log.incidentId);
      // One Slack beat: the regression's delivery (the spike's lands quietly in the incidents rail).
      if (!inc || inc.type !== 'regression') return;
      const endpoint = endpointName(store, log.endpointId);
      const time = formatTimeOfDay(log.at, tz);
      // m1 / r2 ui-11 (IC-14 residue): the release hands every alert to Cribl as plain text (D57) — "Handed to Cribl for
      // …", as its Settings row and the card say — and what the target received is that text, never a Slack card.
      const id: string = tourToast.success(toastBody(t('tour.toast.handed', { endpoint, time })), {
        duration: DURATION_MS,
        action: {
          label: t('tour.toast.viewMessage'),
          onClick: () => {
            Toast.destroy(id); // the toast has done its job; it must not sit over the dialog
            if (!ctx.engine.isActive()) return;
            const current = incidentById(store, log.incidentId) ?? inc;
            openTourDialog({ kind: 'target', endpoint, text: targetTextFor(store, current, log), time });
          },
        },
      });
      return;
    }
    case 'caption': {
      const caption = event.payload as TourCaption;
      if (caption?.id !== 'weekly-receipt') return;
      const receipt = ctx.engine.weeklyReceipt();
      if (!receipt) return;
      const id: string = tourToast.info(
        toastBody(t('tour.toast.weeklyTitle', { label: receipt.label }), t('tour.toast.weeklyBody', { amount: formatMoney(receipt.savedM) })),
        {
          duration: 12_000,
          action: {
            label: t('tour.toast.viewReceipt'),
            onClick: () => {
              Toast.destroy(id);
              if (ctx.engine.isActive()) openTourDialog({ kind: 'receipt', receipt });
            },
          },
        },
      );
      return;
    }
    default:
      return;
  }
}
