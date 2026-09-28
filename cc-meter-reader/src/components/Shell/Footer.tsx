// src/components/Shell/Footer.tsx — "v1.0.1 · demo build │ Meter Reader · built by Steve Koelpin" · who meters ·
// "Last sweep 12 s ago · 23 calls · 4.1 s" (SPEC 13; REVIEW-3a #10, DECISIONS D22/D24).
//
// The builder signs the footer beside the version (credit.footer; the name is core's CREDIT_STRINGS.builder).
//
// The version is the installed package's (this bundle's), never `meta.appVersion` — the runner writes
// 'runner' there. The middle line names who actually metered the last sweep (meta.lastSweepOwner, with the
// runner remembered for 90 s so one minute won by a tab doesn't flip it), not what settings.runtime says —
// and says when that meter went quiet (P1-D03: "The runner on ops-box stopped sweeping 20 min ago").
// While sweeps fail the last line says since when none has succeeded (P0-07), not a calm "Last sweep 2 min ago".

import { t } from '../../copy/en.ts';
import { Credit } from '../common/Credit.tsx';
import { BUILD, versionLabel } from '../../lib/env.ts';
import { formatDuration, formatInt, formatRelative, formatTimeOfDay, toMs } from '../../lib/format.ts';
import { useNow } from '../../lib/ticker.ts';
import { shallowEqual, useAppState } from '../../state/react.tsx';
import { meteredBy, meteringFailure, sweepOwnerHost } from '../../state/selectors.ts';
import { meteredByLine } from './status.ts';
import { SweepStrip } from './StatusPulse.tsx';

export function Footer() {
  const now = useNow();
  const view = useAppState(
    (s) => ({
      lastSweepAt: s.meta?.lastSweepAt ?? s.snapshot?.sweepAt,
      calls: s.meta?.lastSweepCalls ?? s.snapshot?.calls,
      durationMs: s.meta?.lastSweepMs,
      runtime: s.settings.runtime,
      source: s.source,
      by: meteredBy(s, now),
      host: sweepOwnerHost(s.meta),
      failingSince: meteringFailure(s, now)?.since,
      timeZone: s.settings.displayTimezone,
    }),
    shallowEqual,
  );

  const sweptAt = toMs(view.lastSweepAt);
  const ago = Number.isFinite(sweptAt) ? formatRelative(Math.min(sweptAt, now), now) : undefined;
  let sweepLine: string;
  if (view.source !== 'live') sweepLine = t('footer.sampleMode');
  else if (view.failingSince !== undefined) sweepLine = t('footer.noGoodSweepSince', { time: formatTimeOfDay(view.failingSince, view.timeZone) });
  else if (ago === undefined) sweepLine = t('footer.noSweepYet');
  else {
    sweepLine =
      view.calls !== undefined && view.durationMs !== undefined
        ? t('footer.lastSweep', { ago, calls: formatInt(view.calls), duration: formatDuration(view.durationMs) })
        : t('footer.lastSweepNoStats', { ago });
  }

  return (
    <footer className="mr-footer">
      <span className="mr-footer-id">
        <span className="mr-footer-build mr-num" data-testid="footer-build">
          {versionLabel()}{' '}
          <span aria-hidden="true">· </span>
          {BUILD === 'demo' ? t('footer.buildDemo') : t('footer.buildRelease')}
        </span>
        <Credit copyKey="credit.footer" className="mr-footer-credit" testId="footer-credit" />
      </span>
      <span className="mr-footer-runtime" data-testid="footer-runtime" data-metered-by={view.by}>
        {meteredByLine(view.by, view.runtime, view.host, ago)}
      </span>
      <span
        className="mr-footer-sweep mr-num"
        data-testid="footer-sweep"
        data-state={view.failingSince !== undefined ? 'failing' : undefined}
      >
        {sweepLine}
      </span>
      <SweepStrip />
    </footer>
  );
}
