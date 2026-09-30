// src/components/DestinationStatement/DestinationStatement.tsx — one destination's monthly statement (P2-W25),
// opened from its name in "Where the money goes": this month against last (would have paid, paid, saved — from the
// running totals, totals.byOutputMonth), the volume now, the budget and its pace, where the data would go without
// Cribl, the prices that applied, when in the week it saves (core/heatmap.ts over the last 168 hours), and
// "Copy statement" in receipt form. A Capra Drawer like Show the math; its content is the keyboard stop.

import { Button, Drawer } from '@capra/core';
import { CopyOutlined } from '@capra/icons';
import type { Counterfactual, OutputMonthTotals } from '../../../core/types.ts';
import type { Heatmap as HeatmapData } from '../../../core/heatmap.ts';
import { footedMonth, type MoneyTripleM } from '../../views/Receipt/model.ts';
import { t } from '../../copy/en.ts';
import { copyText } from '../../lib/dom.ts';
import { formatBytes, formatMoney, formatPct } from '../../lib/format.ts';
import { notify } from '../common/notify.tsx';
import { Heatmap } from '../Heatmap/Heatmap.tsx';
import { formatPricePerGb } from '../WhereMoneyGoes/price.ts';
import { statementText } from './text.ts';
import './DestinationStatement.css';

export interface StatementDestination {
  groupId: string;
  outputId: string;
  label: string;
  type: string;
  presetLabel?: string;
  paidMcPerGb: number;
  counterfactual: Counterfactual;
  counterfactualLabel?: string;
  inBPerDay: number;
  outBPerDay: number;
  /** Month to date from the snapshot (the fallback for this month when the totals can't be read). */
  mtdWhpM?: number;
  mtdPaidM?: number;
  mtdSavedM?: number;
  unpriced: boolean;
}

export interface StatementPrice {
  effectiveFromMs: number;
  mcPerGb: number;
  committedMcPerGb?: number;
  presetLabel?: string;
}

export interface StatementHistory {
  status: 'loading' | 'ready' | 'sample' | 'error';
  thisMonth?: OutputMonthTotals;
  lastMonth?: OutputMonthTotals;
  heatmap?: HeatmapData;
}

export interface DestinationStatementProps {
  isOpen: boolean;
  onClose: () => void;
  destination: StatementDestination;
  /** Month names for the two columns ("September", "August"). */
  months: [string, string];
  budget?: { centsPerMonth: number; projectedM: number; pct: number };
  prices: StatementPrice[];
  history: StatementHistory;
  /**
   * Founder-build r2 ui-8 (FINDINGS_R2 #9): this destination's month to date as Show the math prints it
   * (footedMtdRows), so the statement never reads a dollar apart from the drawer.
   */
  footedThisMonth?: MoneyTripleM;
  tz: string;
}

const DATE_FMT = (tz: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });

function counterfactualWords(d: StatementDestination): string {
  if (d.counterfactual.kind === 'none') return t('receiptView.math.counterfactualNone');
  if (d.counterfactual.kind === 'other') return t('receiptView.math.counterfactualOther', { target: d.counterfactualLabel ?? d.counterfactual.outputId });
  return t('receiptView.math.counterfactualSame');
}

