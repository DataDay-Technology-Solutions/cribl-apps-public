// src/views/Receipt/text.ts — the Receipt's derived words: the hero's basis caption (SPEC 8, SPEC 17), the
// words of a custom range (core/range.ts) and the top savers as receipt lines with their deep links (SPEC 13).

import type { HeadlinePeriod, Snapshot, TopSaver } from '../../../core/types.ts';
import {
  RETENTION_MONTHS,
  planRangeReads,
  rangeDuration,
  rangeSpanLabel,
  resolveRange,
  type RangeFigures,
  type RangeGranularity,
  type RangeSpec,
  type ResolvedRange,
} from '../../../core/range.ts';
import { centsToMc, fmtBytes, footColumn, mcToDollarInput } from '../../../core/format.ts';
import { DAY_MS, formatLocalMonthDay, formatLocalTime, fromIso, localDayKey } from '../../../core/time.ts';
import { periodCoverage } from '../../../core/pricing.ts';
import { t, tn } from '../../copy/en.ts';
import { formatInt, formatMoney, formatMultiple, formatPct } from '../../lib/format.ts';
import type { ReceiptLine } from '../../components/ReceiptList/ReceiptList.tsx';
import type { ReceiptBarNet } from '../../components/ReceiptBar/ReceiptBar.tsx';
import type { ApiErrorInfo } from '../../state/store.ts';
import { collectingAfterStart, leaderOrigin, pipelineHref, type CriblCostSuggestion, type NetBreakdown, type SaverTotals } from './model.ts';

export const PERIOD_CAPTION: Record<HeadlinePeriod, () => string> = {
  mtd: () => t('meter.period.mtd'),
  today: () => t('meter.period.today'),
  '30d': () => t('meter.period.30d'),
  annualized: () => t('meter.period.annualized'),
};

/** "9:41 PM" when metering began today, else "Sep 24". */
function sinceLabel(sinceMs: number, nowMs: number, tz: string): string {
  return localDayKey(sinceMs, tz) === localDayKey(nowMs, tz) ? formatLocalTime(sinceMs, tz) : formatLocalMonthDay(sinceMs, tz);
}

/**
 * The basis line under the hero number (SPEC 8, SPEC 17), with how much of the period was metered when that is
 * not all of it (P0-23): "month to date · collecting since Sep 25 · 1,440 of 36,000 minutes metered (4%)".
 */
export function heroCaption(snapshot: Snapshot, period: HeadlinePeriod, tz: string): string {
  const h = snapshot.headline;
  if (period === 'annualized') {
    const days = Math.round(h.annualizedFromDays);
    if (h.annualizedFromDays >= 1) return tn('meter.annualizedFrom', days);
    // Under a day: a projection, from how many minutes (hours past the first) of traffic, as the presenter says it.
    const minutes = Number.isFinite(h.annualizedFromDays) ? Math.round(Math.max(0, h.annualizedFromDays) * 1440) : 0;
    if (minutes <= 0) return t('receiptView.annualizedPartial');
    return minutes < 60 ? tn('receiptView.annualizedProjectedMinutes', minutes) : tn('receiptView.annualizedProjectedHours', Math.floor(minutes / 60));
  }
  const parts = [PERIOD_CAPTION[period]()];
  if (collectingAfterStart(period, snapshot, tz)) parts.push(t('meter.collecting', { time: sinceLabel(fromIso(snapshot.collectingSince), fromIso(snapshot.sweepAt), tz) }));
  const cov = periodCoverage(h, period);
  if (cov && !cov.complete) {
    // Never rounds up to 100 % while minutes are missing, nor down to 0 % while any were metered.
    const floorPct = Math.floor(cov.ratio * 100);
    const pct = cov.metered > 0 && floorPct === 0 ? t('meter.coverageUnderOne') : formatPct(floorPct / 100);
    parts.push(tn('meter.coverage', cov.expected, { metered: formatInt(cov.metered), expected: formatInt(cov.expected), pct }));
  }
  return parts.join(' · ');
}

/** The Receipt ghost's one sentence for a snapshot that can't be read, by what went wrong (P1-H03). */
export function unavailableCaption(error: Pick<ApiErrorInfo, 'kind'>): string {
  switch (error.kind) {
    case 'forbidden':
      return t('receiptView.unavailableCaption');
    case 'rate-limited':
      return t('receiptView.unavailableCaptionRateLimited');
    case 'unauthorized':
      return t('receiptView.unavailableCaptionUnauthorized');
    default:
      return t('receiptView.unavailableCaptionServer');
  }
}

