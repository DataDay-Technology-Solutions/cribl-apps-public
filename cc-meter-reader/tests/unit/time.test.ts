import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  addDaysToKey,
  dayOfMonth,
  daysBetweenKeys,
  daysInMonth,
  formatLocalDateTime,
  formatLocalMonthDay,
  formatLocalTime,
  fromIso,
  hourFloor,
  isValidTimeZone,
  localDayKey,
  localDayStartMs,
  localMidnightMs,
  localMonthKey,
  localMonthStartMs,
  localNextMonthStartMs,
  minuteFloor,
  minutesInMonth,
  toIso,
  utcDayKey,
  utcHourKey,
  utcMonthKey,
  weekRangeLabel,
} from '../../core/time.ts';

const T = Date.parse('2026-09-26T03:41:27.123Z');

describe('constants and UTC keys', () => {
  it('has the right durations', () => {
    expect(MINUTE_MS).toBe(60_000);
    expect(HOUR_MS).toBe(3_600_000);
    expect(DAY_MS).toBe(86_400_000);
  });
  it('floors to the minute and hour', () => {
    expect(toIso(minuteFloor(T))).toBe('2026-09-26T03:41:00.000Z');
    expect(toIso(hourFloor(T))).toBe('2026-09-26T03:00:00.000Z');
  });
  it('round-trips ISO', () => {
    expect(fromIso(toIso(T))).toBe(T);
    expect(Number.isNaN(fromIso('not a date'))).toBe(true);
    expect(Number.isNaN(fromIso(''))).toBe(true);
  });
  it('builds UTC keys', () => {
    expect(utcHourKey(T)).toBe('2026-09-26T03');
    expect(utcDayKey(T)).toBe('2026-09-26');
    expect(utcMonthKey(T)).toBe('2026-09');
  });
});

describe('zoned calendar', () => {
  it('computes the local day and month in a US zone', () => {
    // 03:41Z on Sep 26 is 10:41 PM on Sep 25 in Chicago (CDT, −5).
    expect(localDayKey(T, 'America/Chicago')).toBe('2026-09-25');
    expect(localMonthKey(T, 'America/Chicago')).toBe('2026-09');
    expect(localDayKey(T, 'UTC')).toBe('2026-09-26');
    expect(localDayKey(T, 'Asia/Tokyo')).toBe('2026-09-26');
  });
  it('finds local midnight', () => {
    expect(toIso(localMidnightMs(T, 'America/Chicago'))).toBe('2026-09-25T05:00:00.000Z');
    expect(toIso(localMidnightMs(T, 'UTC'))).toBe('2026-09-26T00:00:00.000Z');
    expect(toIso(localMidnightMs(T, 'Asia/Kolkata'))).toBe('2026-09-25T18:30:00.000Z');
  });
  it('finds local month starts', () => {
    expect(toIso(localMonthStartMs(T, 'America/Chicago'))).toBe('2026-09-01T05:00:00.000Z');
    expect(toIso(localNextMonthStartMs(T, 'America/Chicago'))).toBe('2026-10-01T05:00:00.000Z');
    const dec = Date.parse('2026-12-15T12:00:00Z');
    expect(toIso(localNextMonthStartMs(dec, 'UTC'))).toBe('2027-01-01T00:00:00.000Z');
  });
  it('handles a DST fall-back day (25 hours) and spring-forward month', () => {
    const nov1 = Date.parse('2026-11-01T12:00:00Z'); // US fall back on Nov 1 2026
    const start = localMidnightMs(nov1, 'America/Chicago');
    const next = localDayStartMs('2026-11-02', 'America/Chicago');
    expect((next - start) / HOUR_MS).toBe(25);
    // March 2026 in Chicago loses an hour.
    const mar = Date.parse('2026-03-15T12:00:00Z');
    expect(minutesInMonth(mar, 'America/Chicago')).toBe(31 * 1440 - 60);
    expect(minutesInMonth(mar, 'UTC')).toBe(31 * 1440);
  });
  it('resolves a midnight that does not exist to the first instant of the day', () => {
    // Sao Paulo started DST at midnight on 2018-11-04 (00:00 → 01:00).
    const t = localDayStartMs('2018-11-04', 'America/Sao_Paulo');
    expect(localDayKey(t, 'America/Sao_Paulo')).toBe('2018-11-04');
    expect(localDayKey(t - 1, 'America/Sao_Paulo')).toBe('2018-11-03');
  });
  it('day of month and days in month', () => {
    expect(dayOfMonth(T, 'America/Chicago')).toBe(25);
    expect(dayOfMonth(T, 'UTC')).toBe(26);
    expect(daysInMonth(T, 'UTC')).toBe(30);
    expect(daysInMonth(Date.parse('2028-02-10T00:00:00Z'), 'UTC')).toBe(29);
    expect(daysInMonth(Date.parse('2026-02-10T00:00:00Z'), 'UTC')).toBe(28);
  });
  it('day-key arithmetic', () => {
    expect(addDaysToKey('2026-09-26', -29)).toBe('2026-08-28');
    expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetweenKeys('2026-09-01', '2026-09-26')).toBe(25);
    expect(daysBetweenKeys('2026-09-26', '2026-09-01')).toBe(-25);
  });
  it('local midnight is always ≤ t and on the same local day (property)', () => {
    const zones = ['UTC', 'America/Chicago', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe', 'America/Sao_Paulo'];
    fc.assert(
      fc.property(fc.integer({ min: Date.parse('2015-01-01'), max: Date.parse('2035-01-01') }), fc.constantFrom(...zones), (t, tz) => {
        const m = localMidnightMs(t, tz);
        expect(m).toBeLessThanOrEqual(t);
        expect(localDayKey(m, tz)).toBe(localDayKey(t, tz));
        expect(localDayKey(m - 1, tz)).not.toBe(localDayKey(t, tz));
      }),
      { numRuns: 300 },
    );
  });
});

describe('display formatting', () => {
  it('formats local time with a plain space before AM/PM', () => {
    const t = Date.parse('2026-09-27T02:41:00Z'); // 9:41 PM CDT Sep 26
    expect(formatLocalTime(t, 'America/Chicago')).toBe('9:41 PM');
    expect(formatLocalTime(Date.parse('2026-09-26T00:05:00Z'), 'UTC')).toBe('12:05 AM');
  });
  it('formats date-times and month-days', () => {
    const t = Date.parse('2026-09-27T02:41:00Z');
    expect(formatLocalDateTime(t, 'America/Chicago')).toBe('Sep 26, 2026, 9:41 PM');
    expect(formatLocalMonthDay(t, 'America/Chicago')).toBe('Sep 26');
  });
  it('labels week ranges (end exclusive)', () => {
    const tz = 'America/Chicago';
    const start = localDayStartMs('2026-09-21', tz);
    const end = localDayStartMs('2026-09-28', tz);
    expect(weekRangeLabel(start, end, tz)).toBe('Sep 21–27, 2026');
    expect(weekRangeLabel(localDayStartMs('2026-09-28', tz), localDayStartMs('2026-10-05', tz), tz)).toBe('Sep 28–Oct 4, 2026');
    expect(weekRangeLabel(localDayStartMs('2026-12-28', tz), localDayStartMs('2027-01-04', tz), tz)).toBe('Dec 28, 2026–Jan 3, 2027');
    expect(weekRangeLabel(start, start + HOUR_MS, tz)).toBe('Sep 21, 2026');
  });
  it('validates time zones', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});
