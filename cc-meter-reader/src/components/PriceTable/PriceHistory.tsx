// src/components/PriceTable/PriceHistory.tsx — a destination's price history (EPIC_AUDIT P2-W24).
//
// Every change to one destination's price, newest first, receipt-style: when it took effect, the price, the preset
// (or Custom price) and who saved it (the version's changedBy, read from window.getCriblUser at save time).

import { memo } from 'react';
import { mcToDollarInput } from '../../../core/format.ts';
import type { PriceChange } from '../../../core/pricing.ts';
import { presetById } from '../../../core/presets.ts';
import { t } from '../../copy/en.ts';
import { formatDateTime } from '../../lib/format.ts';

export const PriceHistoryList = memo(function PriceHistoryList({ changes, tz, id }: { changes: readonly PriceChange[]; tz?: string; id: string }) {
  return (
    <ol className="mr-pt-history" id={id} data-testid="price-history">
      {changes.map((c) => (
        <li key={c.effectiveFrom} className="mr-pt-history-line">
          <span className="mr-pt-history-when">{formatDateTime(c.effectiveFrom, tz)}</span>
          <span className="mr-pt-receipt-leader" aria-hidden="true" />
          <span className="mr-pt-history-what mr-num">
            {`$${mcToDollarInput(c.entry.milliCentsPerGb)}`}
            <span aria-hidden="true">{' · '}</span>
            {presetById(c.entry.preset)?.label ?? t('settings.prices.customPreset')}
            {c.changedBy ? (
              <>
                <span aria-hidden="true">{' · '}</span>
                <span data-testid="price-history-by">{t('settings.prices.historyBy', { user: c.changedBy })}</span>
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
});
