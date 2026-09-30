// core/goal.ts — the Receipt's forward-looking pieces (P2-W20), pure and in integer millicents:
//
//   goalPace       a monthly savings goal (settings.savingsGoalCentsPerMonth) against month to date: what has been
//                  saved, where the month lands at the month-to-date rate, and whether that clears the goal;
//   weekWindow     this week so far (local Monday 00:00 → the sweep) and the same span a week earlier;
//   weekFromTrend  this week's saved from the snapshot's daily totals (sample data has no rollups to read),
//                  with the comparison over whole days only, so a partial today is never set against a full day;
//   priceBasis     whether every money-carrying destination is on a rate an admin entered (a contract rate or a
//                  committed price) or some still use a preset's typical list price.
//
// Abstain rather than guess: the projection needs an hour of metering this month, the comparison needs the prior
// span metered in full, and a destination with no price is not "on your contract rates".

import type { PricesDoc, TrendPoint } from './types.ts';
import { meteredSpan } from './net.ts';
import { signedWholePct } from './format.ts';
import { priceEntryAt } from './pricing.ts';
import { presetById } from './presets.ts';
import { DAY_MS, addDaysToKey, localDayKey, localDayStartMs, localMonthStartMs, localNextMonthStartMs } from './time.ts';

/** The projection needs this much of the month metered; before it, the strip shows the goal and what is saved. */
export const MIN_PACE_MINUTES = 60;

export interface GoalPace {
  /** The goal, millicents per month. */
  goalM: number;
  /** Saved month to date, millicents. */
  savedM: number;
  /** Saved by the end of the month at the month-to-date rate; undefined until MIN_PACE_MINUTES are metered. */
  projectedM?: number;
  /** projected − goal (negative when short); undefined without a projection. */
  gapM?: number;
  /** projected ≥ goal; undefined without a projection. */
  onPace?: boolean;
  /** Minutes metered this month (from the later of the month's start and when collecting began). */
  meteredMinutes: number;
  /** The month's last instant (exclusive end − 1 ms): "by Sep 30". */
  lastDayMs: number;
}

export interface GoalPaceInput {
  savedMtdM: number;
  goalCentsPerMonth: number | undefined;
  sweepMs: number;
  collectingSinceMs?: number;
  tz: string;
}

/**
 * The goal's pace: month to date's saved over the minutes metered this month is the rate; the month lands at
 * saved + rate × the minutes left. Undefined without a goal or a sweep time.
 */
export function goalPace(input: GoalPaceInput): GoalPace | undefined {
  const { savedMtdM, goalCentsPerMonth, sweepMs, collectingSinceMs, tz } = input;
  if (goalCentsPerMonth === undefined || !Number.isFinite(goalCentsPerMonth) || !(goalCentsPerMonth > 0)) return undefined;
  if (!Number.isFinite(sweepMs)) return undefined;
  const goalM = Math.round(goalCentsPerMonth * 1000);
  const savedM = Math.max(0, Number.isFinite(savedMtdM) ? savedMtdM : 0);
  const monthStart = localMonthStartMs(sweepMs, tz);
  const monthEnd = localNextMonthStartMs(sweepMs, tz);
  const span = meteredSpan(monthStart, sweepMs, collectingSinceMs);
  const out: GoalPace = { goalM, savedM, meteredMinutes: span.minutes, lastDayMs: monthEnd - 1 };
  if (span.minutes < MIN_PACE_MINUTES) return out;
  const leftMinutes = Math.max(0, monthEnd - sweepMs) / 60_000;
  const projectedM = Math.round(savedM + (savedM / span.minutes) * leftMinutes);
  return { ...out, projectedM, gapM: projectedM - goalM, onPace: projectedM >= goalM };
}

// ─── This week so far ────────────────────────────────────────────────────────

export interface WeekWindow {
  /** Local Monday 00:00 of the sweep's week. */
  startMs: number;
  /** The sweep. */
  endMs: number;
  /** The same span a week earlier. */
  priorStartMs: number;
  priorEndMs: number;
  /** Local day keys, Monday and today. */
  mondayKey: string;
  todayKey: string;
}

/** Local Monday of `dayKey`'s week (ISO weeks: Monday first). */
export function mondayOf(dayKey: string): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDaysToKey(dayKey, -((dow + 6) % 7));
}

