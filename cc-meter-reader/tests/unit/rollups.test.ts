import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { MinuteRow, RollMinuteDoc, TotalsDoc } from '../../core/types.ts';
import {
  MAX_MINUTE_ROWS,
  addMinuteToTotals,
  addOutputMinuteToTotals,
  aggregateRows,
  dayDocKey,
  emptyMinuteDoc,
  emptyTotals,
  expiredKeys,
  findMinuteRow,
  foldDayRows,
  foldHourRows,
  hourDocKey,
  mergeRowsByFlow,
  minuteDocKey,
  outputMonthTotals,
  poolMinuteRows,
  pruneTotals,
  sparkline,
  sumFlowRows,
  totalsKey,
  upsertDayRows,
  upsertHourRows,
  upsertMinuteRow,
  upsertMinuteRows,
} from '../../core/rollups.ts';

const HOUR = '2026-09-26T03:00:00.000Z';
const row = (minute: number, savedM = 10, over: Partial<MinuteRow> = {}): MinuteRow => ({
  t: `2026-09-26T03:${String(minute).padStart(2, '0')}:00.000Z`,
  inB: 1000,
  outB: 400,
  inE: 10,
  outE: 5,
  whpM: 2 * savedM,
  paidM: savedM,
  savedM,
  ...over,
});

describe('keys', () => {
  const t = Date.parse('2026-09-26T03:41:00Z');
  it('builds slash-delimited keys', () => {
    expect(minuteDocKey(t)).toBe('roll/min/2026-09-26T03');
    expect(hourDocKey(t)).toBe('roll/hour/2026-09-26');
    expect(dayDocKey(t)).toBe('roll/day/2026-09');
    expect(totalsKey).toBe('totals');
  });
});

describe('minute rows', () => {
  it('inserts sorted, replaces the same minute, and does not mutate', () => {
    const d0 = emptyMinuteDoc(HOUR);
    const d1 = upsertMinuteRow(d0, HOUR, 'f', row(5));
    const d2 = upsertMinuteRow(d1, HOUR, 'f', row(2));
    const d3 = upsertMinuteRow(d2, HOUR, 'f', row(5, 99));
    expect(d0.flows).toEqual({});
    expect(d1.flows.f).toHaveLength(1);
    expect(d3.flows.f.map((r) => r.t.slice(14, 16))).toEqual(['02', '05']);
    expect(findMinuteRow(d3, 'f', row(5).t)?.savedM).toBe(99);
    expect(findMinuteRow(d2, 'f', row(5).t)?.savedM).toBe(10);
    expect(findMinuteRow(null, 'f', row(5).t)).toBeUndefined();
  });
  it('creates a document when none exists and caps at 60 per flow', () => {
    let d: RollMinuteDoc | null = null;
    for (let m = 0; m < 70; m++) {
      d = upsertMinuteRow(d, HOUR, 'f', { ...row(0), t: new Date(Date.parse(HOUR) + m * 60_000).toISOString() });
    }
    expect(d!.bucketStart).toBe(HOUR);
    expect(d!.flows.f).toHaveLength(MAX_MINUTE_ROWS);
    expect(d!.flows.f[0].t).toBe(new Date(Date.parse(HOUR) + 10 * 60_000).toISOString());
  });
  it('batch upsert equals repeated single upserts', () => {
    const rows = { a: row(1, 5), b: row(1, 7) };
    const batch = upsertMinuteRows(null, HOUR, rows);
    const single = upsertMinuteRow(upsertMinuteRow(null, HOUR, 'a', rows.a), HOUR, 'b', rows.b);
    expect(batch).toEqual(single);
  });
});

