// src/lib/format.ts — formatting at the edge for the UI (SPEC 1 "Money", SPEC 8, PRD 8.8 item 2).
//
// Money, percentages, bytes and clocks delegate to core/format.ts so the screen, the copied receipt,
// the Slack payload and Show-the-math all round identically (half-up on the magnitude). This module
// adds only what is UI-specific: options, localized relative times through the copy table, and dates
// in the display timezone.
//
// Money arrives as integer MILLICENTS ($1 = 100,000 mc). On screen: whole dollars with thousands
// separators; cents only in the ticking counter (`cents: true`). Percentages are integers. Bytes are
// decimal units (1 GB = 1,000,000,000 bytes, the same `gb()` the pricing math uses) with one decimal.

import { fmtBytes, fmtDollars, fmtDollarsCents, fmtDollarsCompact, fmtDuration, fmtPct, MC_PER_DOLLAR } from '../../core/format.ts';
import { t, tn } from '../copy/en.ts';

export const MILLICENTS_PER_DOLLAR = MC_PER_DOLLAR;

export interface MoneyFormatOptions {
  /** Show cents (the ticking counter only, PRD 8.8 item 2). */
  cents?: boolean;
  /** Compact notation ($95.6k) for axis ticks and dense labels. */
  compact?: boolean;
  /** Prefix positive values with '+' (deltas). */
  signed?: boolean;
}

/** Millicents → display string, e.g. 2_500_000 → "$25". Non-finite input renders as an em dash. */
export function formatMoney(milliCents: number, opts: MoneyFormatOptions = {}): string {
  if (!Number.isFinite(milliCents)) return t('common.dash');
  const text = opts.compact ? fmtDollarsCompact(milliCents) : opts.cents ? fmtDollarsCents(milliCents) : fmtDollars(milliCents);
  const isZero = !/[1-9]/.test(text);
  return opts.signed && milliCents > 0 && !isZero ? `+${text}` : text;
}

/** Ratio in [0, 1] → integer percent, e.g. 0.604 → "60%". */
export function formatPct(ratio: number, opts: { signed?: boolean } = {}): string {
  if (!Number.isFinite(ratio)) return t('common.dash');
  const text = fmtPct(ratio);
  return opts.signed && ratio > 0 && text !== '0%' ? `+${text}` : text;
}

/**
 * Percentage-point difference between two ratios, e.g. (0.75, 0.50) → "25 points": the difference of the two
 * percentages as formatPct prints them, so "76% → 49%" always sits beside "27 points".
 */
export function formatPoints(fromRatio: number, toRatio: number): string {
  if (!Number.isFinite(fromRatio) || !Number.isFinite(toRatio)) return t('common.dash');
  const shown = (ratio: number): number => Math.floor(Math.abs(ratio) * 100 + 0.5) * Math.sign(ratio);
  return tn('units.points', Math.abs(shown(fromRatio) - shown(toRatio)));
}

/** Bytes → "12.0 GB" (decimal units, one decimal; plain bytes below 1 KB). */
export function formatBytes(bytes: number): string {
  return Number.isFinite(bytes) ? fmtBytes(bytes) : t('common.dash');
}

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Plain integer with thousands separators. */
export function formatInt(n: number): string {
  return Number.isFinite(n) ? integer.format(Math.round(n)) : t('common.dash');
}

/** A multiple such as payback ("4.2") with one decimal. */
export function formatMultiple(x: number): string {
  return Number.isFinite(x) ? oneDecimal.format(x) : t('common.dash');
}

/** Elapsed-time label for "updated 12 s ago" and the footer (SPEC 17 wording). */
export function formatRelative(thenMs: number, nowMs: number): string {
  if (!Number.isFinite(thenMs)) return t('common.dash');
  const seconds = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (seconds < 1) return t('time.justNow');
  if (seconds < 60) return t('time.secondsAgo', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return tn('time.daysAgo', days);
  return formatDate(thenMs);
}

/** Duration for sweep timings: "850 ms", "4.1 s", "2 min 5 s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return t('common.dash');
  if (ms < 1000) return t('time.durationMs', { n: Math.round(ms) });
  if (ms < 60_000) return t('time.durationSeconds', { n: oneDecimal.format(ms / 1000) });
  const totalSeconds = Math.round(ms / 1000);
  return t('time.durationMinutes', { m: Math.floor(totalSeconds / 60), s: totalSeconds % 60 });
}

/** Countdown / stopwatch "m:ss" ("Caught in 2:51", "Next sweep in 0:42"). */
export function formatClock(totalSeconds: number): string {
  return fmtDuration(totalSeconds);
}

function safeTimeZone(timeZone?: string): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return undefined; // an invalid IANA name must never crash a render
  }
}

function toEpoch(at: number | string): number {
  return typeof at === 'number' ? at : Date.parse(at);
}

/** "11:42 AM" in the display timezone. */
export function formatTimeOfDay(at: number | string, timeZone?: string): string {
  const ms = toEpoch(at);
  if (!Number.isFinite(ms)) return t('common.dash');
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: safeTimeZone(timeZone) }).format(ms);
}

/** "Sep 17, 2026" in the display timezone (Capra date guidance, short form). */
export function formatDate(at: number | string, timeZone?: string): string {
  const ms = toEpoch(at);
  if (!Number.isFinite(ms)) return t('common.dash');
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: safeTimeZone(timeZone) }).format(ms);
}

/** "Sep 17, 2026, 11:42 AM" — used for `title` tooltips on relative times. */
export function formatDateTime(at: number | string, timeZone?: string): string {
  const ms = toEpoch(at);
  if (!Number.isFinite(ms)) return t('common.dash');
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: safeTimeZone(timeZone),
  }).format(ms);
}

/** ISO string or epoch ms → epoch ms (NaN when absent or unparseable). */
export function toMs(at: number | string | undefined | null): number {
  if (at === undefined || at === null) return Number.NaN;
  return toEpoch(at);
}
