// src/components/Shell/StatusCluster.tsx — right side of the nav: live dot · "updated 12 s ago" · the
// sample-data indicator. One glance answers "are these numbers current?"
//
// It never says more than it knows (EPIC_AUDIT P0-07, P1-D01): failing sweeps read "Not metering · since
// 2:14 PM", a sweep the Leader rate-limited "Rate limited · next sweep in 0:42", a workspace with no prices
// "Not metering yet", an expired session "Signed out · Reload".

import { Button } from '@capra/core';
import { t } from '../../copy/en.ts';
import { formatClock, formatRelative, formatTimeOfDay } from '../../lib/format.ts';
import { useNow } from '../../lib/ticker.ts';
import { shallowEqual, useAppState } from '../../state/react.tsx';
import { meteringFailure } from '../../state/selectors.ts';
import { dataUpdatedAt, deriveDataStatus, meteringBackoff, type DataStatus } from './status.ts';
import './status.css';

const LABEL: Record<DataStatus, string> = {
  connecting: t('status.connecting'),
  waiting: t('status.waiting'),
  live: t('status.live'),
  stale: t('status.stale'),
  'rate-limited': t('status.rateLimited'),
  offline: t('status.offline'),
  sample: t('status.sample'),
  replay: t('status.replay'),
  failing: t('status.failing'),
  'not-metering': t('status.notMetering'),
  'signed-out': t('status.signedOut'),
  'no-access': t('status.noAccess'),
};

/** One-word labels for phone widths (the tab row must fit in 390 px). */
const SHORT_LABEL: Record<DataStatus, string> = {
  connecting: t('status.short.connecting'),
  waiting: t('status.short.waiting'),
  live: t('status.short.live'),
  stale: t('status.short.stale'),
  'rate-limited': t('status.short.rateLimited'),
  offline: t('status.short.offline'),
  sample: t('status.short.sample'),
  replay: t('status.short.replay'),
  failing: t('status.short.failing'),
  'not-metering': t('status.short.notMetering'),
  'signed-out': t('status.short.signedOut'),
  'no-access': t('status.short.noAccess'),
};

/** States whose caption is the age of the figures on screen. */
const AGED: ReadonlySet<DataStatus> = new Set(['live', 'stale', 'offline']);

export function StatusCluster() {
  const now = useNow();
  const view = useAppState(
    (s) => {
      const failure = meteringFailure(s, now);
      return {
        status: deriveDataStatus(s, now),
        updatedAt: dataUpdatedAt(s),
        backoffUntil: s.status.live.backoffUntil,
        failingSince: failure?.since,
        // This tab's own next sweep, when it is the one being rate limited.
        nextSweepAt: failure?.source === 'this-tab' ? s.status.sweep.nextAt : undefined,
        // The sweeps' back-off (P1-E01): until then no sweep calls Cribl, whoever meters.
        meteringUntil: meteringBackoff(s.meta, now)?.untilMs,
        timeZone: s.settings.displayTimezone,
      };
    },
    shallowEqual,
  );

  let caption: string | null = null;
  if (view.status === 'rate-limited' && view.meteringUntil !== undefined) {
    // Not a countdown to the next tick: those ticks skip until the back-off ends (review W2).
    caption = t('status.meteringResumesAt', { time: formatTimeOfDay(view.meteringUntil, view.timeZone) });
  } else if (view.status === 'rate-limited' && view.backoffUntil !== undefined && view.backoffUntil > now) {
    caption = t('status.rateLimitedBackoff', { time: formatTimeOfDay(view.backoffUntil, view.timeZone) });
  } else if (view.status === 'rate-limited' && view.nextSweepAt !== undefined) {
    caption = t('status.nextSweepIn', { countdown: formatClock(Math.max(0, Math.ceil((view.nextSweepAt - now) / 1000))) });
  } else if (view.status === 'failing' && view.failingSince !== undefined) {
    caption = t('status.failingSince', { time: formatTimeOfDay(view.failingSince, view.timeZone) });
  } else if (AGED.has(view.status) && view.updatedAt !== undefined) {
    caption = t('status.updatedAgo', { ago: formatRelative(Math.min(view.updatedAt, now), now) });
  }

  return (
    // The full label is also the tooltip: at a phone's width some states show the dot alone (Shell.css).
    <div className="mr-status" data-status={view.status} role="status" aria-live="off" title={LABEL[view.status]}>
      <span className="mr-status-dot" aria-hidden="true" />
      <span className="mr-status-label mr-status-label--full">{LABEL[view.status]}</span>
      <span className="mr-status-label mr-status-label--short" aria-hidden="true">
        {SHORT_LABEL[view.status]}
      </span>
      {caption ? (
        <>
          <span className="mr-status-sep" aria-hidden="true">
            ·
          </span>
          <span className="mr-status-caption mr-num">{caption}</span>
        </>
      ) : null}
      {view.status === 'signed-out' ? (
        <span className="mr-status-action">
          <Button variant="tertiary" size="sm" onPress={() => window.location.reload()}>
            {t('status.reload')}
          </Button>
        </span>
      ) : null}
    </div>
  );
}
