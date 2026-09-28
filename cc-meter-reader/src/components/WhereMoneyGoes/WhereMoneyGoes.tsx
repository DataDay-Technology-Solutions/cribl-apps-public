// src/components/WhereMoneyGoes/WhereMoneyGoes.tsx — one horizontal stacked bar per destination: paid grey +
// saved green, sharing one scale (the heaviest destination's would-have-paid is the full width), the paid
// $/day at the end, and chips for the counterfactual and unpriced destinations (DESIGN_BRIEF 5.1 row 3).
//
// A small dot in the destination's own hue tells the rows apart (the destination ramp is the only categorical
// colour on the page, PRD 8.8 item 3). Since D55 the Flow view draws destinations in ink and sources in their own
// hues, so the dot keys this list and the price tiles only; the ramp shares no token with the source hues, and a
// seventh destination and beyond take one neutral instead of repeating a hue.

import type { ReactNode } from 'react';
import { Link, Pill } from '@capra/core';
import type { Counterfactual } from '../../../core/types.ts';
import { t } from '../../copy/en.ts';
import { formatMoney } from '../../lib/format.ts';
import { destinationColorVar } from '../../theme/palette.ts';
import { Money } from '../common/Figures.tsx';
import { slot } from '../ReceiptBar/slot.tsx';
import { formatPricePerGb } from './price.ts';
import './WhereMoneyGoes.css';

export interface MoneyDestination {
  key: string;
  outputId: string;
  label: string;
  type: string;
  whpPerDayM: number;
  paidPerDayM: number;
  savedPerDayM: number;
  /** this destination's price, millicents per GB */
  paidMcPerGb: number;
  /** the counterfactual destination's price, millicents per GB (P2-W25: the hatched ghost) */
  whpMcPerGb?: number;
  counterfactual: Counterfactual;
  counterfactualLabel?: string;
  /** The preset the price came from ("Splunk Cloud"): shown as "priced as …" in place of the output type. */
  presetLabel?: string;
  unpriced: boolean;
  /** saved ÷ would have paid */
  ratio: number;
}

export interface WhereMoneyGoesProps {
  rows: MoneyDestination[];
  /** In-app href of the Prices settings page (for unpriced rows). */
  pricesHref?: string;
  /** Shown when there are no rows. */
  empty?: ReactNode;
  /** Opens a destination's statement (P2-W25): the name becomes a button. */
  onOpen?: (key: string) => void;
  /**
   * Every destination id of the workspace (the snapshot's), the list the Flow colours its ribbons and legend by, so
   * a destination's dot here is its ribbon's colour there (review W2). Defaults to the rows' own ids.
   */
  colorIds?: readonly string[];
}

/**
 * The part of would-have-paid that exists only because, without Cribl, the bytes would have gone to a dearer
 * destination (P2-W25): bytes in × (its price − this one's) = whp × (1 − own ÷ counterfactual). Zero unless the
 * counterfactual is another destination with a higher price.
 */
function counterfactualGhostM(r: Pick<MoneyDestination, 'counterfactual' | 'whpPerDayM' | 'paidMcPerGb' | 'whpMcPerGb'>): number {
  if (r.counterfactual.kind !== 'other' || !r.whpMcPerGb || !(r.whpMcPerGb > r.paidMcPerGb) || !(r.whpPerDayM > 0)) return 0;
  return Math.round(r.whpPerDayM * (1 - r.paidMcPerGb / r.whpMcPerGb));
}

function CounterfactualChip({ cf, label }: { cf: Counterfactual; label?: string }) {
  if (cf.kind === 'same') return null;
  const text = cf.kind === 'none' ? t('receiptView.destinations.withoutCriblNowhere') : t('receiptView.destinations.withoutCribl', { target: label ?? cf.outputId });
  return (
    <span className="mr-wmg-chip" data-chip="counterfactual">
      {cf.kind === 'other' ? <span className="mr-wmg-ghost-swatch" aria-hidden="true" /> : null}
      <Pill appearance="default">{text}</Pill>
    </span>
  );
}

