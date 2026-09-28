// src/components/FlowDiagram/ReceiptCard.tsx — the ONE receipt card of the Flow map (PRD 8.2; DESIGN_BRIEF
// 5.3): In / Out / Would have paid / Paid / Saved / Now $/hour with its multiple of baseline, as itemized
// receipt lines with dot leaders in the mono face (DESIGN_BRIEF 1, "the receipt").

import { footMoney } from '../../../core/format.ts';
import { t } from '../../copy/en.ts';
import { formatBytes, formatMoney, formatMultiple, formatPct } from '../../lib/format.ts';
import type { NodeTotals } from './layout.ts';
import { baselineMultiple } from './selection.ts';

export interface ReceiptCardProps {
  /** What the card is about: a node name, a flow's source, or "All flows in default". */
  heading: string;
  /** 'Source' / 'Pipeline' / 'Destination' / flow count — a small eyebrow above the heading. */
  eyebrow?: string;
  /** Where the heading's bytes go next: pipeline → destination (each step drawn with a leading arrow). */
  path?: string[];
  /** A secondary line under the heading (hint, flow count). */
  caption?: string;
  totals: NodeTotals;
  projected?: boolean;
  pinned?: boolean;
  /** Deep link to the pipeline in the Cribl UI (opened with target _top). */
  link?: { href: string; label: string };
}

function Line({ label, value, unit, tone, callout, testId }: { label: string; value: string; unit?: string; tone?: 'saved'; callout?: string; testId?: string }) {
  return (
    <div className={`mr-receipt-line${tone ? ` mr-receipt-line--${tone}` : ''}`} data-testid={testId}>
      <dt className="mr-receipt-label">{label}</dt>
      <dd className="mr-receipt-value">
        <span className="mr-num" data-callout={callout}>
          {value}
        </span>
        {unit ? <span className="mr-receipt-unit">{unit}</span> : null}
      </dd>
    </div>
  );
}

export function ReceiptCard({ heading, eyebrow, path, caption, totals, projected, pinned, link }: ReceiptCardProps) {
  const perDay = t('units.perDay');
  const multiple = baselineMultiple(totals);
  const savedShare = totals.whpPerDayM > 0 ? totals.savedPerDayM / totals.whpPerDayM : 0;
  // The printed triple adds up to the dollar (core/format.ts footMoney), as every receipt in the App does.
  const shown = footMoney({ whpM: totals.whpPerDayM, paidM: totals.paidPerDayM, savedM: totals.savedPerDayM });
  const summary = [
    t('flow.hoverIn', { volume: formatBytes(totals.inBPerDay) }),
    t('flow.hoverOut', { volume: formatBytes(totals.outBPerDay) }),
    t('flow.hoverSaved', { amount: formatMoney(totals.savedPerDayM) }),
    multiple !== null ? t('flow.hoverNow', { amount: formatMoney(totals.ratePerHourM), multiple: formatMultiple(multiple) }) : '',
  ]
    .filter(Boolean)
    .join('. ');
  return (
    <section className={`mr-receipt${projected ? ' is-projected' : ''}`} aria-label={`${heading}. ${summary}`} data-testid="flow-receipt">
      <header className="mr-receipt-head">
        <div className="mr-receipt-eyebrow">
          <span>{eyebrow ?? t('flow.card.title')}</span>
          {projected ? <span className="mr-receipt-chip">{t('flow.card.projection')}</span> : null}
        </div>
        <h2 className="mr-receipt-title" title={heading}>
          {heading}
        </h2>
        {path && path.length > 0 ? (
          <p className="mr-receipt-path">
            {path.map((step, i) => (
              <span key={i} className="mr-receipt-step">
                <span className="mr-receipt-arrow" aria-hidden="true">
                  →
                </span>
                <span className="mr-truncate" title={step}>
                  {step}
                </span>
              </span>
            ))}
          </p>
        ) : null}
        {caption ? <p className="mr-receipt-caption">{caption}</p> : null}
      </header>

      <dl className="mr-receipt-lines">
        <Line label={t('flow.card.in')} value={formatBytes(totals.inBPerDay)} unit={perDay} testId="receipt-in" />
        <Line label={t('flow.card.out')} value={formatBytes(totals.outBPerDay)} unit={perDay} testId="receipt-out" />
        <div className="mr-receipt-rule" aria-hidden="true" />
        <Line label={t('flow.card.whp')} value={formatMoney(shown.whpM)} unit={perDay} callout="whp" testId="receipt-whp" />
        <Line label={t('flow.card.paid')} value={formatMoney(shown.paidM)} unit={perDay} callout="paid" testId="receipt-paid" />
        <Line label={t('flow.card.saved')} value={formatMoney(shown.savedM)} unit={perDay} tone="saved" callout="saved" testId="receipt-saved" />
        <div className="mr-receipt-rule" aria-hidden="true" />
        <Line label={t('flow.card.now')} value={formatMoney(totals.ratePerHourM)} unit={t('units.perHour')} testId="receipt-now" />
      </dl>

      <p className="mr-receipt-foot">
        <span className="mr-num">{t('flow.card.savedPct', { pct: formatPct(savedShare) })}</span>
        {multiple !== null && !projected ? (
          <>
            <span className="mr-receipt-sep" aria-hidden="true">
              ·
            </span>
            <span className="mr-num">{t('flow.card.baseline', { multiple: formatMultiple(multiple) })}</span>
          </>
        ) : null}
      </p>

      {pinned ? <p className="mr-receipt-pinned">{t('flow.card.pinned')}</p> : null}
      {link ? (
        <a className="mr-receipt-link" href={link.href} target="_top" rel="noopener">
          {link.label}
          <span aria-hidden="true"> ↗</span>
        </a>
      ) : null}
    </section>
  );
}
