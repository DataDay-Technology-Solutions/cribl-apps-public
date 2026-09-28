// tests/unit/sampleRollups.test.ts — the rollup history synthesized for the Tour's sample snapshot (P2-W05).
//
// Acceptance: the day rows add up to the trend and the hour rows of a day add up to that day's figure, exactly
// (integer millicents). Here, precisely: a completed local day's hour rows sum to its trend point; today's
// completed hours plus the current hour's minute rows sum to today's point when played at the recording's own
// time of day (at another it runs at the point's rate, the last describe); an hour's minute rows sum to its
// hour row; a day row is its UTC day's hour rows; and all the history together is the whole trend. Then the
// documents go through core/range.ts unchanged — the plan, the reads, the sum — the way the Receipt reads them.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allot, diurnalRatios, sampleRollups, SAMPLE_MINUTE_HOURS, type SampleRollups } from '../../core/sampleRollups.ts';
import { planRangeReads, resolveRange, sumRange, type RangeDoc } from '../../core/range.ts';
import { dayDocKey, hourDocKey, minuteDocKey } from '../../core/rollups.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, addDaysToKey, fromIso, hourFloor, localDayKey, localDayStartMs, toIso, utcDayFloor } from '../../core/time.ts';
import type { FlowFigures, Snapshot, TrendPoint } from '../../core/types.ts';
import type { TourFixture } from '../../src/tour/types.ts';
import { planRebase, rebaseValue } from '../../src/tour/rebase.ts';

const TOUR = JSON.parse(readFileSync(fileURLToPath(new URL('../../demo/sample/tour.json', import.meta.url)), 'utf8')) as TourFixture;
const SNAP = TOUR.snapshot;
const TZ = TOUR.settings.displayTimezone;

interface Row {
  t: string;
  whpM: number;
  paidM: number;
  savedM: number;
  inB: number;
  outB: number;
}
type Money = Pick<Row, 'whpM' | 'paidM' | 'savedM'>;
const zero = (): Money => ({ whpM: 0, paidM: 0, savedM: 0 });
const add = (acc: Money, r: Money): Money => ({ whpM: acc.whpM + r.whpM, paidM: acc.paidM + r.paidM, savedM: acc.savedM + r.savedM });
const trendMoney = (p: TrendPoint): Money => ({ whpM: p.whpM, paidM: p.paidM, savedM: p.savedM });

/** Every row of every document of a family, flattened (flow key alongside). */
function rows(s: SampleRollups, family: 'minute' | 'hour' | 'day'): (Row & { flow: string })[] {
  const out: (Row & { flow: string })[] = [];
  for (const key of s.keys()[family]) {
    const doc = family === 'minute' ? s.minuteDoc(key) : family === 'hour' ? s.hourDoc(key) : s.dayDoc(key);
    expect(doc, key).not.toBeNull();
    for (const [flow, list] of Object.entries(doc!.flows as Record<string, Row[]>)) for (const r of list) out.push({ ...r, flow });
  }
  return out;
}
const sumWhere = (list: Row[], pred: (t: number) => boolean): Money => list.filter((r) => pred(fromIso(r.t))).reduce(add, zero());

describe('allot (largest remainder)', () => {
  it('parts are integers that sum to exactly the total, in proportion to the weights', () => {
    expect(allot(10, [1, 1, 1])).toEqual([4, 3, 3]);
    expect(allot(100, [3, 1])).toEqual([75, 25]);
    expect(allot(7, [0, 0])).toEqual([4, 3]);
    expect(allot(0, [5, 2])).toEqual([0, 0]);
    expect(allot(-10, [1, 1, 1])).toEqual([-4, -3, -3]);
    expect(allot(5, [])).toEqual([]);
    const parts = allot(1_277_063_504, [0.37, 0.4, 0.39, Number.NaN, -1, 0.41]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1_277_063_504);
    expect(parts[3]).toBe(0);
    expect(parts[4]).toBe(0);
    for (const p of parts) expect(Number.isInteger(p)).toBe(true);
  });
});

describe('diurnalRatios', () => {
  it('reads the 24-hour ratio series into a savings ratio per local hour of day', () => {
    const r = diurnalRatios(SNAP.ratioSeries, TZ);
    expect(r).toHaveLength(24);
    for (const x of r) expect(x).toBeGreaterThan(0.2);
    for (const x of r) expect(x).toBeLessThan(0.6);
    expect(diurnalRatios([], TZ)).toEqual(new Array(24).fill(0.5));
  });
});

