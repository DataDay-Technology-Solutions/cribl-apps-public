// src/views/Receipt/model.ts — what the Receipt view reads from a snapshot, as pure functions (unit-tested
// in tests/unit/meter-model.test.ts). No formatting beyond labels; money stays integer millicents.
//
// The snapshot's headline carries saved / would-have-paid / paid for today, month to date and the last
// 30 days, but only the SAVED figure of the annualized run rate. Its would-have-paid and paid are derived
// here from the same days the headline annualized (snapshot.trend), each scaled by saved's own factor, so the
// receipt bar and Show the math agree with the hero to the dollar.

import { footColumn, footMoney, MC_PER_DOLLAR, roundToDollarsM, shownUnderOneDollar } from '../../../core/format.ts';
import type {
  Counterfactual,
  DestinationFigures,
  HeadlinePeriod,
  Incident,
  PricesDoc,
  Snapshot,
  TrendPoint,
  WeeklyReceipt,
} from '../../../core/types.ts';
import { MINUTES_PER_YEAR, effectivePrices, priceEntryAt, ratio, priceChangeAt } from '../../../core/pricing.ts';
import { humanize } from '../../../core/humanize.ts';
import { criblCostCents, meteredSpan, netOfCribl, type NetOfCribl } from '../../../core/net.ts';
import { isCustomPrice, presetById, suggestCriblCost } from '../../../core/presets.ts';
import {
  DAY_MS,
  addDaysToKey,
  fromIso,
  localDayKey,
  localDayStartMs,
  localMidnightMs,
  localMonthKey,
  localMonthStartMs,
  toIso,
  weekRangeLabel,
} from '../../../core/time.ts';
import { severityRank, titleFor } from '../../../core/incidents.ts';
import { buildWeeklyReceipt } from '../../../core/receipt.ts';
import { rangeSpanLabel, type RangeFigures } from '../../../core/range.ts';
import { changePct, weekFromTrend, weekWindow } from '../../../core/goal.ts';
import { isOtherFlow, type SnapshotFold } from '../../state/selectors.ts';

export const PERIOD_ORDER: readonly HeadlinePeriod[] = ['mtd', 'today', '30d', 'annualized'];

/**
 * How the annualized would-have-paid and paid were derived (annualizedParts): scaled by saved over the rate's own days
 * ('trend') or a period's triple ('ratio'), or, when the rate saved nothing, their own run rates ('rate', 1.1.4).
 */
export type AnnualizedDerivation = 'trend' | 'ratio' | 'rate';

export interface PeriodFigures {
  period: HeadlinePeriod;
  savedM: number;
  whpM: number;
  paidM: number;
  /** saved ÷ would have paid, [0, 1] */
  ratio: number;
  /** Whether the figure accrues second by second (the annualized run rate is a whole-day rate; it doesn't). */
  accrues: boolean;
  /** For 'annualized': how would-have-paid / paid were derived. */
  derivedFrom?: AnnualizedDerivation;
  /** For 'annualized': the whole days behind the rate (fractional while under one day). */
  annualizedDays?: number;
}

// The Receipt's view zone (r2 ui-3) lives in src/lib/zone.ts since r3 ui-1, so the Report, the Ledger and the incident
// cards share it; re-exported here for its existing callers.
export { receiptZone } from '../../lib/zone.ts';

/**
 * The local days the annualized run rate is built from (core computeHeadline, REVIEW-3a #6): the last 30 local
 * days, today included, from the day collecting began. Oldest first.
 */
export function annualizedDays(snapshot: Snapshot, tz: string): TrendPoint[] {
  const sweepMs = fromIso(snapshot.sweepAt);
  const today = Number.isFinite(sweepMs) ? localDayKey(sweepMs, tz) : undefined;
  const sinceMs = fromIso(snapshot.collectingSince);
  const sinceKey = Number.isFinite(sinceMs) ? localDayKey(sinceMs, tz) : undefined;
  const first = today ? addDaysToKey(today, -29) : undefined;
  return (snapshot.trend ?? []).filter(
    (p) => (today === undefined || p.day <= today) && (first === undefined || p.day >= first) && (sinceKey === undefined || p.day >= sinceKey),
  );
}

/**
 * Annualized would-have-paid and paid, consistent with `headline.annualizedM`.
 * The run rate is Σ saved ÷ Σ metered minutes × 525,600 over those days; would-have-paid and paid over the same
 * days and minutes scale by the same factor (founder-build r2 ui-1, BO-3: one factor for all three), so each is the
 * rate × (Σ part ÷ Σ saved) — exact whenever the trend holds those days ('trend'). Otherwise the rate is split by the
 * last 30 days', today's or the month's own triple ('ratio'). Saved always equals the headline.
 *
 * Paid is never derived as would-have-paid − saved: a destination whose counterfactual is "none" is paid for and saves
 * nothing, so that difference hid its spend (EX3 printed Paid $146,000 for $255,500). Printed through footMoney
 * (D53), paid is the printed difference only when the exact triple foots.
 *
 * 1.1.4 (judge path g): a rate that saved nothing has no saved figure to scale by. Would-have-paid and paid are then
 * their own run rates over the same metered minutes, as core computeHeadline records them ('rate'), so a plain Datagen
 * with no Drop reads what it pays a year and 0% saved, never "You would have paid $0 · You paid $0". A snapshot without
 * those rates (written before 1.1.4, rewritten by the next sweep) keeps the arithmetic below: nothing is guessed.
 */