describe('folds', () => {
  it('folds minutes into hours and hours into days', () => {
    let d = upsertMinuteRows(null, HOUR, { a: row(0, 10), b: row(0, 1) });
    d = upsertMinuteRows(d, HOUR, { a: row(1, 20) });
    const hours = foldHourRows(d);
    expect(hours.a).toEqual({ t: HOUR, inB: 2000, outB: 800, whpM: 60, paidM: 30, savedM: 30, samples: 2 });
    expect(hours.b.samples).toBe(1);

    let hd = upsertHourRows(null, '2026-09-26', hours);
    hd = upsertHourRows(hd, '2026-09-26', { a: { ...hours.a, t: '2026-09-26T04:00:00.000Z' } });
    hd = upsertHourRows(hd, '2026-09-26', { a: { ...hours.a, savedM: 31 } }); // re-fold replaces
    expect(hd.day).toBe('2026-09-26');
    expect(hd.flows.a).toHaveLength(2);
    const days = foldDayRows(hd);
    expect(days.a).toEqual({ t: '2026-09-26T00:00:00.000Z', inB: 4000, outB: 1600, whpM: 120, paidM: 60, savedM: 61 });

    const dd = upsertDayRows(upsertDayRows(null, '2026-09', days), '2026-09', days);
    expect(dd.month).toBe('2026-09');
    expect(dd.flows.a).toHaveLength(1);
  });
});

describe('expiredKeys', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  it('applies SPEC 4 retention and ignores chunks and other keys', () => {
    const keys = [
      'roll/min/2026-09-26T11',
      'roll/min/2026-09-25T11', // 25 h old exactly → kept
      'roll/min/2026-09-25T10', // 26 h → expired
      'roll/min/2026-09-25T10/c/0',
      'roll/hour/2026-08-25', // 32 d 12 h → expired
      'roll/hour/2026-08-26',
      'roll/day/2025-09', // 12 months → kept
      'roll/day/2025-08', // 13 months → expired
      'incidents/2026-08-25', // 32 d → expired
      'incidents/2026-08-27',
      'settings',
      'totals',
      'roll/min/garbage',
    ];
    expect(expiredKeys(keys, now).sort()).toEqual(['incidents/2026-08-25', 'roll/day/2025-08', 'roll/hour/2026-08-25', 'roll/min/2026-09-25T10'].sort());
  });
});