describe('sampleRollups on the Tour fixture', () => {
  const s = sampleRollups(SNAP, TZ);
  const hourRows = rows(s, 'hour');
  const minuteRows = rows(s, 'minute');
  const dayRows = rows(s, 'day');
  const endMs = s.toMs;
  const currentHour = hourFloor(endMs);
  const today = localDayKey(endMs - 1, TZ);

  it('covers the trend up to the last metered minute: 25 h of minute documents, ~31 days of hour documents, the months of day documents', () => {
    expect(endMs).toBe(fromIso(SNAP.windowEnd));
    expect(s.fromMs).toBe(localDayStartMs(SNAP.trend[0].day, TZ));
    expect(s.keys().minute).toHaveLength(SAMPLE_MINUTE_HOURS + 1);
    expect(s.keys().minute.at(-1)).toBe(minuteDocKey(endMs - 1));
    expect(s.keys().hour.length).toBeGreaterThanOrEqual(30);
    expect(s.keys().hour.length).toBeLessThanOrEqual(32);
    expect(s.keys().day).toEqual([...new Set([dayDocKey(s.fromMs), dayDocKey(endMs - DAY_MS)])]);
    for (const r of [...hourRows, ...minuteRows, ...dayRows]) {
      expect(fromIso(r.t)).toBeGreaterThanOrEqual(utcDayFloor(s.fromMs));
      expect(fromIso(r.t)).toBeLessThan(endMs);
    }
  });

  it('every row is whole millicents, never negative, and would-have-paid = paid + saved', () => {
    for (const r of [...hourRows, ...minuteRows, ...dayRows]) {
      for (const v of [r.whpM, r.paidM, r.savedM, r.inB, r.outB]) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(r.whpM).toBe(r.paidM + r.savedM);
    }
  });

  it('every flow of the snapshot has its rows, one per bucket, in time order', () => {
    const flows = new Set(SNAP.flows.map((f) => f.key));
    for (const family of ['minute', 'hour', 'day'] as const) {
      for (const key of s.keys()[family]) {
        const doc = family === 'minute' ? s.minuteDoc(key) : family === 'hour' ? s.hourDoc(key) : s.dayDoc(key);
        expect(new Set(Object.keys(doc!.flows))).toEqual(flows);
        for (const list of Object.values(doc!.flows as Record<string, Row[]>)) {
          const ts = list.map((r) => fromIso(r.t));
          expect([...ts].sort((a, b) => a - b)).toEqual(ts);
          expect(new Set(ts).size).toBe(ts.length);
        }
      }
    }
  });

  it('a completed local day: its hour rows sum to its trend point exactly', () => {
    const completed = SNAP.trend.filter((p) => p.day !== today);
    expect(completed).toHaveLength(SNAP.trend.length - 1);
    for (const p of completed) {
      const from = localDayStartMs(p.day, TZ);
      const to = localDayStartMs(addDaysToKey(p.day, 1), TZ);
      expect(sumWhere(hourRows, (t) => t >= from && t < to), p.day).toEqual(trendMoney(p));
    }
  });

  it("today: the completed hours plus the current hour's minute rows sum to today's trend point exactly", () => {
    const p = SNAP.trend.at(-1)!;
    expect(p.day).toBe(today);
    const from = localDayStartMs(p.day, TZ);
    const done = sumWhere(hourRows, (t) => t >= from);
    const current = sumWhere(minuteRows, (t) => t >= currentHour);
    expect(add(done, current)).toEqual(trendMoney(p));
    // The hour in progress has no hour row: the sweep folds an hour once it has ended.
    expect(hourRows.some((r) => fromIso(r.t) === currentHour)).toBe(false);
    expect(minuteRows.filter((r) => fromIso(r.t) >= currentHour && r.flow === SNAP.flows[0].key)).toHaveLength((endMs - currentHour) / MINUTE_MS);
  });

  it("an hour's minute rows sum to its hour row, flow by flow", () => {
    const byFlowHour = new Map<string, Money>();
    for (const r of minuteRows) {
      const k = `${r.flow}@${hourFloor(fromIso(r.t))}`;
      byFlowHour.set(k, add(byFlowHour.get(k) ?? zero(), r));
    }
    let checked = 0;
    for (const r of hourRows) {
      const k = `${r.flow}@${fromIso(r.t)}`;
      if (!byFlowHour.has(k)) continue;
      expect(byFlowHour.get(k), k).toEqual({ whpM: r.whpM, paidM: r.paidM, savedM: r.savedM });
      checked++;
    }
    expect(checked).toBe(SAMPLE_MINUTE_HOURS * SNAP.flows.length);
  });

  it('a day row is the fold of its UTC day of hour rows; the UTC day in progress has none; all of it together is the whole trend', () => {
    for (const d of dayRows) {
      const start = fromIso(d.t);
      expect(start).toBe(utcDayFloor(start));
      expect(start + DAY_MS).toBeLessThanOrEqual(endMs);
      const folded = hourRows.filter((h) => h.flow === d.flow && utcDayFloor(fromIso(h.t)) === start).reduce(add, zero());
      expect(folded).toEqual({ whpM: d.whpM, paidM: d.paidM, savedM: d.savedM });
    }
    expect(dayRows.some((d) => fromIso(d.t) === utcDayFloor(endMs))).toBe(false);
    const dayDocsTotal = dayRows.reduce(add, zero());
    const rest = add(
      sumWhere(hourRows, (t) => t >= utcDayFloor(endMs)),
      sumWhere(minuteRows, (t) => t >= currentHour),
    );
    expect(add(dayDocsTotal, rest)).toEqual(SNAP.trend.map(trendMoney).reduce(add, zero()));
  });

  it('splits each hour across the flows by their share of the day: a flow that saves nothing never shows a saving', () => {
    const passthrough = SNAP.flows.filter((f) => f.savedPerDayM === 0 && f.paidPerDayM > 0);
    expect(passthrough.length).toBeGreaterThan(0);
    for (const f of passthrough) for (const r of hourRows.filter((x) => x.flow === f.key)) expect(r.savedM).toBe(0);
    const top = [...SNAP.flows].sort((a, b) => b.savedPerDayM - a.savedPerDayM)[0];
    const topSaved = hourRows.filter((r) => r.flow === top.key).reduce(add, zero()).savedM;
    const allSaved = hourRows.reduce(add, zero()).savedM;
    const share = top.savedPerDayM / SNAP.flows.reduce((a, f) => a + f.savedPerDayM, 0);
    expect(topSaved / allSaved).toBeCloseTo(share, 4);
  });

  it('is deterministic: the same snapshot builds the same documents', () => {
    const again = sampleRollups(JSON.parse(JSON.stringify(SNAP)) as Snapshot, TZ);
    expect(again.keys()).toEqual(s.keys());
    for (const key of s.keys().hour) expect(again.hourDoc(key)).toEqual(s.hourDoc(key));
    const k = s.keys().minute[3];
    expect(again.minuteDoc(k)).toEqual(s.minuteDoc(k));
  });

  it('a key it holds nothing for reads as null (the store has no such document)', async () => {
    expect(s.minuteDoc(minuteDocKey(endMs - 30 * HOUR_MS))).toBeNull();
    expect(s.minuteDoc(minuteDocKey(endMs + HOUR_MS))).toBeNull();
    expect(s.hourDoc(hourDocKey(s.fromMs - 3 * DAY_MS))).toBeNull();
    expect(s.dayDoc(dayDocKey(s.fromMs - 90 * DAY_MS))).toBeNull();
    expect(s.hourDoc('roll/hour/not-a-day')).toBeNull();
    expect(await s.readHour(s.keys().hour[0])).toBe(s.hourDoc(s.keys().hour[0]));
  });
});