export function annualizedParts(snapshot: Snapshot, tz: string): { whpM: number; paidM: number; derivedFrom: AnnualizedDerivation } {
  const h = snapshot.headline;
  const days = annualizedDays(snapshot, tz);
  const whp = days.reduce((s, d) => s + d.whpM, 0);
  const paid = days.reduce((s, d) => s + d.paidM, 0);
  const saved = days.reduce((s, d) => s + d.savedM, 0);
  if (whp > 0 && saved > 0 && h.annualizedM > 0) {
    return { whpM: Math.round((h.annualizedM * whp) / saved), paidM: Math.max(0, Math.round((h.annualizedM * paid) / saved)), derivedFrom: 'trend' };
  }
  // The window the fallback splits the rate by: the last 30 days, else today, else month to date (as before).
  const w =
    h.whp30dM > 0
      ? { savedM: h.d30M, whpM: h.whp30dM, paidM: h.paid30dM }
      : h.whpTodayM > 0
        ? { savedM: h.todayM, whpM: h.whpTodayM, paidM: h.paidTodayM }
        : { savedM: h.mtdM, whpM: h.whpMtdM, paidM: h.paidMtdM };
  if (w.savedM > 0 && w.whpM > 0 && h.annualizedM > 0) {
    const k = h.annualizedM / w.savedM;
    return { whpM: Math.round(k * w.whpM), paidM: Math.max(0, Math.round(k * w.paidM)), derivedFrom: 'ratio' };
  }
  const ownWhp = h.annualizedWhpM;
  const ownPaid = h.annualizedPaidM;
  if (!(h.annualizedM > 0) && typeof ownWhp === 'number' && Number.isFinite(ownWhp) && typeof ownPaid === 'number' && Number.isFinite(ownPaid)) {
    return { whpM: Math.max(0, Math.round(ownWhp)), paidM: Math.max(0, Math.round(ownPaid)), derivedFrom: 'rate' };
  }
  const r = h.whp30dM > 0 ? ratio(h.d30M, h.whp30dM) : h.whpTodayM > 0 ? ratio(h.todayM, h.whpTodayM) : h.ratioMtd;
  const whpM = r > 0 ? Math.round(h.annualizedM / r) : h.annualizedM;
  return { whpM, paidM: Math.max(0, whpM - h.annualizedM), derivedFrom: 'ratio' };
}

/** Saved / would-have-paid / paid for the selected period. */
export function periodFigures(snapshot: Snapshot, period: HeadlinePeriod, tz: string): PeriodFigures {
  const h = snapshot.headline;
  switch (period) {
    case 'today':
      return { period, savedM: h.todayM, whpM: h.whpTodayM, paidM: h.paidTodayM, ratio: ratio(h.todayM, h.whpTodayM), accrues: true };
    case '30d':
      return { period, savedM: h.d30M, whpM: h.whp30dM, paidM: h.paid30dM, ratio: ratio(h.d30M, h.whp30dM), accrues: true };
    case 'annualized': {
      const parts = annualizedParts(snapshot, tz);
      return {
        period,
        savedM: h.annualizedM,
        whpM: parts.whpM,
        paidM: parts.paidM,
        ratio: ratio(h.annualizedM, parts.whpM),
        accrues: false,
        derivedFrom: parts.derivedFrom,
        annualizedDays: h.annualizedFromDays,
      };
    }
    default:
      return { period: 'mtd', savedM: h.mtdM, whpM: h.whpMtdM, paidM: h.paidMtdM, ratio: h.ratioMtd, accrues: true };
  }
}

/** When the period began (local), or undefined for the run rate. */
export function periodStartMs(period: HeadlinePeriod, nowMs: number, tz: string): number | undefined {
  switch (period) {
    case 'today':
      return localMidnightMs(nowMs, tz);
    case 'mtd':
      return localMonthStartMs(nowMs, tz);
    case '30d':
      return localDayStartMs(addDaysToKey(localDayKey(nowMs, tz), -29), tz);
    default:
      return undefined;
  }
}

/** True when metering began after the period did — the caption then says "collecting since …" (SPEC 8). */
export function collectingAfterStart(period: HeadlinePeriod, snapshot: Snapshot, tz: string): boolean {
  const since = fromIso(snapshot.collectingSince);
  const now = fromIso(snapshot.sweepAt);
  if (!Number.isFinite(since) || !Number.isFinite(now)) return false;
  const start = periodStartMs(period, now, tz);
  return start !== undefined && since > start;
}

/**
 * The Receipt's landing period when the URL names none (P1-H08): the settings default — the annualized run rate for a
 * new install since founder-build r2 ui-2 (named item (a); a projection with its pill while under a day) — and, for a
 * member whose settings chose month to date (a stored 'mtd' is never migrated), the run rate still while the workspace
 * is under a day old: month to date would be the first hour's few dollars.
 */
export function landingPeriod(snapshot: Snapshot, settingsDefault: HeadlinePeriod | undefined): HeadlinePeriod {
  const fallback = settingsDefault ?? 'mtd';
  const since = fromIso(snapshot.collectingSince);
  const sweep = fromIso(snapshot.sweepAt);
  if (fallback !== 'mtd' || !Number.isFinite(since) || !Number.isFinite(sweep)) return fallback;
  return sweep - since < DAY_MS && snapshot.headline.annualizedM > 0 ? 'annualized' : fallback;
}

/**
 * Net after Cribl as it prints (founder-build r1 ui-8, FINDINGS_R1 m9; D53's footing rule): the saved figure as printed
 * minus the cost as printed, so "saved − cost = net" always adds up to the dollar ("$597,932 − $220,546 = $377,386",
 * never $377,387 from the unrounded net). `netM` and `costM` as core/net.ts returns them (saved = net + cost).
 */
