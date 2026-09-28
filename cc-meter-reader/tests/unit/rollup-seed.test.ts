// The emulator's rollup history (testdata/rollups.ts): deterministic, shaped like the sweep's own documents
// (they pass core/kv.ts's guards and stay far under the value cap), consistent across granularities, and —
// the proof the hero needs — a range covering exactly "today so far" equals the headline's todayM when both
// come from the same rows.

import { describe, expect, it } from 'vitest';
import { createKvDocs, createMemoryKvStore } from '../../core/kv.ts';
import { identityCodec } from '../../core/codec.ts';
import { computeHeadline } from '../../core/pricing.ts';
import { planRangeReads, sumRange, type RangeDoc } from '../../core/range.ts';
import { addMinuteToTotals, aggregateRows } from '../../core/rollups.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, fromIso, hourFloor, localDayKey, localMidnightMs, minuteFloor, toIso, utcDayFloor } from '../../core/time.ts';
import type { TotalsDoc } from '../../core/types.ts';
import { demoRigWorld } from '../../testdata/gen.ts';
import { SEED_PRICES, seedRollupDocs, seedToKv, type RollupSeed } from '../../testdata/rollups.ts';

const TZ = 'America/Chicago';
const AT = Date.parse('2026-09-26T17:34:56.000Z'); // 12:34:56 PM in Chicago
const WORLD = demoRigWorld({ now: AT, seed: 42, historyDays: 2 });

let cached: RollupSeed | undefined;
const seed = (): RollupSeed => (cached ??= seedRollupDocs({ world: WORLD, at: AT, prices: SEED_PRICES, tz: TZ }));

