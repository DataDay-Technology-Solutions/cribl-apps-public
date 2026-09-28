// The custom time range (core/range.ts): the URL form, resolution against the clock and collecting-since,
// the read plan at the 24 h / 31 d boundaries and its caps, hour and day snapping, minutes metered, missing
// documents, byOutput; the minute-precision wall-clock helpers (core/time.ts); the state-layer reader's cache
// and concurrency (src/state/rangeReader.ts); the action's gates (src/state/services.ts); the URL param
// (src/lib/params.ts); and the shortcut guard over the picker's inputs (src/lib/dom.ts).

import { describe, expect, it, vi } from 'vitest';
import {
  DOC_CAPS,
  RELATIVE_PRESETS,
  RETENTION_MONTHS,
  docBucketEndMs,
  docBucketStartMs,
  emptyRangeFigures,
  formatRangeParam,
  granularityCapMs,
  parseRangeParam,
  planRangeReads,
  presetKeyOf,
  rangeDuration,
  rangeSpanLabel,
  resolveRange,
  retentionStartMs,
  snapRange,
  sumRange,
  type RangeDoc,
  type RangeSpec,
} from '../../core/range.ts';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  formatLocalDateTimeInput,
  hourCeil,
  localWallToUtcMs,
  minuteFloor,
  parseLocalDateTimeInput,
  utcDayCeil,
  utcDayFloor,
} from '../../core/time.ts';
import { defaultSettings } from '../../core/settings.ts';
import type { HourRow, MinuteRow, RollDayDoc, RollHourDoc, RollMinuteDoc } from '../../core/types.ts';
import { IMMUTABLE_AFTER_MS, createRangeReader } from '../../src/state/rangeReader.ts';
import { createAppServices } from '../../src/state/services.ts';
import { createAppStore } from '../../src/state/store.ts';
import type { AppDocs, RollupDocs } from '../../src/state/ports.ts';
import { hrefWithStickyParams, patchSearchParams, readAppParams } from '../../src/lib/params.ts';
import { patchLedgerParams, readLedgerParams } from '../../src/views/Ledger/params.ts';
import { rangeCaption, rangePreview, rangePreviewLine, rangeWords } from '../../src/views/Receipt/text.ts';

const NOW = Date.parse('2026-09-26T17:34:56.789Z'); // 12:34:56 PM in Chicago
const TZ = 'America/Chicago';
const T = (iso: string) => Date.parse(iso);
const FLOW_A = 'default|mrd_payments_api|mrd_payments_api|mrd_pay_sample|mrd_siem_prod';
const FLOW_B = 'default|mrd_k8s_prod|mrd_k8s_prod|mrd_k8s_noise|mrd_analytics';

// ─── URL form ────────────────────────────────────────────────────────────────

describe('parseRangeParam / formatRangeParam', () => {
  it('accepts exactly the five quick picks', () => {
    for (const p of RELATIVE_PRESETS) expect(parseRangeParam(p.key)).toEqual({ kind: 'relative', hours: p.hours });
    expect(parseRangeParam('12h')).toBeUndefined();
    expect(parseRangeParam('2d')).toBeUndefined();
    expect(parseRangeParam('')).toBeUndefined();
    expect(parseRangeParam(null)).toBeUndefined();
    expect(parseRangeParam('mtd')).toBeUndefined();
  });

  it('accepts the absolute form at UTC minute precision, exclusive end after start', () => {
    expect(parseRangeParam('2026-09-26T10:00Z..2026-09-26T14:00Z')).toEqual({ kind: 'absolute', fromMs: T('2026-09-26T10:00:00Z'), toMs: T('2026-09-26T14:00:00Z') });
    expect(parseRangeParam('2026-09-26T14:00Z..2026-09-26T10:00Z')).toBeUndefined(); // reversed
    expect(parseRangeParam('2026-09-26T10:00Z..2026-09-26T10:00Z')).toBeUndefined(); // empty
    expect(parseRangeParam('2026-13-01T10:00Z..2026-13-01T14:00Z')).toBeUndefined(); // no month 13
    expect(parseRangeParam('2026-02-30T10:00Z..2026-03-01T14:00Z')).toBeUndefined(); // no Feb 30
    expect(parseRangeParam('2026-09-26T10:00:30Z..2026-09-26T14:00:00Z')).toBeUndefined(); // seconds are not the form
    expect(parseRangeParam('2026-09-26T10:00..2026-09-26T14:00')).toBeUndefined(); // must be Z
  });

  it('round-trips every preset and an absolute range, flooring instants to the minute', () => {
    for (const p of RELATIVE_PRESETS) expect(formatRangeParam(parseRangeParam(p.key)!)).toBe(p.key);
    const abs: RangeSpec = { kind: 'absolute', fromMs: T('2026-09-26T10:00:45Z'), toMs: T('2026-09-26T14:00:59Z') };
    expect(formatRangeParam(abs)).toBe('2026-09-26T10:00Z..2026-09-26T14:00Z');
    expect(parseRangeParam(formatRangeParam(abs))).toEqual({ kind: 'absolute', fromMs: T('2026-09-26T10:00:00Z'), toMs: T('2026-09-26T14:00:00Z') });
  });

  it('names the preset a spec is', () => {
    expect(presetKeyOf({ kind: 'relative', hours: 168 })).toBe('7d');
    expect(presetKeyOf({ kind: 'relative', hours: 5 })).toBeUndefined();
    expect(presetKeyOf({ kind: 'absolute', fromMs: 0, toMs: 1 })).toBeUndefined();
    expect(presetKeyOf(undefined)).toBeUndefined();
  });
});

// ─── Resolution ──────────────────────────────────────────────────────────────

