// src/components/MathDrawer/MathDrawer.tsx — "Show the math" (PRD 6, SPEC 8): every formula with its live
// values substituted, every price used, every assumption labelled.
//
//   The formulas            would have paid = bytes in × price · paid = bytes out × price
//                           saved = would have paid − paid (values) · ratio = saved ÷ would have paid (values)
//   Net after Cribl         saved − Cribl's cost for the same span (values), the payback multiple, the cost's
//                           basis (the monthly setting, × 12 ÷ 365 a day, prorated to the metered span or a year)
//                           and what it comes to per GB received beside Cribl's list price (core/net.ts, D48)
//   At each destination     month to date: each destination's month totals, which add up to the hero, and a
//                           reconciliation sentence saying so (P1-F09); other periods: GB/day in × price =
//                           $/day, out × price, saved, labelled as the last hour × 24 (not parts of the figure).
//                           The head says "priced as <preset>" like Where the money goes; then the price, its
//                           preset, and the counterfactual ("Without Cribl this data would go to …")
//   Where bytes are measured the attribution basis (N7 wording: route output vs destination out-bytes)
//   Units                   1 GB = 1,000,000,000 bytes; millicent rounding
//   Annualized run rate     Σ saved ÷ Σ metered minutes × 525,600 over the last 30 days (core, REVIEW-3a #6)
//   Between sweeps          the rate the meter ticks at, and what it reads right now — so the drawer and
//                           the hero agree to the cent
//   Compared with           (a custom range with ?vs=, P2-W13) both windows' saved, the change and its share of
//                           the baseline, the basis (sums, or a day at each window's rate), the baseline's read
//
// Desktop: a Capra Drawer (right). Phones: Capra's Drawer never renders narrower than 400 px, so under
// 640 px the same content opens in a small Modal instead. The content is a focusable region (tab stop after
// Close), so a keyboard can scroll the drawer's body (WCAG 2.1.1; it has no other focusable content).

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Button, Drawer, Modal } from '@capra/core';
import type { Attribution, Counterfactual, HeadlinePeriod } from '../../../core/types.ts';
import { fmtBytes, fmtDollarsCents, footMoney, mcToDollarInput } from '../../../core/format.ts';
import type { RangeComparison, RangeFigures } from '../../../core/range.ts';
import { formatLocalDateTime, formatLocalMonthDay, formatLocalTime, localMidnightMs } from '../../../core/time.ts';
import { t, tn, type CopyKey } from '../../copy/en.ts';
import { formatInt, formatMoney, formatMultiple, formatPct } from '../../lib/format.ts';
import { useNow } from '../../lib/ticker.ts';
import { targetAt } from '../Meter/meterMath.ts';
import { slot } from '../ReceiptBar/slot.tsx';
import { diversionTarget, headlineSplit } from '../../../core/snapshot.ts';
import type { PricesDoc, Snapshot } from '../../../core/types.ts';
import { priceEntryAt } from '../../../core/pricing.ts';
import { presetById } from '../../../core/presets.ts';
import { useOptionalStoreApi } from '../../state/react.tsx';
import './MathDrawer.css';

export interface MathFigures {
  period: HeadlinePeriod;
  savedM: number;
  whpM: number;
  paidM: number;
  ratio: number;
  accrues: boolean;
  derivedFrom?: 'trend' | 'ratio';
  annualizedDays?: number;
}

export interface MathDestination {
  key: string;
  label: string;
  type: string;
  inBPerDay: number;
  outBPerDay: number;
  whpPerDayM: number;
  paidPerDayM: number;
  savedPerDayM: number;
  paidMcPerGb: number;
  whpMcPerGb: number;
  counterfactual: Counterfactual;
  counterfactualLabel?: string;
  presetLabel?: string;
  /** The member's own rate rather than the preset's typical (P1-G01). */
  customPrice?: boolean;
  /** P2-W24: who saved the price in force. */
  priceSetBy?: string;
  unpriced: boolean;
  /** P1-F01: priced itself, but its counterfactual destination has no price */
  counterfactualUnpriced?: boolean;
  /** Month to date at this destination (shown, and summed, when the period is MTD). */
  mtdWhpM?: number;
  mtdPaidM?: number;
  mtdSavedM?: number;
}