describe('seedRollupDocs', () => {
  it('is deterministic: the same inputs give byte-identical documents', () => {
    const a = JSON.stringify(seedToKv(seedRollupDocs({ world: WORLD, at: AT, prices: SEED_PRICES, tz: TZ })));
    const b = JSON.stringify(seedToKv(seedRollupDocs({ world: demoRigWorld({ now: AT, seed: 42, historyDays: 2 }), at: AT, prices: SEED_PRICES, tz: TZ })));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(100_000);
  });

  it('covers 25 h of minutes, 32 days of hours and ~3 months of days, none of it after the last whole minute', () => {
    const s = seed();
    expect(Object.keys(s.minute)).toHaveLength(26);
    expect(Object.keys(s.hour)).toHaveLength(33);
    expect(Object.keys(s.day).length).toBeGreaterThanOrEqual(3);
    expect(s.lastRowMs).toBe(minuteFloor(AT) - MINUTE_MS);
    for (const doc of Object.values(s.minute)) for (const rows of Object.values(doc.flows)) for (const r of rows) expect(fromIso(r.t)).toBeLessThan(minuteFloor(AT));
    // The hour in progress has no hour row (the sweep folds an hour once it ends); the one before it does, whole.
    const currentHourDoc = s.hour[`roll/hour/${toIso(AT).slice(0, 10)}`];
    const rows = Object.values(currentHourDoc.flows)[0];
    expect(rows.find((r) => fromIso(r.t) === hourFloor(AT))).toBeUndefined();
    expect(rows.find((r) => fromIso(r.t) === hourFloor(AT) - HOUR_MS)?.samples).toBe(60);
    // The current hour's minutes are in its minute document, though.
    expect(Object.values(s.minute[`roll/min/${toIso(AT).slice(0, 13)}`].flows)[0]).toHaveLength(34);
    const thisMonth = s.day[`roll/day/${toIso(AT).slice(0, 7)}`];
    for (const rows of Object.values(thisMonth.flows)) for (const r of rows) expect(fromIso(r.t)).toBeLessThan(utcDayFloor(AT));
    // Every rig flow is present, keyed the way the sweep keys flows.
    const keys = new Set(Object.values(s.minute).flatMap((d) => Object.keys(d.flows)));
    expect(keys.size).toBe(WORLD.flows.length);
    expect([...keys].every((k) => k.split('|').length === 5)).toBe(true);
  });

  it('writes documents the typed KV layer accepts, each far under the value cap', async () => {
    const s = seed();
    const kv = createMemoryKvStore({ initial: seedToKv(s) });
    const docs = createKvDocs({ kv, codec: identityCodec, clock: { now: () => AT } });
    for (const [key, value] of kv.data) expect(value.length, key).toBeLessThan(90_000);
    const minuteKey = Object.keys(s.minute).at(-1)!;
    expect(await docs.getRollMinute(minuteKey)).toEqual(s.minute[minuteKey]);
    const hourKey = Object.keys(s.hour).at(-1)!;
    expect(await docs.getRollHour(hourKey)).toEqual(s.hour[hourKey]);
    const dayKey = Object.keys(s.day).at(-1)!;
    expect(await docs.getRollDay(dayKey)).toEqual(s.day[dayKey]);
    expect(await docs.getTotals()).toEqual(s.totals);
  });

  it('hour rows fold the minute rows they cover; day rows fold the hour rows', () => {
    const s = seed();
    const minuteDocs = Object.values(s.minute);
    const hourDocs = Object.values(s.hour);
    const hourStart = hourFloor(AT) - 10 * HOUR_MS; // an hour inside the minute window
    const flowKey = Object.keys(minuteDocs[0].flows)[0];
    const minutes = minuteDocs.flatMap((d) => d.flows[flowKey] ?? []).filter((r) => fromIso(r.t) >= hourStart && fromIso(r.t) < hourStart + HOUR_MS);
    const hourRow = hourDocs.flatMap((d) => d.flows[flowKey] ?? []).find((r) => fromIso(r.t) === hourStart)!;
    expect(minutes.length).toBe(60);
    expect(hourRow.samples).toBe(60);
    expect(hourRow.savedM).toBe(minutes.reduce((acc, r) => acc + r.savedM, 0));
    expect(hourRow.inB).toBe(minutes.reduce((acc, r) => acc + r.inB, 0));
    const dayStart = utcDayFloor(AT) - 5 * DAY_MS;
    const hours = hourDocs.flatMap((d) => d.flows[flowKey] ?? []).filter((r) => fromIso(r.t) >= dayStart && fromIso(r.t) < dayStart + DAY_MS);
    const dayRow = Object.values(s.day)
      .flatMap((d) => d.flows[flowKey] ?? [])
      .find((r) => fromIso(r.t) === dayStart)!;
    expect(hours.length).toBe(24);
    expect(dayRow.savedM).toBe(hours.reduce((acc, r) => acc + r.savedM, 0));
  });

  it('honours `since`: nothing before collecting began', () => {
    const since = AT - 3 * HOUR_MS + 17 * MINUTE_MS;
    const s = seedRollupDocs({ world: WORLD, at: AT, prices: SEED_PRICES, tz: TZ, since });
    expect(s.firstRowMs).toBe(minuteFloor(since));
    const families: Record<string, { t: string }[]>[] = [...Object.values(s.minute), ...Object.values(s.hour), ...Object.values(s.day)].map((d) => d.flows);
    for (const flows of families) for (const rows of Object.values(flows)) for (const r of rows) expect(fromIso(r.t)).toBeGreaterThanOrEqual(hourFloor(since));
    expect(Object.keys(s.day)).toHaveLength(0);
  });

  // The proof: "today so far" as a custom range equals the headline's todayM from the same rows.
  it('a range covering exactly today so far equals the headline’s todayM from the same rows', () => {
    const s = seed();
    const midnight = localMidnightMs(AT, TZ);
    const to = minuteFloor(AT);
    // Totals built minute by minute from the seeded minute documents, the way the sweep builds them.
    let totals: TotalsDoc = { schemaVersion: 1, updatedAt: toIso(AT), byDay: {} };
    const byMinute = new Map<string, { whpM: number; paidM: number; savedM: number }[]>();
    for (const doc of Object.values(s.minute)) for (const rows of Object.values(doc.flows)) for (const r of rows) (byMinute.get(r.t) ?? byMinute.set(r.t, []).get(r.t)!).push(r);
    for (const [t, rows] of byMinute) totals = addMinuteToTotals(totals, localDayKey(fromIso(t), TZ), aggregateRows(rows), undefined, toIso(AT));
    const headline = computeHeadline(totals, AT, TZ, s.firstRowMs);
    const plan = planRangeReads(midnight, to, AT);
    expect(plan.granularity).toBe('minute');
    const docs: Record<string, RangeDoc | null> = {};
    for (const key of plan.keys) docs[key] = s.minute[key] ?? null;
    const range = sumRange(docs, 'minute', midnight, to);
    expect(range.savedM).toBe(headline.todayM);
    expect(range.whpM).toBe(headline.whpTodayM);
    expect(range.paidM).toBe(headline.paidTodayM);
    expect(range.minutesMetered).toBe(totals.byDay[localDayKey(AT, TZ)].minutes);
    // And the seed's own totals (folded from hour rows) say the same, so the emulator's headline agrees too.
    expect(computeHeadline(s.totals, AT, TZ, s.firstRowMs).todayM).toBe(headline.todayM);
  });
});