describe('resolveRange', () => {
  it('ends a relative range at the last whole minute', () => {
    const r = resolveRange({ kind: 'relative', hours: 6 }, NOW);
    expect(r.toMs).toBe(T('2026-09-26T17:34:00Z'));
    expect(r.fromMs).toBe(T('2026-09-26T11:34:00Z'));
    expect(r.clippedStart).toBe(false);
    expect(r.clippedEnd).toBe(false);
  });

  it('keeps an absolute range as given unless it reaches into the future', () => {
    const past = resolveRange({ kind: 'absolute', fromMs: T('2026-09-25T10:00Z'), toMs: T('2026-09-25T14:00Z') }, NOW);
    expect(past).toEqual({ fromMs: T('2026-09-25T10:00Z'), toMs: T('2026-09-25T14:00Z'), clippedStart: false, clippedEnd: false, clippedRetention: false, future: false });
    const future = resolveRange({ kind: 'absolute', fromMs: T('2026-09-26T10:00Z'), toMs: T('2026-09-27T10:00Z') }, NOW);
    expect(future.toMs).toBe(T('2026-09-26T17:34:00Z'));
    expect(future.clippedEnd).toBe(true);
    expect(future.future).toBe(false);
  });

  it('a range lying entirely in the future keeps its own window, flagged future, and is never "collecting since"', () => {
    const r = resolveRange({ kind: 'absolute', fromMs: NOW + DAY_MS, toMs: NOW + 2 * DAY_MS }, NOW, T('2026-08-01T00:00Z'));
    expect(r).toEqual({ fromMs: minuteFloor(NOW + DAY_MS), toMs: minuteFloor(NOW + 2 * DAY_MS), clippedStart: false, clippedEnd: false, clippedRetention: false, future: true });
    // Starting exactly at the last whole minute is the future too (nothing completed inside it).
    expect(resolveRange({ kind: 'absolute', fromMs: minuteFloor(NOW), toMs: minuteFloor(NOW) + HOUR_MS }, NOW).future).toBe(true);
    // The empty sum for it: zeros, nothing read, no rate.
    const f = emptyRangeFigures(r.fromMs, r.toMs);
    expect(f).toMatchObject({ savedM: 0, rows: 0, docsRead: 0, docsMissing: 0, expectedMinutes: 1440 });
    expect(f.ratePerDayM).toBeUndefined();
  });

  it('never starts before the history kept (13 months of day rows), and says so', () => {
    expect(RETENTION_MONTHS).toBe(13);
    expect(retentionStartMs(NOW)).toBe(T('2025-09-01T00:00Z'));
    const r = resolveRange({ kind: 'absolute', fromMs: T('2024-01-15T00:00Z'), toMs: minuteFloor(NOW) }, NOW, T('2023-06-01T00:00Z'));
    expect(r.fromMs).toBe(T('2025-09-01T00:00Z'));
    expect(r.clippedRetention).toBe(true);
    expect(r.clippedStart).toBe(false);
    // Which keeps every plan inside its cap: the widest day plan is the 13 kept months.
    const plan = planRangeReads(r.fromMs, r.toMs, NOW);
    expect(plan.granularity).toBe('day');
    expect(plan.truncated).toBe(false);
    expect(plan.keys).toHaveLength(13);
    expect(plan.keys[0]).toBe('roll/day/2025-09');
    expect(plan.window.fromMs).toBe(T('2025-09-01T00:00Z'));
    // A range lying entirely before the history stays the window asked for (nothing metered in it), flagged for the
    // retention only — never one minute at its end that day snapping widens past it (OQ-05).
    const gone = resolveRange({ kind: 'absolute', fromMs: T('2024-01-15T00:00Z'), toMs: T('2024-02-15T00:00Z') }, NOW);
    expect(gone.fromMs).toBe(T('2024-01-15T00:00Z'));
    expect(gone.toMs).toBe(T('2024-02-15T00:00Z'));
    expect(gone.clippedRetention).toBe(true);
    expect(gone.clippedStart).toBe(false);
  });

  it('never starts before collecting began, and says so', () => {
    const since = T('2026-09-26T15:41:30Z');
    const r = resolveRange({ kind: 'relative', hours: 6 }, NOW, since);
    expect(r.fromMs).toBe(T('2026-09-26T15:41:00Z'));
    expect(r.clippedStart).toBe(true);
    expect(resolveRange({ kind: 'relative', hours: 1 }, NOW, since).clippedStart).toBe(false);
  });

  it('keeps a window wholly before collecting as asked (nothing metered), and from < to always', () => {
    const r = resolveRange({ kind: 'absolute', fromMs: T('2026-09-20T10:00Z'), toMs: T('2026-09-20T14:00Z') }, NOW, T('2026-09-25T00:00Z'));
    expect(r.toMs).toBe(T('2026-09-20T14:00Z'));
    expect(r.fromMs).toBe(T('2026-09-20T10:00Z'));
    expect(r.clippedStart).toBe(true);
    const tiny = resolveRange({ kind: 'absolute', fromMs: T('2026-09-20T10:00:10Z'), toMs: T('2026-09-20T10:00:50Z') }, NOW);
    expect(tiny.toMs - tiny.fromMs).toBe(MINUTE_MS);
  });
});

// ─── The read plan ───────────────────────────────────────────────────────────

