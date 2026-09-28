// src/components/ReceiptBar/ReceiptBar.tsx — the receipt bar under the hero (DESIGN_BRIEF 5.1):
// one full-width bar whose whole length is what you would have paid, split into what you paid (grey)
// and what Cribl saved (green); a bracket over the bar labels the whole length.
//
//   ┌──────────────── You would have paid $68,412 ─────────────┐
//   ████████████ paid ████████ ▕ ▨▨▨▨▨▨▨▨▨▨▨ saved ▨▨▨▨▨▨▨▨▨▨▨▨
//
// The segments sit a card-coloured gap apart and saved carries a faint hatch, so the bar reads as two parts
// without its hues (deuteranopia, a washed-out projector); under forced colours both keep their fills and gain
// an outline (P1-H05).
//   You paid $27,181                                  60% saved
//   ───────────────────────────────────────────────────────────── (optional, when a Cribl cost is set)
//   Net after Cribl $33,230  [Paid for itself 4.2×]   Cribl cost $10,450, prorated to the 25.4 days metered
//
// The net line is the receipt's total line: its own row under a hairline, the net at the size of a card
// figure, the payback as a chip, and what the cost covers on the right (core/net.ts, DECISIONS D48).
//
// Callout ids (DESIGN_BRIEF §8): `whp` on the bar, `paid` on the paid segment.
//
// Projection (P2-W08, the What-if hero): the caller passes the projected paid / saved and `projection.deltaM`,
// the part of the saved segment the change would add; that part is drawn hatched and dashed at the end of the
// green ("would save"), the paid label reads "You would pay", and a third legend item names the change.

import { Link } from '@capra/core';
import { footMoney } from '../../../core/format.ts';
import { t } from '../../copy/en.ts';
import { formatMoney, formatMultiple, formatPct } from '../../lib/format.ts';
import { Money } from '../common/Figures.tsx';
import { paidShare, slot } from './slot.tsx';
import './ReceiptBar.css';

export interface ReceiptBarNet {
  /** Net after Cribl, millicents (may be negative). */
  netM: number;
  paybackX?: number;
  /** '/ year' suffix for the run rate. */
  per?: 'year';
  /** The payback in words ("Paid for itself 4.2×", "Covered 40% of its cost"); defaults to the multiple. */
  paybackText?: string;
  /** What the Cribl cost covers: "Cribl cost $10,450, prorated to the 25.4 days metered". */
  basis?: string;
  /**
   * No Cribl cost is set: these figures are an estimate at Cribl's list price (usefulness review, round 2). The line
   * says so ("≈", "Estimate at Cribl's list price: …") and links to where the contract cost is entered.
   */
  estimate?: { href: string };
}

export interface ReceiptBarProps {
  whpM: number;
  paidM: number;
  savedM: number;
  /** saved ÷ would have paid, [0, 1] */
  ratio: number;
  net?: ReceiptBarNet | null;
  /**
   * What the percentage is a share of ("of dollars, month to date"): the hover on "60% saved" and its
   * visually hidden suffix, so it can't be read as the Ledger's byte reduction. Omitted on a bare bar.
   */
  basis?: string;
  /** Show the bar without motion (first paint, reduced motion is handled in CSS). */
  className?: string;
  /**
   * P1-F02: of `savedM`, the diversion credit (data credited at another destination's price); the saved segment
   * splits into bytes dropped (solid) and diversion (hatched), with a legend line. Omitted or 0: one saved segment.
   */
  divertedM?: number;
  /**
   * Keep the split line's row when there is no split to show (another period of a workspace with diversion credits
   * this month), so the hero keeps one height as the periods toggle (P1-F12).
   */
  reserveSplit?: boolean;
  /** P2-W08: a projection — `deltaM` of `savedM` is what the change would add (drawn hatched). */
  projection?: { deltaM: number };
}