// ─── Custom range ────────────────────────────────────────────────────────────

/** "Sep 26, 10:00 AM–2:00 PM (4 h)" — the SUMMED window in the display timezone (core rangeSpanLabel). */
export function rangeWords(window: Pick<RangeFigures, 'fromMs' | 'toMs'>, tz: string, nowMs: number = Date.now()): string {
  const d = rangeDuration(window.fromMs, window.toMs);
  const duration =
    d.unit === 'minutes' ? t('meter.range.durationMinutes', { n: d.value }) : d.unit === 'hours' ? t('meter.range.durationHours', { n: d.value }) : tn('meter.range.durationDays', d.count, { n: d.value });
  return t('meter.range.words', { span: rangeSpanLabel(window.fromMs, window.toMs, tz, nowMs), duration });
}

export interface RangePreview {
  /** The window the spec would be summed over right now, in words. */
  words: string;
  granularity: RangeGranularity;
  /** The spec lies in the future: nothing to sum. */
  future: boolean;
  fromMs: number;
  toMs: number;
}

/**
 * What a spec means before (or without) reading it: the resolved, snapped and capped window and its
 * granularity, from the same pure rules the reader applies — the picker previews it, the hero shows its
 * words while the rows are still being read.
 */
export function rangePreview(spec: RangeSpec, nowMs: number, collectingSinceMs: number | undefined, tz: string): RangePreview {
  const resolved = resolveRange(spec, nowMs, collectingSinceMs);
  if (resolved.future) return { words: rangeWords(resolved, tz), granularity: 'minute', future: true, fromMs: resolved.fromMs, toMs: resolved.toMs };
  const plan = planRangeReads(resolved.fromMs, resolved.toMs, nowMs);
  return { words: rangeWords(plan.window, tz), granularity: plan.granularity, future: false, ...plan.window };
}

/** The picker's line under the fields: "Summed in whole hours as Sep 19, 2:00 PM–Sep 26, 2:00 PM (7 days)." */
export function rangePreviewLine(preview: RangePreview): string {
  if (preview.future) return t('meter.range.preview.future');
  return t(`meter.range.preview.${preview.granularity}`, { words: preview.words });
}

/**
 * The caption under a range's number: how exact the sum is ("minute-exact" / "whole hours · 1,380 of 1,440
 * minutes metered" / "whole UTC days · 6 of 7 days metered"), saying when the rows widened the exact window
 * that was asked for (a quick pick has no exact edges to widen: its window is the same length, moved to the
 * last whole hour) and when they stop short of it (the hour or UTC day in progress has no row yet); then
 * "collecting since …" when the start was clipped, "history is kept for 13 months" when it hit the retention,
 * "ends at the last whole minute" when the end was clipped, and that nothing was metered when no row fell inside.
 */
export function rangeCaption(figures: RangeFigures, resolved: ResolvedRange, spec: RangeSpec, snapshot: Pick<Snapshot, 'collectingSince' | 'sweepAt'>, tz: string): string {
  if (resolved.future) return `${t('meter.range.future')} · ${t('meter.range.empty')}`;
  const parts: string[] = [];
  const widened = spec.kind === 'absolute' && (figures.fromMs < resolved.fromMs || figures.toMs > resolved.toMs);
  const stoppedShort = figures.toMs < resolved.toMs;
  if (figures.granularity === 'minute') parts.push(t('meter.range.exactMinute'));
  else if (figures.granularity === 'hour') {
    const vars = { metered: formatInt(figures.minutesMetered ?? 0), expected: formatInt(figures.expectedMinutes) };
    parts.push(t(widened ? 'meter.range.exactHourWidened' : 'meter.range.exactHour', vars));
    if (stoppedShort) parts.push(t('meter.range.throughLastHour'));
  } else {
    const days = Math.max(1, Math.round((figures.toMs - figures.fromMs) / DAY_MS));
    parts.push(tn(widened ? 'meter.range.exactDayWidened' : 'meter.range.exactDay', days, { metered: formatInt(figures.daysMetered ?? 0) }));
    if (stoppedShort) parts.push(t('meter.range.throughLastDay'));
  }
  if (resolved.clippedRetention) parts.push(tn('meter.range.clippedRetention', RETENTION_MONTHS));
  if (resolved.clippedStart) {
    const since = fromIso(snapshot.collectingSince);
    const now = fromIso(snapshot.sweepAt);
    if (Number.isFinite(since)) parts.push(t('meter.collecting', { time: sinceLabel(since, Number.isFinite(now) ? now : since, tz) }));
  }
  if (resolved.clippedEnd && !stoppedShort) parts.push(t('meter.range.clippedEnd'));
  if (figures.rows === 0) parts.push(t('meter.range.empty'));
  return parts.join(' · ');
}