describe('planRangeReads', () => {
  it('reads minute documents while the whole range is inside the last 24 h, hour documents inside 31 days, else day documents', () => {
    // The reaches are measured from the last whole minute (what a relative range ends at), not the raw clock.
    const to = minuteFloor(NOW);
    const minute = planRangeReads(to - 24 * HOUR_MS, to, NOW);
    expect(minute.granularity).toBe('minute');
    expect(minute.keys[0]).toBe('roll/min/2026-09-25T17');
    expect(minute.keys.at(-1)).toBe('roll/min/2026-09-26T17');
    expect(minute.keys).toHaveLength(25);
    const hour = planRangeReads(to - 24 * HOUR_MS - 1, to, NOW);
    expect(hour.granularity).toBe('hour');
    expect(hour.keys[0]).toBe('roll/hour/2026-09-25');
    expect(hour.keys.at(-1)).toBe('roll/hour/2026-09-26');
    expect(planRangeReads(to - 31 * DAY_MS, to, NOW).granularity).toBe('hour');
    const day = planRangeReads(to - 31 * DAY_MS - 1, to, NOW);
    expect(day.granularity).toBe('day');
    expect(day.keys).toEqual(['roll/day/2026-08', 'roll/day/2026-09']);
    // The quick picks land where their family reaches: 1 h · 6 h · 24 h minute-exact, 7 d · 30 d whole hours.
    for (const p of RELATIVE_PRESETS) {
      const r = resolveRange({ kind: 'relative', hours: p.hours }, NOW);
      expect(planRangeReads(r.fromMs, r.toMs, NOW).granularity, p.key).toBe(p.hours <= 24 ? 'minute' : 'hour');
    }
  });

  it('covers every bucket the snapped window touches, oldest first, as full keys', () => {
    const plan = planRangeReads(T('2026-09-25T18:30Z'), T('2026-09-26T09:10Z'), NOW);
    expect(plan.granularity).toBe('minute');
    expect(plan.keys).toHaveLength(16);
    expect(plan.keys[0]).toBe('roll/min/2026-09-25T18');
    expect(plan.keys.at(-1)).toBe('roll/min/2026-09-26T09');
    const hours = planRangeReads(T('2026-09-01T23:30Z'), T('2026-09-03T00:00Z'), NOW);
    expect(hours.keys).toEqual(['roll/hour/2026-09-01', 'roll/hour/2026-09-02']);
  });

  it('stops the window at the last completed bucket: whole hours end at the last whole hour, UTC days at the last UTC midnight', () => {
    expect(granularityCapMs('minute', NOW)).toBe(T('2026-09-26T17:34Z'));
    expect(granularityCapMs('hour', NOW)).toBe(T('2026-09-26T17:00Z'));
    expect(granularityCapMs('day', NOW)).toBe(T('2026-09-26T00:00Z'));
    // 7 days: exactly 168 whole hours ending at the last whole hour; 30 days: 720.
    const week = resolveRange({ kind: 'relative', hours: 168 }, NOW);
    const weekPlan = planRangeReads(week.fromMs, week.toMs, NOW);
    expect(weekPlan.granularity).toBe('hour');
    expect(weekPlan.window).toEqual({ fromMs: T('2026-09-19T17:00Z'), toMs: T('2026-09-26T17:00Z') });
    const month = resolveRange({ kind: 'relative', hours: 720 }, NOW);
    const monthPlan = planRangeReads(month.fromMs, month.toMs, NOW);
    expect(monthPlan.window.toMs - monthPlan.window.fromMs).toBe(720 * HOUR_MS);
    expect(monthPlan.keys.length).toBeLessThanOrEqual(DOC_CAPS.hour);
    // An exact window three days back is widened outward and never reaches now.
    const abs = planRangeReads(T('2026-09-23T15:30Z'), T('2026-09-23T18:10Z'), NOW);
    expect(abs.window).toEqual({ fromMs: T('2026-09-23T15:00Z'), toMs: T('2026-09-23T19:00Z') });
    // A 45-day window ending now stops at today's UTC midnight (today has no day row yet).
    const days = planRangeReads(minuteFloor(NOW) - 45 * DAY_MS, minuteFloor(NOW), NOW);
    expect(days.granularity).toBe('day');
    expect(days.window.toMs).toBe(T('2026-09-26T00:00Z'));
    expect(days.window.fromMs).toBe(utcDayFloor(minuteFloor(NOW) - 45 * DAY_MS));
    expect(days.keys).toEqual(['roll/day/2026-08', 'roll/day/2026-09']);
    // Minute windows are exact and untouched.
    const min = planRangeReads(T('2026-09-26T10:30Z'), T('2026-09-26T10:32Z'), NOW);
    expect(min.window).toEqual({ fromMs: T('2026-09-26T10:30Z'), toMs: T('2026-09-26T10:32Z') });
  });

  it('caps the documents a request may read, keeping the newest, and starts the window where the kept documents do', () => {
    const wide = planRangeReads(T('2024-01-15T00:00Z'), minuteFloor(NOW), NOW);
    expect(wide.granularity).toBe('day');
    expect(wide.keys).toHaveLength(DOC_CAPS.day);
    expect(wide.truncated).toBe(true);
    expect(wide.keys.at(-1)).toBe('roll/day/2026-09');
    expect(wide.keys[0]).toBe('roll/day/2025-08');
    expect(wide.window.fromMs).toBe(T('2025-08-01T00:00Z'));
    expect(DOC_CAPS).toEqual({ minute: 26, hour: 33, day: 14 });
    // The longest windows each family answers stay inside their caps.
    expect(planRangeReads(NOW - 24 * HOUR_MS, minuteFloor(NOW), NOW).keys.length).toBeLessThanOrEqual(DOC_CAPS.minute);
    expect(planRangeReads(NOW - 31 * DAY_MS, minuteFloor(NOW), NOW).keys.length).toBeLessThanOrEqual(DOC_CAPS.hour);
  });
});

describe('docBucketEndMs', () => {
  it('knows when each family of document stops changing', () => {
    expect(docBucketStartMs('roll/min/2026-09-26T10')).toBe(T('2026-09-26T10:00Z'));
    expect(docBucketStartMs('roll/day/2026-09')).toBe(T('2026-09-01T00:00Z'));
    expect(docBucketStartMs('nope')).toBeUndefined();
    expect(docBucketEndMs('roll/min/2026-09-26T10')).toBe(T('2026-09-26T11:00Z'));
    expect(docBucketEndMs('roll/hour/2026-09-26')).toBe(T('2026-09-27T00:00Z'));
    expect(docBucketEndMs('roll/day/2026-12')).toBe(T('2027-01-01T00:00Z'));
    expect(docBucketEndMs('roll/day/2026-09-26')).toBeUndefined();
    expect(docBucketEndMs('snapshot')).toBeUndefined();
  });
});

// ─── The sum ─────────────────────────────────────────────────────────────────

function minuteRow(iso: string, whpM: number, paidM: number): MinuteRow {
  return { t: iso, inB: 1000, outB: 400, inE: 10, outE: 4, whpM, paidM, savedM: Math.max(0, whpM - paidM) };
}
function hourRow(iso: string, whpM: number, paidM: number, samples: number): HourRow {
  return { t: iso, inB: 1000, outB: 400, whpM, paidM, savedM: Math.max(0, whpM - paidM), samples };
}

