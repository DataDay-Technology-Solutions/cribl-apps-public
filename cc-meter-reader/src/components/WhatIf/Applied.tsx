// src/components/WhatIf/Applied.tsx — the What-if after "Apply for real" (DESIGN_BRIEF 5.9 "Flip it on", P1-J03):
// the demo's payoff moment. The projection frozen at apply time stands next to what the sweeps measure:
//   • one line with the two ratios in the metric size — "Projected 33%, measured 34% after 3 min" — under a
//     running clock since the change;
//   • a before / projected / measured table (savings ratio, saved per day, sent per day) whose Measured column
//     fills in as sweeps arrive and follows every new one; it turns saved-green once the measured ratio beats
//     the one the stream ran before (a change that has not landed yet stays neutral, never a green 0%);
//   • the hero — the Receipt's own hero card (P2-W08, HeroShell.tsx), no PROJECTION pill — reads the workspace's
//     annualized run rate now, real, no longer a preview, with this stream's measured and projected yearly
//     change under it and today's receipt bar.
// The three columns are priced on the stream's current volume and price per byte (core/whatif.ts
// compareApplied), so they differ only by the ratio. Reached through ?applied= (demo build: Apply for real).

import type { ReactNode } from 'react';
import type { Projection } from '../../../core/whatif.ts';
import { t } from '../../copy/en.ts';
import { formatClock, formatMoney } from '../../lib/format.ts';
import { useNow } from '../../lib/ticker.ts';
import { ReceiptBar } from '../ReceiptBar/ReceiptBar.tsx';
import { Fig, Rich } from './Fig.tsx';
import { HeroShell } from './HeroShell.tsx';
import { bytesFigure, moneyFigure, pctFigure, type Figure } from './figures.ts';
import { useTweened } from './useTween.ts';
import type { WhatIfModel } from './useWhatIf.ts';

const lerpMoney = (a: number, b: number, p: number): number => (p >= 1 ? b : Math.round(a + (b - a) * p));

interface RowProps {
  id: string;
  label: string;
  before: Figure | null;
  projected: Figure;
  measured: Figure | null;
  saves: boolean;
}

function Row({ id, label, before, projected, measured, saves }: RowProps) {
  const dash = <span className="mr-whatif-applied-none">{t('common.dash')}</span>;
  return (
    <tr data-row={id}>
      <th scope="row">{label}</th>
      <td>{before ? <Fig f={before} /> : dash}</td>
      <td>
        <Fig f={projected} />
      </td>
      <td className="is-measured" data-testid={`whatif-measured-${id}`} data-state={measured ? 'measured' : 'waiting'} data-tone={measured && saves ? 'saved' : 'neutral'}>
        {measured ? (
          <Fig f={measured} />
        ) : (
          <span className="mr-whatif-applied-waiting">
            <span aria-hidden="true">{t('whatif.compare.measuring')}</span>
            <span className="mr-visually-hidden">{t('whatif.compare.measuringAria')}</span>
          </span>
        )}
      </td>
    </tr>
  );
}

const one = (get: (p: Projection) => number, fmt: (lo: number, hi: number) => Figure) => (p: Projection | null) => (p ? fmt(get(p), get(p)) : null);

