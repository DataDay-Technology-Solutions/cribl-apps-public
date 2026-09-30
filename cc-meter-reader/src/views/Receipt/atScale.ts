// src/views/Receipt/atScale.ts — "At your scale" (founder-build r1 ui-3, FINDINGS_EXTRA (b)): what this workspace's
// measured rate would come to a year at 1, 5 and 10 TB a day, as pure functions (tests/unit/r1-ui-at-scale.test.ts).
//
//   saved per GB received = Σ saved a day at current rates ÷ the GB the workspace receives a day (both the last hour
//                           × 24, the flows' own per-day figures), rounded to a tenth of a cent so the drawer's
//                           arithmetic foots exactly
//   a rung                = saved per GB × rung GB a day × 365, shown to two significant figures ($9.4K, $950)
//
// It is this workspace's mix (every flow, every priced destination), so on the demo org it projects that org's own rate,
// not the projection public surfaces quote (ops/numbers/NUMBERS_STANDARD.md: Cribl's published 30 %): the label names
// the basis. A projection, never a measurement: it assumes more data is cut in the same proportion, at the same
// destinations' prices.
//
// Shown only when it means something: a priced destination carries money, the workspace's bytes received are exact
// (every Source feeds one flow, model.ts bytesInPerDay), it saves something, the rate rests on at least an hour of
// metering, and it receives under 10 TB a day (the rungs above what it already receives; none at 10 TB and up, so the
// enterprise sample tour never shows it).

import type { Snapshot } from '../../../core/types.ts';
import { fmtDollarsCompact, MC_PER_DOLLAR } from '../../../core/format.ts';
import { fromIso } from '../../../core/time.ts';
import { bytesInPerDay, savedPerDayNowM } from './model.ts';

/** The rungs, in GB a day (decimal: 1 TB = 1,000 GB, the app's units line). */
export const AT_SCALE_RUNGS_GB = [1_000, 5_000, 10_000] as const;

const BYTES_PER_GB = 1e9;
const DAYS_PER_YEAR = 365;
/** Under this much metering the rate is too young to multiply by a thousand. */
const MIN_BASIS_MINUTES = 60;
/** The per-GB rate is rounded to a tenth of a cent (100 millicents), so every line of the drawer foots. */
const PER_GB_STEP_M = 100;

export interface AtScaleRung {
  gbPerDay: number;
  /** 1, 5, 10 */
  tb: number;
  /** saved per GB × GB a day × 365, millicents (exact integer arithmetic on the rounded per-GB rate) */
  exactPerYearM: number;
  /** exactPerYearM in whole dollars rounded to two significant figures, back in millicents */
  roundedPerYearM: number;
  /** '$9.4K', '$950' */
  amount: string;
}

export interface AtScale {
  /** Saved per GB received, millicents (a multiple of 100). */
  savedPerGbM: number;
  /** What the workspace receives a day, in GB (unrounded). */
  gbInPerDay: number;
  bytesInPerDay: number;
  /** Σ saved a day at current rates, millicents. */
  savedPerDayM: number;
  rungs: AtScaleRung[];
}

export interface AtScaleInput {
  savedPerDayM: number;
  /** Undefined when a Source feeds several flows (the sum would count cloned bytes twice). */
  bytesInPerDay: number | undefined;
  /** A destination carries a price above $0. */
  priced: boolean;
  /** The minutes the rate rests on. */
  basisMinutes: number;
}

/** Rounds to `digits` significant figures, half away from zero (9,449 → 9,400). */
export function roundToSignificant(value: number, digits = 2): number {
  if (!Number.isFinite(value) || value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const step = 10 ** (magnitude - digits + 1);
  const rounded = Math.sign(value) * Math.floor(Math.abs(value) / step + 0.5) * step;
  // Floating dust (1.4000000000000001e6) never reaches the formatter.
  return Math.round(rounded);
}

/**
 * '$9.4K', '$950', '$12K': core/format.ts's compact dollars (one decimal, '.0' dropped) with the thousands
 * suffix in capitals, as the ladder is written everywhere it is quoted.
 */
export function atScaleAmount(mc: number): string {
  return fmtDollarsCompact(mc).replace(/k$/, 'K');
}

export function atScale(input: AtScaleInput): AtScale | undefined {
  const { savedPerDayM, bytesInPerDay: bytes, priced, basisMinutes } = input;
  if (!priced || bytes === undefined || !(bytes > 0) || !Number.isFinite(bytes)) return undefined;
  if (!(savedPerDayM > 0) || !Number.isFinite(savedPerDayM)) return undefined;
  if (!(basisMinutes >= MIN_BASIS_MINUTES)) return undefined;
  const gbInPerDay = bytes / BYTES_PER_GB;
  const last = AT_SCALE_RUNGS_GB[AT_SCALE_RUNGS_GB.length - 1];
  if (gbInPerDay >= last) return undefined;
  const savedPerGbM = Math.round(savedPerDayM / gbInPerDay / PER_GB_STEP_M) * PER_GB_STEP_M;
  if (!(savedPerGbM > 0)) return undefined;
  const rungs: AtScaleRung[] = AT_SCALE_RUNGS_GB.filter((gb) => gb > gbInPerDay).map((gb) => {
    const exactPerYearM = savedPerGbM * gb * DAYS_PER_YEAR;
    const roundedPerYearM = roundToSignificant(exactPerYearM / MC_PER_DOLLAR) * MC_PER_DOLLAR;
    return { gbPerDay: gb, tb: gb / 1_000, exactPerYearM, roundedPerYearM, amount: atScaleAmount(roundedPerYearM) };
  });
  return rungs.length > 0 ? { savedPerGbM, gbInPerDay, bytesInPerDay: bytes, savedPerDayM, rungs } : undefined;
}

/** The minutes the annualized run rate rests on: its days (fractional under one), never more than collecting has run. */
function basisMinutes(snapshot: Snapshot): number {
  const days = snapshot.headline?.annualizedFromDays;
  const fromDays = Number.isFinite(days) && days > 0 ? days * 1_440 : 0;
  const since = fromIso(snapshot.collectingSince);
  const sweep = fromIso(snapshot.sweepAt);
  const collecting = Number.isFinite(since) && Number.isFinite(sweep) ? Math.max(0, (sweep - since) / 60_000) : fromDays;
  return Math.min(fromDays, collecting);
}

/** A destination carries a price above $0 (a free or unpriced one alone saves nothing to project). */
function hasPricedDestination(snapshot: Snapshot): boolean {
  return (snapshot.destinations ?? []).some((d) => !d.unpriced && d.milliCentsPerGb > 0);
}

/** The projection for the snapshot on screen, or undefined when it is not shown (see the header). */
export function atScaleFromSnapshot(snapshot: Snapshot | null | undefined): AtScale | undefined {
  if (!snapshot) return undefined;
  return atScale({
    savedPerDayM: savedPerDayNowM(snapshot),
    bytesInPerDay: bytesInPerDay(snapshot),
    priced: hasPricedDestination(snapshot),
    basisMinutes: basisMinutes(snapshot),
  });
}