export function printedNetM(netM: number, costM: number): number {
  return roundToDollarsM(netM + costM) - roundToDollarsM(costM);
}

/** A non-zero amount fmtDollars prints '< $1' (it rounds to $0). */
function underOneDollarShown(mc: number): boolean {
  return Number.isFinite(mc) && mc !== 0 && roundToDollarsM(mc) === 0;
}

/**
 * Rows printed under column totals (founder-build r1 ui-8, m10): would have paid and saved each footed to their
 * total as printed (core/format.ts footColumn), paid the difference on every row — so every column sums to the
 * "These rows add up to …" sentence and every row still reads would have paid − paid = saved. A row can take a
 * dollar from its neighbour, never below $0 paid.
 *
 * Final 1.1.4 (FINDINGS_R4 #1): a row with real spend never prints "Paid $0", just as the formula line above the rows
 * (footMoney) never does. When a row's would have paid and saved foot to the same dollar, a spend under a dollar prints
 * '< $1' ("$2 − < $1 = $2", the formula line's own form). A spend of a dollar or more moves a dollar of the row's saved
 * to the row with the most room, so the column still adds up; when no row has room, the dollar comes off the column.
 */
export function footRows(rows: readonly MoneyTripleM[], total: MoneyTripleM): MoneyTripleM[] {
  const whp = footColumn(rows.map((r) => r.whpM), total.whpM);
  const saved = footColumn(rows.map((r) => r.savedM), total.savedM);
  // A row never saves more than it would have paid: a dollar the saved column's rounding put above a row's would-have-
  // paid moves to the row with the most room (still the column's total, never below $0 paid).
  for (let i = 0; i < rows.length; i++) {
    while (saved[i] > whp[i]) {
      let best = -1;
      for (let j = 0; j < rows.length; j++) if (j !== i && whp[j] - saved[j] >= 100_000 && (best < 0 || whp[j] - saved[j] > whp[best] - saved[best])) best = j;
      if (best < 0) {
        saved[i] = whp[i];
        break;
      }
      saved[i] -= 100_000;
      saved[best] += 100_000;
    }
  }
  const paid = rows.map((_, i) => whp[i] - saved[i]);
  // Final 1.1.4 (integration): a saved line kept at its exact amount of $0.50 prints "$1", and the difference then rounds
  // half up to the would have paid's own dollar ("$1 − $1 = $1", "$4 − $4 = $1"). When no figure on the row prints
  // '< $1' and the printed row does not add up, paid is the printed difference; a $0 left beside real spend is then
  // handled below like any other ("$1 − < $1 = $1", footMoney's own form for the same triple).
  for (let i = 0; i < rows.length; i++) {
    if (underOneDollarShown(whp[i]) || underOneDollarShown(paid[i]) || underOneDollarShown(saved[i])) continue;
    const printedPaid = roundToDollarsM(whp[i]) - roundToDollarsM(saved[i]);
    if (roundToDollarsM(paid[i]) !== printedPaid) paid[i] = printedPaid;
  }
  const whole = (mc: number): boolean => mc % MC_PER_DOLLAR === 0;
  for (let i = 0; i < rows.length; i++) {
    const spend = rows[i].paidM;
    if (!(spend > 0) || paid[i] !== 0) continue;
    if (spend < MC_PER_DOLLAR) {
      paid[i] = shownUnderOneDollar(spend);
      continue;
    }
    if (!whole(saved[i]) || saved[i] < MC_PER_DOLLAR) {
      // Not a split of whole dollars (would have paid under the spend): the spend prints its own rounding.
      paid[i] = roundToDollarsM(spend);
      continue;
    }
    // A donor keeps a dollar of paid when it has a dollar or more of real spend, so the "$0" never moves to another row.
    // A donor whose real spend is under a dollar may give its printed dollar away: it then prints '< $1' (below), the
    // form footMoney prints for its own triple. Final 1.1.4 (integration): holding that dollar left no donor for a row
    // with $1.00 of spend beside one with a fraction of a cent, and the saved column came up a dollar short.
    let best = -1;
    for (let j = 0; j < rows.length; j++) {
      if (j === i || !whole(saved[j]) || !whole(paid[j])) continue;
      if (paid[j] - MC_PER_DOLLAR < (rows[j].paidM >= MC_PER_DOLLAR ? MC_PER_DOLLAR : 0)) continue;
      if (best < 0 || paid[j] > paid[best]) best = j;
    }
    saved[i] -= MC_PER_DOLLAR;
    paid[i] += MC_PER_DOLLAR;
    if (best >= 0) {
      saved[best] += MC_PER_DOLLAR;
      paid[best] -= MC_PER_DOLLAR;
    }
  }
  // A donor that gave its only printed dollar away and has real spend under a dollar prints it '< $1', never "Paid $0".
  for (let i = 0; i < rows.length; i++) {
    const spend = rows[i].paidM;
    if (paid[i] === 0 && spend > 0 && spend < MC_PER_DOLLAR) paid[i] = shownUnderOneDollar(spend);
  }
  return rows.map((_, i) => ({ whpM: whp[i], paidM: paid[i], savedM: saved[i] }));
}

/**
 * Each priced destination's month to date as Show the math and its statement both print it (founder-build r2 ui-8,
 * FINDINGS_R2 #9 / #10): footed to the reconciliation's totals when the rows add up to the hero (m10, footRows), else
 * each row on its own (footMoney). One selector, so the drawer and the statement never print a destination a dollar
 * apart. Keyed by the row's key (`groupId:outputId`).
 */
