// src/views/Settings/SweepNowButton.tsx — "Sweep now" (SPEC 7, 13; PRD 8.4): at most once per 30 s,
// never on a timer. In the ui runtime it runs this tab's sweep; in the backend runtime it POSTs
// /endpoints/meter once (src/state/meterLoop.ts). Shows the result's calls and duration. In the ui runtime
// it stays off until prices exist: a sweep then would meter the seed hour at $0 for good (REVIEW-3a #3).

import { useState } from 'react';
import { Button } from '@capra/core';
import { t } from '../../copy/en.ts';
import { useNow } from '../../lib/ticker.ts';
import { shallowEqual, useAppState, useServices } from '../../state/react.tsx';
import type { SweepNowResult } from '../../state/meterLoop.ts';
import { pricesAbsent } from '../../state/selectors.ts';
import { sweepResultLine } from './hooks.ts';

export interface SweepNowButtonProps {
  variant?: 'primary' | 'secondary';
  /** Render the result line next to the button. */
  showResult?: boolean;
}

export function SweepNowButton({ variant = 'secondary', showResult = false }: SweepNowButtonProps) {
  const { meter } = useServices();
  const now = useNow();
  const view = useAppState(
    (s) => ({
      running: s.status.sweep.running,
      nextManualAt: s.status.sweep.nextManualAt,
      live: s.source === 'live',
      hydrated: s.hasHydrated,
      noPrices: s.hasHydrated && s.source === 'live' && s.settings.runtime === 'ui' && pricesAbsent(s),
    }),
    shallowEqual,
  );
  const [result, setResult] = useState<SweepNowResult | null>(null);
  const [pending, setPending] = useState(false);
  const waitMs = Math.max(0, view.nextManualAt - now);
  const disabled = !view.live || !view.hydrated || view.noPrices || pending || view.running || waitMs > 0;

  const run = async () => {
    setPending(true);
    try {
      setResult(await meter.sweepNow());
    } finally {
      setPending(false);
    }
  };

  const line = view.noPrices ? sweepResultLine({ status: 'blocked', reason: 'no-prices' }) : sweepResultLine(result);
  return (
    <div className="mr-sweep-now">
      <Button variant={variant} pending={pending || view.running} disabled={disabled} onPress={() => void run()}>
        {t('sweep.now')}
      </Button>
      {showResult ? (
        <span className="mr-sweep-now-status" aria-live="polite" data-testid="sweep-now-status">
          {waitMs > 0 && !pending ? (
            <span className="mr-set-muted mr-num">{t('settings.runtime.nextManual', { seconds: Math.ceil(waitMs / 1000) })}</span>
          ) : null}
          {line ? (
            <span className={`mr-sweep-now-line mr-num`} data-tone={line.tone}>
              {line.text}
            </span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
