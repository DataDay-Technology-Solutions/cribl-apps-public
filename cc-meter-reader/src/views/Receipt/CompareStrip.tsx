// src/views/Receipt/CompareStrip.tsx — "Compare with…" on the Receipt hero (P2-W13): the second figure beside the
// meter (what the baseline window is, its words, A → B on the comparison's basis and the signed change as a chip
// whose percentage names its basis), the receipt bar as two stacked bars on one scale (this range over the
// baseline, paid grey and saved green inside each window's would-have-paid length), and the per-pipeline lines
// that moved most, with a change column. Every figure comes from core/range.ts compareRanges over rows the reader
// summed; nothing here computes money.
//
// States: the eyebrow and a static ghost while the baseline is read (nothing moves when it lands); a refusal is
// one sentence (no Retry: nothing a retry could change); a failed baseline read is an inline notice with Retry,
// a 429 says when it reads again. Colour: the change is the saved green when the range saved more, the incident
// red when it saved less (a savings drop is the incident class), neutral when it rounds to $0 — no new hue.

import { CaretDownSolid, CaretUpSolid } from '@capra/icons';
import { perDayAtRate, type RangeComparison } from '../../../core/range.ts';
import type { ComparisonLine } from '../../../core/receipt.ts';
import { footMoney } from '../../../core/format.ts';
import { formatLocalTime } from '../../../core/time.ts';
import { t } from '../../copy/en.ts';
import { InlineNotice } from '../../components/common/InlineNotice.tsx';
import { paidShare, slot } from '../../components/ReceiptBar/slot.tsx';
import { formatMoney } from '../../lib/format.ts';
import { barLine, basisMoney, deltaText, moneyOnBasis, pctBasisText, shareLineText, type CompareNames } from './compareText.ts';
import './Compare.css';

/** A change smaller than this rounds to $0 on screen. */
const HALF_DOLLAR_M = 50_000;

/** The comparison on the hero, as HeroCard shows it. */
export interface HeroCompare {
  status: 'loading' | 'ready' | 'refused' | 'error';
  names: CompareNames;
  /** The baseline window in words ("Sep 12, 2:00 PM–Sep 19, 2:00 PM (7 days)"): once read, or planned while reading. */
  baselineWords?: string;
  /** The current window in words (the one read for the comparison, which may be aligned). */
  currentWords?: string;
  comparison?: RangeComparison;
  /** How the windows were made comparable (caption segments). */
  notes?: string[];
  /** Refused / failed / nothing metered: the one sentence shown instead of the figures. */
  notice?: string;
  /** A 429: the comparison reads again at this instant (held figures stay on screen). */
  retryAtMs?: number;
  onRetry?: () => void;
  /** The per-pipeline lines that moved most (compareLines). */
  lines?: ComparisonLine[];
}

function Delta({ cmp, name }: { cmp: RangeComparison; name: string }) {
  const basis = cmp.pct !== undefined ? pctBasisText(cmp, name) : undefined;
  return (
    <p className="mr-cmp-delta" data-direction={cmp.direction} data-testid="hero-compare-delta" title={basis}>
      {cmp.direction !== 'flat' ? (
        <span className="mr-cmp-caret" aria-hidden="true">
          {cmp.direction === 'up' ? <CaretUpSolid size="sm" /> : <CaretDownSolid size="sm" />}
        </span>
      ) : null}
      <span className="mr-num">{deltaText(cmp)}</span>
      {basis ? <span className="mr-visually-hidden">{` ${basis}`}</span> : null}
    </p>
  );
}

/** A window's money as the bar's label prints it: would have paid − paid = saved, to the dollar (core/format.ts footMoney). */
function footedWords(m: { whpM: number; paidM: number; savedM: number }): { whp: string; paid: string; saved: string } {
  const f = footMoney(m);
  return { whp: formatMoney(f.whpM), paid: formatMoney(f.paidM), saved: formatMoney(f.savedM) };
}

