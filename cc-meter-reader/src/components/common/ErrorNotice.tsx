// src/components/common/ErrorNotice.tsx — one component for every API failure state (SPEC 13 "Errors",
// PRD 8.8 item 7: "a state with no design is a bug").
//
//   401        session expired → reload
//   403        inline per section, actions disabled by the caller, the rest of the view intact
//   404        treated as empty → renders nothing (show an EmptyBlock instead)
//   429        rate limited, with the next-sweep countdown when known
//   5xx / net  keep the last good data, captioned with when it was last updated; with none, say so
//
// `MeteringNotice` (below) is the same idea for the meter itself: sweeps failing, figures gone stale, prices
// that can never count anything as saved.

import type { ReactNode } from 'react';
import { Alert } from '@capra/core';
import { useNavigate } from 'react-router-dom';
import { t, tn } from '../../copy/en.ts';
import { formatClock, formatRelative, formatTimeOfDay, toMs } from '../../lib/format.ts';
import { useNow } from '../../lib/ticker.ts';
import { shallowEqual, useAppState } from '../../state/react.tsx';
import { everyPriceIsZero, meteredBy, meteredGroups, meteringFailure, sweepOwnerHost, zeroPricedReducers } from '../../state/selectors.ts';
import { errorKindForStatus, type ApiErrorInfo, type ApiErrorKind } from '../../state/store.ts';
import { deriveDataStatus, meteredByLine, meteringBackoff, sweepErrorText } from '../Shell/status.ts';
import { InlineNotice } from './InlineNotice.tsx';
import './common.css';
import './MeteringNotice.css';

export interface ErrorNoticeProps {
  /** The failure, or just an HTTP status. */
  error: ApiErrorInfo | number;
  /** What couldn't be read, in plain words ("metrics for default", "prices"); used in the 403 copy. */
  section?: string;
  /**
   * 403 only: the rest of the page still works without this data, so the copy may say so. Leave it off when the
   * whole page depends on it (BEAUTY F14: never "everything else still works" over a blank page).
   */
  othersWork?: boolean;
  /** epoch ms of the last good data (5xx / network copy). */
  lastGoodAt?: number;
  /** epoch ms of the next sweep (429 countdown). */
  nextSweepAt?: number;
  onRetry?: () => void;
  layout?: 'section' | 'inline';
}

function kindOf(error: ApiErrorInfo | number): ApiErrorKind {
  return typeof error === 'number' ? errorKindForStatus(error) : error.kind;
}

function statusOf(error: ApiErrorInfo | number): number {
  return typeof error === 'number' ? error : error.status;
}

export function ErrorNotice(props: ErrorNoticeProps) {
  const { error, section, lastGoodAt, nextSweepAt, onRetry, layout = 'section', othersWork = false } = props;
  const now = useNow();
  const kind = kindOf(error);
  const retry = onRetry ? { label: t('errors.retry'), onClick: () => onRetry() } : undefined;

  switch (kind) {
    case 'not-found':
      return null;

    case 'unauthorized':
      return (
        <Alert
          appearance="warning"
          layout={layout}
          title={t('errors.unauthorizedTitle')}
          action={{ label: t('errors.reload'), onClick: () => window.location.reload() }}
        >
          {t('errors.unauthorizedBody')}
        </Alert>
      );

    case 'forbidden':
      return (
        <Alert appearance="warning" layout={layout} title={t('errors.forbiddenTitle')} data-state="forbidden">
          {othersWork
            ? section
              ? t('errors.forbiddenBody', { section })
              : t('errors.forbiddenBodyGeneric')
            : section
              ? t('errors.forbiddenBodyOnly', { section })
              : t('errors.forbiddenBodyOnlyGeneric')}
        </Alert>
      );

    case 'rate-limited': {
      const countdown = nextSweepAt !== undefined ? Math.max(0, Math.ceil((nextSweepAt - now) / 1000)) : undefined;
      return (
        <Alert appearance="info" layout={layout} title={t('errors.rateLimitedTitle')} data-state="rate-limited">
          {countdown !== undefined
            ? t('errors.rateLimitedNextSweep', { countdown: formatClock(countdown) })
            : t('errors.rateLimitedBody')}
        </Alert>
      );
    }

    case 'network':
      return (
        <Alert appearance="warning" layout={layout} title={t('errors.networkTitle')} action={retry} data-state="network">
          {t('errors.networkBody')}
        </Alert>
      );

    case 'server':
    case 'unknown':
    default: {
      const status = statusOf(error);
      return (
        <Alert
          appearance="warning"
          layout={layout}
          title={`${t('errors.serverTitle')}${status ? ` (${status})` : ''}`}
          action={retry}
          data-state="server-error"
        >
          {lastGoodAt !== undefined && Number.isFinite(lastGoodAt)
            ? t('errors.serverBody', { ago: formatRelative(lastGoodAt, now) })
            : t('errors.serverBodyNoData')}
        </Alert>
      );
    }
  }
}