/** "≈ $1,240 a day at this rate", or undefined when nothing was metered (no rate to speak of). */
export function rangeRateLine(figures: RangeFigures): string | undefined {
  if (figures.ratePerDayM === undefined || figures.rows === 0) return undefined;
  return t('meter.range.rate', { amount: formatMoney(figures.ratePerDayM) });
}

// ─── Net after Cribl ─────────────────────────────────────────────────────────

const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** "25.4 days", "14.2 hours", "38 minutes": the span a net figure's Cribl cost is prorated to. */
export function netSpanWords(minutes: number): string {
  if (!(minutes > 0) || !Number.isFinite(minutes)) return tn('receiptView.netSpanMinutes', 0);
  if (minutes < 60) {
    const n = Math.max(1, Math.round(minutes));
    return tn('receiptView.netSpanMinutes', n);
  }
  const [value, key] = minutes < 1440 ? [minutes / 60, 'receiptView.netSpanHours' as const] : [minutes / 1440, 'receiptView.netSpanDays' as const];
  const text = oneDecimal.format(value);
  return tn(key, text === '1.0' ? 1 : 2, { n: text });
}

/** The hero's basis under the net: "Cribl cost $29,190, prorated to the 25.4 days metered" / "Cribl cost $52,572 a year". */
export function netBasisLine(net: Pick<NetBreakdown, 'costM' | 'minutes' | 'per'>): string {
  return net.per === 'year'
    ? t('receiptView.netBasisYear', { cost: formatMoney(net.costM) })
    : t('receiptView.netBasis', { cost: formatMoney(net.costM), span: netSpanWords(net.minutes) });
}

/** The estimate's payback, always marked "≈ … at list price" (usefulness review, round 2). */
export function estimatePaybackWords(paybackX: number): string {
  return paybackX >= 1
    ? t('receiptView.estimate.payback', { multiple: formatMultiple(paybackX) })
    : t('receiptView.estimate.paybackPartial', { pct: formatPct(Math.floor(Math.max(0, paybackX) * 100) / 100) });
}

/** "Estimate at Cribl's list price: 450.0 GB a day × $0.32 per GB ≈ $4,380 a month." */
export function estimateBasisLine(s: Pick<CriblCostSuggestion, 'bytesInPerDay' | 'listMcPerGb' | 'centsPerMonth'>): string {
  return t('receiptView.estimate.basis', {
    volume: fmtBytes(s.bytesInPerDay),
    list: `$${mcToDollarInput(s.listMcPerGb)}`,
    amount: formatMoney(centsToMc(s.centsPerMonth)),
  });
}

/**
 * The hero's net line: the set cost's net; with no cost set, the list-price estimate (usefulness review, round 2);
 * a cost saved from that estimate (`costIsEstimate`) keeps reading as an estimate, with the way to the contract cost.
 */
export function receiptNetLine(
  net: NetBreakdown | null,
  estimate: { suggestion: CriblCostSuggestion; net: NetBreakdown } | undefined,
  costIsEstimate = false,
): ReceiptBarNet | null {
  if (net) {
    return {
      netM: net.netM,
      paybackX: net.paybackX,
      per: net.per,
      paybackText: net.paybackX !== undefined ? (costIsEstimate ? estimatePaybackWords(net.paybackX) : paybackWords(net.paybackX)) : undefined,
      basis: costIsEstimate ? t('receiptView.estimate.basisSaved', { cost: formatMoney(centsToMc(net.monthlyCostCents)) }) : netBasisLine(net),
      ...(costIsEstimate ? { estimate: { href: '/settings?section=cost' } } : {}),
    };
  }
  if (!estimate) return null;
  return {
    netM: estimate.net.netM,
    paybackX: estimate.net.paybackX,
    per: estimate.net.per,
    paybackText: estimate.net.paybackX !== undefined ? estimatePaybackWords(estimate.net.paybackX) : undefined,
    basis: estimateBasisLine(estimate.suggestion),
    estimate: { href: '/settings?section=cost' },
  };
}