describe('totals', () => {
  it('adds minutes, supports the late-minute rewrite, and equals the sum of rows (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            minute: fc.integer({ min: 0, max: 59 }),
            saved: fc.integer({ min: 0, max: 1_000_000 }),
            paid: fc.integer({ min: 0, max: 1_000_000 }),
          }),
          { maxLength: 80 },
        ),
        (writes) => {
          let doc: RollMinuteDoc | null = null;
          let totals: TotalsDoc | null = null;
          for (const w of writes) {
            const r = row(w.minute, w.saved, { paidM: w.paid, whpM: w.saved + w.paid });
            const replaced = findMinuteRow(doc, 'f', r.t);
            doc = upsertMinuteRow(doc, HOUR, 'f', r);
            totals = addMinuteToTotals(totals, '2026-09-25', r, replaced, '2026-09-26T03:59:00.000Z');
          }
          const rows = doc?.flows.f ?? [];
          const sum = aggregateRows(rows);
          const day = totals?.byDay['2026-09-25'] ?? { whpM: 0, paidM: 0, savedM: 0, minutes: 0 };
          expect(day.savedM).toBe(sum.savedM);
          expect(day.paidM).toBe(sum.paidM);
          expect(day.whpM).toBe(sum.whpM);
          expect(day.minutes).toBe(rows.length);
        },
      ),
    );
  });
  it('tracks output month totals with the same rewrite contract', () => {
    let t = addOutputMinuteToTotals(null, '2026-09', 'default:siem', { whpM: 10, paidM: 4, savedM: 6 });
    t = addOutputMinuteToTotals(t, '2026-09', 'default:siem', { whpM: 20, paidM: 5, savedM: 15 });
    t = addOutputMinuteToTotals(t, '2026-09', 'default:siem', { whpM: 30, paidM: 5, savedM: 25 }, { whpM: 20, paidM: 5, savedM: 15 });
    expect(outputMonthTotals(t, '2026-09', 'default:siem')).toEqual({ whpM: 40, paidM: 9, savedM: 31 });
    expect(outputMonthTotals(t, '2026-08', 'default:siem')).toEqual({ whpM: 0, paidM: 0, savedM: 0 });
    expect(outputMonthTotals(null, '2026-09', 'x')).toEqual({ whpM: 0, paidM: 0, savedM: 0 });
  });
  it('prunes to the newest days and 13 months', () => {
    let t: TotalsDoc = emptyTotals('x');
    for (let i = 0; i < 10; i++) t = addMinuteToTotals(t, `2026-09-${String(i + 10)}`, { whpM: 1, paidM: 0, savedM: 1 });
    const months = [...Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`), '2026-01', '2026-02', '2026-03'];
    for (const m of months) t = addOutputMinuteToTotals(t, m, 'o', { whpM: 1, paidM: 1, savedM: 0 });
    const p = pruneTotals(t, 3);
    expect(Object.keys(p.byDay).sort()).toEqual(['2026-09-17', '2026-09-18', '2026-09-19']);
    expect(Object.keys(p.byOutputMonth ?? {})).toHaveLength(13);
    expect(Object.keys(p.byOutputMonth ?? {})).not.toContain('2025-01');
    expect(Object.keys(pruneTotals(emptyTotals('x')).byDay)).toEqual([]);
    expect(addMinuteToTotals(undefined, 'd', { t: 'T', whpM: 1, paidM: 1, savedM: 0 }).updatedAt).toBe('T');
  });
});

describe('row helpers', () => {
  it('sums rows per flow within a window', () => {
    const rows = { a: [row(0, 1), row(1, 2), row(2, 4)], b: [row(5, 8)], c: [] };
    const s = sumFlowRows(rows, Date.parse('2026-09-26T03:01:00Z'), Date.parse('2026-09-26T03:03:00Z'));
    expect(s).toEqual({ a: { whpM: 12, paidM: 6, savedM: 6 } });
  });
  it('merges documents and sorts rows', () => {
    const d1 = upsertMinuteRows(null, HOUR, { a: row(5) });
    const d2 = upsertMinuteRows(null, HOUR, { a: row(1), b: row(2) });
    const m = mergeRowsByFlow([d1, null, d2]);
    expect(m.a.map((r) => r.t.slice(14, 16))).toEqual(['01', '05']);
    expect(m.b).toHaveLength(1);
  });
  it('downsamples to ratio or saved sparklines', () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i, i));
    const s12 = sparkline(rows, 12);
    expect(s12).toHaveLength(12);
    expect(s12.every((v) => v >= 0 && v <= 1)).toBe(true);
    expect(sparkline(rows.slice(0, 3), 12)).toEqual([0, 0.5, 0.5]);
    const saved = sparkline([...rows].reverse(), 3, 'savedM');
    expect(saved).toEqual([45, 145, 245]);
    expect(sparkline([], 5)).toEqual([]);
    expect(sparkline(rows, 0)).toEqual([]);
  });
});

describe('poolMinuteRows', () => {
  it('merges several flows\' rows into one series sorted by minute, summing a shared minute', () => {
    const a = [row(3, 10), row(1, 10)];
    const b = [row(2, 20), row(3, 5, { inB: 500, outB: 100, inE: 1, outE: 1 })];
    const pooled = poolMinuteRows([a, undefined, null, b]);
    expect(pooled.map((r) => r.t.slice(14, 16))).toEqual(['01', '02', '03']);
    expect(pooled[2]).toEqual({ t: row(3).t, inB: 1500, outB: 500, inE: 11, outE: 6, whpM: 30, paidM: 15, savedM: 15 });
    expect(pooled[1]).toEqual(row(2, 20));
  });
  it('never mutates its inputs and returns an empty series for no rows', () => {
    const a = [row(1, 10)];
    const b = [row(1, 10)];
    const pooled = poolMinuteRows([a, b]);
    expect(pooled[0].savedM).toBe(20);
    expect(a[0]).toEqual(row(1, 10));
    expect(poolMinuteRows([])).toEqual([]);
  });
  it('keeps every column\'s total equal to the sum of the inputs (property)', () => {
    const arbRow = fc.record({ minute: fc.integer({ min: 0, max: 59 }), saved: fc.integer({ min: 0, max: 1_000 }) });
    fc.assert(
      fc.property(fc.array(fc.array(arbRow, { maxLength: 20 }), { maxLength: 5 }), (lists) => {
        const input = lists.map((l) => l.map((x) => row(x.minute, x.saved)));
        const pooled = poolMinuteRows(input);
        const sumOf = (rows: MinuteRow[]) => rows.reduce((acc, r) => acc + r.savedM + r.inB, 0);
        expect(sumOf(pooled)).toBe(input.reduce((acc, l) => acc + sumOf(l), 0));
        expect(new Set(pooled.map((r) => r.t)).size).toBe(pooled.length);
      }),
    );
  });
});
