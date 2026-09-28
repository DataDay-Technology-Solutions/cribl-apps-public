// src/components/PriceTable/LiveReceipt.tsx — the receipt motif inside Prices (EPIC_AUDIT P2-W09; DESIGN_BRIEF 1).
//
// Three pieces, all in the receipt's face (mono, dot leaders, the one green on the saved line):
//   • RowReceiptLine — under a row's fields: "412.0 GB/day × $2.25 ........ ~ $927 / day", the last sweep's
//     delivered traffic at the price being typed, with "was $1,012" while a stored price is being changed;
//   • ReceiptTotals — the card's receipt at the prices on screen: would have paid, paid, saved per day;
//   • PendingList — above the save bar while dirty: what Save will write, "siem-prod  $2.25 → $2.50".
// Figures come from ./receiptModel.ts (core pricing over the last snapshot); nothing here computes money.

import { memo } from 'react';
import { fmtBytes, mcToDollarInput } from '../../../core/format.ts';
import { t, tn } from '../../copy/en.ts';
import { formatMoney } from '../../lib/format.ts';
import type { DraftReceipt, PendingChange, RowReceipt } from './receiptModel.ts';

/** One dollar in millicents. */
const DOLLAR_M = 100_000;

/**
 * Whole dollars, as every other receipt list prints money (DESIGN_BRIEF §3: cents only on the session ticker and the
 * lost counter; review W2); a figure that rounds to nothing reads "< $1", never "$0".
 */
function money(m: number, exact: number = m): string {
  return exact > 0 && exact < DOLLAR_M / 2 && m < DOLLAR_M ? t('settings.prices.receiptUnderDollar') : formatMoney(m);
}

/** "~ $927" in the figure's weight, then " / day" as the secondary-text unit (DESIGN_BRIEF §3). `amount` is the
 *  printed (footed) figure; `exact` decides "< $1" for traffic that costs something but rounds to nothing. */
function PerDay({ amount, exact }: { amount: number; exact?: number }) {
  return (
    <>
      {t('settings.prices.receiptAmount', { amount: money(amount, exact) })}
      <span className="mr-pt-receipt-unit">{` ${t('units.perDay')}`}</span>
    </>
  );
}

export const RowReceiptLine = memo(function RowReceiptLine({ line, outputId }: { line: RowReceipt; outputId: string }) {
  return (
    <div className="mr-pt-receipt" data-testid={`price-receipt-${outputId}`}>
      <span className="mr-pt-receipt-what">
        {t('settings.prices.receiptLine', {
          volume: `${fmtBytes(line.outBPerDay)} ${t('units.perDay')}`,
          price: `$${mcToDollarInput(line.priceMc)}`,
        })}
      </span>
      <span className="mr-pt-receipt-leader" aria-hidden="true" />
      <span className="mr-pt-receipt-amount mr-num" data-testid={`price-receipt-amount-${outputId}`}>
        <PerDay amount={line.shownPaidPerDayM} exact={line.paidPerDayM} />
      </span>
      {line.wasPaidPerDayM !== undefined ? (
        <span className="mr-pt-receipt-was mr-num">
          {t('settings.prices.receiptWas', {
            amount: money(line.wasPaidPerDayM),
          })}
        </span>
      ) : null}
    </div>
  );
});

export function ReceiptTotals({ receipt }: { receipt: DraftReceipt }) {
  const { total, shown } = receipt;
  // The printed triple adds up to the dollar (receiptModel foots it), as the Receipt, the Flow map and the Ledger.
  const lines: {
    key: string;
    label: string;
    amount: number;
    exact: number;
    tone?: 'saved';
  }[] = [
    {
      key: 'whp',
      label: t('settings.prices.receiptWhp'),
      amount: shown.whpM,
      exact: total.whpPerDayM,
    },
    {
      key: 'paid',
      label: t('settings.prices.receiptPaid'),
      amount: shown.paidM,
      exact: total.paidPerDayM,
    },
    {
      key: 'saved',
      label: t('settings.prices.receiptSaved'),
      amount: shown.savedM,
      exact: total.savedPerDayM,
      tone: 'saved',
    },
  ];
  return (
    <section className="mr-pt-totals" aria-label={t('settings.prices.receiptTitle')} data-testid="prices-receipt">
      <header className="mr-pt-totals-head">
        <span className="mr-pt-totals-title">{t('settings.prices.receiptTitle')}</span>
        <span className="mr-pt-totals-basis">{tn('settings.prices.receiptBasis', total.destinations)}</span>
      </header>
      {lines.map((l) => (
        <p key={l.key} className="mr-pt-totals-line" data-tone={l.tone} data-testid={`prices-receipt-${l.key}`}>
          <span className="mr-pt-totals-label">{l.label}</span>
          <span className="mr-pt-receipt-leader" aria-hidden="true" />
          <span className="mr-pt-totals-amount mr-num">
            <PerDay amount={l.amount} exact={l.exact} />
          </span>
        </p>
      ))}
    </section>
  );
}

/** At most this many lines; the rest fold into "+ N more" so the sticky bar never covers the rows being edited. */
const PENDING_MAX = 4;
const PENDING_MAX_PHONE = 2;

export function PendingList({ changes, shortcut }: { changes: readonly PendingChange[]; shortcut?: string }) {
  if (changes.length === 0) return null;
  const shown = changes.slice(0, PENDING_MAX);
  const more = changes.length - shown.length;
  return (
    <div className="mr-pt-pending" data-testid="prices-pending">
      <p className="mr-pt-pending-head">
        <span>{t('settings.prices.diffTitle')}</span>
        {shortcut ? <kbd className="mr-pt-kbd">{t('settings.prices.saveShortcut', { keys: shortcut })}</kbd> : null}
      </p>
      <ul className="mr-pt-pending-list">
        {shown.map((c) => (
          <li key={c.key} className="mr-pt-pending-line" data-testid={`prices-pending-${c.key}`}>
            <span className="mr-pt-pending-name">{c.name}</span>
            <span className="mr-pt-receipt-leader" aria-hidden="true" />
            <span
              className="mr-pt-pending-diff mr-num"
              aria-label={
                c.before === c.after && c.detail
                  ? undefined
                  : t('settings.prices.diffAria', {
                      before: c.before,
                      after: c.after,
                    })
              }
            >
              {c.before === c.after && c.detail ? (
                c.detail
              ) : (
                <>
                  <span className="mr-pt-pending-before">{c.before}</span>
                  <span aria-hidden="true">{' → '}</span>
                  <span className="mr-pt-pending-after">{c.after}</span>
                </>
              )}
            </span>
          </li>
        ))}
        {more > 0 ? (
          <li className="mr-pt-pending-more" data-width="wide">
            {tn('settings.prices.diffMore', more)}
          </li>
        ) : null}
        {/* A phone shows two lines (PriceTable.css), so its count of the rest starts after the second. */}
        {changes.length > PENDING_MAX_PHONE ? (
          <li className="mr-pt-pending-more" data-width="phone">
            {tn('settings.prices.diffMore', changes.length - PENDING_MAX_PHONE)}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
