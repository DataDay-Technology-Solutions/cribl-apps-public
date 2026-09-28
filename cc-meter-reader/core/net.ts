// core/net.ts — net of Cribl: what Cribl saved minus what Cribl itself cost over the same span, and how many
// times it paid for itself (PRD 6 "gross headline; optional net", DECISIONS D48, D49). Pure; money in millicents.
//
// The Cribl cost is stored per month (settings.criblCostCentsPerMonth). It is a rate: × 12 months ÷ 525,600
// minutes gives a cost per minute over the same year the annualized run rate uses (D48 built the demo org's
// figure the same way: GB/day × $0.32 × 365 ÷ 12). A period's cost is that rate over the span its savings were
// metered — from the later of the period's start and when collecting began, to the sweep. Prorating by calendar
// day of the month instead would charge a workspace that began metering on the 26th for 26 days of Cribl
// against one day of savings, and report Cribl as not paying for itself.

import { MINUTES_PER_YEAR, localMonthStartMs } from './time.ts';

/**
 * Cribl's published Enterprise Cloud Worker list price per GB received, in millicents (DECISIONS D48:
 * 0.32 credits per GB processed at $1 per credit; Pricing Guide BGDE-0002, Nov 2025). Stream bills the bytes
 * it RECEIVES, so a pipeline's reduction lowers the destination's bill, not Cribl's.
 */
export const CRIBL_LIST_MC_PER_GB = 32_000;

const BYTES_PER_GB = 1e9;

export interface NetOfCribl {
  /** Cribl's cost over the span, millicents (rounded). */
  costM: number;
  /** saved − cost (may be negative). */
  netM: number;
  /** saved ÷ cost; undefined when the cost is 0. */
  paybackX?: number;
  /** The span the cost covers, in minutes. */
  minutes: number;
  /** Cribl's cost per day at this monthly figure (× 12 ÷ 365), millicents, unrounded. */
  costPerDayM: number;
}

/** A usable monthly cost in cents, or undefined (unset, zero, negative or not a number: no net line). */
export function criblCostCents(costCentsPerMonth: number | undefined): number | undefined {
  return costCentsPerMonth !== undefined && Number.isFinite(costCentsPerMonth) && costCentsPerMonth > 0 ? costCentsPerMonth : undefined;
}

/** Cribl's cost per minute, millicents (unrounded): monthly × 12 ÷ 525,600. */
export function criblCostPerMinuteM(costCentsPerMonth: number): number {
  return (costCentsPerMonth * 1000 * 12) / MINUTES_PER_YEAR;
}

/**
 * Net of Cribl for `savedM` metered over `minutes`: Cribl's cost for those same minutes, the net and the payback
 * multiple. Null without a usable cost or a span.
 */
export function netOfCribl(savedM: number, minutes: number, costCentsPerMonth: number | undefined): NetOfCribl | null {
  const cents = criblCostCents(costCentsPerMonth);
  if (cents === undefined || !Number.isFinite(savedM) || !(minutes > 0) || !Number.isFinite(minutes)) return null;
  const perMinute = criblCostPerMinuteM(cents);
  const exact = perMinute * minutes;
  const costM = Math.round(exact);
  const out: NetOfCribl = { costM, netM: savedM - costM, minutes, costPerDayM: perMinute * 1440 };
  if (exact > 0) out.paybackX = savedM / exact;
  return out;
}

/** The span a period's net covers (minutes, from when). */
export interface MeteredSpan {
  fromMs: number;
  minutes: number;
  /** True when collecting began after the period did, so the span starts there. */
  sinceCollecting: boolean;
}

/**
 * The minutes a period's savings were metered in: from the later of the period's start and when collecting
 * began, to `toMs` (the sweep). The Receipt's net and the Settings cost preview both prorate Cribl's cost to it.
 */
export function meteredSpan(periodStartMs: number, toMs: number, collectingSinceMs?: number): MeteredSpan {
  const since = collectingSinceMs !== undefined && Number.isFinite(collectingSinceMs) ? collectingSinceMs : Number.NEGATIVE_INFINITY;
  const fromMs = Math.max(periodStartMs, since);
  return { fromMs, minutes: Math.max(0, toMs - fromMs) / 60_000, sinceCollecting: fromMs > periodStartMs };
}

/**
 * What the monthly cost comes to per GB of the bytes this workspace receives per day (millicents per GB), so
 * Show the math can set it beside Cribl's list price; undefined without traffic.
 */
export function impliedCostPerGbM(costCentsPerMonth: number | undefined, bytesInPerDay: number): number | undefined {
  const cents = criblCostCents(costCentsPerMonth);
  if (cents === undefined || !(bytesInPerDay > 0) || !Number.isFinite(bytesInPerDay)) return undefined;
  return (criblCostPerMinuteM(cents) * 1440) / (bytesInPerDay / BYTES_PER_GB);
}

/**
 * Month-to-date net of Cribl (DECISIONS D49): the month's savings against Cribl's cost over the minutes they were
 * metered — from the later of the local first of the month and when collecting began, to the sweep. The one rule
 * behind the Receipt hero, its Copy receipt, the sweep's headline (netMtdM, paybackX), the tour's rebased
 * headline, the Settings cost preview and the Report Card. Null without a usable cost or a metered minute.
 */
export function mtdNetOfCribl(
  mtdSavedM: number,
  sweepMs: number,
  tz: string,
  collectingSinceMs: number | undefined,
  costCentsPerMonth: number | undefined,
): NetOfCribl | null {
  if (!Number.isFinite(sweepMs)) return null;
  return netOfCribl(mtdSavedM, meteredSpan(localMonthStartMs(sweepMs, tz), sweepMs, collectingSinceMs).minutes, costCentsPerMonth);
}