/** How the month-to-date rows add up against the hero (src/views/Receipt/model.ts mtdReconciliation). */
export interface MathReconciliation {
  whpM: number;
  paidM: number;
  savedM: number;
  gapM: number;
  matches: boolean;
}

/** Net after Cribl for the period (src/views/Receipt/model.ts netFigures, core/net.ts), with its basis. */
export interface MathNet {
  savedM: number;
  costM: number;
  netM: number;
  paybackX?: number;
  /** Cribl's cost per day at the monthly figure (× 12 ÷ 365), millicents. */
  costPerDayM: number;
  monthlyCostCents: number;
  /** 'year' for the run rate; else the cost is prorated to the metered span. */
  per?: 'year';
  fromMs?: number;
  sinceCollecting?: boolean;
  /** "25.4 days" */
  spanWords: string;
  /** What the monthly cost comes to per GB received (millicents per GB), when there is traffic. */
  impliedMcPerGb?: number;
  /** What the workspace receives per day, when the flows say it exactly (each Source on one flow). */
  bytesInPerDay?: number;
  /** Cribl's published list price per GB received (core/net.ts). */
  listMcPerGb: number;
}

/** A custom range (core/range.ts) showing on the hero: its sum and the window in words. */
export interface MathRange {
  figures: RangeFigures;
  /** "Sep 26, 10:00 AM–2:00 PM (4 h)" */
  words: string;
  /** ?vs= (P2-W13): what the range is compared with, once both windows are read. */
  compare?: MathCompare;
}

/** A comparison of the range with a baseline window (core/range.ts compareRanges) and its words. */
export interface MathCompare {
  comparison: RangeComparison;
  /** 'the previous 7 days', 'the time before 805b12c' */
  name: string;
  /** The baseline window in words. */
  words: string;
  /** How the windows were made comparable (the hero's notes). */
  notes: string[];
}

export interface MathDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** "month to date", "annualized run rate", … (the range's words while one shows) */
  periodCaption: string;
  figures: MathFigures;
  destinations: MathDestination[];
  attribution: Attribution;
  /** The meter's anchor: snapshot sweep time (epoch ms) and accrual rate (millicents per second). */
  sweepAtMs: number;
  ratePerSecM: number;
  tz: string;
  /** While a custom range shows: the formulas use its figures, and a "Custom range" section explains the read. */
  range?: MathRange;
  /** Month to date: how the destination rows add up to the hero. */
  reconciliation?: MathReconciliation;
  /** Net after Cribl for the period, when a Cribl cost is set (never for a range). */
  net?: MathNet;
  /** Whether a Cribl cost is set in Settings (the net section says how to add one when it isn't). */
  criblCostSet?: boolean;
}

const BASIS_KEYS: Record<Attribution, CopyKey> = {
  route: 'receiptView.math.basis.route',
  pipeline: 'receiptView.math.basis.pipeline',
  reconciled: 'receiptView.math.basis.reconciled',
  proportional: 'receiptView.math.basis.proportional',
  'route-only': 'receiptView.math.basis.routeOnly',
};

/** "$2.50", "$0.023" — prices and per-second rates keep their precision (core/format). */
function price(mc: number): string {
  return `$${mcToDollarInput(mc)}`;
}

function useNarrow(): boolean {
  const query = '(max-width: 640px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return narrow;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mr-math-section">
      <h3 className="mr-math-title">{title}</h3>
      {children}
    </section>
  );
}

function Formula({ text, values }: { text: string; values?: ReactNode }) {
  return (
    <div className="mr-math-formula">
      <p className="mr-math-formula-text">{text}</p>
      {values ? <p className="mr-math-values">{values}</p> : null}
    </div>
  );
}

function counterfactualLine(cf: Counterfactual, label?: string): string {
  if (cf.kind === 'none') return t('receiptView.math.counterfactualNone');
  if (cf.kind === 'other') return t('receiptView.math.counterfactualOther', { target: label ?? cf.outputId });
  return t('receiptView.math.counterfactualSame');
}