describe('sampleRollups through core/range.ts (the Receipt reads it like the KV history)', () => {
  const s = sampleRollups(SNAP, TZ);
  const now = s.toMs + 35_000; // the tour shows the snapshot 35 s after its last metered minute
  const since = fromIso(SNAP.collectingSince);

  async function readRange(hours: number) {
    const resolved = resolveRange({ kind: 'relative', hours }, now, since);
    const plan = planRangeReads(resolved.fromMs, resolved.toMs, now);
    const docs: Record<string, RangeDoc | null> = {};
    for (const key of plan.keys) docs[key] = plan.granularity === 'minute' ? await s.readMinute(key) : plan.granularity === 'hour' ? await s.readHour(key) : await s.readDay(key);
    return { plan, figures: sumRange(docs, plan.granularity, plan.window.fromMs, plan.window.toMs) };
  }

  it('7 days: hour documents, every hour of the window metered, about a week of the trend', async () => {
    const { plan, figures } = await readRange(7 * 24);
    expect(plan.granularity).toBe('hour');
    expect(figures.docsMissing).toBe(0);
    expect(figures.minutesMetered).toBe(figures.expectedMinutes);
    const hourRows = rows(s, 'hour');
    expect({ whpM: figures.whpM, paidM: figures.paidM, savedM: figures.savedM }).toEqual(sumWhere(hourRows, (t) => t >= plan.window.fromMs && t < plan.window.toMs));
    // The last seven trend days (today partial) bracket it.
    const week = SNAP.trend.slice(-8).map(trendMoney).reduce(add, zero()).savedM;
    const sixDays = SNAP.trend.slice(-7, -1).map(trendMoney).reduce(add, zero()).savedM;
    expect(figures.savedM).toBeGreaterThan(sixDays);
    expect(figures.savedM).toBeLessThan(week);
    expect(figures.ratio).toBeGreaterThan(0.3);
    expect(figures.ratio).toBeLessThan(0.5);
  });

  it('24 hours and 1 hour: minute documents, the rate close to the snapshot', async () => {
    const day = await readRange(24);
    expect(day.plan.granularity).toBe('minute');
    expect(day.figures.docsMissing).toBe(0);
    expect(day.figures.minutesMetered).toBe(24 * 60);
    const minuteRows = rows(s, 'minute');
    expect(day.figures.savedM).toBe(sumWhere(minuteRows, (t) => t >= day.plan.window.fromMs && t < day.plan.window.toMs).savedM);
    const hour = await readRange(1);
    expect(hour.figures.minutesMetered).toBe(60);
    expect(hour.figures.savedM).toBeGreaterThan(0);
    // An hour's savings ratio follows the diurnal curve the Receipt draws.
    const curve = diurnalRatios(SNAP.ratioSeries, TZ);
    expect(Math.abs(hour.figures.ratio - curve[Math.floor((hour.plan.window.fromMs - localDayStartMs(localDayKey(hour.plan.window.fromMs, TZ), TZ)) / HOUR_MS)])).toBeLessThan(0.06);
  });

  it('30 days: every day of the trend, nothing before collecting began', async () => {
    const { plan, figures } = await readRange(30 * 24);
    expect(plan.granularity).toBe('hour');
    expect(figures.savedM).toBeGreaterThan(SNAP.trend.slice(-29, -1).map(trendMoney).reduce(add, zero()).savedM);
    expect(figures.savedM).toBeLessThanOrEqual(SNAP.trend.map(trendMoney).reduce(add, zero()).savedM);
  });
});