/** "Paid for itself 4.2×", or under 1× "Covered 40% of its cost" (a multiple below one isn't a payback). */
export function paybackWords(paybackX: number): string {
  // Floored, so a 99.6% share never reads "Covered 100%" while it is still short of paying for itself.
  return paybackX >= 1 ? t('receipt.payback', { multiple: formatMultiple(paybackX) }) : t('receipt.paybackPartial', { pct: formatPct(Math.floor(Math.max(0, paybackX) * 100) / 100) });
}

/**
 * Top savers as receipt lines: the amount per day (the card's caption names the unit, P1-H02), a deep link to the
 * pipeline in Cribl (none when `origin` is null: sample data, OQ-01), the saved share as a tooltip.
 */
export function topSaverLines(savers: TopSaver[], origin: string | null = leaderOrigin(), totals?: SaverTotals): ReceiptLine[] {
  const amounts = totals ? footedSavers(savers, totals).saversM : savers.map((s) => s.savedPerDayM);
  return savers.map((s, i) => {
    const href = origin === null ? undefined : pipelineHref(s.groupId, s.pipelineId, origin);
    return {
      id: s.objectKey,
      label: s.label,
      amountM: amounts[i],
      href,
      hrefLabel: href ? t('receiptView.topSavers.openInCribl', { label: s.label }) : undefined,
      // The saved share (saved ÷ would-have-paid: dollars at current rates).
      title: `${s.label} · ${t('receiptView.topSavers.savedShare', { pct: formatPct(s.ratio) })}`,
    };
  });
}

/**
 * The receipt's bottom lines under the Top savers (P1-H04), a list of their own (they are not savers): the flows
 * the list left out ("4 other flows"), then every flow together under the dotted rule. None for a single saver
 * that is every flow.
 */
export function saverTotalLines(savers: TopSaver[], totals: SaverTotals): ReceiptLine[] {
  if (savers.length === 0) return [];
  const lines: ReceiptLine[] = [];
  const otherCount = Math.max(0, totals.count - savers.length);
  const { othersM, totalM, hasOthers } = footedSavers(savers, totals);
  if (hasOthers) {
    // A folded snapshot (usefulness review, round 2): the rest includes the Other row's smaller flows, many flows in one.
    const folded = totals.folded;
    // (every saver outside the fold already listed: the line is the folded flows alone, never "0 other flows and …")
    const label = !folded
      ? tn('receiptView.topSavers.others', otherCount)
      : otherCount === 0
        ? folded.flows !== undefined
          ? tn('receiptView.topSavers.othersOnlyFolded', folded.flows, { n: formatInt(folded.flows) })
          : t('receiptView.topSavers.othersOnlyFoldedNoCount')
        : folded.flows !== undefined
          ? tn('receiptView.topSavers.othersFolded', otherCount, { n: formatInt(otherCount), folded: formatInt(folded.flows) })
          : tn('receiptView.topSavers.othersFoldedNoCount', otherCount, { n: formatInt(otherCount) });
    lines.push({ id: 'others', label, amountM: othersM, muted: true, testId: 'savers-others' });
  }
  if (savers.length > 1 || otherCount > 0 || totals.folded) {
    lines.push({ id: 'total', label: t('receiptView.topSavers.total'), amountM: totalM, total: true, testId: 'savers-total' });
  }
  return lines;
}

/**
 * The Top savers' amounts as printed: the "All flows" total is the anchor (the workspace's saved per day, as the
 * hero prints it) and the savers' lines, with "N other flows" when there is one, are footed to it to the dollar
 * (core/format.ts footColumn), so the lines above the dotted rule add up to the line under it.
 */
export function footedSavers(savers: TopSaver[], totals: SaverTotals): { saversM: number[]; othersM: number; totalM: number; hasOthers: boolean } {
  const shownM = savers.reduce((sum, s) => sum + s.savedPerDayM, 0);
  const otherCount = Math.max(0, totals.count - savers.length);
  const rawOthersM = Math.max(0, totals.allM - shownM);
  const hasOthers = (otherCount > 0 || totals.folded !== undefined) && rawOthersM > 0;
  const totalM = Math.max(totals.allM, shownM);
  const column = footColumn([...savers.map((s) => s.savedPerDayM), ...(hasOthers ? [rawOthersM] : [])], totalM);
  return { saversM: column.slice(0, savers.length), othersM: hasOthers ? column[savers.length] : 0, totalM, hasOthers };
}

/** Whether the hero's figure is a projection from less than a day of traffic (the annualized run rate, first day). */
export function heroIsProjection(snapshot: Snapshot, period: HeadlinePeriod): boolean {
  const days = snapshot.headline.annualizedFromDays;
  return period === 'annualized' && !(Number.isFinite(days) && days >= 1);
}