/** The live reconciliation line: what the meter reads now = the snapshot + the accrual since (cents, like the meter). */
function LiveLine({ savedM, sweepAtMs, ratePerSecM, tz }: { savedM: number; sweepAtMs: number; ratePerSecM: number; tz: string }) {
  const now = useNow();
  const current = targetAt({ valueM: savedM, ratePerSecM, anchorMs: sweepAtMs }, now);
  return (
    <>
      <p className="mr-math-body">
        {t('receiptView.math.liveLine', {
          rate: fmtDollarsCents(ratePerSecM * 60),
          time: Number.isFinite(sweepAtMs) ? formatLocalTime(sweepAtMs, tz) : t('common.dash'),
        })}
      </p>
      <p className="mr-math-values" data-testid="math-live">
        {fmtDollarsCents(savedM)} + {fmtDollarsCents(Math.max(0, current - savedM))} = <strong className="mr-saved">{fmtDollarsCents(current)}</strong>
      </p>
    </>
  );
}

const SNAP_KEYS: Record<RangeFigures['granularity'], CopyKey> = {
  minute: 'receiptView.math.rangeSnapMinute',
  hour: 'receiptView.math.rangeSnapHour',
  day: 'receiptView.math.rangeSnapDay',
};
const GRANULARITY_KEYS: Record<RangeFigures['granularity'], CopyKey> = {
  minute: 'receiptView.math.rangeGranularity.minute',
  hour: 'receiptView.math.rangeGranularity.hour',
  day: 'receiptView.math.rangeGranularity.day',
};

/** The custom range: the sum over its rows, the read plan behind it, and the snapping rule. */
function RangeSection({ range }: { range: MathRange }) {
  const f = range.figures;
  const read = tn('receiptView.math.rangePlanRead', f.docsRead, { n: formatInt(f.docsRead) });
  const missing = f.docsMissing === 0 ? t('receiptView.math.rangePlanNoneMissing') : tn('receiptView.math.rangePlanMissing', f.docsMissing, { n: formatInt(f.docsMissing) });
  // A hybrid read (api-budget F2, core/range.ts): the window's own rows at the ragged edges, coarser rows between
  // (or, for a window of whole coarse buckets, the coarser rows alone).
  const [fine, coarse] = f.families ?? [];
  const plan =
    fine && coarse
      ? t('receiptView.math.rangePlanHybrid', { fine: t(GRANULARITY_KEYS[fine]), coarse: t(GRANULARITY_KEYS[coarse]), read, missing })
      : t('receiptView.math.rangePlan', { granularity: t(GRANULARITY_KEYS[fine ?? f.granularity]), read, missing });
  return (
    <Section title={t('receiptView.math.rangeTitle')}>
      <p className="mr-math-body">{range.words}</p>
      <Formula
        text={t('receiptView.math.rangeFormula')}
        values={slot(t('receiptView.math.rangeValues'), {
          flows: formatInt(Object.keys(f.byFlow).length),
          rows: formatInt(f.rows),
          saved: <strong className="mr-saved">{formatMoney(f.savedM)}</strong>,
        })}
      />
      <p className="mr-math-body mr-math-tnum" data-testid="math-range-plan">
        {plan}
        {f.minutesMetered !== undefined ? (
          <>
            <span aria-hidden="true"> · </span>
            {t('receiptView.math.rangeMinutes', { metered: formatInt(f.minutesMetered), expected: formatInt(f.expectedMinutes) })}
          </>
        ) : f.daysMetered !== undefined ? (
          <>
            <span aria-hidden="true"> · </span>
            {t('receiptView.math.rangeDays', { metered: formatInt(f.daysMetered), expected: formatInt(Math.round(f.expectedMinutes / 1440)) })}
          </>
        ) : null}
      </p>
      <p className="mr-math-body">{t(SNAP_KEYS[f.granularity])}</p>
      {fine && f.granularity !== 'day' ? <p className="mr-math-body">{t(`receiptView.math.rangeHybrid.${f.granularity}`)}</p> : null}
    </Section>
  );
}