export function footedMtdRows(
  rows: readonly { key: string; unpriced?: boolean; mtdWhpM?: number; mtdPaidM?: number; mtdSavedM?: number }[],
  reconciliation: Pick<MtdReconciliation, 'whpM' | 'paidM' | 'savedM' | 'matches'> | undefined,
): Map<string, MoneyTripleM> {
  const priced = rows.filter((r) => !r.unpriced);
  const triples = priced.map((r) => ({ whpM: r.mtdWhpM ?? 0, paidM: r.mtdPaidM ?? 0, savedM: r.mtdSavedM ?? 0 }));
  const footed = reconciliation?.matches ? footRows(triples, reconciliation) : triples.map((m) => footMoney(m));
  return new Map(priced.map((r, i) => [r.key, footed[i]]));
}

/**
 * A statement month as it prints (r2 ui-8): the snapshot's own month to date reads exactly as Show the math prints it
 * (`drawer`, from footedMtdRows); any other month — last month, or a running total that moved on — foots on its own.
 */
export function footedMonth<M extends MoneyTripleM>(month: M | undefined, snapshotMonth: MoneyTripleM | undefined, drawer: MoneyTripleM | undefined): M | undefined {
  if (!month) return undefined;
  const same = snapshotMonth !== undefined && month.whpM === snapshotMonth.whpM && month.paidM === snapshotMonth.paidM && month.savedM === snapshotMonth.savedM;
  return same && drawer ? { ...month, ...drawer } : { ...month, ...footMoney(month) };
}

/**
 * An aside line's whole dollars (founder-build r2 ui-8, FINDINGS_EXTRA BO-7): what the hero's meter would print for that
 * period — floored while it ticks (motion allowed, a rate, a period that accrues), as its wheels show it; half up when it
 * is static (reduced motion, a rate of 0, the run rate), as fmtDollars prints it everywhere else (r1 ui-8 m12).
 */
export function asideWholeM(period: HeadlinePeriod, savedM: number, ticking: boolean): number {
  const v = Math.max(0, Number.isFinite(savedM) ? savedM : 0);
  return ticking && period !== 'annualized' ? Math.floor(v / 100_000) * 100_000 : roundToDollarsM(v);
}

/** Would have paid, paid and saved, millicents. */
export interface MoneyTripleM {
  whpM: number;
  paidM: number;
  savedM: number;
}

/** Net after Cribl for the hero, the drawer and the copied receipt: the core figures plus what they cover. */
export interface NetBreakdown extends NetOfCribl {
  /** The monthly Cribl cost from settings, cents. */
  monthlyCostCents: number;
  /** 'year' for the annualized run rate (the cost is a year of Cribl); else the metered span of the period. */
  per?: 'year';
  /** When the span began: the later of the period's start and when collecting began (not for 'year'). */
  fromMs?: number;
  /** True when collecting began after the period did, so the span starts there. */
  sinceCollecting?: boolean;
  /** The sweep the figures are as of. */
  toMs: number;
}

/**
 * Net after Cribl and the payback multiple for the period (core/net.ts): saved − Cribl's cost over the same span.
 * The run rate is a year, so its cost is a year of Cribl; every other period's cost is prorated to the minutes
 * from the later of its start and when collecting began, to the sweep — the span its savings were metered in.
 * Null without a Cribl cost.
 */
export function netFigures(
  snapshot: Snapshot,
  period: HeadlinePeriod,
  criblCostCentsPerMonth: number | undefined,
  tz: string,
  opts: { frozen?: boolean } = {},
): NetBreakdown | null {
  const cents = criblCostCents(criblCostCentsPerMonth);
  if (cents === undefined) return null;
  const sweepMs = fromIso(snapshot.sweepAt);
  if (!Number.isFinite(sweepMs)) return null;
  if (period === 'annualized') {
    const net = netOfCribl(snapshot.headline.annualizedM, MINUTES_PER_YEAR, cents);
    return net ? { ...net, monthlyCostCents: cents, per: 'year', toMs: sweepMs } : null;
  }
  // Founder-build r2 ui-12 (FINDINGS_EXTRA BO-12): a frozen sample (the tour) moves its sweep to the wall clock while
  // its savings change only at a day boundary, so its cost covers the span those savings cover — the whole days before
  // today plus today's recorded minutes (headline.minutesToday, D49) — never the minutes the clock adds.
  const recordedToday = snapshot.headline?.minutesToday;
  const spanEnd =
    opts.frozen && typeof recordedToday === 'number' && Number.isFinite(recordedToday) && recordedToday > 0
      ? localMidnightMs(sweepMs, tz) + recordedToday * 60_000 // the recording's today, whatever the clock reads (M2)
      : sweepMs;
  const span = meteredSpan(periodStartMs(period, sweepMs, tz) ?? sweepMs, spanEnd, fromIso(snapshot.collectingSince));
  // Founder-build r1 ui-7 (FINDINGS_R1 M2): Today's cost covers the minutes its savings were metered in
  // (headline.minutesToday, D49's rule), not the wall-clock span. The sample tour's Today holds the recording's own
  // minutes whatever the clock reads, so a cost prorated from midnight to the wall clock paid for 21 hours against 11.7
  // hours of savings (1.8×), or for 30 minutes against 11.7 hours at 12:30 AM (74.6×). A workspace metering all day
  // has minutesToday ≈ that span; a snapshot without the field keeps the span.
  const minutesToday = snapshot.headline?.minutesToday;
  const minutes = period === 'today' && typeof minutesToday === 'number' && Number.isFinite(minutesToday) && minutesToday > 0 ? minutesToday : span.minutes;
  const net = netOfCribl(periodFigures(snapshot, period, tz).savedM, minutes, cents);
  return net ? { ...net, monthlyCostCents: cents, fromMs: span.fromMs, toMs: sweepMs, sinceCollecting: span.sinceCollecting } : null;
}