describe('sumRange', () => {
  it('minute granularity is exact: rows inside [from, to), distinct minutes, per flow and per destination', () => {
    const doc: RollMinuteDoc = {
      schemaVersion: 1,
      bucketStart: '2026-09-26T10:00:00.000Z',
      flows: {
        [FLOW_A]: [minuteRow('2026-09-26T10:29:00.000Z', 100, 40), minuteRow('2026-09-26T10:30:00.000Z', 100, 40), minuteRow('2026-09-26T10:31:00.000Z', 100, 40)],
        [FLOW_B]: [minuteRow('2026-09-26T10:30:00.000Z', 50, 30), minuteRow('2026-09-26T10:32:00.000Z', 50, 30)],
      },
    };
    const f = sumRange({ 'roll/min/2026-09-26T10': doc, 'roll/min/2026-09-26T09': null }, 'minute', T('2026-09-26T10:30Z'), T('2026-09-26T10:32Z'));
    expect(f).toMatchObject({ fromMs: T('2026-09-26T10:30Z'), toMs: T('2026-09-26T10:32Z'), granularity: 'minute', savedM: 140, whpM: 250, paidM: 110 });
    expect(f.rows).toBe(3);
    expect(f.minutesMetered).toBe(2);
    expect(f.expectedMinutes).toBe(2);
    expect(f.byFlow).toEqual({ [FLOW_A]: { whpM: 200, paidM: 80, savedM: 120 }, [FLOW_B]: { whpM: 50, paidM: 30, savedM: 20 } });
    expect(f.byOutput).toEqual({ 'default:mrd_siem_prod': { whpM: 200, paidM: 80, savedM: 120 }, 'default:mrd_analytics': { whpM: 50, paidM: 30, savedM: 20 } });
    expect(f.docsRead).toBe(1);
    expect(f.docsMissing).toBe(1);
    expect(f.ratio).toBeCloseTo(140 / 250, 6);
    expect(f.ratePerDayM).toBe(Math.round((140 * 1440) / 2));
  });

  it('hour granularity snaps to whole hours and counts the minutes metered from the rows’ samples', () => {
    const doc: RollHourDoc = {
      schemaVersion: 1,
      day: '2026-09-25',
      flows: {
        [FLOW_A]: [hourRow('2026-09-25T09:00:00.000Z', 1, 0, 60), hourRow('2026-09-25T10:00:00.000Z', 10, 4, 60), hourRow('2026-09-25T13:00:00.000Z', 10, 4, 45), hourRow('2026-09-25T14:00:00.000Z', 10, 4, 60)],
        [FLOW_B]: [hourRow('2026-09-25T10:00:00.000Z', 5, 3, 58), hourRow('2026-09-25T11:00:00.000Z', 5, 3, 60)],
      },
    };
    // 10:30 → 13:15 snaps to 10:00 → 14:00: hours 10, 11, 12 (absent) and 13.
    const f = sumRange({ 'roll/hour/2026-09-25': doc }, 'hour', T('2026-09-25T10:30Z'), T('2026-09-25T13:15Z'));
    expect(f.fromMs).toBe(T('2026-09-25T10:00Z'));
    expect(f.toMs).toBe(T('2026-09-25T14:00Z'));
    expect(f.savedM).toBe(6 + 6 + 2 + 2);
    expect(f.rows).toBe(4);
    expect(f.expectedMinutes).toBe(240);
    expect(f.minutesMetered).toBe(60 + 60 + 45); // per hour, the flows' largest sample count
    expect(f.ratePerDayM).toBe(Math.round((16 * 1440) / 165));
  });

  it('day granularity snaps to whole UTC days, has no minute count, and rates per whole day', () => {
    const doc: RollDayDoc = {
      schemaVersion: 1,
      month: '2026-08',
      flows: {
        [FLOW_A]: [
          { t: '2026-08-30T00:00:00.000Z', inB: 1, outB: 1, whpM: 100, paidM: 40, savedM: 60 },
          { t: '2026-08-31T00:00:00.000Z', inB: 1, outB: 1, whpM: 100, paidM: 40, savedM: 60 },
        ],
      },
    };
    const f = sumRange({ 'roll/day/2026-08': doc, 'roll/day/2026-09': null }, 'day', T('2026-08-30T15:00Z'), T('2026-08-31T03:00Z'));
    expect(f.fromMs).toBe(T('2026-08-30T00:00Z'));
    expect(f.toMs).toBe(T('2026-09-01T00:00Z'));
    expect(f.savedM).toBe(120);
    expect(f.minutesMetered).toBeUndefined();
    expect(f.daysMetered).toBe(2);
    expect(f.expectedMinutes).toBe(2880);
    expect(f.ratePerDayM).toBe(60);
    expect(f.docsMissing).toBe(1);
    // The rate is per day METERED: a day without a row lowers neither side of the fraction.
    const gap = sumRange({ 'roll/day/2026-08': doc, 'roll/day/2026-09': null }, 'day', T('2026-08-29T00:00Z'), T('2026-09-02T00:00Z'));
    expect(gap.daysMetered).toBe(2);
    expect(gap.expectedMinutes).toBe(4 * 1440);
    expect(gap.ratePerDayM).toBe(60);
  });

  it('an empty window has zeros and no rate', () => {
    const f = sumRange({ 'roll/min/2026-09-26T10': null }, 'minute', T('2026-09-26T10:00Z'), T('2026-09-26T10:05Z'));
    expect(f).toMatchObject({ savedM: 0, whpM: 0, paidM: 0, ratio: 0, rows: 0, minutesMetered: 0, expectedMinutes: 5, docsRead: 0, docsMissing: 1 });
    expect(f.ratePerDayM).toBeUndefined();
  });

  it('snapRange is the identity at minute granularity', () => {
    expect(snapRange(T('2026-09-26T10:30Z'), T('2026-09-26T10:31Z'), 'minute')).toEqual({ fromMs: T('2026-09-26T10:30Z'), toMs: T('2026-09-26T10:31Z') });
    expect(hourCeil(T('2026-09-26T10:00Z'))).toBe(T('2026-09-26T10:00Z'));
    expect(utcDayFloor(T('2026-09-26T23:59Z'))).toBe(T('2026-09-26T00:00Z'));
    expect(utcDayCeil(T('2026-09-26T00:00:01Z'))).toBe(T('2026-09-27T00:00Z'));
  });
});

// ─── Words ───────────────────────────────────────────────────────────────────