function StatementBody(props: DestinationStatementProps) {
  const { destination: d, months, budget, prices, history, footedThisMonth, tz } = props;
  // This month: the running totals when read, else the Receipt's own month to date (sample data, a failed read).
  const fromSnapshot: OutputMonthTotals | undefined =
    d.mtdWhpM !== undefined || d.mtdPaidM !== undefined ? { whpM: d.mtdWhpM ?? 0, paidM: d.mtdPaidM ?? 0, savedM: d.mtdSavedM ?? 0 } : undefined;
  const thisMonth = history.status === 'ready' ? (history.thisMonth ?? fromSnapshot) : fromSnapshot;
  const lastMonth = history.status === 'ready' ? history.lastMonth : undefined;
  const rows: [string, keyof OutputMonthTotals][] = [
    [t('receiptView.statement.whp'), 'whpM'],
    [t('receiptView.statement.paid'), 'paidM'],
    [t('receiptView.statement.saved'), 'savedM'],
  ];
  // Printed money adds up: would have paid − paid = saved in whole dollars (core/format footMoney, review W2); the
  // snapshot's own month reads exactly as Show the math prints it (r2 ui-8, footedMonth).
  const footed = (m: OutputMonthTotals | undefined): OutputMonthTotals | undefined => footedMonth(m, fromSnapshot, footedThisMonth);
  const cell = (m: OutputMonthTotals | undefined, k: keyof OutputMonthTotals) => {
    const f = footed(m);
    return f ? formatMoney(f[k]) : t('receiptView.statement.noMonth');
  };
  const budgetLine = budget
    ? t('receiptView.statement.budget', { budget: formatMoney(budget.centsPerMonth * 1000), projected: formatMoney(budget.projectedM), pct: formatPct(budget.pct / 100) })
    : undefined;
  const fmt = DATE_FMT(tz);

  const onCopy = async () => {
    const text = statementText({
      title: t('receiptView.statement.textTitle'),
      destination: d.label,
      months,
      rows: rows.map(([label, k]) => [label, footed(thisMonth)?.[k], footed(lastMonth)?.[k]]),
      notes: [
        ...(budget ? [t('receiptView.statement.textBudget', { budget: formatMoney(budget.centsPerMonth * 1000), projected: formatMoney(budget.projectedM) })] : []),
        ...(d.unpriced ? [] : [t('receiptView.statement.textPrice', { price: formatPricePerGb(d.paidMcPerGb) })]),
        counterfactualWords(d),
      ],
    });
    if (await copyText(text)) notify.success(t('receiptView.statement.copied'));
    else notify.error(t('receiptView.statement.copyFailed'));
  };

  return (
    <div
      className="mr-stmt"
      data-testid="statement"
      data-output={d.outputId}
      tabIndex={0}
      role="region"
      aria-label={t('receiptView.statement.regionLabel', { label: d.label })}
    >
      {!d.unpriced ? (
        <p className="mr-stmt-sub">{t('receiptView.statement.subtitle', { type: d.presetLabel ?? d.type, price: formatPricePerGb(d.paidMcPerGb) })}</p>
      ) : null}

      <section className="mr-stmt-section">
        <h3 className="mr-stmt-title">{t('receiptView.statement.monthsTitle')}</h3>
        <table className="mr-stmt-table" data-testid="statement-months">
          <thead>
            <tr>
              <th scope="col" className="mr-visually-hidden">
                {t('receiptView.statement.colItem')}
              </th>
              <th scope="col" data-testid="statement-this-head">
                {months[0]}
              </th>
              <th scope="col">{months[1]}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, k]) => (
              <tr key={k} data-row={k}>
                <th scope="row">
                  <span className="mr-stmt-rowlabel">{label}</span>
                  <span className="mr-stmt-leader" aria-hidden="true" />
                </th>
                <td className={`mr-num${k === 'savedM' && thisMonth ? ' mr-saved' : ''}`} data-col="this">
                  {cell(thisMonth, k)}
                </td>
                <td className={`mr-num${k === 'savedM' && lastMonth ? ' mr-saved' : ''}`} data-col="last">
                  {history.status === 'loading' ? <span className="mr-skel mr-stmt-skel" /> : cell(lastMonth, k)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mr-stmt-note">
          {history.status === 'sample'
            ? t('receiptView.statement.monthsSample')
            : history.status === 'error'
              ? t('receiptView.statement.monthsFailed')
              : t('receiptView.statement.monthsNote')}
        </p>
        <p className="mr-stmt-note">{t('receiptView.statement.now', { volumeIn: formatBytes(d.inBPerDay), volumeOut: formatBytes(d.outBPerDay) })}</p>
      </section>

      <section className="mr-stmt-section">
        <h3 className="mr-stmt-title">{t('receiptView.statement.budgetTitle')}</h3>
        <p className="mr-stmt-body" data-testid="statement-budget">
          {budgetLine ?? t('receiptView.statement.budgetNone')}
        </p>
        {budget ? (
          <div className="mr-stmt-budget" aria-hidden="true">
            <span className="mr-stmt-budget-fill" data-over={budget.pct >= 100 ? 'true' : undefined} style={{ width: `${Math.min(100, Math.max(0, budget.pct))}%` }} />
          </div>
        ) : null}
      </section>

      <section className="mr-stmt-section">
        <h3 className="mr-stmt-title">{t('receiptView.statement.pricesTitle')}</h3>
        {/* What the data would have cost without Cribl is a pricing fact: it sits with the prices, not the budget. */}
        <p className="mr-stmt-body" data-testid="statement-counterfactual">
          {counterfactualWords(d)}
        </p>
        {prices.length === 0 ? (
          <p className="mr-stmt-body">{t('receiptView.statement.priceNone')}</p>
        ) : (
          <ol className="mr-stmt-prices">
            {prices.map((p) => (
              <li key={p.effectiveFromMs}>
                <span className="mr-stmt-price-from">{t('receiptView.statement.priceFrom', { date: fmt.format(new Date(p.effectiveFromMs)) })}</span>
                <span className="mr-num mr-stmt-price">{t('receiptView.destinations.pricePerGb', { price: formatPricePerGb(p.mcPerGb) })}</span>
                {p.presetLabel ? <span className="mr-stmt-price-preset">{t('receiptView.destinations.pricedAs', { preset: p.presetLabel })}</span> : null}
                {p.committedMcPerGb !== undefined ? (
                  <span className="mr-stmt-price-preset">{t('receiptView.statement.priceCommitted', { price: formatPricePerGb(p.committedMcPerGb) })}</span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="mr-stmt-section">
        <h3 className="mr-stmt-title">{t('receiptView.statement.heatTitle')}</h3>
        {history.status === 'sample' && !history.heatmap ? (
          <p className="mr-stmt-body">{t('receiptView.statement.heatSample')}</p>
        ) : history.status === 'loading' ? (
          <p className="mr-stmt-body">{t('receiptView.statement.heatLoading')}</p>
        ) : history.status === 'error' || !history.heatmap ? (
          <p className="mr-stmt-body">{t('receiptView.statement.heatFailed')}</p>
        ) : history.heatmap.totalSavedM <= 0 ? (
          <p className="mr-stmt-body">{t('receiptView.statement.heatEmpty')}</p>
        ) : (
          <Heatmap data={history.heatmap} label={d.label} />
        )}
      </section>

      <div className="mr-stmt-actions">
        <Button variant="secondary" size="sm" leadingIcon={CopyOutlined} onPress={() => void onCopy()}>
          {t('receiptView.statement.copy')}
        </Button>
      </div>
    </div>
  );
}

export function DestinationStatement(props: DestinationStatementProps) {
  const { isOpen, onClose, destination } = props;
  return (
    <Drawer
      isOpen={isOpen}
      onClose={() => onClose()}
      title={t('receiptView.statement.title', { label: destination.label })}
      width={600}
      footer={
        <div className="mr-stmt-footer">
          <Button variant="secondary" onPress={onClose}>
            {t('receiptView.statement.close')}
          </Button>
        </div>
      }
    >
      <StatementBody {...props} />
    </Drawer>
  );
}
