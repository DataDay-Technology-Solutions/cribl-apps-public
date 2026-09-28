// src/tour/rebase.ts — moves a recorded fixture onto the wall clock.
//
// The tour fixture is generated at a fixed instant (its `anchor`) and played days or months later.
// Shown as recorded it would say "last sweep 3 days ago" and a live "Caught in" clock would count
// from last week. So at play time every timestamp moves by one delta (wall clock − anchor):
//   · ISO instants ('2026-09-24T16:41:35.000Z') shift by the delta, keeping every gap between them
//     (commit → alert = 2:51, alert → Slack = 6 s) exactly as the detector produced it;
//   · local-day keys ('2026-09-24', the trend's days) shift by the whole days between the anchor's
//     local day and the wall clock's, both taken in the fixture's zone, so "today" stays today.
// Money, ratios and bytes never change — except the month-to-date figures, which rebaseHeadline recomputes
// from the moved trend: shifting the days can move the first of the month (recorded on the 24th and played on
// the 26th, month to date covers two more trend days than the recording did). Each destination's month to date
// moves with it, so the monthly statements add up to the hero.

import { ratio } from '../../core/pricing.ts';
import { mtdNetOfCribl } from '../../core/net.ts';
import { allot } from '../../core/sampleRollups.ts';
import { MINUTE_MS, addDaysToKey, daysBetweenKeys, fromIso, localDayKey, localMonthKey, localMonthStartMs } from '../../core/time.ts';
import type { DestinationFigures, Snapshot } from '../../core/types.ts';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export interface RebasePlan {
  /** ms to add to every ISO instant */
  deltaMs: number;
  /** whole days to add to every 'YYYY-MM-DD' key */
  dayShift: number;
}

/** The shift that makes `anchorMs` read as `wallMs`, with day keys counted in `tz`. */
export function planRebase(anchorMs: number, wallMs: number, tz: string): RebasePlan {
  if (!Number.isFinite(anchorMs) || !Number.isFinite(wallMs)) return { deltaMs: 0, dayShift: 0 };
  let dayShift = 0;
  try {
    dayShift = daysBetweenKeys(localDayKey(anchorMs, tz), localDayKey(wallMs, tz));
  } catch {
    dayShift = Math.round((wallMs - anchorMs) / 86_400_000);
  }
  return { deltaMs: wallMs - anchorMs, dayShift };
}

/** Shifts one string if it is an ISO instant or a day key; anything else is returned as is. */
export function rebaseString(value: string, plan: RebasePlan): string {
  if (value.length === 10 && DAY_KEY.test(value)) return plan.dayShift === 0 ? value : addDaysToKey(value, plan.dayShift);
  if (value.length >= 20 && value.length <= 24 && ISO_INSTANT.test(value)) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? value : new Date(ms + plan.deltaMs).toISOString();
  }
  return value;
}