export function WhereMoneyGoes({ rows, pricesHref = '/settings/prices', empty, onOpen, colorIds }: WhereMoneyGoesProps) {
  if (rows.length === 0) return <>{empty ?? null}</>;
  const max = Math.max(1, ...rows.map((r) => Math.max(r.whpPerDayM, r.paidPerDayM)));
  const ids = colorIds && colorIds.length > 0 ? colorIds : rows.map((r) => r.outputId);
  // past six destinations the six that would have cost the most keep the hues; the rest share one neutral
  const weight = new Map(rows.map((r) => [r.outputId, r.whpPerDayM]));
  const weightOf = (id: string): number => weight.get(id) ?? 0;
  return (
    <ul className="mr-wmg" data-testid="where-money-goes">
      {rows.map((r) => {
        const whole = Math.max(r.whpPerDayM, r.paidPerDayM);
        const lengthPct = r.unpriced ? 0 : (whole / max) * 100;
        const paidPct = whole > 0 ? (Math.min(r.paidPerDayM, whole) / whole) * 100 : 0;
        const ghostM = counterfactualGhostM(r);
        const ghostPct = whole > 0 ? (Math.min(ghostM, Math.max(0, whole - r.paidPerDayM)) / whole) * 100 : 0;
        return (
          <li
            key={r.key}
            className="mr-wmg-row"
            data-unpriced={r.unpriced ? 'true' : 'false'}
            aria-label={t('receiptView.destinations.rowLabel', {
              label: r.label,
              paid: formatMoney(r.paidPerDayM),
              saved: formatMoney(r.savedPerDayM),
            })}
          >
            <div className="mr-wmg-head">
              <span className="mr-wmg-dot" style={{ background: destinationColorVar(r.outputId, ids, weightOf) }} aria-hidden="true" />
              {onOpen ? (
                <button
                  type="button"
                  className="mr-wmg-name mr-wmg-name--button mr-truncate"
                  title={r.outputId}
                  aria-label={t('receiptView.destinations.openStatement', { label: r.label })}
                  aria-haspopup="dialog"
                  onClick={() => onOpen(r.key)}
                  data-testid="open-statement"
                >
                  {r.label}
                </button>
              ) : (
                <span className="mr-wmg-name mr-truncate" title={r.outputId}>
                  {r.label}
                </span>
              )}
              <span className="mr-wmg-paid">
                {r.unpriced ? (
                  <Link href={pricesHref}>{t('receiptView.destinations.setPrice')}</Link>
                ) : (
                  // "paid $2,550 / day": the row's one figure says which figure it is (P1-H05).
                  slot(t('receiptView.destinations.paidHead'), { amount: <Money value={r.paidPerDayM} per="day" className="mr-wmg-paid-amount" /> })
                )}
              </span>
            </div>
            <div className="mr-wmg-track" aria-hidden="true">
              {r.unpriced ? null : (
                <div className="mr-wmg-bar" style={{ width: `${lengthPct}%` }}>
                  <div className="mr-wmg-bar-paid" style={{ width: `${paidPct}%` }} />
                  <div className="mr-wmg-bar-saved" />
                  {ghostPct > 0 ? (
                    <div
                      className="mr-wmg-bar-ghost"
                      data-testid="wmg-ghost"
                      style={{ width: `${ghostPct}%` }}
                      title={t('receiptView.destinations.ghostLabel', { target: r.counterfactualLabel ?? '' })}
                    />
                  ) : null}
                </div>
              )}
            </div>
            <div className="mr-wmg-meta">
              <span className="mr-wmg-caption">
                {/* "priced as Splunk Cloud" says why $2.25; the output type ("devnull") only says what it is. */}
                {!r.unpriced && r.presetLabel ? (
                  <span className="mr-wmg-type" data-basis="preset">
                    {t('receiptView.destinations.pricedAs', { preset: r.presetLabel })}
                  </span>
                ) : (
                  <span className="mr-wmg-type" data-basis="type">
                    {r.type}
                  </span>
                )}
                {!r.unpriced ? (
                  <>
                    <span className="mr-wmg-sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="mr-num">{t('receiptView.destinations.pricePerGb', { price: formatPricePerGb(r.paidMcPerGb) })}</span>
                    {r.savedPerDayM > 0 ? (
                      <>
                        <span className="mr-wmg-sep" aria-hidden="true">
                          ·
                        </span>
                        <span className="mr-num mr-saved mr-wmg-saved">
                          {t('receiptView.destinations.savedPerDay', { amount: formatMoney(r.savedPerDayM) })}
                        </span>
                      </>
                    ) : null}
                  </>
                ) : null}
              </span>
              <span className="mr-wmg-chips">
                <CounterfactualChip cf={r.counterfactual} label={r.counterfactualLabel} />
                {r.unpriced ? (
                  <span className="mr-wmg-chip" data-chip="unpriced">
                    {/* A setup state, not a severity: neutral (BEAUTY F10). */}
                    <Pill appearance="default" variant="outline">
                      {t('unpriced.badge')}
                    </Pill>
                  </span>
                ) : null}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