/**
 * What the workspace receives per day (current rates), for the implied $/GB beside Cribl's list price: Σ bytes in
 * over the flows, but only when every Source feeds exactly one flow. A Source on two routes is either cloned (a
 * non-final route: each flow carries all of its bytes, so the sum counts them twice — the sample tour's archive
 * routes) or split (final routes with filters: the sum is right), and the snapshot can't tell which, so then the
 * figure is undefined and Show the math prints the list price alone rather than a wrong rate.
 */
export function bytesInPerDay(snapshot: Snapshot): number | undefined {
  const flows = snapshot.flows ?? [];
  const seen = new Set<string>();
  let sum = 0;
  for (const f of flows) {
    const source = `${f.groupId}/${f.inputId}`;
    if (seen.has(source)) return undefined;
    seen.add(source);
    sum += Number.isFinite(f.inBPerDay) ? f.inBPerDay : 0;
  }
  return sum;
}

// ─── Cribl's cost at list price (usefulness review, rounds 1 and 2) ──────────

export interface CriblCostSuggestion {
  /** Bytes this workspace receives per day, at current rates (the Receipt's exact figure). */
  bytesInPerDay: number;
  /** Cribl's published list price per GB received, millicents (core/presets.ts CRIBL_STREAM_CLOUD_MILLICENTS_PER_GB). */
  listMcPerGb: number;
  /** GB/day × list × 365 ÷ 12 (core/presets.ts suggestCriblCost), rounded to whole dollars, in cents. */
  centsPerMonth: number;
}

/**
 * What this workspace's ingest would cost a month at Cribl's published Cloud Worker list price: core/presets.ts
 * suggestCriblCost on the bytes it receives per day, rounded to whole dollars. Only when that byte figure is exact
 * (every Source feeds one flow, bytesInPerDay) and there is traffic; otherwise undefined, and nothing is suggested
 * rather than a guess. A suggestion only: Settings offers it, the Receipt and the Report card show it as an estimate.
 */
export function criblCostSuggestion(snapshot: Snapshot | null | undefined): CriblCostSuggestion | undefined {
  if (!snapshot) return undefined;
  const bytes = bytesInPerDay(snapshot);
  if (bytes === undefined) return undefined;
  const s = suggestCriblCost(bytes);
  if (!s) return undefined;
  const centsPerMonth = Math.round(s.centsPerMonth / 100) * 100;
  return centsPerMonth > 0 ? { bytesInPerDay: bytes, listMcPerGb: s.milliCentsPerGb, centsPerMonth } : undefined;
}

/**
 * No Cribl cost is set (usefulness review, round 2: "did Cribl pay for itself?" was blank on a fresh install): the
 * net and payback for `period` at the list-price suggestion, labelled as an estimate wherever it shows. Undefined
 * when there is no suggestion (no exact byte figure, no traffic).
 */
export function listPriceEstimate(
  snapshot: Snapshot,
  period: HeadlinePeriod,
  tz: string,
): { suggestion: CriblCostSuggestion; net: NetBreakdown } | undefined {
  const suggestion = criblCostSuggestion(snapshot);
  if (!suggestion) return undefined;
  const net = netFigures(snapshot, period, suggestion.centsPerMonth, tz);
  return net ? { suggestion, net } : undefined;
}

// ─── Current rates (the hero's aside, the top savers' total lines) ─────────

/** What the flows save per day at current rates (the last hour × 24, the Top savers' basis): Σ flows' savedPerDayM. */
export function savedPerDayNowM(snapshot: Snapshot): number {
  return (snapshot.flows ?? []).reduce((s, f) => s + (Number.isFinite(f.savedPerDayM) && f.savedPerDayM > 0 ? f.savedPerDayM : 0), 0);
}

export interface SaverTotals {
  /** Σ saved per day over every saving flow (routes as core/snapshot groups them; a flow without a route alone). */
  allM: number;
  /** How many of those save anything (a folded snapshot's Other flow not counted: it is many flows). */
  count: number;
  /**
   * The snapshot folded its smaller flows into one Other flow that saves something (usefulness review, round 2): its
   * savings are in `allM`, and the receipt line says the rest includes them. The number it folds, when known.
   */
  folded?: { flows?: number };
}

/**
 * The Top savers' bottom lines (P1-H04): every saving flow together, grouped the way core/snapshot builds the
 * list (one line per route, its flows summed), so "N other flows" is the count the list left out.
 */
export function saverTotals(snapshot: Snapshot, fold?: SnapshotFold): SaverTotals {
  const byLine = new Map<string, number>();
  let otherM = 0;
  for (const f of snapshot.flows ?? []) {
    if (isOtherFlow(f)) {
      otherM += Number.isFinite(f.savedPerDayM) ? f.savedPerDayM : 0;
      continue;
    }
    const k = f.routeId && f.routeId !== '-' ? `${f.groupId}:${f.routeId}` : `flow:${f.key}`;
    byLine.set(k, (byLine.get(k) ?? 0) + (Number.isFinite(f.savedPerDayM) ? f.savedPerDayM : 0));
  }
  let allM = 0;
  let count = 0;
  for (const v of byLine.values()) {
    if (v > 0) {
      allM += v;
      count += 1;
    }
  }
  if (otherM > 0) return { allM: allM + otherM, count, folded: fold?.inOther !== undefined ? { flows: fold.inOther } : {} };
  return { allM, count };
}