/** 'DevNull', 'DevNull and Archive', 'A, B and C' (row 14's destination names). */
function listWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} ${t('common.and')} ${names[names.length - 1]}`;
}

// ─── The meter's own state (P0-07, P1-D03, P1-D06) ────────────────────────────

export interface MeteringNoticeProps {
  /** 'receipt' (under the hero): failures, the stale caveat and the all-$0 notice; 'runtime': failures only. */
  placement?: 'receipt' | 'runtime';
  layout?: 'section' | 'inline';
}

/**
 * Why the figures are not moving, or cannot:
 *   • sweeps are failing — "Not metering since 2:14 PM", with what the failure means in words ("Couldn't read
 *     metrics for default: your role can't view them…", "Rate limited by the Leader. Next sweep in 0:42.");
 *   • the figures are stale and nothing is failing — "Not updated since 2:14 PM. The runner on ops-box
 *     stopped sweeping 20 min ago.";
 *   • every price is $0 — nothing can ever count as saved, with Set prices;
 *   • the session expired (a 401 on a read or a sweep) — the Reload notice, which phones need (the chip there is a dot).
 * Renders nothing while metering is healthy. Recovery clears it on the next sweep, without a reload.
 */
export function MeteringNotice({ placement = 'receipt', layout = 'section' }: MeteringNoticeProps) {
  const now = useNow();
  const navigate = useNavigate();
  const receipt = placement === 'receipt';
  const view = useAppState(
    (s) => {
      const failure = meteringFailure(s, now);
      const status = deriveDataStatus(s, now);
      const stale = receipt && !failure && status === 'stale';
      return {
        // The chip's Reload is hidden on phones: an expired session gets the page's own notice, unless the Receipt
        // already shows one for its snapshot read.
        signedOut: status === 'signed-out' && s.errors.snapshot?.kind !== 'unauthorized',
        kind: failure?.kind,
        status: failure?.status,
        since: failure?.since,
        nextAt: failure?.source === 'this-tab' ? s.status.sweep.nextAt : undefined,
        // P1-E01's back-off, while it runs: the sentence names the resume time, not the next (skipping) tick.
        backoffSince: failure?.kind === 'rate-limited' ? meteringBackoff(s.meta, now, failure.since)?.sinceMs : undefined,
        backoffUntil: failure?.kind === 'rate-limited' ? meteringBackoff(s.meta, now, failure.since)?.untilMs : undefined,
        groups: meteredGroups(s).join('\u0000'),
        stale,
        lastSweepAt: stale ? (s.snapshot?.sweepAt ?? s.meta?.lastSweepAt) : undefined,
        by: stale ? meteredBy(s, now) : undefined,
        host: stale ? sweepOwnerHost(s.meta) : undefined,
        runtime: s.settings.runtime,
        zero: receipt && s.source === 'live' && everyPriceIsZero(s.prices),
        // Row 14 (r1 ui-11): the mixed $0 case names the $0 destinations the pipelines reduce into.
        zeroRows: receipt && s.source === 'live' && !everyPriceIsZero(s.prices) ? zeroPricedReducers(s.snapshot, s.settings.humanize).join('\u0000') : '',
        tz: s.settings.displayTimezone,
      };
    },
    shallowEqual,
  );

  let meter: ReactNode = null;
  if (view.signedOut) {
    meter = (
      <div className="mr-metering-notice" data-testid="metering-notice" data-state="signed-out">
        <ErrorNotice error={401} layout={layout} />
      </div>
    );
  } else if (view.kind !== undefined && view.since !== undefined) {
    const nextSweepInS = view.nextAt !== undefined ? (view.nextAt - now) / 1000 : undefined;
    const groups = view.groups ? view.groups.split('\u0000') : undefined;
    const backoff =
      view.backoffSince !== undefined && view.backoffUntil !== undefined
        ? { since: formatTimeOfDay(view.backoffSince, view.tz), until: formatTimeOfDay(view.backoffUntil, view.tz) }
        : undefined;
    let body = sweepErrorText({ kind: view.kind, status: view.status }, { groups, nextSweepInS, ...(backoff ? { backoff } : {}) });
    // A permission fixed by an administrator is picked up by the next timed sweep: say when that is.
    if ((view.kind === 'metrics-forbidden' || view.kind === 'forbidden') && nextSweepInS !== undefined) {
      body = `${body} ${t('sweep.failure.nextSweep', { countdown: formatClock(Math.max(0, Math.ceil(nextSweepInS))) })}`;
    }
    meter = (
      <div className="mr-metering-notice" data-testid="metering-notice" data-state="metering-failed" data-kind={view.kind}>
        <Alert
          appearance={view.kind === 'rate-limited' ? 'info' : 'warning'}
          layout={layout}
          title={t('receiptView.notMeteringSince', { time: formatTimeOfDay(view.since, view.tz) })}
          action={view.kind === 'unauthorized' ? { label: t('errors.reload'), onClick: () => window.location.reload() } : undefined}
        >
          {body}
        </Alert>
      </div>
    );
  } else if (view.stale && view.lastSweepAt !== undefined) {
    const at = toMs(view.lastSweepAt);
    if (Number.isFinite(at)) {
      const ago = formatRelative(Math.min(at, now), now);
      const who =
        view.by === 'runner-silent' || view.by === 'backend-silent' ? `${meteredByLine(view.by, view.runtime, view.host, ago)}.` : t('receiptView.staleBody', { ago });
      meter = (
        <InlineNotice data-testid="metering-notice" data-state="stale">
          <strong className="mr-notice-strong">{`${t('receiptView.staleTitle', { time: formatTimeOfDay(at, view.tz) })}.`}</strong> {who}
        </InlineNotice>
      );
    }
  }

  const zero = view.zero ? (
    <InlineNotice data-testid="zero-priced-notice" data-state="zero-priced" action={{ label: t('receiptView.setPrices'), onClick: () => navigate('/settings/prices') }}>
      <strong className="mr-notice-strong">{`${t('receiptView.zeroPricedTitle')}.`}</strong> {t('receiptView.zeroPricedBody')}
    </InlineNotice>
  ) : null;

  const zeroNames = view.zeroRows ? view.zeroRows.split('\u0000') : [];
  const zeroRow =
    !zero && zeroNames.length > 0 ? (
      <InlineNotice data-testid="zero-row-notice" data-state="zero-row" action={{ label: t('receiptView.setPrices'), onClick: () => navigate('/settings/prices') }}>
        {tn('receiptView.zeroRow', zeroNames.length, { names: listWords(zeroNames) })}
      </InlineNotice>
    ) : null;

  if (!meter && !zero && !zeroRow) return null;
  return (
    <>
      {meter}
      {zero}
      {zeroRow}
    </>
  );
}
