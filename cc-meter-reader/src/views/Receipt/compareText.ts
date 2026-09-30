// src/views/Receipt/compareText.ts — the words of "Compare with…" (P2-W13, core/range.ts planComparison /
// compareRanges): what each window is called, the change and what its percentage is a share of, the notes on how
// the two windows were made comparable, and why a comparison can't be made. Every string from src/copy/en.ts;
// money through the shared formatters.

import { rangeDuration, type CompareRefusalReason, type CompareSpec, type ComparisonPlan, type ComparisonRefusal, type RangeComparison, type RangeFigures, type RangeGranularity, printedDeltaM } from '../../../core/range.ts';
import { footMoney } from '../../../core/format.ts';
import { formatLocalMonthDay, formatLocalTime, localDayKey } from '../../../core/time.ts';
import { t, tn, type CopyKey } from '../../copy/en.ts';
import { formatMoney, formatPct } from '../../lib/format.ts';
import { rangeWords } from './text.ts';

/** A commit hash as it is shown: the first seven characters. */
export const shortHash = (hash: string): string => hash.slice(0, 7);

/** '7 days' · '24 h' · '45 min' — a window's length in the range's own words ("the previous 24 h", never "1 day"). */
export function durationWords(window: { fromMs: number; toMs: number }): string {
  const d = rangeDuration(window.fromMs, window.toMs);
  if (d.unit === 'minutes') return t('meter.range.durationMinutes', { n: d.value });
  if (d.unit === 'hours') return t('meter.range.durationHours', { n: d.value });
  if (d.count === 1) return t('meter.range.durationHours', { n: '24' });
  return tn('meter.range.durationDays', d.count, { n: d.value });
}

export interface CompareNames {
  /** In a sentence: 'the previous 7 days', 'the same window a week earlier', 'the time before a1f3c9e'. */
  name: string;
  /** "Compared with the previous 7 days" */
  eyebrow: string;
  /** The two bars' labels: 'This range' / 'The previous 7 days'; 'After a1f3c9e' / 'Before a1f3c9e'. */
  currentRow: string;
  baselineRow: string;
}

/** What the two windows are called, for a comparison of windows `window` long. */
export function compareNames(vs: CompareSpec, window: { fromMs: number; toMs: number }): CompareNames {
  const duration = durationWords(window);
  if (vs.kind === 'commit') {
    const hash = shortHash(vs.hash);
    const name = t('meter.range.compare.name.commit', { hash });
    return { name, eyebrow: t('meter.range.compare.eyebrow', { name }), currentRow: t('meter.range.compare.row.after', { hash }), baselineRow: t('meter.range.compare.row.before', { hash }) };
  }
  const name = vs.kind === 'week' ? t('meter.range.compare.name.week') : t('meter.range.compare.name.prev', { duration });
  const baselineRow = vs.kind === 'week' ? t('meter.range.compare.row.week') : t('meter.range.compare.row.prev', { duration });
  return { name, eyebrow: t('meter.range.compare.eyebrow', { name }), currentRow: t('meter.range.compare.row.current'), baselineRow };
}

/** An amount on the comparison's basis: '$1,832', or '$262 a day' when the windows are compared per day. */
export function basisMoney(cmp: Pick<RangeComparison, 'basis'>, amountM: number, opts: { signed?: boolean } = {}): string {
  const money = formatMoney(amountM, { signed: opts.signed });
  return cmp.basis === 'rate' ? t('meter.range.compare.perDay', { amount: money }) : money;
}

/** "$1,610 → $1,832" — the baseline, then the current window (A → B). */
export function fromToText(cmp: RangeComparison): string {
  return t('meter.range.compare.fromTo', { from: basisMoney(cmp, cmp.baselineM), to: basisMoney(cmp, cmp.currentM) });
}

/** "+$222 (+14%)", "−$95 a day (−6%)", "+$40" (the baseline saved nothing), or "No change". */
export function deltaText(cmp: RangeComparison): string {
  // The change as printed foots with the two figures as printed (r1 ui-8, m11): round(current) − round(baseline).
  const printed = printedDeltaM(cmp);
  if (cmp.direction === 'flat' || printed === 0) return t('meter.range.compare.flat');
  const amount = basisMoney(cmp, printed, { signed: true });
  return cmp.pct !== undefined ? t('meter.range.compare.delta', { amount, pct: formatPct(cmp.pct, { signed: true }) }) : amount;
}

/**
 * "Share of dollars saved 39% → 43% (+4 points)": the saved share of each window. The dollars can fall while the
 * share rises (less traffic, a better pipeline), so the chip's direction is never the whole story.
 */
export function shareLineText(cmp: RangeComparison): string {
  // The points are the difference of the two percentages as printed, so the line never contradicts itself
  // ("38% → 40% (+3 points)" when the unrounded shares were 37.56% and 40.35%, review W2).
  const shown = (ratio: number): number => Math.floor(Math.abs(ratio) * 100 + 0.5) * Math.sign(ratio);
  const diff = shown(cmp.current.ratio) - shown(cmp.baseline.ratio);
  const pts = Math.abs(diff);
  const sign = pts === 0 ? '' : diff > 0 ? '+' : '−';
  return t('meter.range.compare.shareLine', { from: formatPct(cmp.baseline.ratio), to: formatPct(cmp.current.ratio), points: `${sign}${tn('units.points', pts)}` });
}