/** The hero's caption segments as a sentence of their own: a capital first, a full stop last. */
const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}${text.endsWith('.') ? '' : '.'}`;

/** The comparison: both windows' saved, the change and its share of the baseline, on a named basis. */
function CompareSection({ compare }: { compare: MathCompare }) {
  const c = compare.comparison;
  const b = c.baseline;
  const perDay = c.basis === 'rate';
  const money = (m: number, signed = false): string => (perDay ? t('meter.range.compare.perDay', { amount: formatMoney(m, { signed }) }) : formatMoney(m, { signed }));
  const read = tn('receiptView.math.rangePlanRead', b.docsRead, { n: formatInt(b.docsRead) });
  const missing = b.docsMissing === 0 ? t('receiptView.math.rangePlanNoneMissing') : tn('receiptView.math.rangePlanMissing', b.docsMissing, { n: formatInt(b.docsMissing) });
  const metered =
    b.minutesMetered !== undefined
      ? t('receiptView.math.rangeMinutes', { metered: formatInt(b.minutesMetered), expected: formatInt(b.expectedMinutes) })
      : b.daysMetered !== undefined
        ? t('receiptView.math.rangeDays', { metered: formatInt(b.daysMetered), expected: formatInt(Math.round(b.expectedMinutes / 1440)) })
        : undefined;
  return (
    <Section title={t('receiptView.math.compareTitle', { name: compare.name })}>
      <p className="mr-math-body">{compare.words}</p>
      {c.basis === 'none' ? (
        <p className="mr-math-body">{t('meter.range.compare.empty', { name: compare.name })}</p>
      ) : (
        <>
          <Formula
            text={t(perDay ? 'receiptView.math.compareFormulaRate' : 'receiptView.math.compareFormulaSum', { name: compare.name })}
            values={slot(t('receiptView.math.compareValues'), {
              current: money(c.currentM),
              baseline: money(c.baselineM),
              change: <strong className={c.direction === 'down' ? 'mr-math-down' : 'mr-saved'}>{money(c.deltaM, true)}</strong>,
            })}
          />
          {c.pct !== undefined ? (
            <Formula
              text={t('receiptView.math.comparePctFormula', { name: compare.name })}
              values={t('receiptView.math.comparePctValues', { change: money(c.deltaM, true), baseline: money(c.baselineM), pct: formatPct(c.pct, { signed: true }) })}
            />
          ) : null}
        </>
      )}
      <p className="mr-math-body mr-math-tnum" data-testid="math-compare-plan">
        {t('receiptView.math.compareRead', { read, missing })}
        {metered ? (
          <>
            <span aria-hidden="true"> · </span>
            {metered}
          </>
        ) : null}
      </p>
      <p className="mr-math-body">{t(perDay ? 'receiptView.math.compareBasisRate' : 'receiptView.math.compareBasisSum')}</p>
      {compare.notes.length > 0 ? <p className="mr-math-body">{sentence(compare.notes.join(' · '))}</p> : null}
    </Section>
  );
}

/** "Sep 1" when the span starts at a local midnight (a month or a day), else "Sep 26, 2026, 2:20 AM". */
function sinceWords(ms: number, tz: string): string {
  return localMidnightMs(ms, tz) === ms ? formatLocalMonthDay(ms, tz) : formatLocalDateTime(ms, tz);
}

/** Net after Cribl: saved − Cribl's cost for the same span, the payback, and where the cost comes from (D48). */
function NetSection({ net, tz, criblCostSet, range }: { net?: MathNet; tz: string; criblCostSet: boolean; range: boolean }) {
  if (!net) {
    return (
      <Section title={t('receiptView.math.netTitle')}>
        <p className="mr-math-body" data-testid="math-net-none">
          {t(range && criblCostSet ? 'receiptView.math.netRangeNone' : 'receiptView.math.netNone')}
        </p>
      </Section>
    );
  }
  const monthly = fmtDollarsCents(net.monthlyCostCents * 1000);
  const cost = formatMoney(net.costM);
  return (
    <Section title={t('receiptView.math.netTitle')}>
      <div data-testid="math-net">
        <Formula
          text={t('receiptView.math.netFormula')}
          values={slot(t('receiptView.math.netValues'), {
            saved: formatMoney(net.savedM),
            cost,
            net: <strong className={net.netM < 0 ? undefined : 'mr-saved'}>{formatMoney(net.netM)}</strong>,
          })}
        />
      </div>
      {net.paybackX !== undefined ? (
        <Formula
          text={t('receiptView.math.paybackFormula')}
          values={t('receiptView.math.paybackValues', { saved: formatMoney(net.savedM), cost, multiple: formatMultiple(net.paybackX) })}
        />
      ) : null}
      <p className="mr-math-body mr-math-tnum" data-testid="math-net-cost">
        {t('receiptView.math.netCostLine', { monthly, perDay: fmtDollarsCents(net.costPerDayM) })}
      </p>
      <p className="mr-math-body mr-math-tnum" data-testid="math-net-span">
        {net.per === 'year'
          ? t('receiptView.math.netYearLine', { monthly, cost })
          : t(net.sinceCollecting ? 'receiptView.math.netSpanLineSince' : 'receiptView.math.netSpanLine', {
              span: net.spanWords,
              from: net.fromMs !== undefined ? sinceWords(net.fromMs, tz) : t('common.dash'),
              cost,
            })}
      </p>
      {/* Cribl's list price and what Stream bills on, always (D48); what the monthly cost comes to per GB received
          only when the bytes received are exact. */}
      <p className="mr-math-body mr-math-tnum" data-testid="math-net-rate">
        {net.impliedMcPerGb !== undefined && net.bytesInPerDay !== undefined
          ? t('receiptView.math.netRateLine', {
              volume: fmtBytes(net.bytesInPerDay),
              // Tenths of a cent: a cost per GB is a rate, not a total ($0.324, like the list price's $0.32).
              rate: price(Math.round(net.impliedMcPerGb / 100) * 100),
              list: price(net.listMcPerGb),
            })
          : t('receiptView.math.netListLine', { list: price(net.listMcPerGb) })}
      </p>
    </Section>
  );
}

/** One destination's head: its name, then "priced as <preset>" (as in Where the money goes) or its output type. */
function DestHead({ d }: { d: MathDestination }) {
  return (
    <p className="mr-math-dest-head">
      <span className="mr-math-dest-name">{d.label}</span>
      {!d.unpriced && d.presetLabel ? (
        <span className="mr-math-dest-type" data-basis="preset">
          {t('receiptView.destinations.pricedAs', { preset: d.presetLabel })}
        </span>
      ) : (
        <span className="mr-math-dest-type" data-basis="type">
          {d.type}
        </span>
      )}
    </p>
  );
}

const noop = () => {};

/** The snapshot when the drawer is inside the app's providers (P1-F02/F03 read the split and the cost added), else null. */
function useSnapshot(): Snapshot | null {
  const store = useOptionalStoreApi();
  const subscribe = useCallback((l: () => void) => (store ? store.subscribe(l) : noop), [store]);
  const get = useCallback(() => store?.getState().snapshot ?? null, [store]);
  return useSyncExternalStore(subscribe, get, get);
}

/** The prices document when the drawer is inside the app's providers (P1-F10), else null. */
function usePrices(): PricesDoc | null {
  const store = useOptionalStoreApi();
  const subscribe = useCallback((l: () => void) => (store ? store.subscribe(l) : noop), [store]);
  const get = useCallback(() => store?.getState().prices ?? null, [store]);
  return useSyncExternalStore(subscribe, get, get);
}

/** P1-F10: the typical list price (mc/GB) of the preset a member's own rate replaced, when it differs from that rate. */
function listPriceOf(prices: PricesDoc | null, key: string, atMs: number, rateMc: number): number | undefined {
  const cut = key.indexOf(':');
  if (!prices || cut < 0 || !Number.isFinite(atMs)) return undefined;
  const entry = priceEntryAt(prices, key.slice(0, cut), key.slice(cut + 1), atMs);
  const list = presetById(entry?.preset)?.milliCentsPerGb;
  return list !== undefined && list > 0 && list !== rateMc ? list : undefined;
}

/**
 * P1-F02: which dollars are measured and which rest on a price — month to date exactly (the headline's split), the
 * other periods at current rates (the flows' per-day figures). P1-F03: what pipelines that grow bytes add.
 */
function MeasuredSection({ snapshot, period }: { snapshot: Snapshot | null; period: HeadlinePeriod }) {
  if (!snapshot) return null;
  const split = period === 'mtd' ? headlineSplit(snapshot) : undefined;
  let reducedDay = 0;
  let divertedDay = 0;
  for (const f of snapshot.flows ?? []) {
    if (diversionTarget(f, snapshot.destinations) !== undefined) divertedDay += f.savedPerDayM;
    else reducedDay += f.savedPerDayM;
  }
  const h = snapshot.headline;
  const addedFlows = h?.addedFlows ?? 0;
  const showSplit = split ? split.divertedM > 0 : divertedDay > 0;
  if (!showSplit && !(addedFlows > 0)) return null;
  return (
    <Section title={t('receiptView.math.splitTitle')}>
      {showSplit ? (
        <>
          <p className="mr-math-values mr-math-tnum" data-testid="math-split">
            {split
              ? slot(t('receiptView.math.splitMtd'), {
                  reduced: <strong className="mr-saved">{formatMoney(split.reducedM)}</strong>,
                  diverted: <strong className="mr-saved">{formatMoney(split.divertedM)}</strong>,
                })
              : slot(t('receiptView.math.splitRates'), {
                  reduced: <strong className="mr-saved">{formatMoney(reducedDay)}</strong>,
                  diverted: <strong className="mr-saved">{formatMoney(divertedDay)}</strong>,
                })}
          </p>
          <p className="mr-math-body">{t('receiptView.math.splitBody')}</p>
        </>
      ) : null}
      {addedFlows > 0 ? (
        <>
          <p className="mr-math-values mr-math-tnum" data-testid="math-added">
            {tn('receiptView.math.addedLine', addedFlows, { n: formatInt(addedFlows), amount: formatMoney(h?.addedPerDayM ?? 0) })}
          </p>
          <p className="mr-math-body">{t('receiptView.math.addedBody')}</p>
        </>
      ) : null}
    </Section>
  );
}

function MathContent(props: MathDrawerProps) {
  const snapshot = useSnapshot();
  const pricesDoc = usePrices();
  const { destinations, attribution, periodCaption, sweepAtMs, ratePerSecM, tz, range, reconciliation, net, criblCostSet = false } = props;
  // With a range showing, the formulas substitute its figures; the period's own annualized notes step aside.
  const figures: MathFigures = range ? { ...props.figures, savedM: range.figures.savedM, whpM: range.figures.whpM, paidM: range.figures.paidM, ratio: range.figures.ratio, accrues: false, derivedFrom: undefined, annualizedDays: undefined } : props.figures;
  const priced = destinations.filter((d) => !d.unpriced);
  const unpriced = destinations.filter((d) => d.unpriced);
  const footed = footMoney({ whpM: figures.whpM, paidM: figures.paidM, savedM: figures.savedM });
  const days = Math.round(figures.annualizedDays ?? 0);
  // Month to date (and no range): the rows are the month's own totals, which add up to the hero.
  const mtd = !range && figures.period === 'mtd' && reconciliation !== undefined;
  return (
    <div className="mr-math" data-testid="math-drawer" tabIndex={0} role="region" aria-label={t('receiptView.math.regionLabel')}>
      <p className="mr-math-intro">{t(range ? 'receiptView.math.introRange' : 'receiptView.math.intro', { period: periodCaption })}</p>

      {range ? <RangeSection range={range} /> : null}
      {range?.compare ? <CompareSection compare={range.compare} /> : null}

      <Section title={t('receiptView.math.formulasTitle')}>
        <Formula text={t('receiptView.math.whpFormula')} />
        <Formula text={t('receiptView.math.paidFormula')} />
        <Formula
          text={t('receiptView.math.savedFormula')}
          values={slot(t('receiptView.math.savedValues'), {
            // Printed money adds up, as the hero's bar prints it (core/format.ts footMoney).
            whp: formatMoney(footed.whpM),
            paid: formatMoney(footed.paidM),
            saved: <strong className="mr-saved">{formatMoney(footed.savedM)}</strong>,
          })}
        />
        <Formula
          text={t('receiptView.math.ratioFormula')}
          values={t('receiptView.math.ratioValues', { saved: formatMoney(footed.savedM), whp: formatMoney(footed.whpM), pct: formatPct(figures.ratio) })}
        />
        {/* The same basis the hero's "% saved" hover names, and why the Ledger's and the Flow map's figures differ. */}
        <p className="mr-math-body" data-testid="math-ratio-basis">
          {t('receiptView.math.ratioBasis', { pct: formatPct(figures.ratio), period: periodCaption })}
        </p>
      </Section>

      {range ? null : <MeasuredSection snapshot={snapshot} period={figures.period} />}

      <NetSection net={net} tz={tz} criblCostSet={criblCostSet} range={Boolean(range)} />

      <Section title={t(mtd ? 'receiptView.math.perDestinationTitleMtd' : 'receiptView.math.perDestinationTitle')}>
        {!mtd && priced.length > 0 ? (
          <p className="mr-math-body" data-testid="math-rate-note">
            {t('receiptView.math.perDestinationRateNote')}
          </p>
        ) : null}
        {priced.length === 0 ? <p className="mr-math-body">{t('receiptView.math.destinationsNone')}</p> : null}
        <ul className="mr-math-dests">
          {priced.map((d) => (
            <li key={d.key} className="mr-math-dest">
              <DestHead d={d} />
              <p className="mr-math-body">
                <span className="mr-math-tnum">{t('receiptView.destinations.pricePerGb', { price: price(d.paidMcPerGb) })}</span>
                <span aria-hidden="true"> · </span>
                {d.presetLabel && !d.customPrice
                  ? t('receiptView.math.preset', { preset: d.presetLabel })
                  : (() => {
                      // P1-F10: "Your rate · Splunk Cloud list $2.25" — the member's rate beside the list price it replaced.
                      const list = d.presetLabel ? listPriceOf(pricesDoc, d.key, sweepAtMs, d.paidMcPerGb) : undefined;
                      return list !== undefined && d.presetLabel ? (
                        <span data-testid="math-your-rate">{t('receiptView.math.yourRate', { preset: d.presetLabel, list: price(list) })}</span>
                      ) : (
                        t('receiptView.math.customPrice')
                      );
                    })()}
                {d.priceSetBy ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span data-testid="math-set-by">{t('receiptView.math.setBy', { user: d.priceSetBy })}</span>
                  </>
                ) : null}
              </p>
              <p className="mr-math-body">{counterfactualLine(d.counterfactual, d.counterfactualLabel)}</p>
              {mtd ? (
                <>
                  <dl className="mr-math-grid" data-testid="math-dest-mtd">
                    {(() => {
                      // Printed money adds up: $5,809 − $4,409 = $1,400, never − $4,408 (core/format footMoney, review W2).
                      const f = footMoney({ whpM: d.mtdWhpM ?? 0, paidM: d.mtdPaidM ?? 0, savedM: d.mtdSavedM ?? 0 });
                      return (
                        <>
                          <dt>{t('receiptView.trend.tipWhp')}</dt>
                          <dd>{formatMoney(f.whpM)}</dd>
                          <dt>{t('receiptView.trend.tipPaid')}</dt>
                          <dd>{formatMoney(f.paidM)}</dd>
                          <dt>{t('receiptView.trend.tipSaved')}</dt>
                          <dd className="mr-saved">
                            {t('receiptView.math.destSaved', { whp: formatMoney(f.whpM), paid: formatMoney(f.paidM), amount: formatMoney(f.savedM) })}
                          </dd>
                        </>
                      );
                    })()}
                  </dl>
                  <p className="mr-math-body mr-math-tnum">{t('receiptView.math.destNow', { volumeIn: fmtBytes(d.inBPerDay), volumeOut: fmtBytes(d.outBPerDay) })}</p>
                </>
              ) : (
                <dl className="mr-math-grid">
                  {(() => {
                    const f = footMoney({ whpM: d.whpPerDayM, paidM: d.paidPerDayM, savedM: d.savedPerDayM });
                    return (
                      <>
                        <dt>{t('receiptView.trend.tipWhp')}</dt>
                        <dd>
                          {t('receiptView.math.destWhp', {
                            volume: fmtBytes(d.inBPerDay),
                            price: price(d.whpMcPerGb),
                            amount: formatMoney(f.whpM),
                          })}
                        </dd>
                        <dt>{t('receiptView.trend.tipPaid')}</dt>
                        <dd>
                          {t('receiptView.math.destPaid', {
                            volume: fmtBytes(d.outBPerDay),
                            price: price(d.paidMcPerGb),
                            amount: formatMoney(f.paidM),
                          })}
                        </dd>
                        <dt>{t('receiptView.trend.tipSaved')}</dt>
                        <dd className="mr-saved">
                          {t('receiptView.math.destSaved', { whp: formatMoney(f.whpM), paid: formatMoney(f.paidM), amount: formatMoney(f.savedM) })}
                        </dd>
                      </>
                    );
                  })()}
                </dl>
              )}
            </li>
          ))}
          {unpriced.map((d) => (
            <li key={d.key} className="mr-math-dest mr-math-dest--unpriced">
              <DestHead d={d} />
              <p className="mr-math-body">
                {d.counterfactualUnpriced
                  ? t('receiptView.math.counterfactualUnpriced', { target: d.counterfactualLabel ?? (d.counterfactual.kind === 'other' ? d.counterfactual.outputId : d.label) })
                  : t('receiptView.math.unpriced')}
              </p>
            </li>
          ))}
        </ul>
        {mtd && reconciliation && priced.length > 0 ? (
          <p className="mr-math-body mr-math-tnum mr-math-reconcile" data-testid="math-reconcile" data-matches={reconciliation.matches ? 'true' : 'false'}>
            {reconciliation.matches
              ? (() => {
                  const f = footMoney({ whpM: reconciliation.whpM, paidM: reconciliation.paidM, savedM: reconciliation.savedM });
                  return t('receiptView.math.reconcileMatch', { whp: formatMoney(f.whpM), paid: formatMoney(f.paidM), saved: formatMoney(f.savedM) });
                })()
              : t('receiptView.math.reconcileDiffer', {
                  rows: formatMoney(reconciliation.savedM),
                  saved: formatMoney(figures.savedM),
                  gap: formatMoney(Math.abs(reconciliation.gapM)),
                })}
          </p>
        ) : null}
      </Section>

      <Section title={t('receiptView.math.measuredTitle')}>
        <p className="mr-math-body">{t(BASIS_KEYS[attribution] ?? BASIS_KEYS.route)}</p>
      </Section>

      <Section title={t('receiptView.math.unitsTitle')}>
        <p className="mr-math-body mr-math-tnum">{t('receiptView.math.gbLine')}</p>
        <p className="mr-math-body">{t('receiptView.math.roundingLine')}</p>
      </Section>

      {figures.period === 'annualized' && !range ? (
        <Section title={t('receiptView.math.annualizedTitle')}>
          <p className="mr-math-body mr-math-tnum">
            {days >= 1
              ? t('receiptView.math.annualizedLine', { n: days, amount: formatMoney(figures.savedM) })
              : t('receiptView.math.annualizedPartialLine', { amount: formatMoney(figures.savedM) })}
          </p>
          <p className="mr-math-body">
            {t(figures.derivedFrom === 'ratio' ? 'receiptView.math.annualizedRatioNote' : 'receiptView.math.annualizedTrendNote')}
          </p>
        </Section>
      ) : null}

      <Section title={t('receiptView.math.liveTitle')}>
        {range ? (
          <p className="mr-math-body">{t('receiptView.math.rangeLiveStatic')}</p>
        ) : figures.accrues ? (
          <LiveLine savedM={figures.savedM} sweepAtMs={sweepAtMs} ratePerSecM={ratePerSecM} tz={tz} />
        ) : (
          <p className="mr-math-body">{t('receiptView.math.liveStatic')}</p>
        )}
      </Section>
    </div>
  );
}

export function MathDrawer(props: MathDrawerProps) {
  const narrow = useNarrow();
  const { isOpen, onClose } = props;
  if (narrow) {
    return (
      <Modal
        isOpen={isOpen}
        onIsOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={t('receiptView.math.title')}
        size="sm"
        confirmButtonText={t('receiptView.math.close')}
        cancelButtonText={null}
        onConfirm={onClose}
      >
        <MathContent {...props} />
      </Modal>
    );
  }
  return (
    <Drawer
      isOpen={isOpen}
      onClose={() => onClose()}
      title={t('receiptView.math.title')}
      width={560}
      footer={
        <div className="mr-math-footer">
          <Button variant="secondary" onPress={onClose}>
            {t('receiptView.math.close')}
          </Button>
        </div>
      }
    >
      <MathContent {...props} />
    </Drawer>
  );
}