/** The second figure: beside the meter on a desktop, under the range's words on a phone. */
export function CompareFigure({ compare, tz }: { compare: HeroCompare; tz: string }) {
  const cmp = compare.comparison;
  const heldAt = compare.retryAtMs !== undefined && Number.isFinite(compare.retryAtMs) ? compare.retryAtMs : undefined;
  return (
    <div
      className="mr-cmp"
      data-testid="hero-compare"
      data-status={compare.status}
      data-basis={cmp?.basis}
      data-direction={cmp && cmp.basis !== 'none' ? cmp.direction : undefined}
      aria-busy={compare.status === 'loading' ? true : undefined}
    >
      <p className="mr-cmp-eyebrow">{compare.names.eyebrow}</p>
      {compare.baselineWords ? (
        <p className="mr-cmp-words" data-testid="hero-compare-words">
          {compare.baselineWords}
        </p>
      ) : null}
      {compare.status === 'loading' ? (
        <div className="mr-cmp-ghost" role="status" aria-label={t('meter.range.compare.loading', { name: compare.names.name })}>
          <span className="mr-skel mr-skel--range mr-cmp-ghost-fig" />
          <span className="mr-skel mr-skel--range mr-cmp-ghost-chip" />
        </div>
      ) : compare.status === 'refused' ? (
        <p className="mr-cmp-notice" data-testid="hero-compare-refused">
          {compare.notice}
        </p>
      ) : compare.status === 'error' ? (
        <div className="mr-cmp-error">
          <InlineNotice
            variant="inline"
            data-testid="hero-compare-error"
            action={heldAt === undefined && compare.onRetry ? { label: t('meter.range.retry'), onClick: compare.onRetry } : undefined}
          >
            {heldAt !== undefined ? t('meter.range.compare.rateLimited', { time: formatLocalTime(heldAt, tz) }) : compare.notice}
          </InlineNotice>
        </div>
      ) : cmp && cmp.basis === 'none' ? (
        <p className="mr-cmp-notice" data-testid="hero-compare-empty">
          {compare.notice}
        </p>
      ) : cmp ? (
        <>
          <p className="mr-cmp-fromto" data-testid="hero-compare-fromto">
            {slot(t('meter.range.compare.fromTo'), {
              from: <span className="mr-cmp-a mr-num">{formatMoney(cmp.baselineM)}</span>,
              to: <span className="mr-cmp-b mr-num">{formatMoney(cmp.currentM)}</span>,
            })}
            {/* Compared per day: the unit is a secondary suffix, never inside the figures (DESIGN_BRIEF §3). */}
            {cmp.basis === 'rate' ? <span className="mr-cmp-unit">{t('units.perDay')}</span> : null}
          </p>
          <Delta cmp={cmp} name={compare.names.name} />
          <p className="mr-cmp-share" data-testid="hero-compare-share">
            {shareLineText(cmp)}
          </p>
        </>
      ) : null}
      {compare.status === 'ready' && (compare.notes?.length || heldAt !== undefined) ? (
        <p className="mr-cmp-notes" data-testid="hero-compare-notes">
          {[...(compare.notes ?? []), ...(heldAt !== undefined ? [t('meter.range.compare.held', { time: formatLocalTime(heldAt, tz) })] : [])].join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

/** The receipt bar as two stacked bars on one scale: this range over the baseline. */
export function CompareBars({ compare }: { compare: HeroCompare }) {
  const cmp = compare.comparison;
  if (!cmp) return null;
  const rows = [
    { key: 'current', name: compare.names.currentRow, money: moneyOnBasis(cmp, cmp.current, perDayAtRate) },
    { key: 'baseline', name: compare.names.baselineRow, money: moneyOnBasis(cmp, cmp.baseline, perDayAtRate) },
  ];
  const scale = Math.max(1, ...rows.map((r) => r.money.whpM));
  return (
    <div className="mr-cmp-bars" data-testid="hero-compare-bars">
      {rows.map((r) => {
        const share = paidShare(r.money.whpM, r.money.paidM);
        const empty = !(r.money.whpM > 0);
        const current = r.key === 'current';
        return (
          <div key={r.key} className="mr-cmp-row" data-which={r.key} data-empty={empty ? 'true' : 'false'}>
            <p className="mr-cmp-row-head">
              <span className="mr-cmp-row-name">{r.name}</span>
              <span className="mr-cmp-row-saved mr-num">{t('meter.range.compare.rowSaved', { amount: basisMoney(cmp, r.money.savedM) })}</span>
            </p>
            <div className="mr-cmp-lane">
              <div
                className="mr-cmp-track"
                style={{ width: `${(Math.max(0, r.money.whpM) / scale) * 100}%` }}
                data-callout={current ? 'whp' : undefined}
                role="img"
                aria-label={t('meter.range.compare.barLabel', { name: r.name, ...footedWords(r.money) })}
              >
                <div className="mr-cmp-paid" data-callout={current ? 'paid' : undefined} style={{ flexGrow: share }} />
                <div className="mr-cmp-saved" style={{ flexGrow: empty ? 0 : 1 - share }} />
              </div>
            </div>
            <p className="mr-cmp-row-line">{barLine(cmp, r.money)}</p>
          </div>
        );
      })}
    </div>
  );
}

/** The pipelines that moved most: receipt lines with dot leaders, the range's amount and the change. */
export function CompareMovers({ compare, max = 3 }: { compare: HeroCompare; max?: number }) {
  const cmp = compare.comparison;
  // Only the lines that moved (a change that rounds to $0 is not news), biggest first.
  const lines = (compare.lines ?? []).filter((l) => Math.abs(l.deltaM) >= HALF_DOLLAR_M).slice(0, max);
  if (!cmp || cmp.basis === 'none' || lines.length === 0) return null;
  return (
    <div className="mr-cmp-movers" data-testid="hero-compare-movers">
      <p className="mr-cmp-movers-title">{t(cmp.basis === 'rate' ? 'meter.range.compare.moversPerDay' : 'meter.range.compare.movers')}</p>
      <ul className="mr-cmp-movers-list" aria-label={t('meter.range.compare.moversCaption')}>
        {lines.map((l) => {
          const direction = l.deltaM > 0 ? 'up' : 'down';
          return (
            <li key={l.label} className="mr-cmp-mover" data-direction={direction}>
              <span className="mr-cmp-mover-label" title={l.label}>
                {l.label}
              </span>
              <span className="mr-cmp-mover-dots" aria-hidden="true" />
              <span className="mr-cmp-mover-amount mr-num">{formatMoney(l.currentM)}</span>
              <span className="mr-cmp-mover-delta mr-num">{formatMoney(l.deltaM, { signed: true })}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