// ─── Destinations ("Where the money goes", Show the math) ───────────────────

export interface DestinationRow {
  key: string;
  groupId: string;
  outputId: string;
  label: string;
  type: string;
  whpPerDayM: number;
  paidPerDayM: number;
  savedPerDayM: number;
  /** Month to date at this destination (core DestinationFigures.mtd*): Show the math's rows for MTD add up to the hero. */
  mtdWhpM?: number;
  mtdPaidM?: number;
  mtdSavedM?: number;
  inBPerDay: number;
  outBPerDay: number;
  /** this destination's price, millicents per GB */
  paidMcPerGb: number;
  /** the counterfactual's price, millicents per GB */
  whpMcPerGb: number;
  counterfactual: Counterfactual;
  /** label of the counterfactual target for 'other' */
  counterfactualLabel?: string;
  presetLabel?: string;
  /** The price is the member's own, not its preset's typical (P1-G01): Show the math says "Custom price". */
  customPrice?: boolean;
  /** P2-W24: who saved the price in force (the price version's changedBy), when known. */
  priceSetBy?: string;
  unpriced: boolean;
  /** P1-F01: the counterfactual destination has no price (`unpriced` is set too) */
  counterfactualUnpriced?: boolean;
  ratio: number;
}

/**
 * One row per destination, heaviest would-have-paid first; unpriced destinations last. Bytes per day are
 * summed from the flows feeding each destination; prices come from the prices document when present
 * (so the counterfactual's own price is exact), else from the snapshot's figures.
 */
/** `{ priceSetBy }` when the author is known, else nothing (exactOptionalPropertyTypes-safe). */
function optionalSetBy(user: string | undefined): { priceSetBy?: string } {
  return user ? { priceSetBy: user } : {};
}

