// src/components/Shell/StageAnnouncer.tsx — the stage's polite live region (EPIC_AUDIT P1-A09).
//
// The hero on the stage ticks every frame, which a screen reader must never chase; instead this visually
// hidden status line says the figure in words when the stage opens and then every 30 s ("Saved by Cribl:
// $95,525, annualized run rate, from the last 5 days"), from the same figure and basis the stage shows.

import { useEffect, useState } from 'react';
import type { HeadlinePeriod } from '../../../core/types.ts';
import { fmtDollars } from '../../../core/format.ts';
import { t } from '../../copy/en.ts';
import { useAppParams } from '../../lib/params.ts';
import { useAppState, useStoreApi } from '../../state/react.tsx';
import { periodBasis } from '../../views/Presenter/basis.ts';
import { periodFigure } from '../../views/Presenter/heroValue.ts';

/** How often the stage's figure is read out. */
export const STAGE_ANNOUNCE_MS = 30_000;

export function StageAnnouncer() {
  const store = useStoreApi();
  const [params] = useAppParams();
  const settingsPeriod = useAppState((s) => s.settings.presenter?.headlinePeriod);
  const hasSnapshot = useAppState((s) => s.snapshot !== null);
  const period: HeadlinePeriod = params.period ?? settingsPeriod ?? 'annualized';
  const [text, setText] = useState('');

  useEffect(() => {
    if (!hasSnapshot) return;
    const read = () => {
      const snap = store.getState().snapshot;
      if (!snap) return;
      const figure = periodFigure(snap.headline, period);
      const since = Math.max(0, (Date.now() - Date.parse(snap.sweepAt)) / 1000);
      const valueM = figure.accrue && Number.isFinite(since) ? figure.valueM + snap.ratePerSecM * since : figure.valueM;
      setText(t('presenter.heroAnnounce', { amount: fmtDollars(valueM), period: periodBasis(period, snap.headline) }));
    };
    // The first read waits a beat, so the stage's own content is announced first.
    const first = window.setTimeout(read, 1_500);
    const timer = window.setInterval(read, STAGE_ANNOUNCE_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [store, period, hasSnapshot]);

  return (
    <span className="mr-visually-hidden" role="status" aria-live="polite" data-testid="stage-announcer">
      {text}
    </span>
  );
}
