// core/time.ts — time arithmetic for the sweep, the rollups and the headline.
// Storage is UTC (ISO strings / epoch ms); "local" always means the org's IANA display timezone
// (settings.displayTimezone), resolved with Intl.DateTimeFormat. No DOM, no Node APIs.

import type { ISO } from './types.ts';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** 365 × 1,440: the year the annualized run rate and Cribl's cost per minute use (core/net.ts). */
export const MINUTES_PER_YEAR = 525_600;

/** Start of the UTC minute containing `ms`. */
export function minuteFloor(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** Start of the UTC hour containing `ms`. */
export function hourFloor(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** The first UTC hour boundary at or after `ms`. */
export function hourCeil(ms: number): number {
  return Math.ceil(ms / HOUR_MS) * HOUR_MS;
}

/** Start of the UTC day containing `ms`. */
export function utcDayFloor(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** The first UTC midnight at or after `ms`. */
export function utcDayCeil(ms: number): number {
  return Math.ceil(ms / DAY_MS) * DAY_MS;
}

export function toIso(ms: number): ISO {
  return new Date(ms).toISOString();
}

/** Parses an ISO-8601 string to epoch ms; returns NaN when it is not a date. */
export function fromIso(iso: ISO): number {
  if (typeof iso !== 'string' || iso.length === 0) return Number.NaN;
  return Date.parse(iso);
}

/** 'YYYY-MM-DDTHH' of the UTC hour. */
export function utcHourKey(ms: number): string {
  return toIso(ms).slice(0, 13);
}

/** 'YYYY-MM-DD' of the UTC day. */
export function utcDayKey(ms: number): string {
  return toIso(ms).slice(0, 10);
}

/** 'YYYY-MM' of the UTC month. */
export function utcMonthKey(ms: number): string {
  return toIso(ms).slice(0, 7);
}

// ─── Zoned calendar ──────────────────────────────────────────────────────────

interface ZonedParts {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number; // 0–23
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of instant `ms` in `tz`. */
function zonedParts(ms: number, tz: string): ZonedParts {
  const out: ZonedParts = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) {
    switch (p.type) {
      case 'year':
        out.year = Number(p.value);
        break;
      case 'month':
        out.month = Number(p.value);
        break;
      case 'day':
        out.day = Number(p.value);
        break;
      case 'hour':
        out.hour = Number(p.value) % 24;
        break;
      case 'minute':
        out.minute = Number(p.value);
        break;
      case 'second':
        out.second = Number(p.value);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Offset of `tz` from UTC at instant `ms`, in ms (local wall time − UTC). */
function tzOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - (Math.floor(ms / 1000) * 1000);
}

/**
 * The first instant whose local wall time in `tz` is at or after y-m-d h:00.
 * Handles DST: a wall time inside a spring-forward gap resolves to the first instant after the gap.
 */
function zonedWallToUtc(year: number, month: number, day: number, hour: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, hour);
  let t = wall - tzOffsetMs(wall, tz);
  const second = wall - tzOffsetMs(t, tz);
  if (second !== t) t = second;
  // If the wall time did not exist (gap) we may have landed before it; walk forward to it.
  const target = `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
  for (let i = 0; i < 12; i++) {
    const p = zonedParts(t, tz);
    const key = `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`;
    if (key > target || (key === target && p.hour >= hour)) break;
    t += 15 * MINUTE_MS;
    t = Math.floor(t / (15 * MINUTE_MS)) * 15 * MINUTE_MS;
  }
  return t;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

/**
 * The first instant whose local wall time in `tz` is at or after y-m-d h:mm (minute precision, for the
 * custom range picker). A wall time inside a spring-forward gap resolves to the first instant after the gap;
 * an ambiguous fall-back time resolves to its first occurrence.
 */
export function localWallToUtcMs(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let t = wall - tzOffsetMs(wall, tz);
  const second = wall - tzOffsetMs(t, tz);
  if (second !== t) t = second;
  // A gap: the wall time does not exist, so we may have landed before it; walk forward minute by minute.
  const target = `${pad4(year)}-${pad2(month)}-${pad2(day)}`;
  for (let i = 0; i < 180; i++) {
    const p = zonedParts(t, tz);
    const key = `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`;
    if (key > target || (key === target && (p.hour > hour || (p.hour === hour && p.minute >= minute)))) break;
    t = Math.floor(t / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  }
  return t;
}

/** 'YYYY-MM-DDTHH:mm' (the value of a `datetime-local` input) for instant `ms` in `tz`. */
export function formatLocalDateTimeInput(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Parses a `datetime-local` value ('YYYY-MM-DDTHH:mm', seconds tolerated) as wall time in `tz`; NaN when invalid. */
export function parseLocalDateTimeInput(value: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(typeof value === 'string' ? value.trim() : '');
  if (!m) return Number.NaN;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return Number.NaN;
  // Reject calendar overflow (Feb 30): the parts must survive a round trip through UTC.
  const probe = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return Number.NaN;
  return localWallToUtcMs(year, month, day, hour, minute, tz);
}

/** 'YYYY-MM-DD' of the local calendar day containing `ms` in `tz`. */
export function localDayKey(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 'YYYY-MM' of the local calendar month containing `ms` in `tz`. */
export function localMonthKey(ms: number, tz: string): string {
  return localDayKey(ms, tz).slice(0, 7);
}

/** Epoch ms of local midnight (start of the local day) containing `ms` in `tz`. */
export function localMidnightMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return zonedWallToUtc(p.year, p.month, p.day, 0, tz);
}

/** Epoch ms of the start of the local month containing `ms` in `tz`. */
export function localMonthStartMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return zonedWallToUtc(p.year, p.month, 1, 0, tz);
}

/** Epoch ms of the start of the next local month after the one containing `ms`. */
export function localNextMonthStartMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const y = p.month === 12 ? p.year + 1 : p.year;
  const m = p.month === 12 ? 1 : p.month + 1;
  return zonedWallToUtc(y, m, 1, 0, tz);
}

/** Epoch ms of the local midnight that starts local day `dayKey` ('YYYY-MM-DD') in `tz`. */
export function localDayStartMs(dayKey: string, tz: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  return zonedWallToUtc(y, m, d, 0, tz);
}

/** Day of the local month (1–31). */
export function dayOfMonth(ms: number, tz: string): number {
  return zonedParts(ms, tz).day;
}

/** Number of days in the local month containing `ms`. */
export function daysInMonth(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
}

/** Minutes in the local month containing `ms` (DST-aware: a spring-forward month is 60 minutes short). */
export function minutesInMonth(ms: number, tz: string): number {
  return Math.round((localNextMonthStartMs(ms, tz) - localMonthStartMs(ms, tz)) / MINUTE_MS);
}

/** Adds `n` calendar days to a 'YYYY-MM-DD' key (pure calendar arithmetic, no timezone involved). */
export function addDaysToKey(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole calendar days from `fromKey` to `toKey` (positive when `toKey` is later). */
export function daysBetweenKeys(fromKey: string, toKey: string): number {
  const [y1, m1, d1] = fromKey.split('-').map(Number);
  const [y2, m2, d2] = toKey.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / DAY_MS);
}

// ─── Display formatting (en-US, the copy deck's locale) ─────────────────────

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

function displayFormatter(tz: string, kind: 'time' | 'datetime' | 'monthday' | 'monthdayyear'): Intl.DateTimeFormat {
  const cacheKey = `${kind}|${tz}`;
  let f = displayFormatters.get(cacheKey);
  if (!f) {
    const base: Intl.DateTimeFormatOptions = { timeZone: tz };
    const opts: Intl.DateTimeFormatOptions =
      kind === 'time'
        ? { ...base, hour: 'numeric', minute: '2-digit', hour12: true }
        : kind === 'datetime'
          ? { ...base, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }
          : kind === 'monthday'
            ? { ...base, month: 'short', day: 'numeric' }
            : { ...base, month: 'short', day: 'numeric', year: 'numeric' };
    f = new Intl.DateTimeFormat('en-US', opts);
    displayFormatters.set(cacheKey, f);
  }
  return f;
}

/** ICU (Node ≥ 20, modern browsers) puts a narrow no-break space before AM/PM; the copy deck uses a plain space. */
function normalizeSpaces(s: string): string {
  return s.replace(/[   ]/g, ' ');
}

/** '9:41 PM' in `tz`. */
export function formatLocalTime(ms: number, tz: string): string {
  return normalizeSpaces(displayFormatter(tz, 'time').format(new Date(ms)));
}

/** 'Sep 26, 2026, 9:41 PM' in `tz`. */
export function formatLocalDateTime(ms: number, tz: string): string {
  return normalizeSpaces(displayFormatter(tz, 'datetime').format(new Date(ms)));
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * 'Sep 21–27, 2026' for a period in `tz`. `endMs` is the EXCLUSIVE end of the period
 * (the last day shown is the local day containing `endMs − 1`).
 * Across months: 'Sep 28–Oct 4, 2026'; across years: 'Dec 28, 2026–Jan 3, 2027'.
 */
export function weekRangeLabel(startMs: number, endMs: number, tz: string): string {
  const a = zonedParts(startMs, tz);
  const b = zonedParts(Math.max(startMs, endMs - 1), tz);
  const ma = MONTHS_SHORT[a.month - 1];
  const mb = MONTHS_SHORT[b.month - 1];
  if (a.year !== b.year) return `${ma} ${a.day}, ${a.year}–${mb} ${b.day}, ${b.year}`;
  if (a.month !== b.month) return `${ma} ${a.day}–${mb} ${b.day}, ${b.year}`;
  if (a.day !== b.day) return `${ma} ${a.day}–${b.day}, ${b.year}`;
  return `${ma} ${a.day}, ${a.year}`;
}

/** 'Sep 26' in `tz`. */
export function formatLocalMonthDay(ms: number, tz: string): string {
  return normalizeSpaces(displayFormatter(tz, 'monthday').format(new Date(ms)));
}

/**
 * Legacy IANA names some engines still report (Chromium's resolvedOptions() gives Asia/Calcutta for a browser in
 * Asia/Kolkata), mapped to the names people know (OQ-16). Both name the same zone to Intl.
 */
const LEGACY_ZONES: Readonly<Record<string, string>> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Godthab': 'America/Nuuk',
  'Pacific/Truk': 'Pacific/Chuuk',
  'Pacific/Ponape': 'Pacific/Pohnpei',
};

/** The current IANA name of `tz` (a legacy alias to its modern name), or `tz` itself. */
export function canonicalZoneName(tz: string): string {
  return LEGACY_ZONES[tz] ?? tz;
}

/** True when `tz` is an IANA zone this runtime's Intl understands. */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