export function destinationRows(snapshot: Snapshot, prices: PricesDoc | null, labels?: Record<string, string>): DestinationRow[] {
  const sweepMs = fromIso(snapshot.sweepAt);
  const byOutput = new Map<string, DestinationFigures>();
  for (const d of snapshot.destinations ?? []) byOutput.set(`${d.groupId}:${d.outputId}`, d);
  const bytes = new Map<string, { inB: number; outB: number }>();
  for (const f of snapshot.flows ?? []) {
    const k = `${f.groupId}:${f.outputId}`;
    const acc = bytes.get(k) ?? { inB: 0, outB: 0 };
    acc.inB += f.inBPerDay ?? 0;
    acc.outB += f.outBPerDay ?? 0;
    bytes.set(k, acc);
  }
  const rows: DestinationRow[] = [];
  for (const [key, d] of byOutput) {
    const eff = prices && Number.isFinite(sweepMs) ? effectivePrices(prices, d.groupId, d.outputId, sweepMs, d.type) : undefined;
    const counterfactual = eff?.counterfactual ?? d.counterfactual ?? { kind: 'same' };
    let whpMcPerGb = eff?.whpMcPerGb ?? d.milliCentsPerGb;
    if (!eff) {
      if (counterfactual.kind === 'none') whpMcPerGb = 0;
      else if (counterfactual.kind === 'other') whpMcPerGb = byOutput.get(`${d.groupId}:${counterfactual.outputId}`)?.milliCentsPerGb ?? d.milliCentsPerGb;
    }
    const entry = prices && Number.isFinite(sweepMs) ? priceEntryAt(prices, d.groupId, d.outputId, sweepMs) : undefined;
    const b = bytes.get(key) ?? { inB: 0, outB: 0 };
    rows.push({
      key,
      groupId: d.groupId,
      outputId: d.outputId,
      label: humanize(d.outputId, labels),
      type: d.type,
      whpPerDayM: d.whpPerDayM,
      paidPerDayM: d.paidPerDayM,
      savedPerDayM: d.savedPerDayM,
      mtdWhpM: d.mtdWhpM ?? 0,
      mtdPaidM: d.mtdPaidM ?? 0,
      mtdSavedM: d.mtdSavedM ?? 0,
      inBPerDay: b.inB,
      outBPerDay: b.outB,
      paidMcPerGb: eff?.paidMcPerGb ?? d.milliCentsPerGb,
      whpMcPerGb,
      counterfactual,
      counterfactualLabel: counterfactual.kind === 'other' ? humanize(counterfactual.outputId, labels) : undefined,
      presetLabel: presetById(entry?.preset)?.label,
      customPrice: isCustomPrice(entry),
      ...(prices && Number.isFinite(sweepMs) ? optionalSetBy(priceChangeAt(prices, d.groupId, d.outputId, sweepMs)?.changedBy) : {}),
      unpriced: d.unpriced,
      counterfactualUnpriced: eff?.counterfactualUnpriced ?? d.counterfactualUnpriced === true,
      ratio: ratio(d.savedPerDayM, d.whpPerDayM),
    });
  }
  return rows.sort(
    (a, b) =>
      Number(a.unpriced) - Number(b.unpriced) ||
      b.whpPerDayM - a.whpPerDayM ||
      b.paidPerDayM - a.paidPerDayM ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
}

/**
 * The destinations "Where the money goes" and Show the math list: every unpriced one (it needs a price), and
 * every priced one that carries money. A priced destination with no money in either column — a free output
 * such as the built-in devnull, or one with no traffic — is not a place the money goes.
 */
export function moneyDestinations(rows: DestinationRow[]): DestinationRow[] {
  return rows.filter((r) => r.unpriced || r.whpPerDayM > 0 || r.paidPerDayM > 0);
}

/**
 * The destinations Show the math lists for a period: month to date, every destination that carried money this
 * month (one idle now still holds part of the month's figure), heaviest month first; otherwise the same rows as
 * "Where the money goes", at current rates.
 */
export function mathDestinations(rows: DestinationRow[], period: HeadlinePeriod | 'custom'): DestinationRow[] {
  if (period !== 'mtd') return moneyDestinations(rows);
  return rows
    .filter((r) => r.unpriced || (r.mtdWhpM ?? 0) > 0 || (r.mtdPaidM ?? 0) > 0 || r.whpPerDayM > 0 || r.paidPerDayM > 0)
    .sort(
      (a, b) =>
        Number(a.unpriced) - Number(b.unpriced) ||
        (b.mtdWhpM ?? 0) - (a.mtdWhpM ?? 0) ||
        (b.mtdPaidM ?? 0) - (a.mtdPaidM ?? 0) ||
        (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    );
}

/** How the month-to-date destination rows add up against the hero's month-to-date figures (P1-F09). */
export interface MtdReconciliation {
  whpM: number;
  paidM: number;
  savedM: number;
  /** The hero's saved minus the rows' saved: money at destinations no longer listed (or rounding). */
  gapM: number;
  /** True when the rows reproduce the hero's saved within a dollar. */
  matches: boolean;
}

export function mtdReconciliation(rows: DestinationRow[], heroSavedM: number): MtdReconciliation {
  const whpM = rows.reduce((s, r) => s + (r.mtdWhpM ?? 0), 0);
  const paidM = rows.reduce((s, r) => s + (r.mtdPaidM ?? 0), 0);
  const savedM = rows.reduce((s, r) => s + (r.mtdSavedM ?? 0), 0);
  const gapM = heroSavedM - savedM;
  return { whpM, paidM, savedM, gapM, matches: Math.abs(gapM) < 100_000 };
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

/** Open incidents, most severe first, then newest. */
export function openIncidents(snapshot: Snapshot): Incident[] {
  return (snapshot.incidents ?? [])
    .filter((i) => !i.closedAt)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || fromIso(b.openedAt) - fromIso(a.openedAt));
}

/** Incidents closed in the snapshot's window (the last 24 h), newest close first. */
export function recentlyClosed(snapshot: Snapshot): Incident[] {
  return (snapshot.incidents ?? []).filter((i) => i.closedAt).sort((a, b) => fromIso(b.closedAt ?? '') - fromIso(a.closedAt ?? ''));
}

export interface WatchCoverage {
  /** Routes whose savings ratio the detector watches (core/sweep: regression per route). */
  routes: number;
  /** Sources whose paid $/hour it watches (spike per input). */
  sources: number;
  /** Destinations with a monthly budget (budget pace). */
  budgets: number;
}

/**
 * What "No open alerts" is a statement about (P1-H04): how much the detector is watching right now. The detector
 * watches every flow the sweep meters; a folded snapshot lists only the largest, so the inventory's counts stand in
 * for the listed ones when they are larger (usefulness review, round 2).
 */
export function watchCoverage(snapshot: Snapshot, budgets: Record<string, { centsPerMonth: number }> | undefined, fold?: SnapshotFold): WatchCoverage {
  const routes = new Set<string>();
  const sources = new Set<string>();
  for (const f of snapshot.flows ?? []) {
    if (isOtherFlow(f)) continue;
    if (f.routeId && f.routeId !== '-') routes.add(`${f.groupId}:${f.routeId}`);
    if (f.inputId && f.inputId !== '-') sources.add(`${f.groupId}:${f.inputId}`);
  }
  const budgetCount = Object.values(budgets ?? {}).filter((b) => b && b.centsPerMonth > 0).length;
  return {
    routes: Math.max(routes.size, fold?.routes ?? 0),
    sources: Math.max(sources.size, fold?.sources ?? 0),
    budgets: budgetCount,
  };
}

// ─── This week so far (P2-W20) ───────────────────────────────────────────────

/** What "This week so far" shows: figures from the range reader (live) or the daily totals (sample data). */
export interface WeekCardData {
  status: 'loading' | 'ready' | 'error';
  /** The summed window in words (core rangeSpanLabel). */
  span: string;
  /** The summed window, epoch ms. */
  fromMs?: number;
  toMs?: number;
  /** The window stops at the last whole hour (hour-granular reads). */
  throughLastHour?: boolean;
  savedM: number;
  /** What the week would have paid (founder-build r2 ui-13, IC-7: a week with traffic that saved nothing says so). */
  whpM?: number;
  /** Signed whole percent against the same span a week earlier; undefined when not comparable. */
  changePct?: number;
  /** Top lines by what saves them (live); undefined on sample data (no rollups to read). */
  lines?: { label: string; savedM: number }[];
  /** The weekly receipt as it would be sent now (for the Slack preview). */
  receipt?: WeeklyReceipt;
  sample: boolean;
}

/**
 * The week from the range reader's sums: the total and lines are exactly what "Copy receipt" would print for the
 * same window (core receiptTextForRange), and the comparison is the same span a week earlier — shown only when that
 * span was metered from its start (collecting began before it).
 */
export function weekFromRange(
  cur: RangeFigures,
  prior: RangeFigures | undefined,
  opts: { tz: string; labels?: Record<string, string>; collectingSinceMs?: number; incidents?: Incident[] },
): WeekCardData {
  const comparable = prior !== undefined && (opts.collectingSinceMs === undefined || opts.collectingSinceMs <= prior.fromMs);
  const receipt = buildWeeklyReceipt({
    periodStartMs: cur.fromMs,
    periodEndMs: cur.toMs,
    tz: opts.tz,
    flowSums: cur.byFlow,
    labels: opts.labels,
    ...(comparable ? { priorSavedM: prior.savedM } : {}),
    openIncidents: opts.incidents ?? [],
  });
  return {
    status: 'ready',
    span: rangeSpanLabel(cur.fromMs, cur.toMs, opts.tz),
    fromMs: cur.fromMs,
    toMs: cur.toMs,
    throughLastHour: cur.granularity !== 'minute',
    savedM: cur.savedM,
    whpM: cur.whpM,
    changePct: comparable ? changePct(cur.savedM, prior.savedM) : undefined,
    lines: receipt.lines,
    receipt: { ...receipt, savedM: cur.savedM },
    sample: false,
  };
}

/**
 * The week from the snapshot's daily totals — sample data without a reader, or a live Receipt while a custom range
 * is being read (one history read plan at a time) — the total, whole days compared, no line items.
 */
export function weekFromSnapshotTrend(snapshot: Snapshot, tz: string, sample = true): WeekCardData {
  const sweepMs = fromIso(snapshot.sweepAt);
  const w = weekWindow(sweepMs, tz);
  const since = fromIso(snapshot.collectingSince);
  const week = weekFromTrend(snapshot.trend ?? [], sweepMs, tz, Number.isFinite(since) ? since : undefined);
  const pct = week.compare ? changePct(week.compare.savedM, week.compare.priorSavedM) : undefined;
  const receipt: WeeklyReceipt = {
    periodStart: toIso(w.startMs),
    periodEnd: toIso(w.endMs),
    label: weekRangeLabel(w.startMs, w.endMs, tz),
    lines: [],
    savedM: week.savedM,
    whpM: week.whpM,
    paidM: week.paidM,
    ratio: ratio(week.savedM, week.whpM),
    openIncidents: (snapshot.incidents ?? []).filter((i) => !i.closedAt).map((i) => ({ title: titleFor(i) })),
    ...(week.compare ? { priorSavedM: week.compare.priorSavedM } : {}),
    ...(pct !== undefined ? { trendPct: pct } : {}),
  };
  return { status: 'ready', span: rangeSpanLabel(w.startMs, w.endMs, tz), fromMs: w.startMs, toMs: w.endMs, savedM: week.savedM, whpM: week.whpM, changePct: pct, receipt, sample };
}

// ─── A destination's statement (P2-W25) ─────────────────────────────────────

export interface StatementPriceRow {
  effectiveFromMs: number;
  mcPerGb: number;
  committedMcPerGb?: number;
  presetLabel?: string;
}

/**
 * The prices that applied to one destination, newest first: each version whose entry for it differs from the one
 * before (a version that re-states the same price for another destination's sake is not a change here). At most 5.
 */
export function statementPrices(prices: PricesDoc | null, groupId: string, outputId: string): StatementPriceRow[] {
  const versions = [...(prices?.versions ?? [])].sort((a, b) => fromIso(a.effectiveFrom) - fromIso(b.effectiveFrom));
  const out: StatementPriceRow[] = [];
  let last = '';
  for (const v of versions) {
    const e = v.byOutputId?.[`${groupId}:${outputId}`] ?? v.byOutputId?.[outputId];
    if (!e) continue;
    const sig = `${e.milliCentsPerGb}|${e.committedMilliCentsPerGb ?? ''}|${e.preset ?? ''}`;
    if (sig === last) continue;
    last = sig;
    out.push({
      effectiveFromMs: fromIso(v.effectiveFrom),
      mcPerGb: e.milliCentsPerGb,
      ...(e.committedMilliCentsPerGb !== undefined ? { committedMcPerGb: e.committedMilliCentsPerGb } : {}),
      ...(presetById(e.preset)?.label ? { presetLabel: presetById(e.preset)!.label } : {}),
    });
  }
  return out.reverse().slice(0, 5);
}

/** The month keys a statement reads from totals.byOutputMonth: this local month and the one before. */
export function statementMonths(sweepMs: number, tz: string): { thisKey: string; lastKey: string; thisStartMs: number; lastStartMs: number } {
  const thisStartMs = localMonthStartMs(sweepMs, tz);
  const lastStartMs = localMonthStartMs(thisStartMs - 1, tz);
  return { thisKey: localMonthKey(sweepMs, tz), lastKey: localMonthKey(lastStartMs, tz), thisStartMs, lastStartMs };
}

// ─── Deep links (SPEC 13) ────────────────────────────────────────────────────

/** The Cribl UI page for a pipeline: `<leader>/stream/m/<group>/pipelines/<id>`, or undefined without one. */
export function pipelineHref(groupId: string, pipelineId: string, origin: string): string | undefined {
  if (!groupId || !pipelineId || pipelineId === '-' || groupId === '-') return undefined;
  return `${origin.replace(/\/+$/, '')}/stream/m/${encodeURIComponent(groupId)}/pipelines/${encodeURIComponent(pipelineId)}`;
}

/** The Leader's origin: the window's own origin when installed (the app is served by the Leader). */
export function leaderOrigin(): string {
  try {
    return window.location.origin;
  } catch {
    return '';
  }
}