describe('rangeSpanLabel / rangeDuration', () => {
  it('reads times on one day, across days, and whole days as dates, in the display timezone', () => {
    expect(rangeSpanLabel(T('2026-09-26T15:00Z'), T('2026-09-26T19:00Z'), TZ)).toBe('Sep 26, 10:00 AM–2:00 PM');
    expect(rangeSpanLabel(T('2026-09-26T03:00Z'), T('2026-09-26T19:00Z'), TZ)).toBe('Sep 25, 10:00 PM–Sep 26, 2:00 PM');
    expect(rangeSpanLabel(T('2026-09-19T05:00Z'), T('2026-09-26T05:00Z'), TZ)).toBe('Sep 19–25');
    expect(rangeSpanLabel(T('2026-09-26T05:00Z'), T('2026-09-27T05:00Z'), TZ)).toBe('Sep 26');
    expect(rangeSpanLabel(T('2026-09-28T05:00Z'), T('2026-10-05T05:00Z'), TZ)).toBe('Sep 28–Oct 4');
    expect(rangeSpanLabel(T('2026-12-28T06:00Z'), T('2027-01-04T06:00Z'), TZ)).toBe('Dec 28, 2026–Jan 3, 2027');
    expect(rangeSpanLabel(T('2026-12-31T20:00Z'), T('2027-01-01T02:00Z'), TZ)).toBe('Dec 31, 2:00 PM–8:00 PM'); // both on Dec 31 in Chicago
    expect(rangeSpanLabel(T('2027-01-01T04:00Z'), T('2027-01-01T08:00Z'), TZ)).toBe('Dec 31, 2026, 10:00 PM–Jan 1, 2027, 2:00 AM');
    // UTC-day snapping in a non-UTC zone reads as times, honestly.
    expect(rangeSpanLabel(T('2026-09-19T00:00Z'), T('2026-09-26T00:00Z'), TZ)).toBe('Sep 18, 7:00 PM–Sep 25, 7:00 PM');
  });

  it('lengths read in minutes, hours or days', () => {
    expect(rangeDuration(0, 45 * MINUTE_MS)).toEqual({ unit: 'minutes', value: '45', count: 45 });
    expect(rangeDuration(0, 4 * HOUR_MS)).toEqual({ unit: 'hours', value: '4', count: 4 });
    expect(rangeDuration(0, 4.5 * HOUR_MS)).toEqual({ unit: 'hours', value: '4.5', count: 4.5 });
    expect(rangeDuration(0, 7 * DAY_MS)).toEqual({ unit: 'days', value: '7', count: 7 });
    expect(rangeDuration(0, 36 * HOUR_MS)).toEqual({ unit: 'days', value: '1.5', count: 1.5 });
  });
});

// ─── Wall-clock helpers ──────────────────────────────────────────────────────

describe('local wall-clock minutes', () => {
  it('formats and parses a datetime-local value in the display timezone', () => {
    const ms = T('2026-09-26T15:07:00Z');
    expect(formatLocalDateTimeInput(ms, TZ)).toBe('2026-09-26T10:07');
    expect(parseLocalDateTimeInput('2026-09-26T10:07', TZ)).toBe(ms);
    expect(parseLocalDateTimeInput('2026-09-26T10:07:30', TZ)).toBe(ms); // seconds tolerated, floored
    expect(parseLocalDateTimeInput('2026-09-26T10:07', 'UTC')).toBe(T('2026-09-26T10:07:00Z'));
    expect(parseLocalDateTimeInput('2026-02-30T10:07', TZ)).toBeNaN();
    expect(parseLocalDateTimeInput('2026-09-26T24:00', TZ)).toBeNaN();
    expect(parseLocalDateTimeInput('nonsense', TZ)).toBeNaN();
    expect(parseLocalDateTimeInput('', TZ)).toBeNaN();
  });

  it('resolves a spring-forward gap to the first minute after it and a fall-back hour to its first occurrence', () => {
    // 2026-03-08 02:30 does not exist in Chicago: the clocks jump from 02:00 CST to 03:00 CDT (08:00Z).
    expect(localWallToUtcMs(2026, 3, 8, 2, 30, TZ)).toBe(T('2026-03-08T08:00:00Z'));
    // 2026-11-01 01:30 happens twice; the first (CDT) is 06:30Z.
    expect(localWallToUtcMs(2026, 11, 1, 1, 30, TZ)).toBe(T('2026-11-01T06:30:00Z'));
    expect(localWallToUtcMs(2026, 9, 26, 10, 7, TZ)).toBe(T('2026-09-26T15:07:00Z'));
  });
});

// ─── The reader ──────────────────────────────────────────────────────────────

interface FakeRollups extends RollupDocs {
  reads: string[];
  maxInFlight: number;
}

function fakeRollups(docs: Record<string, RangeDoc | null>, opts: { fail?: RegExp; delayMs?: number } = {}): FakeRollups {
  const reads: string[] = [];
  let inFlight = 0;
  const self: FakeRollups = {
    reads,
    maxInFlight: 0,
    async read(key: string): Promise<RangeDoc | null> {
      reads.push(key);
      inFlight++;
      self.maxInFlight = Math.max(self.maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, opts.delayMs ?? 1));
      inFlight--;
      if (opts.fail?.test(key)) throw Object.assign(new Error(`KV GET ${key} failed: HTTP 503`), { status: 503 });
      return docs[key] ?? null;
    },
    readMinute(key) {
      return this.read(key) as Promise<RollMinuteDoc | null>;
    },
    readHour(key) {
      return this.read(key) as Promise<RollHourDoc | null>;
    },
    readDay(key) {
      return this.read(key) as Promise<RollDayDoc | null>;
    },
  } as FakeRollups & { read(key: string): Promise<RangeDoc | null> };
  return self;
}