describe('sampleRollups across a daylight-saving change and in a half-hour zone', () => {
  const flows = [
    { key: 'g|a|r|p|siem', savedPerDayM: 3_000_000, paidPerDayM: 1_000_000, whpPerDayM: 4_000_000, inBPerDay: 5e11, outBPerDay: 1.5e11 },
    { key: 'g|b|r|p|s3', savedPerDayM: 0, paidPerDayM: 50_000, whpPerDayM: 50_000, inBPerDay: 2e11, outBPerDay: 2e11 },
  ] as FlowFigures[];
  const snap = (tz: string, days: string[], windowEnd: string): Snapshot =>
    ({
      sweepAt: windowEnd,
      windowEnd,
      collectingSince: '2026-01-01T00:00:00.000Z',
      flows,
      ratioSeries: [],
      trend: days.map((day, i) => ({ day, savedM: 2_950_000 + i * 17, paidM: 1_050_000 - i * 3, whpM: 4_000_000 + i * 14 })),
    }) as unknown as Snapshot;

  it('America/Chicago over the fall-back day (25 local hours): each completed local day still sums exactly', () => {
    const tz = 'America/Chicago';
    const days = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'];
    const s = sampleRollups(snap(tz, days, '2026-11-03T18:30:00.000Z'), tz);
    const hourRows = rows(s, 'hour');
    for (const p of snap(tz, days, '2026-11-03T18:30:00.000Z').trend.slice(0, -1)) {
      const from = localDayStartMs(p.day, tz);
      const to = localDayStartMs(addDaysToKey(p.day, 1), tz);
      const inDay = hourRows.filter((r) => fromIso(r.t) >= from && fromIso(r.t) < to);
      expect(inDay.reduce(add, zero()), p.day).toEqual(trendMoney(p));
      expect(new Set(inDay.map((r) => r.t)).size).toBe(p.day === '2026-11-01' ? 25 : 24);
    }
  });

  it('Asia/Kolkata (UTC+5:30): an hour shared by two local days is one row, and everything still adds up to the trend', () => {
    const tz = 'Asia/Kolkata';
    const days = ['2026-09-20', '2026-09-21', '2026-09-22'];
    const s = sampleRollups(snap(tz, days, '2026-09-22T10:15:00.000Z'), tz);
    const hourRows = rows(s, 'hour');
    const minuteRows = rows(s, 'minute');
    for (const flow of flows) {
      const ts = hourRows.filter((r) => r.flow === flow.key).map((r) => r.t);
      expect(new Set(ts).size).toBe(ts.length);
    }
    const current = hourFloor(s.toMs);
    const all = add(
      hourRows.reduce(add, zero()),
      sumWhere(minuteRows, (t) => t >= current),
    );
    expect(all).toEqual(snap(tz, days, '2026-09-22T10:15:00.000Z').trend.map(trendMoney).reduce(add, zero()));
    expect(toIso(s.fromMs)).toBe('2026-09-19T18:30:00.000Z');
  });
});

