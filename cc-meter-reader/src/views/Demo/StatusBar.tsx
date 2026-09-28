// src/views/Demo/StatusBar.tsx — the console's pinned status line (DESIGN_BRIEF 5.7): live dot · last sweep
// · open alerts, and underneath what the one lever in flight is doing ("Break the trim · deploying…"), a
// retry countdown the member can cancel, or a lever another device is running. `flash` marks the 1.2 s after
// an alert lands (src/views/Demo/useIncidentCue.ts, EPIC_AUDIT P2-W18).

import type { ReactNode } from 'react';
import { Button, Spinner } from '@capra/core';
import { ClockOutlined } from '@capra/icons';
import { t, tn, type CopyKey } from '../../copy/en.ts';
import { formatClock, formatRelative, toMs } from '../../lib/format.ts';
import type { DataStatus } from '../../components/Shell/status.ts';
import type { ClientStatus } from '../../demo/client.ts';
import { jobLabel } from '../../demo/actions.tsx';
import type { RemoteLever } from '../../demo/derive.ts';

const STATE_KEY: Record<DataStatus, CopyKey> = {
  live: 'demo.state.live',
  waiting: 'demo.state.waiting',
  stale: 'demo.state.stale',
  offline: 'demo.state.offline',
  'rate-limited': 'demo.state.rateLimited',
  replay: 'demo.state.replay',
  sample: 'demo.state.sample',
  connecting: 'demo.state.connecting',
  failing: 'demo.state.failing',
  'not-metering': 'demo.state.notMetering',
  'signed-out': 'demo.state.signedOut',
  'no-access': 'demo.state.noAccess',
};

export interface StatusBarProps {
  dataStatus: DataStatus;
  lastSweepAt: string | undefined;
  openAlerts: number;
  client: ClientStatus;
  remote: RemoteLever | undefined;
  nowMs: number;
  /** An alert just landed: one 1.2 s flash in the incident colour (never a loop). */
  flash?: boolean;
  onCancelRetry(): void;
}

/** demo/state.inFlight.lever (a core LeverName) in plain words. */
const REMOTE_LEVER: Record<string, CopyKey> = {
  applyPack: 'demo.sections.packs',
  revertPack: 'shortcuts.lever.revertAll',
  breakTrim: 'shortcuts.lever.breakTrim',
  restoreTrim: 'shortcuts.lever.restore',
  setRate: 'demo.sections.rate',
  resetBaselines: 'demo.resetBaselines',
  resetAll: 'shortcuts.lever.reset',
};

function leverWord(lever: string): string {
  const key = REMOTE_LEVER[lever];
  return key ? t(key) : lever;
}

export function StatusBar({ dataStatus, lastSweepAt, openAlerts, client, remote, nowMs, flash, onCancelRetry }: StatusBarProps) {
  const swept = toMs(lastSweepAt);
  const sweepText = Number.isFinite(swept)
    ? t('demo.lastSweep', {
        ago: formatRelative(Math.min(swept, nowMs), nowMs),
      })
    : t('demo.noSweep');

  let activity: ReactNode;
  let activityState: 'idle' | 'running' | 'retry' | 'remote' = 'idle';
  if (client.busy && client.retry) {
    activityState = 'retry';
    const left = Math.max(0, Math.ceil((client.retry.at - nowMs) / 1000));
    activity = (
      <>
        <span className="mr-demo-activity-icon">
          <ClockOutlined size="sm" aria-hidden="true" />
        </span>
        <span className="mr-demo-activity-text">
          <span className="mr-demo-activity-lever">{client.job ? jobLabel(client.job) : ''}</span>
          <span className="mr-demo-activity-stage">
            {t(`demo.retryReason.${client.retry.reason}` as CopyKey)} {t('demo.retrying', { countdown: formatClock(left) })}
          </span>
        </span>
        <span className="mr-demo-activity-action">
          <Button variant="tertiary" size="sm" onPress={onCancelRetry}>
            {t('demo.cancelRetry')}
          </Button>
        </span>
      </>
    );
  } else if (client.busy) {
    activityState = 'running';
    activity = (
      <>
        <span className="mr-demo-activity-icon">
          <Spinner size="sm" />
        </span>
        <span className="mr-demo-activity-text">
          <span className="mr-demo-activity-lever">{client.job ? jobLabel(client.job) : ''}</span>
          <span className="mr-demo-activity-stage" data-testid="demo-stage">
            {t(`demo.stage.${client.stage ?? 'preparing'}` as CopyKey)}
          </span>
        </span>
      </>
    );
  } else if (remote) {
    activityState = 'remote';
    activity = (
      <>
        <span className="mr-demo-activity-icon">
          <Spinner size="sm" />
        </span>
        <span className="mr-demo-activity-text">
          <span className="mr-demo-activity-lever">{t('demo.remote', { lever: leverWord(remote.lever) })}</span>
          <span className="mr-demo-activity-stage">{t('demo.remoteHint')}</span>
        </span>
      </>
    );
  } else {
    activity = (
      <>
        <span className="mr-demo-activity-icon" aria-hidden="true">
          <span className="mr-demo-ready-dot" />
        </span>
        <span className="mr-demo-activity-text">
          <span className="mr-demo-activity-lever">{t('demo.ready')}</span>
          <span className="mr-demo-activity-stage">{t('demo.readyHint')}</span>
        </span>
      </>
    );
  }

  return (
    <section className="mr-demo-status" aria-label={t('demo.statusAria')} data-testid="demo-status" data-flash={flash ? 'true' : undefined}>
      <div className="mr-demo-status-row">
        <span className="mr-demo-status-dot" data-status={dataStatus} aria-hidden="true" />
        <span className="mr-demo-status-state">{t(STATE_KEY[dataStatus])}</span>
        <span className="mr-demo-status-sep" aria-hidden="true">
          ·
        </span>
        <span className="mr-demo-status-sweep mr-num">{sweepText}</span>
        <span
          className={`mr-demo-status-alerts mr-num${openAlerts > 0 ? ' mr-demo-status-alerts--open' : ''}`}
          data-testid="demo-open-alerts"
        >
          {tn('demo.openAlerts', openAlerts)}
        </span>
      </div>
      <div
        className="mr-demo-activity"
        data-state={activityState}
        data-last={client.last ? (client.last.ok ? 'ok' : (client.last.error ?? 'failed')) : undefined}
        role="status"
        aria-live="polite"
        data-testid="demo-activity"
      >
        {activity}
      </div>
    </section>
  );
}