describe('createRangeReader', () => {
  const minuteDoc = (hourIso: string, rows: number): RollMinuteDoc => ({
    schemaVersion: 1,
    bucketStart: hourIso,
    flows: { [FLOW_A]: Array.from({ length: rows }, (_, i) => minuteRow(new Date(T(hourIso) + i * MINUTE_MS).toISOString(), 100, 40)) },
  });

  it('plans, reads at most four documents at a time, sums, and reports what it read', async () => {
    const docs: Record<string, RangeDoc | null> = {};
    for (let h = 0; h < 25; h++) {
      const start = new Date(T('2026-09-25T17:00Z') + h * HOUR_MS).toISOString();
      docs[`roll/min/${start.slice(0, 13)}`] = minuteDoc(start, 60);
    }
    const rollups = fakeRollups(docs, { delayMs: 3 });
    const reader = createRangeReader({ rollups, now: () => NOW });
    const r = await reader.read({ kind: 'relative', hours: 24 });
    if (!r.ok) throw new Error('read failed');
    expect(rollups.maxInFlight).toBeLessThanOrEqual(4);
    expect(rollups.maxInFlight).toBeGreaterThan(1);
    expect(r.figures.granularity).toBe('minute');
    expect(r.figures.minutesMetered).toBe(24 * 60);
    expect(r.figures.savedM).toBe(24 * 60 * 60);
    expect(r.planned).toBe(25);
    expect(r.cached).toBe(0);
  });

  it('caches immutable buckets, re-reads the current one and the one that just ended', async () => {
    const docs: Record<string, RangeDoc | null> = {
      'roll/min/2026-09-26T15': minuteDoc('2026-09-26T15:00:00.000Z', 60),
      'roll/min/2026-09-26T16': minuteDoc('2026-09-26T16:00:00.000Z', 60),
      'roll/min/2026-09-26T17': minuteDoc('2026-09-26T17:00:00.000Z', 34),
    };
    const rollups = fakeRollups(docs);
    let now = NOW;
    const reader = createRangeReader({ rollups, now: () => now });
    const spec: RangeSpec = { kind: 'relative', hours: 2 };
    await reader.read(spec);
    expect(rollups.reads).toHaveLength(3);
    expect(reader.cacheSize()).toBe(2); // 15 and 16 are past; 17 is current
    const again = await reader.read(spec);
    if (!again.ok) throw new Error('read failed');
    expect(rollups.reads).toHaveLength(4);
    expect(rollups.reads.at(-1)).toBe('roll/min/2026-09-26T17');
    expect(again.cached).toBe(2);
    // Just past the hour: the bucket that ended is still in flight for IMMUTABLE_AFTER_MS.
    now = T('2026-09-26T18:01:00Z');
    docs['roll/min/2026-09-26T18'] = minuteDoc('2026-09-26T18:00:00.000Z', 1);
    await reader.read(spec);
    expect(rollups.reads.slice(4)).toEqual(['roll/min/2026-09-26T17', 'roll/min/2026-09-26T18']);
    now = T('2026-09-26T18:00:00Z') + IMMUTABLE_AFTER_MS;
    await reader.read(spec);
    expect(rollups.reads.slice(6)).toEqual(['roll/min/2026-09-26T17', 'roll/min/2026-09-26T18']); // 17 was read while in flight, so it was never cached
    await reader.read(spec);
    expect(rollups.reads.slice(8)).toEqual(['roll/min/2026-09-26T18']); // now it is
    reader.clearCache();
    expect(reader.cacheSize()).toBe(0);
  });

  it('drops its cache when the sweep cursor jumps (a catch-up rewrote past buckets), not on a normal sweep', async () => {
    const docs: Record<string, RangeDoc | null> = {
      'roll/min/2026-09-26T15': null, // nothing metered yet…
      'roll/min/2026-09-26T16': minuteDoc('2026-09-26T16:00:00.000Z', 60),
      'roll/min/2026-09-26T17': minuteDoc('2026-09-26T17:00:00.000Z', 34),
    };
    const rollups = fakeRollups(docs);
    const reader = createRangeReader({ rollups, now: () => NOW });
    const spec: RangeSpec = { kind: 'relative', hours: 2 };
    const cursor = T('2026-09-26T17:34:00Z');
    const first = await reader.read(spec, undefined, cursor);
    if (!first.ok) throw new Error('read failed');
    expect(first.figures.docsMissing).toBe(1);
    // The next sweep: the cursor moves one minute; the past hours stay cached.
    await reader.read(spec, undefined, cursor + MINUTE_MS);
    expect(rollups.reads.slice(3)).toEqual(['roll/min/2026-09-26T17']);
    // …then the tab's first sweep backfills the day: the cursor jumps, hour 15 now exists, and the reader must see it.
    docs['roll/min/2026-09-26T15'] = minuteDoc('2026-09-26T15:00:00.000Z', 60);
    const after = await reader.read(spec, undefined, cursor + 5 * HOUR_MS);
    if (!after.ok) throw new Error('read failed');
    expect(rollups.reads.slice(4)).toEqual(['roll/min/2026-09-26T15', 'roll/min/2026-09-26T16', 'roll/min/2026-09-26T17']);
    expect(after.figures.docsMissing).toBe(0);
    expect(after.cached).toBe(0);
    // A cursor moving backwards (a rewrite from an older point) also drops the cache; no cursor at all never does.
    await reader.read(spec, undefined, cursor);
    expect(rollups.reads.slice(7)).toHaveLength(3);
    await reader.read(spec);
    expect(rollups.reads.slice(10)).toEqual(['roll/min/2026-09-26T17']);
  });

  it('a missing document is a null in the sum, a failed read is a typed error', async () => {
    const rollups = fakeRollups({}, { fail: /T15$/ });
    const reader = createRangeReader({ rollups, now: () => NOW });
    const ok = await reader.read({ kind: 'relative', hours: 1 }); // 16:34 → 17:34: hours 16 and 17, neither stored
    if (!ok.ok) throw new Error('read failed');
    expect(ok.figures.docsMissing).toBe(2);
    expect(ok.figures.rows).toBe(0);
    const bad = await reader.read({ kind: 'relative', hours: 2 }); // reaches hour 15, which fails
    expect(bad).toMatchObject({ ok: false, reason: 'error' });
    if (!bad.ok && bad.reason === 'error') expect(bad.error.kind).toBe('server');
  });

  it('reads nothing for a range in the future and sums it to zero', async () => {
    const rollups = fakeRollups({});
    const reader = createRangeReader({ rollups, now: () => NOW });
    const r = await reader.read({ kind: 'absolute', fromMs: NOW + HOUR_MS, toMs: NOW + 2 * HOUR_MS });
    if (!r.ok) throw new Error('read failed');
    expect(r.resolved.future).toBe(true);
    expect(rollups.reads).toEqual([]);
    expect(r.figures).toMatchObject({ savedM: 0, rows: 0, docsRead: 0, docsMissing: 0 });
    expect(r.planned).toBe(0);
  });

  it('sums the plan’s window: a 7-day pick at hour granularity is 168 whole hours ending at the last whole hour', async () => {
    const docs: Record<string, RangeDoc | null> = {};
    const hourDoc = (dayIso: string, hours: number[]): RollHourDoc => ({ schemaVersion: 1, day: dayIso, flows: { [FLOW_A]: hours.map((h) => hourRow(`${dayIso}T${String(h).padStart(2, '0')}:00:00.000Z`, 100, 40, 60)) } });
    for (let d = 0; d < 8; d++) {
      const day = new Date(T('2026-09-19T00:00Z') + d * DAY_MS).toISOString().slice(0, 10);
      docs[`roll/hour/${day}`] = hourDoc(day, Array.from({ length: 24 }, (_, i) => i));
    }
    const rollups = fakeRollups(docs);
    const reader = createRangeReader({ rollups, now: () => NOW });
    const r = await reader.read({ kind: 'relative', hours: 168 });
    if (!r.ok) throw new Error('read failed');
    expect(r.figures.fromMs).toBe(T('2026-09-19T17:00Z'));
    expect(r.figures.toMs).toBe(T('2026-09-26T17:00Z'));
    expect(r.figures.rows).toBe(168);
    expect(r.figures.savedM).toBe(168 * 60);
    expect(r.figures.expectedMinutes).toBe(168 * 60);
    expect(r.figures.minutesMetered).toBe(168 * 60);
  });

  it('passes collecting-since through to the resolution', async () => {
    const rollups = fakeRollups({});
    const reader = createRangeReader({ rollups, now: () => NOW });
    const r = await reader.read({ kind: 'relative', hours: 24 }, T('2026-09-26T16:00:00Z'));
    if (!r.ok) throw new Error('read failed');
    expect(r.resolved.clippedStart).toBe(true);
    expect(r.resolved.fromMs).toBe(T('2026-09-26T16:00:00Z'));
    expect(rollups.reads).toEqual(['roll/min/2026-09-26T16', 'roll/min/2026-09-26T17']);
  });
});