/** The receipt's total line: net after Cribl, the payback chip, and what the cost covers. */
function NetLine({ net }: { net: ReceiptBarNet }) {
  const payback =
    net.paybackText ?? (net.paybackX !== undefined && Number.isFinite(net.paybackX) ? t('receipt.payback', { multiple: formatMultiple(net.paybackX) }) : undefined);
  return (
    <div className="mr-rbar-net" data-testid="receipt-net" data-sign={net.netM < 0 ? 'negative' : 'positive'} data-estimate={net.estimate ? 'true' : undefined}>
      <p className="mr-rbar-net-main">
        {slot(net.estimate ? t(net.per === 'year' ? 'receiptView.estimate.netPerYear' : 'receiptView.estimate.net') : net.per === 'year' ? t('receiptView.netPerYear') : t('receipt.net'), {
          amount: <Money value={net.netM} className="mr-rbar-net-amount" />,
        })}
      </p>
      {payback ? (
        <p className="mr-rbar-net-payback" data-full={net.paybackX !== undefined && net.paybackX >= 1 ? 'true' : 'false'}>
          <span className="mr-rbar-sep mr-visually-hidden">{' · '}</span>
          <span className="mr-num">{payback}</span>
        </p>
      ) : null}
      {net.basis ? (
        <p className="mr-rbar-net-basis" data-testid="receipt-net-basis">
          <span className="mr-rbar-sep mr-visually-hidden">{' · '}</span>
          {net.basis}
          {net.estimate ? (
            <>
              {' '}
              <Link href={net.estimate.href} data-testid="receipt-net-estimate-link">
                {t('receiptView.estimate.link')}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** P1-F02: "By reduction $X · by diversion $Y" — bytes dropped (solid swatch) and the diversion credit (hatched). */
function SplitLine({ reducedM, divertedM, reserved }: { reducedM: number; divertedM: number; reserved?: boolean }) {
  return (
    <p
      className={['mr-rbar-split', reserved ? 'mr-rbar-split--reserved' : ''].filter(Boolean).join(' ')}
      data-testid={reserved ? undefined : 'receipt-split'}
      title={reserved ? undefined : t('receipt.splitHint')}
      aria-hidden={reserved ? true : undefined}
    >
      {slot(t('receipt.split'), {
        reduced: (
          <span className="mr-rbar-split-part">
            <span className="mr-rbar-swatch mr-rbar-swatch--saved" aria-hidden="true" />
            <Money value={reducedM} className="mr-rbar-amount" />
          </span>
        ),
        diverted: (
          <span className="mr-rbar-split-part">
            <span className="mr-rbar-swatch mr-rbar-swatch--diverted" aria-hidden="true" />
            <Money value={divertedM} className="mr-rbar-amount" />
          </span>
        ),
      })}
    </p>
  );
}

export function ReceiptBar({ whpM, paidM, savedM, ratio, net, basis, className, divertedM, reserveSplit, projection }: ReceiptBarProps) {
  const share = paidShare(whpM, paidM);
  const empty = !(whpM > 0);
  const diverted = savedM > 0 && divertedM !== undefined && divertedM > 0 ? Math.min(divertedM, savedM) : 0;
  const divertedShare = diverted > 0 ? diverted / savedM : 0;
  // P2-W08: the projected part of the green, within what is saved (never more than the saved segment itself).
  const addM = projection && !empty ? Math.max(0, Math.min(projection.deltaM, savedM)) : 0;
  const addShare = empty ? 0 : Math.min(1 - share, addM / whpM);
  const savedShare = empty ? 0 : 1 - share - addShare;
  // Printed money adds up (core/format.ts footMoney): the legends print would have paid and paid so that their
  // difference is the saved the Meter and the Report card print, to the dollar ($1,503,380 − $958,406 = $544,974,
  // never You paid $958,407 beside it). The segments' lengths stay the exact figures.
  const shown = footMoney({ whpM, paidM, savedM });
  const label = projection
    ? t('receiptView.projection.barLabel', { whp: formatMoney(shown.whpM), paid: formatMoney(shown.paidM), saved: formatMoney(shown.savedM), delta: formatMoney(addM) })
    : t('receiptView.barLabel', { whp: formatMoney(shown.whpM), paid: formatMoney(shown.paidM), saved: formatMoney(shown.savedM) });
  // The split's two parts add up to the printed saved the same way (reduction = saved − diversion, as printed).
  const split = diverted > 0 ? footMoney({ whpM: savedM, paidM: savedM - diverted, savedM: diverted }) : undefined;
  return (
    <div className={['mr-rbar', projection ? 'mr-rbar--projection' : '', className].filter(Boolean).join(' ')} data-empty={empty ? 'true' : 'false'}>
      {/* A dimension line over the bar (P1-H05): end ticks down to the bar's ends, the label centred on the line. */}
      <p className="mr-rbar-whp">
        <span className="mr-rbar-whp-text">{slot(t('receipt.wouldHavePaid'), { amount: <Money value={shown.whpM} className="mr-rbar-amount" /> })}</span>
      </p>
      <div className="mr-rbar-track" data-callout="whp" role="img" aria-label={label}>
        <div className="mr-rbar-paid" data-callout="paid" style={{ flexGrow: share }} />
        <div className="mr-rbar-saved" style={{ flexGrow: savedShare * (1 - divertedShare) }} />
        {diverted > 0 ? <div className="mr-rbar-saved mr-rbar-saved--diverted" data-testid="receipt-bar-diverted" style={{ flexGrow: savedShare * divertedShare }} /> : null}
        {projection ? (
          <div className="mr-rbar-projected" style={{ flexGrow: addShare }} data-testid="rbar-projected" data-share={addShare.toFixed(4)} />
        ) : null}
      </div>
      <div className="mr-rbar-legend">
        <p className="mr-rbar-legend-paid">
          <span className="mr-rbar-swatch mr-rbar-swatch--paid" aria-hidden="true" />
          {slot(projection ? t('receiptView.projection.paid') : t('receipt.paid'), { amount: <Money value={shown.paidM} className="mr-rbar-amount" /> })}
        </p>
        {projection && addM > 0 ? (
          <p className="mr-rbar-legend-projected" data-testid="rbar-projected-legend">
            <span className="mr-rbar-swatch mr-rbar-swatch--projected" aria-hidden="true" />
            {slot(t('receiptView.projection.delta'), { amount: <span className="mr-rbar-amount mr-num">{formatMoney(addM, { signed: true })}</span> })}
          </p>
        ) : null}
        <p className="mr-rbar-legend-saved" title={basis} data-testid="receipt-saved-pct">
          <span className="mr-rbar-swatch mr-rbar-swatch--saved" aria-hidden="true" />
          <span className="mr-rbar-amount mr-num mr-saved">{t('receipt.savedPct', { pct: formatPct(ratio) })}</span>
          {basis ? <span className="mr-visually-hidden">{` ${basis}`}</span> : null}
        </p>
      </div>
      {split ? (
        <SplitLine reducedM={split.paidM} divertedM={split.savedM} />
      ) : reserveSplit ? (
        // The same line, invisible: the hero keeps one height as the periods toggle (P1-F12).
        <SplitLine reducedM={0} divertedM={0} reserved />
      ) : null}
      {net ? <NetLine net={net} /> : null}
    </div>
  );
}