/** What the change's percentage is a share of: "of what the previous 7 days saved" (a day, when per day). */
export function pctBasisText(cmp: RangeComparison, name: string): string {
  return t(cmp.basis === 'rate' ? 'meter.range.compare.pctBasisPerDay' : 'meter.range.compare.pctBasis', { name });
}

const GAP_BUCKET: Record<RangeGranularity, CopyKey> = {
  minute: 'meter.range.compare.notes.gapBucket.minute',
  hour: 'meter.range.compare.notes.gapBucket.hour',
  day: 'meter.range.compare.notes.gapBucket.day',
};

/**
 * How the two windows were made comparable, as caption segments: aligned to whole hours or UTC days (when the
 * current window moved for it), the deploy's bucket left out, compared per day, a baseline clipped at collecting.
 */
export function compareNotes(plan: ComparisonPlan, cmp: RangeComparison | undefined, tz: string): string[] {
  const notes: string[] = [];
  if (plan.realigned && plan.alignedTo === 'hour') notes.push(t('meter.range.compare.notes.realignedHour'));
  if (plan.realigned && plan.alignedTo === 'day') notes.push(t('meter.range.compare.notes.realignedDay'));
  if (plan.gap) {
    const span = `${formatLocalTime(plan.gap.fromMs, tz)}–${formatLocalTime(plan.gap.toMs, tz)}`;
    notes.push(t('meter.range.compare.notes.gap', { bucket: t(GAP_BUCKET[plan.alignedTo]), span }));
  }
  // Compared per day: say why, once (the earlier window starting before collecting is the usual reason).
  if (cmp?.basis === 'rate') notes.push(t(plan.baselineClipped ? 'meter.range.compare.notes.perDayClipped' : 'meter.range.compare.notes.perDay'));
  else if (plan.baselineClipped) notes.push(t('meter.range.compare.notes.clipped'));
  return notes;
}

const REFUSAL_KEY: Record<Exclude<CompareRefusalReason, 'too-many-reads'>, CopyKey> = {
  future: 'meter.range.compare.refused.future',
  'week-too-long': 'meter.range.compare.refused.weekTooLong',
  overlap: 'meter.range.compare.refused.overlap',
  'no-commit': 'meter.range.compare.refused.noCommit',
  'too-short': 'meter.range.compare.refused.tooShort',
  'before-collecting': 'meter.range.compare.refused.beforeCollecting',
};

/** Why a comparison can't be made, in one sentence. `sinceMs`: when collecting began (for 'before-collecting'). */
export function refusalText(refusal: ComparisonRefusal, tz: string, sinceMs?: number, nowMs?: number): string {
  const hash = refusal.vs.kind === 'commit' ? shortHash(refusal.vs.hash) : '';
  const since =
    sinceMs !== undefined && Number.isFinite(sinceMs)
      ? nowMs !== undefined && localDayKey(sinceMs, tz) === localDayKey(nowMs, tz)
        ? formatLocalTime(sinceMs, tz)
        : formatLocalMonthDay(sinceMs, tz)
      : '';
  if (refusal.reason === 'too-many-reads') return tn('meter.range.compare.refused.tooManyReads', refusal.reads ?? 0, { cap: String(refusal.cap ?? 0) });
  return t(REFUSAL_KEY[refusal.reason], { hash, since });
}

/** The picker's line for a planned comparison: "Compared with Sep 12, 2:00 PM–Sep 19, 2:00 PM (7 days)." */
export function comparePreviewLine(plan: ComparisonPlan, tz: string): string {
  return t('meter.range.compare.preview', { words: rangeWords(plan.baseline, tz) });
}

/**
 * One window's money under its bar: "Would have paid $5,204 · paid $2,602 · 50% saved" (a day at the rate when per
 * day). Printed money adds up: would have paid − paid = the row's saved, to the dollar (core/format.ts footMoney).
 */
export function barLine(cmp: Pick<RangeComparison, 'basis'>, money: { whpM: number; paidM: number; savedM: number; ratio: number }): string {
  const key = cmp.basis === 'rate' ? 'meter.range.compare.barLinePerDay' : 'meter.range.compare.barLine';
  const shown = footMoney(money);
  return t(key, { whp: formatMoney(shown.whpM), paid: formatMoney(shown.paidM), pct: formatPct(money.ratio) });
}

/** A window's money on the comparison's basis: its sums, or a day at its own rate. */
export function moneyOnBasis(cmp: Pick<RangeComparison, 'basis'>, f: RangeFigures, perDay: (f: RangeFigures, m: number) => number | undefined): { whpM: number; paidM: number; savedM: number; ratio: number } {
  if (cmp.basis !== 'rate') return { whpM: f.whpM, paidM: f.paidM, savedM: f.savedM, ratio: f.ratio };
  return { whpM: perDay(f, f.whpM) ?? 0, paidM: perDay(f, f.paidM) ?? 0, savedM: perDay(f, f.savedM) ?? 0, ratio: f.ratio };
}
