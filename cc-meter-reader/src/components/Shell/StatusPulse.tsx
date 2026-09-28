// src/components/Shell/StatusPulse.tsx — the status cluster becomes the app's live pulse (EPIC_AUDIT P2-W21).
//
//   • A click or tap anywhere on the status (or its chevron, the keyboard's way in) opens a Capra Popover: when
//     the next sweep lands ("Next sweep in 0:42", counting down; "expected" when someone else meters), who
//     meters, a 60-minute strip of the sweeps this tab has seen (Leader calls each; failures in red), the
//     median duration, and Sweep now. It answers "are these numbers current?" on every width, the phone
//     included, where the cluster is a dot and a word.
//   • The dot ticks once when a sweep lands (a single ring, never a loop; none under reduced motion).
//   • The footer's sweep strip (`SweepStrip`) is the same history at 96 px, with the countdown.
//
// StatusCluster itself (WP-D's) is untouched: this wraps it.

import { useState } from 'react';
import { IconButton, Popover } from '@capra/core';
import { ChevronDown } from '@capra/icons';
import { t } from '../../copy/en.ts';
import { formatClock } from '../../lib/format.ts';
import { useNow } from '../../lib/ticker.ts';
import { useAppState } from '../../state/react.tsx';
import { meteredBy, sweepOwnerHost } from '../../state/selectors.ts';
import type { AppState } from '../../state/store.ts';
import { SweepNowButton } from '../../views/Settings/SweepNowButton.tsx';
import { meteredByLine } from './status.ts';
import { StatusCluster } from './StatusCluster.tsx';
import { SweepSparkline } from './SweepSparkline.tsx';
import { countdownLine, historyCaption, nextSweep, stripCountdown, useSweepHistory, windowEntries } from './sweepHistory.ts';

function PulsePanel() {
  const now = useNow();
  const history = useSweepHistory();
  const state = useAppState((s: AppState) => s);
  const next = nextSweep(state, history, now);
  const live = state.source === 'live';
  const lastAt = state.meta?.lastSweepAt ? Date.parse(state.meta.lastSweepAt) : Number.NaN;
  const ago = Number.isFinite(lastAt) ? formatClock(Math.max(0, Math.round((now - lastAt) / 1000))) : undefined;
  const who = meteredByLine(meteredBy(state, now), state.settings.runtime, sweepOwnerHost(state.meta), ago);
  const entries = windowEntries(history, now);
  return (
    <div className="mr-pulse" data-testid="status-pulse">
      <p className="mr-pulse-next mr-num" data-testid="pulse-next" data-expected={next?.expected ? 'true' : undefined}>
        {live ? (countdownLine(next, now) ?? t('pulse.noNext')) : t('pulse.sample')}
      </p>
      {live ? <p className="mr-pulse-who">{who}</p> : null}
      <div className="mr-pulse-chart">
        <p className="mr-pulse-title">{t('pulse.title')}</p>
        <SweepSparkline entries={entries} now={now} since={history.since} width={288} height={44} label={t('pulse.chartLabel')} />
        <div className="mr-pulse-axis" aria-hidden="true">
          <span>{t('pulse.axisStart')}</span>
          <span>{t('pulse.axisEnd')}</span>
        </div>
        <p className="mr-pulse-caption" data-testid="pulse-caption">
          {historyCaption(history, now, state.settings.displayTimezone)}
        </p>
      </div>
      {live ? (
        <div className="mr-pulse-actions">
          <SweepNowButton showResult />
        </div>
      ) : null}
    </div>
  );
}

/** Flips on each sweep that lands after the first one this tab saw, so the dot's one-shot ring replays (P2-W21). */
function useSweepTick(): string | undefined {
  const { landed } = useSweepHistory();
  return landed > 1 ? (landed % 2 === 0 ? 'a' : 'b') : undefined;
}

export function StatusPulse() {
  const [open, setOpen] = useState(false);
  const tick = useSweepTick();
  return (
    <div
      className="mr-status-pulse"
      data-tick={tick}
      data-open={open ? 'true' : undefined}
      data-testid="status-pulse-trigger"
      onClick={(event) => {
        // The chevron is the Popover's own trigger; anywhere else on the status opens it too.
        if (event.target instanceof Element && event.target.closest('button')) return;
        setOpen(true);
      }}
    >
      <StatusCluster />
      <Popover placement="bottomRight" isOpen={open} onOpenChange={setOpen} content={open ? <PulsePanel /> : null}>
        <IconButton icon={ChevronDown} aria-label={t('pulse.open')} aria-expanded={open} size="sm" variant="tertiary" appearance="neutral" />
      </Popover>
    </div>
  );
}

/** The footer's stub: the hour's sweeps at 96 px and "next 0:42" (P2-W21). */
export function SweepStrip() {
  const now = useNow();
  const history = useSweepHistory();
  const state = useAppState((s: AppState) => s);
  if (state.source !== 'live') return null;
  const next = nextSweep(state, history, now);
  const countdown = stripCountdown(next, now);
  const entries = windowEntries(history, now);
  return (
    <span className="mr-footer-pulse" data-testid="footer-pulse">
      <SweepSparkline entries={entries} now={now} since={history.since} width={96} height={14} className="mr-footer-spark" />
      {countdown ? (
        <span className="mr-footer-next mr-num" data-testid="footer-next" data-expected={next?.expected ? 'true' : undefined}>
          {countdown}
        </span>
      ) : null}
    </span>
  );
}
