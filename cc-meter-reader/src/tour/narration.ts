// src/tour/narration.ts — what the tour says while it plays: one toast per beat, each tied to what just
// changed on screen, so a judge who is looking at the Receipt still notices the alert that fired.
//
// Budget (DESIGN_BRIEF 4): five toasts in 130 s, the Capra notification idiom, nothing that loops or
// pulses. Seeks and fast-forwards are silent. The copy lives in src/copy/en.ts (`tour.toast.*`, plus
// the shared incident titles).

import { createElement } from 'react';
import { Toast } from '@capra/core';
import type { DeliveryLog, Incident } from '../../core/types.ts';
import { canonicalPayload, slackPayload } from '../../core/payloads.ts';
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
import { TourToastBody } from './TourToast.tsx';

export interface NarrationContext {
  store: AppStore;
  engine: TourEngine;
  /** In-app navigation (react-router's navigate), for "View in Ledger". */
  navigate?: (to: string) => void;
}

const DURATION_MS = 9_000;

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

/** The Slack message the regression's delivery carried, rebuilt from the live (rebased) incident. */
export function slackMessageFor(store: AppStore, incident: Incident, log: DeliveryLog): unknown {
  const { settings } = store.getState();
  const tz = settings.displayTimezone || 'UTC';
  const canonical = canonicalPayload('incident.opened', {
    incident,
    workspace: 'sample-enterprise',
    linkBase: '',
    labels: settings.humanize,
    sentAt: log.at,
  });
  return slackPayload(canonical, { tz, labels: settings.humanize });
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
      const action = navigate ? { label: t('tour.toast.viewInLedger'), onClick: () => navigate(ledgerPath(inc.objectKey)) } : undefined;
      if (inc.type === 'regression') {
        const body = t('tour.toast.regressionBody', {
          perDay: formatMoney(inc.impactPerDayM),
          perYear: formatMoney(perYear(inc.impactPerDayM)),
          hash: inc.commit ? inc.commit.hash.slice(0, 7) : t('common.dash'),
          author: inc.commit ? commitAuthor(inc.commit.author) : t('common.dash'),
          caughtIn: formatClock(inc.caughtInSec ?? 0),
        });
        notify.warning(toastBody(title, body), { duration: DURATION_MS, action });
      } else {
        notify.warning(toastBody(title, t('tour.toast.spikeBody', { perDay: formatMoney(inc.impactPerDayM) })), { duration: DURATION_MS, action });
      }
      return;
    }
    case 'incident.close': {
      const inc = event.payload as Incident;
      // The reading at close (D47), never the low the incident keeps as `after`.
      const to = incidentReadings(inc).recoveredTo;
      const body = to === undefined ? t('incidents.recoveredGeneric') : t('incidents.recovered', { pct: formatPct(to) });
      notify.success(toastBody(t('tour.toast.recoveredTitle', { label: inc.label }), body), {
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
      const id: string = notify.success(toastBody(t('tour.toast.delivered', { endpoint, time })), {
        duration: DURATION_MS,
        action: {
          label: t('tour.toast.viewMessage'),
          onClick: () => {
            Toast.destroy(id); // the toast has done its job; it must not sit over the dialog
            const current = incidentById(store, log.incidentId) ?? inc;
            openTourDialog({ kind: 'slack', endpoint, message: slackMessageFor(store, current, log), time });
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
      const id: string = notify.info(
        toastBody(t('tour.toast.weeklyTitle', { label: receipt.label }), t('tour.toast.weeklyBody', { amount: formatMoney(receipt.savedM) })),
        {
          duration: 12_000,
          action: {
            label: t('tour.toast.viewReceipt'),
            onClick: () => {
              Toast.destroy(id);
              openTourDialog({ kind: 'receipt', receipt });
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