// Review W2 ("the squeeze"): a tour moves the recording onto the wall clock, so its sweep lands at whatever time of
// day the judge opens it. Today's recorded point covers the recording's own first minutesToday minutes; spread over
// the hours since midnight as they stand at play time it was squeezed into one hour at 1:34 AM ($3,799 in hour 0)
// and stretched at 10 PM. Today now runs at the rate the point was metered at: an hour reads about the same
// whatever the time of day, and today's total grows with the clock.
describe('sampleRollups on a tour played at different times of day (review W2)', () => {
  const ANCHOR = Date.parse(TOUR.anchor ?? TOUR.generatedAt);
  /** Today's saved per local hour, from midnight to the play's sweep (completed hours from hour documents). */
  function todayHours(wallIso: string): number[] {
    const wall = Date.parse(wallIso);
    const moved = rebaseValue(SNAP, planRebase(ANCHOR, wall, TZ));
    const s = sampleRollups(moved, TZ);
    const dayStart = localDayStartMs(localDayKey(wall - 60_000, TZ), TZ);
    const out: number[] = [];
    for (let h = dayStart; h + HOUR_MS <= s.toMs; h += HOUR_MS) {
      const doc = s.hourDoc(hourDocKey(h));
      const inHour = doc ? Object.values(doc.flows).flat().filter((r) => fromIso(r.t) === h) : [];
      out.push(inHour.reduce((a, r) => a + r.savedM, 0));
    }
    return out;
  }
  const RECORDED_PER_HOUR = (SNAP.trend.at(-1)!.savedM / (SNAP.headline.minutesToday ?? 1)) * 60;

  it("an hour of today reads the same whatever the time of day the tour is opened at", () => {
    const early = todayHours('2026-09-27T06:34:00Z'); // 1:34 AM in Chicago: one completed hour
    const morning = todayHours('2026-09-27T11:30:00Z'); // 6:30 AM
    const night = todayHours('2026-09-28T03:30:00Z'); // 10:30 PM
    expect(early).toHaveLength(1);
    expect(morning).toHaveLength(6);
    expect(night).toHaveLength(22);
    for (const first of [early[0], morning[0], night[0]]) {
      expect(first / night[0]).toBeGreaterThan(0.9);
      expect(first / night[0]).toBeLessThan(1.1);
      // Near the recording's own hourly rate, never the whole day's point squeezed into one hour.
      expect(first / RECORDED_PER_HOUR).toBeGreaterThan(0.75);
      expect(first / RECORDED_PER_HOUR).toBeLessThan(1.25);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(morning) / mean(night.slice(0, 6))).toBeGreaterThan(0.9);
    expect(mean(morning) / mean(night.slice(0, 6))).toBeLessThan(1.1);
  });
});