/** A copy of `value` with every timestamp moved by `plan` (the value itself when the plan moves nothing). Plain JSON in, plain JSON out; never mutates. */
export function rebaseValue<T>(value: T, plan: RebasePlan): T {
  if (plan.deltaMs === 0 && plan.dayShift === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return rebaseString(v, plan);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * A rebased snapshot's month-to-date headline, recomputed the way core computeHeadline does: saved / would have
 * paid / paid summed over the trend days of the sweep's local month (in `tz`, the zone the day keys were moved
 * in), and — with a Cribl cost — net and payback against the cost prorated to the minutes metered this month
 * (core/net.ts mtdNetOfCribl, D49; the moved collectingSince bounds them), as the Receipt hero reads them.
 * Today, the last 30 days and the annual run rate are whole-day windows the shift keeps intact, so they stay
 * as recorded. The snapshot itself when its sweep time is unreadable.
 */
export function rebaseHeadline(snapshot: Snapshot, tz: string, criblCostCentsPerMonth: number | undefined): Snapshot {
  const sweepMs = fromIso(snapshot.sweepAt);
  if (!Number.isFinite(sweepMs) || !Array.isArray(snapshot.trend)) return snapshot;
  const todayKey = localDayKey(sweepMs, tz);
  const monthKey = localMonthKey(sweepMs, tz);
  let savedM = 0;
  let whpM = 0;
  let paidM = 0;
  for (const p of snapshot.trend) {
    if (!p.day.startsWith(monthKey) || p.day > todayKey) continue;
    savedM += p.savedM;
    whpM += p.whpM;
    paidM += p.paidM;
  }
  const recorded = snapshot.headline;
  const { netMtdM: _net, paybackX: _payback, ...rest } = recorded;
  const headline: Snapshot['headline'] = { ...rest, mtdM: savedM, whpMtdM: whpM, paidMtdM: paidM, ratioMtd: ratio(savedM, whpM) };
  const net = mtdNetOfCribl(savedM, sweepMs, tz, fromIso(snapshot.collectingSince), criblCostCentsPerMonth);
  if (net) {
    headline.netMtdM = net.netM;
    if (net.paybackX !== undefined) headline.paybackX = net.paybackX;
  }
  // By reduction and by diversion (P1-F02) still add up to the month's savings.
  if (recorded.reducedMtdM !== undefined && recorded.divertedMtdM !== undefined) {
    const [reduced, diverted] = allot(savedM, [recorded.reducedMtdM, recorded.divertedMtdM]);
    headline.reducedMtdM = reduced;
    headline.divertedMtdM = diverted;
  }
  // The month's minutes: the sample meters every minute, from the later of the first of the month and collecting.
  const windowEnd = fromIso(snapshot.windowEnd);
  const monthFrom = Math.max(localMonthStartMs(sweepMs, tz), fromIso(snapshot.collectingSince));
  const monthMinutes = Number.isFinite(windowEnd) && Number.isFinite(monthFrom) ? Math.max(0, Math.round((windowEnd - monthFrom) / MINUTE_MS)) : undefined;
  if (monthMinutes !== undefined && recorded.expectedMinutesMtd !== undefined && recorded.expectedMinutesMtd > 0) {
    headline.expectedMinutesMtd = monthMinutes;
    if (recorded.minutesMtd !== undefined) headline.minutesMtd = Math.round((recorded.minutesMtd * monthMinutes) / recorded.expectedMinutesMtd);
  }
  const destinations = rebaseDestinationMonths(snapshot.destinations, recorded, headline, monthMinutes);
  return { ...snapshot, headline, ...(destinations ? { destinations } : {}) };
}

/**
 * Each destination's month to date moved with the headline (review W2: the monthly statement read the recording's
 * September beside a re-summed hero): every figure scaled by the headline's own move and allotted by the recorded
 * shares, so the destinations still add up to the month the hero shows. Undefined when there are none.
 */
function rebaseDestinationMonths(
  destinations: DestinationFigures[] | undefined,
  recorded: Snapshot['headline'],
  moved: Snapshot['headline'],
  monthMinutes: number | undefined,
): DestinationFigures[] | undefined {
  if (!Array.isArray(destinations) || destinations.length === 0) return undefined;
  const scaled = (key: 'mtdPaidM' | 'mtdSavedM', from: number, to: number): number[] => {
    const weights = destinations.map((d) => (Number.isFinite(d[key]) ? d[key] : 0));
    const total = weights.reduce((a, b) => a + b, 0);
    return allot(from > 0 ? Math.round((total * to) / from) : total, weights);
  };
  const paid = scaled('mtdPaidM', recorded.paidMtdM, moved.paidMtdM);
  const saved = scaled('mtdSavedM', recorded.mtdM, moved.mtdM);
  // Would have paid = paid + saved, destination by destination, as the sweep writes it.
  const whp = paid.map((p, i) => p + saved[i]);
  const expected = recorded.expectedMinutesMtd;
  return destinations.map((d, i) => ({
    ...d,
    mtdWhpM: whp[i],
    mtdPaidM: paid[i],
    mtdSavedM: saved[i],
    ...(d.mtdMinutes !== undefined && monthMinutes !== undefined && expected !== undefined && expected > 0
      ? { mtdMinutes: Math.round((d.mtdMinutes * monthMinutes) / expected) }
      : {}),
  }));
}