export function weekWindow(sweepMs: number, tz: string): WeekWindow {
  const todayKey = localDayKey(sweepMs, tz);
  const mondayKey = mondayOf(todayKey);
  const startMs = localDayStartMs(mondayKey, tz);
  return { startMs, endMs: sweepMs, priorStartMs: startMs - 7 * DAY_MS, priorEndMs: sweepMs - 7 * DAY_MS, mondayKey, todayKey };
}

export interface WeekFromTrend {
  savedM: number;
  whpM: number;
  paidM: number;
  /** Days of this week the trend holds (today included). */
  days: number;
  /** Σ saved over this week's whole days (Monday → yesterday) and the same weekdays a week earlier; undefined when not comparable. */
  compare?: { savedM: number; priorSavedM: number; days: number };
}

/**
 * This week so far from the snapshot's daily totals (snapshot.trend, local days). The comparison sets this week's
 * whole days against the same weekdays a week earlier, and only when every one of those earlier days was metered
 * from its start (collecting began before the prior Monday).
 */
export function weekFromTrend(trend: readonly TrendPoint[], sweepMs: number, tz: string, collectingSinceMs?: number): WeekFromTrend {
  const w = weekWindow(sweepMs, tz);
  const byDay = new Map(trend.map((p) => [p.day, p]));
  let savedM = 0;
  let whpM = 0;
  let paidM = 0;
  let days = 0;
  for (let k = w.mondayKey; k <= w.todayKey; k = addDaysToKey(k, 1)) {
    const p = byDay.get(k);
    if (!p) continue;
    savedM += p.savedM;
    whpM += p.whpM;
    paidM += p.paidM;
    days++;
  }
  const out: WeekFromTrend = { savedM, whpM, paidM, days };
  const priorMonday = addDaysToKey(w.mondayKey, -7);
  const sinceOk = collectingSinceMs === undefined || !Number.isFinite(collectingSinceMs) || collectingSinceMs <= localDayStartMs(priorMonday, tz);
  if (!sinceOk || w.todayKey === w.mondayKey) return out;
  let cur = 0;
  let prior = 0;
  let n = 0;
  for (let k = w.mondayKey; k < w.todayKey; k = addDaysToKey(k, 1)) {
    const a = byDay.get(k);
    const b = byDay.get(addDaysToKey(k, -7));
    if (!a || !b) return out;
    cur += a.savedM;
    prior += b.savedM;
    n++;
  }
  if (n > 0 && prior > 0) out.compare = { savedM: cur, priorSavedM: prior, days: n };
  return out;
}

/**
 * Signed whole-percent change, or undefined without a base: +16 for 116 vs 100. R2 core-9 (BO-11): half up on the
 * magnitude, as fmtPct prints the comparison's change (−0.5 % → −1, never "0%" beside the comparison's "−1%").
 */
export function changePct(current: number, prior: number): number | undefined {
  if (!(prior > 0) || !Number.isFinite(current)) return undefined;
  return signedWholePct((current - prior) / prior);
}

// ─── Price basis (the confidence badge) ──────────────────────────────────────

export type PriceBasis = 'typical' | 'contract' | 'none';

/**
 * 'contract' when every destination that carries money is priced at a rate an admin entered — a price that is not
 * its preset's typical figure, or a committed price; 'typical' while any of them still uses a preset's typical
 * list price (or has no entry the prices document can name); 'none' when no destination carries money.
 */
export function priceBasis(prices: PricesDoc | null, destinations: readonly { groupId: string; outputId: string; unpriced?: boolean }[], atMs: number): PriceBasis {
  const priced = destinations.filter((d) => !d.unpriced);
  if (priced.length === 0) return 'none';
  if (!prices || !Number.isFinite(atMs)) return 'typical';
  for (const d of priced) {
    const entry = priceEntryAt(prices, d.groupId, d.outputId, atMs);
    if (!entry) return 'typical';
    if (entry.committedMilliCentsPerGb !== undefined && entry.committedMilliCentsPerGb > 0) continue;
    const preset = presetById(entry.preset);
    if (preset && preset.milliCentsPerGb === entry.milliCentsPerGb) return 'typical';
  }
  return 'contract';
}