export function AppliedResults({ model }: { model: WhatIfModel }) {
  const now = useNow();
  const a = model.applied;
  const m = model.measured;
  const appliedAt = model.appliedAt ?? now;
  const clock = formatClock(Math.max(0, Math.floor((now - appliedAt) / 1000)));
  const live = useTweened(model.liveAnnualizedM ?? 0, lerpMoney);

  if (!a) {
    return (
      <p className="mr-whatif-actual" data-testid="whatif-actual" data-state="waiting" aria-live="polite">
        {t('whatif.waitingForSweep')}
      </p>
    );
  }

  const lo = a.projectedLow;
  const hi = a.projectedHigh;
  const span = (get: (p: Projection) => number): [number, number] => {
    const x = get(lo);
    const y = get(hi);
    return x <= y ? [x, y] : [y, x];
  };
  const saves = a.measuredSaves;
  const pct = one((p) => p.ratio, pctFigure);
  const money = one((p) => p.savedPerDayM, moneyFigure);
  const bytes = one((p) => p.outBPerDay, bytesFigure);
  const projectedRatio = pctFigure(...span((p) => p.ratio));
  const figure = (f: Figure, testId: string, tone?: 'saved' | 'neutral'): ReactNode => (
    <Fig f={f} className={`mr-whatif-actual-fig${tone === 'saved' ? ' mr-whatif-actual-fig--saved' : ''}`} testId={testId} />
  );

  return (
    <div className="mr-whatif-applied" data-testid="whatif-applied" data-measured={m ? 'true' : 'false'}>
      <div className="mr-whatif-applied-main">
        <div className="mr-whatif-applied-head">
          <h3 className="mr-whatif-subhead">{t('whatif.applied.title')}</h3>
          <span className="mr-whatif-applied-clock mr-num" data-testid="whatif-applied-clock">
            {t('whatif.applied.clock', { clock })}
          </span>
        </div>
        <p className="mr-whatif-actual" data-testid="whatif-actual" data-state={m ? 'measured' : 'waiting'} aria-live="polite">
          {m ? (
            <Rich
              template={t('whatif.projectedVsActual')}
              parts={{
                projected: figure(projectedRatio, 'whatif-actual-projected'),
                measured: figure(pctFigure(m.ratio, m.ratio), 'whatif-actual-measured', saves ? 'saved' : 'neutral'),
                minutes: String(m.minutes),
              }}
            />
          ) : (
            t('whatif.waitingForSweep')
          )}
        </p>
        <table className="mr-whatif-applied-table" data-testid="whatif-applied-table">
          <thead>
            <tr>
              <td />
              <th scope="col">{t('whatif.compare.before')}</th>
              <th scope="col">{t('whatif.compare.projected')}</th>
              <th scope="col" className="is-measured">
                {t('whatif.compare.measured')}
              </th>
            </tr>
          </thead>
          <tbody>
            <Row id="ratio" label={t('whatif.compare.ratio')} before={pct(a.before)} projected={projectedRatio} measured={pct(a.measured)} saves={saves} />
            <Row id="saved-day" label={t('whatif.compare.savedDay')} before={money(a.before)} projected={moneyFigure(...span((p) => p.savedPerDayM))} measured={money(a.measured)} saves={saves} />
            <Row id="volume" label={t('whatif.compare.volume')} before={bytes(a.before)} projected={bytesFigure(...span((p) => p.outBPerDay))} measured={bytes(a.measured)} saves={saves} />
          </tbody>
        </table>
        <p className="mr-whatif-note">{t('whatif.applied.basis')}</p>
      </div>
      <HeroShell
        variant="live"
        testId="whatif-applied-hero"
        label={t('whatif.applied.heroLabel')}
        {...(model.liveAnnualizedM !== null ? { figure: formatMoney(live) } : {})}
        caption={
          <>
            <span className="mr-whatif-hero-line">{t('whatif.applied.heroCaption')}</span>{' '}
            {a.measuredDeltaPerYearM !== null ? (
              <span className="mr-whatif-hero-line" data-testid="whatif-applied-measured-year">
                {t('whatif.applied.streamMeasured', { delta: formatMoney(a.measuredDeltaPerYearM, { signed: true }) })}
              </span>
            ) : null}{' '}
            {a.projectedDeltaPerYearM !== null ? (
              <span className="mr-whatif-hero-line mr-whatif-hero-from">{t('whatif.applied.streamProjected', { delta: formatMoney(a.projectedDeltaPerYearM, { signed: true }) })}</span>
            ) : null}
          </>
        }
        bar={model.heroBar ? <ReceiptBar whpM={model.heroBar.whpM} paidM={model.heroBar.paidM} savedM={model.heroBar.savedM} ratio={model.heroBar.whpM > 0 ? model.heroBar.savedM / model.heroBar.whpM : 0} /> : undefined}
      />
    </div>
  );
}
