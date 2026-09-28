// src/views/Settings/RuntimeSection.tsx — Runtime (PRD 8.4, SPEC 7/13, DECISIONS D11/D12b/D24): where metering
// runs, whether this tab is metering (and why not: no prices yet, sample data, replay), who metered the last
// sweep (this tab, another tab, the runner, the backend), the last sweep's stats, Sweep now (once per 30 s), and
// About: the version and the builder's signature.

import type { ReactNode } from 'react';
import { t } from '../../copy/en.ts';
import { ErrorNotice, MeteringNotice } from '../../components/common/ErrorNotice.tsx';
import { RelativeTime } from '../../components/common/RelativeTime.tsx';
import { Credit } from '../../components/common/Credit.tsx';
import { versionLabel } from '../../lib/env.ts';
import { formatDateTime, formatDuration, formatInt, formatRelative, toMs } from '../../lib/format.ts';
import { useNow } from '../../lib/ticker.ts';
import { shallowEqual, useAppState } from '../../state/react.tsx';
import { meterBlocker, meteredBy, meteredGroups, meteringFailure, sweepOwnerHost } from '../../state/selectors.ts';
import { meteredByLine, sweepErrorCodeText } from '../../components/Shell/status.ts';
import { Link } from '@capra/core';
import { SectionCard } from './shared.tsx';
import { SweepNowButton } from './SweepNowButton.tsx';

function Stat({ label, children, testId, wrap }: { label: string; children: ReactNode; testId?: string; wrap?: boolean }) {
  return (
    <div className="mr-rt-stat" data-testid={testId}>
      <dt className="mr-rt-label">{label}</dt>
      <dd className="mr-rt-value mr-num" data-wrap={wrap ? 'true' : undefined}>
        {children}
      </dd>
    </div>
  );
}

export function RuntimeSection() {
  const now = useNow();
  const view = useAppState(
    (s) => ({
      blocker: meterBlocker(s, now),
      by: meteredBy(s, now),
      host: sweepOwnerHost(s.meta),
      runtime: s.settings.runtime,
      tz: s.settings.displayTimezone,
      metering: s.status.sweep.metering,
      replay: s.settings.demo.replayMode,
      source: s.source,
      hydrated: s.hasHydrated,
      lastSweepAt: s.meta?.lastSweepAt ?? s.snapshot?.sweepAt,
      calls: s.meta?.lastSweepCalls ?? s.snapshot?.calls,
      ms: s.meta?.lastSweepMs,
      sweeps: s.meta?.sweepCount,
      collectingSince: s.meta?.collectingSince ?? s.snapshot?.collectingSince,
      lastError: s.meta?.lastError,
      groups: meteredGroups(s).join(', '),
      // The failure notice above the stats says it already; the raw line below is for an old, isolated error.
      failing: meteringFailure(s, now) !== null,
      backoffUntil: s.status.live.backoffUntil,
      liveError: s.status.live.lastError,
    }),
    shallowEqual,
  );

  const ui = view.runtime === 'ui';
  const knownMeterer =
    view.by === 'runner' || view.by === 'runner-silent' || view.by === 'this-tab' || view.by === 'other-tab' || view.by === 'backend' || view.by === 'backend-silent';
  const sweptAt = toMs(view.lastSweepAt);
  const ago = Number.isFinite(sweptAt) ? formatRelative(Math.min(sweptAt, now), now) : undefined;
  let meteringLine: ReactNode;
  // Who actually metered the last sweep beats what the settings say (REVIEW-3a #10: the runner, on the demo org).
  if (knownMeterer) meteringLine = meteredByLine(view.by, view.runtime, view.host, ago);
  else if (!ui) meteringLine = t('sweep.backgroundNote');
  else if (view.metering) meteringLine = t('settings.runtime.metering');
  else if (view.source !== 'live') meteringLine = t('settings.runtime.notMeteringSample');
  else if (view.replay) meteringLine = t('settings.runtime.notMeteringReplay');
  else if (view.blocker === 'no-prices')
    meteringLine = (
      <>
        {t('settings.runtime.notMeteringNoPrices')} ·{' '}
        <Link href="/settings/prices">{t('settings.runtime.setPricesLink')}</Link>
      </>
    );
  else meteringLine = t('settings.runtime.notMeteringWaiting');

  const rateLimited = view.backoffUntil !== undefined && view.backoffUntil > now;

  return (
    <SectionCard id="runtime" title={t('settings.runtimeGroup')} description={t('settings.runtime.description')}>
      <div className="mr-rt-top">
        <div className="mr-rt-runtime">
          <span className="mr-rt-label">{t('settings.runtime.label')}</span>
          <span className="mr-rt-runtime-value" data-testid="runtime-value" data-runtime={view.runtime}>
            {/* Green only while this tab's sweeps actually run (P0-07): a failing meter is not "on". */}
            <span className="mr-rt-dot" data-on={view.metering && !view.failing ? 'true' : 'false'} aria-hidden="true" />
            {ui ? t('settings.runtime.ui') : t('settings.runtime.backend')}
          </span>
          <span className="mr-set-caption" data-testid="runtime-metering" data-metered-by={view.by}>
            {meteringLine}
          </span>
        </div>
        <SweepNowButton variant="primary" showResult />
      </div>

      <p className="mr-rt-note">{ui ? t('settings.runtime.uiNote') : t('sweep.backgroundNote')}</p>

      {rateLimited ? <ErrorNotice error={429} nextSweepAt={view.backoffUntil} layout="inline" /> : null}
      <MeteringNotice placement="runtime" layout="inline" />

      <dl className="mr-rt-stats">
        <Stat label={t('settings.runtime.lastSweep')} testId="runtime-last-sweep">
          {view.lastSweepAt ? <RelativeTime at={view.lastSweepAt} timeZone={view.tz} /> : t('footer.noSweepYet')}
        </Stat>
        <Stat label={t('settings.runtime.calls')} testId="runtime-calls">
          {view.calls !== undefined ? formatInt(view.calls) : t('common.dash')}
        </Stat>
        <Stat label={t('settings.runtime.duration')} testId="runtime-duration">
          {view.ms !== undefined ? formatDuration(view.ms) : t('common.dash')}
        </Stat>
        <Stat label={t('settings.runtime.sweeps')}>{view.sweeps !== undefined ? formatInt(view.sweeps) : t('common.dash')}</Stat>
        <Stat label={t('settings.runtime.collecting')} wrap>{view.collectingSince ? formatDateTime(view.collectingSince, view.tz) : t('common.dash')}</Stat>
      </dl>

      {/* About: the version and who built it, signed as the footer is (credit.about). */}
      <p className="mr-rt-about" data-testid="runtime-about">
        <span className="mr-rt-label">{t('credit.aboutLabel')}</span>
        <Credit copyKey="credit.about" vars={{ version: versionLabel() }} className="mr-rt-about-text" testId="runtime-credit" />
      </p>

      {view.lastError && !view.failing ? (
        <p className="mr-set-error" data-testid="runtime-last-error">
          {t('settings.runtime.lastError', { error: sweepErrorCodeText(view.lastError, undefined, { groups: view.groups ? view.groups.split(', ') : undefined }) })}
        </p>
      ) : null}
    </SectionCard>
  );
}
