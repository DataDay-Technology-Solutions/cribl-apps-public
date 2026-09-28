// src/views/Presenter/RestPanel.tsx — the stage at rest (P2-W04): the lower half is the incident card's, and for
// all but a minute of a talk no card is up, so it holds what the card may cover — the month's receipt bar at stage
// scale (would have paid → paid grey → saved green, the Receipt's own component and words) and the last 30 days
// of savings as one green line. When a card arrives the panel fades out in 200 ms (before the card's 450 ms slide
// lands) and comes back when the card goes: nothing the audience needs at the payoff is ever under the card
// (BEAUTY F1), and the payoff gets its before and after.
//
// Real figures only: the snapshot's month to date and its completed days (today, still partial, is left out). No
// bar before there is a month to show; no line before there are two completed days.

import { useId } from 'react';
import type { Snapshot, TrendPoint } from '../../../core/types.ts';
import { t } from '../../copy/en.ts';
import { formatMoney } from '../../lib/format.ts';
import { ReceiptBar } from '../../components/ReceiptBar/ReceiptBar.tsx';
import { TREND_H, TREND_W, restTrendDays, trendPaths } from './trend.ts';

function TrendArea({ points }: { points: readonly TrendPoint[] }) {
  const titleId = useId();
  const paths = trendPaths(points);
  if (!paths) return null;
  return (
    <figure className="mr-pv-trend" aria-labelledby={titleId}>
      <figcaption className="mr-pv-rest-title">
        <span id={titleId}>{t('presenter.rest.trendTitle', { days: points.length })}</span>
        <span className="mr-pv-rest-note mr-num">{t('presenter.rest.trendPeak', { amount: formatMoney(paths.max) })}</span>
      </figcaption>
      <svg className="mr-pv-trend-svg" viewBox={`0 0 ${TREND_W} ${TREND_H}`} preserveAspectRatio="none" aria-hidden="true">
        <path className="mr-pv-trend-area" d={paths.area} />
        <path className="mr-pv-trend-line" d={paths.line} vectorEffect="non-scaling-stroke" />
        <line className="mr-pv-trend-base" x1={0} x2={TREND_W} y1={TREND_H} y2={TREND_H} vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}

export function RestPanel({ snapshot, tz }: { snapshot: Snapshot; tz?: string }) {
  const h = snapshot.headline;
  if (!(h.whpMtdM > 0)) return null;
  // The share names its basis the Receipt's way: of dollars, month to date.
  const basis = t('receipt.savedPctBasis', { period: t('meter.period.mtd') });
  return (
    <section className="mr-pv-rest" aria-label={t('presenter.rest.label')} data-testid="stage-rest">
      <div className="mr-pv-bar">
        <p className="mr-pv-rest-title">{t('presenter.rest.barTitle')}</p>
        <ReceiptBar whpM={h.whpMtdM} paidM={h.paidMtdM} savedM={h.mtdM} ratio={h.ratioMtd} basis={basis} />
      </div>
      <TrendArea points={restTrendDays(snapshot, tz)} />
    </section>
  );
}