// ─── The action ──────────────────────────────────────────────────────────────

describe('actions.readRange', () => {
  const DEFAULTS = defaultSettings('2026-09-26T12:00:00.000Z', 'UTC');
  function services(opts: { hydrated?: boolean; source?: 'live' | 'sample'; rollups?: RollupDocs; collectingSince?: string } = {}) {
    const docs: AppDocs = {
      readSettings: async () => null,
      readPrices: async () => null,
      readSnapshot: async () => null,
      readMeta: async () => null,
      readDemoState: async () => null,
      readInventory: async () => null,
      writeSettings: async () => undefined,
      writePrices: async () => undefined,
      ...(opts.rollups ? { rollups: opts.rollups } : {}),
    };
    const store = createAppStore(DEFAULTS, {
      hasHydrated: opts.hydrated ?? true,
      source: opts.source ?? 'live',
      meta: opts.collectingSince
        ? { schemaVersion: 1, installedAt: opts.collectingSince, collectingSince: opts.collectingSince, appVersion: '1', build: 'release', metricsSource: 'metrics-query', sweepErrors: 0, consecutiveRateLimited: 0, sweepCount: 1 }
        : null,
    });
    return createAppServices({ store, docs, mergeSettings: (s) => s, engine: { runLocal: vi.fn(), invokeBackend: vi.fn() }, now: () => NOW });
  }

  it('refuses before hydration, on sample data, and without a rollup port', async () => {
    expect(await services({ hydrated: false, rollups: fakeRollups({}) }).actions.readRange({ kind: 'relative', hours: 1 })).toEqual({ ok: false, reason: 'not-hydrated' });
    expect(await services({ source: 'sample', rollups: fakeRollups({}) }).actions.readRange({ kind: 'relative', hours: 1 })).toEqual({ ok: false, reason: 'not-live' });
    expect(await services().actions.readRange({ kind: 'relative', hours: 1 })).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('reads through the port and clips to meta.collectingSince', async () => {
    const rollups = fakeRollups({});
    const r = await services({ rollups, collectingSince: '2026-09-26T17:00:00.000Z' }).actions.readRange({ kind: 'relative', hours: 6 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolved.clippedStart).toBe(true);
      expect(r.resolved.fromMs).toBe(T('2026-09-26T17:00:00Z'));
    }
    expect(rollups.reads).toEqual(['roll/min/2026-09-26T17']);
  });
});

// ─── The URL param ───────────────────────────────────────────────────────────

describe('?range=', () => {
  it('parses into the app params, sticks across tabs, and clears with an undefined patch', () => {
    const search = new URLSearchParams('period=today&range=6h&group=default');
    expect(readAppParams(search).range).toEqual({ kind: 'relative', hours: 6 });
    expect(readAppParams(new URLSearchParams('range=nope')).range).toBeUndefined();
    expect(hrefWithStickyParams('/ledger', search)).toBe('/ledger?group=default&period=today&range=6h');
    // The Ledger's change timeline keeps its own key, so neither view's choice reaches the other's.
    expect(readLedgerParams(search).range).toBe('24h');
    expect(readLedgerParams(new URLSearchParams('timeline=7d')).range).toBe('7d');
    expect(readAppParams(patchLedgerParams(new URLSearchParams('period=mtd'), { range: '7d' })).range).toBeUndefined();
    expect(patchLedgerParams(new URLSearchParams('range=6h&timeline=7d'), { range: '24h' }).toString()).toBe('range=6h');
    const cleared = patchSearchParams(search, { period: 'mtd', range: undefined });
    expect(cleared.get('range')).toBeNull();
    expect(cleared.get('period')).toBe('mtd');
    const set = patchSearchParams(search, { range: formatRangeParam({ kind: 'absolute', fromMs: T('2026-09-26T10:00Z'), toMs: T('2026-09-26T14:00Z') }) });
    expect(set.get('range')).toBe('2026-09-26T10:00Z..2026-09-26T14:00Z');
  });
});

// ─── The hero's words and caption (src/views/Receipt/text.ts) ────────────────

describe('rangeCaption / rangePreview', () => {
  const snapshot = { collectingSince: '2026-08-17T02:41:00.000Z', sweepAt: '2026-09-26T17:34:56.000Z' };
  const hourDocs = (): Record<string, RangeDoc | null> => {
    const docs: Record<string, RangeDoc | null> = {};
    for (let d = 0; d < 8; d++) {
      const day = new Date(T('2026-09-19T00:00Z') + d * DAY_MS).toISOString().slice(0, 10);
      docs[`roll/hour/${day}`] = { schemaVersion: 1, day, flows: { [FLOW_A]: Array.from({ length: 24 }, (_, h) => hourRow(`${day}T${String(h).padStart(2, '0')}:00:00.000Z`, 100, 40, 60)) } };
    }
    return docs;
  };

  it('a quick pick at hour granularity is whole hours through the last whole hour, never "widened"', () => {
    const spec: RangeSpec = { kind: 'relative', hours: 168 };
    const resolved = resolveRange(spec, NOW);
    const plan = planRangeReads(resolved.fromMs, resolved.toMs, NOW);
    const figures = sumRange(hourDocs(), plan.granularity, plan.window.fromMs, plan.window.toMs);
    expect(rangeCaption(figures, resolved, spec, snapshot, TZ)).toBe('whole hours · 10,080 of 10,080 minutes metered · through the last whole hour');
    expect(rangeWords(figures, TZ, Date.parse('2026-09-27T12:00:00Z'))).toBe('Sep 19, 12:00 PM–Sep 26, 12:00 PM (7 days)');
    expect(rangePreview(spec, NOW, undefined, TZ)).toMatchObject({ granularity: 'hour', future: false, fromMs: figures.fromMs, toMs: figures.toMs, words: 'Sep 19, 12:00 PM–Sep 26, 12:00 PM (7 days)' });
    expect(rangePreviewLine(rangePreview(spec, NOW, undefined, TZ))).toBe('Summed in whole hours as Sep 19, 12:00 PM–Sep 26, 12:00 PM (7 days).');
  });

  it('an exact window says when the rows widened it, and when they stop short of it', () => {
    const spec: RangeSpec = { kind: 'absolute', fromMs: T('2026-09-23T15:30Z'), toMs: T('2026-09-23T18:10Z') };
    const resolved = resolveRange(spec, NOW);
    const plan = planRangeReads(resolved.fromMs, resolved.toMs, NOW);
    const figures = sumRange(hourDocs(), plan.granularity, plan.window.fromMs, plan.window.toMs);
    expect(rangeCaption(figures, resolved, spec, snapshot, TZ)).toBe('widened to whole hours · 240 of 240 minutes metered');
    // Ending inside the hour in progress: not widened past now, stopped at the last whole hour instead.
    const tail: RangeSpec = { kind: 'absolute', fromMs: T('2026-09-24T15:00Z'), toMs: T('2026-09-26T17:20Z') };
    const r2 = resolveRange(tail, NOW);
    const p2 = planRangeReads(r2.fromMs, r2.toMs, NOW);
    const f2 = sumRange(hourDocs(), p2.granularity, p2.window.fromMs, p2.window.toMs);
    expect(f2.toMs).toBe(T('2026-09-26T17:00Z'));
    expect(rangeCaption(f2, r2, tail, snapshot, TZ)).toBe('whole hours · 3,000 of 3,000 minutes metered · through the last whole hour');
    // A window reaching into the future and the hour in progress: the cap explains the end once.
    const ahead: RangeSpec = { kind: 'absolute', fromMs: T('2026-09-24T15:00Z'), toMs: T('2026-09-27T00:00Z') };
    const r3 = resolveRange(ahead, NOW);
    expect(r3.clippedEnd).toBe(true);
    const p3 = planRangeReads(r3.fromMs, r3.toMs, NOW);
    const f3 = sumRange(hourDocs(), p3.granularity, p3.window.fromMs, p3.window.toMs);
    expect(rangeCaption(f3, r3, ahead, snapshot, TZ)).toBe('whole hours · 3,000 of 3,000 minutes metered · through the last whole hour');
  });

  it('whole UTC days count the days metered; the retention and the future are named', () => {
    const doc: RollDayDoc = {
      schemaVersion: 1,
      month: '2026-08',
      flows: { [FLOW_A]: [{ t: '2026-08-22T00:00:00.000Z', inB: 1, outB: 1, whpM: 100, paidM: 40, savedM: 60 }, { t: '2026-08-23T00:00:00.000Z', inB: 1, outB: 1, whpM: 100, paidM: 40, savedM: 60 }] },
    };
    const spec: RangeSpec = { kind: 'absolute', fromMs: T('2026-08-22T05:00Z'), toMs: T('2026-08-24T05:00Z') };
    const resolved = resolveRange(spec, NOW);
    const plan = planRangeReads(resolved.fromMs, resolved.toMs, NOW);
    expect(plan.window).toEqual({ fromMs: T('2026-08-22T00:00Z'), toMs: T('2026-08-25T00:00Z') });
    const figures = sumRange({ 'roll/day/2026-08': doc }, plan.granularity, plan.window.fromMs, plan.window.toMs);
    expect(rangeCaption(figures, resolved, spec, snapshot, TZ)).toBe('widened to whole UTC days · 2 of 3 days metered');
    const old: RangeSpec = { kind: 'absolute', fromMs: T('2024-01-01T00:00Z'), toMs: T('2026-08-24T05:00Z') };
    const r2 = resolveRange(old, NOW, T('2023-06-01T00:00Z'));
    const p2 = planRangeReads(r2.fromMs, r2.toMs, NOW);
    const f2 = sumRange({ 'roll/day/2026-08': doc }, p2.granularity, p2.window.fromMs, p2.window.toMs);
    expect(rangeCaption(f2, r2, old, snapshot, TZ)).toBe('widened to whole UTC days · 2 of 358 days metered · history is kept for 13 months');
    const future: RangeSpec = { kind: 'absolute', fromMs: NOW + DAY_MS, toMs: NOW + 2 * DAY_MS };
    const r3 = resolveRange(future, NOW);
    expect(rangeCaption(emptyRangeFigures(r3.fromMs, r3.toMs), r3, future, snapshot, TZ)).toBe('this window is in the future · nothing was metered in this window');
    expect(rangePreviewLine(rangePreview(future, NOW, undefined, TZ))).toBe('This window is in the future: nothing has been metered in it yet.');
  });

  it('a clipped start says when collecting began; nothing metered says so', () => {
    const spec: RangeSpec = { kind: 'relative', hours: 6 };
    const since = T('2026-09-26T15:41:30Z');
    const resolved = resolveRange(spec, NOW, since);
    const figures = sumRange({}, 'minute', resolved.fromMs, resolved.toMs);
    expect(rangeCaption(figures, resolved, spec, { ...snapshot, collectingSince: '2026-09-26T15:41:30.000Z' }, TZ)).toBe('minute-exact · collecting since 10:41 AM · nothing was metered in this window');
  });
});

describe('a window in another year (OQ-05)', () => {
  it('names its year when given now, and not otherwise', () => {
    const tz = 'America/Chicago';
    const now = Date.parse('2026-09-27T12:00:00Z');
    const from = Date.parse('2025-09-12T00:00:00Z');
    const to = Date.parse('2025-09-13T00:00:00Z');
    expect(rangeSpanLabel(from, to, tz, now)).toBe('Sep 11, 2025, 7:00 PM–Sep 12, 2025, 7:00 PM');
    expect(rangeSpanLabel(from, to, tz)).toBe('Sep 11, 7:00 PM–Sep 12, 7:00 PM');
    expect(rangeSpanLabel(Date.parse('2026-09-19T05:00:00Z'), Date.parse('2026-09-26T05:00:00Z'), tz, now)).toBe('Sep 19–25');
    expect(rangeSpanLabel(Date.parse('2025-09-19T05:00:00Z'), Date.parse('2025-09-26T05:00:00Z'), tz, now)).toBe('Sep 19–25, 2025');
    expect(rangeSpanLabel(Date.parse('2024-10-26T01:28:00Z'), Date.parse('2024-10-26T03:28:00Z'), tz, now)).toBe('Oct 25, 2024, 8:28 PM–10:28 PM');
  });
});
