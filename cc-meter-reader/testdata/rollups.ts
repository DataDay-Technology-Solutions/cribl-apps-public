// testdata/rollups.ts — deterministic rollup history for the emulated Leader's KV: the minute, hour and day
// documents the sweep would have written had it been metering the mock world all along, plus the running
// totals. The emulator's `seedRollups` control action stores them so a custom range on the Receipt can be
// exercised end to end (the world's own history only reaches two days back, and the tab's sweep only ever
// meters forward from its first run).
//
// Consistency rules, so every family agrees where they overlap:
//   • minute rows are `flowMinute()` of each rig flow (its `activeFrom` lifted, so history reaches back), priced
//     with core/pricing's `priceMinute` at the prices in force — the sweep's own arithmetic;
//   • hour rows inside the minute window fold those same minutes; older hours evaluate their 60 minutes the
//     same way; day rows fold the hour rows they cover; days older than the hour window are a sampled
//     evaluation (every tenth minute × 10);
//   • an hour gets its HourRow only once it has ended (the sweep folds completed hours, core/sweep.ts
//     foldsFor; the hour in progress lives in its minute document only); the current UTC day has no DayRow
//     (the sweep folds a day once its last hour has); minutes end at the last whole minute;
//   • totals.byDay (local days in `tz`) is the sum of the hour rows, so `computeHeadline` over it agrees with
//     a range summed from the same rows.
// Same inputs → byte-identical output (tests/unit/rollup-seed.test.ts).

import type { DayRow, FlowKey, HourRow, MinuteRow, PricesDoc, RollDayDoc, RollHourDoc, RollMinuteDoc, TotalsDoc } from '../core/types.ts';
import { effectivePrices, priceMinute } from '../core/pricing.ts';
import { addMinuteToTotals, aggregateRows, dayDocKey, hourDocKey, minuteDocKey } from '../core/rollups.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, hourFloor, localDayKey, minuteFloor, toIso, utcDayFloor } from '../core/time.ts';
import { flowKeyOf, flowMinute, type FlowSpec, type World } from './gen.ts';

export interface RollupSeedOptions {
  world: World;
  /** The clock at seeding time (the last whole minute before it is the newest row). */
  at: number;
  prices: PricesDoc;
  /** Display timezone for totals.byDay (default UTC). */
  tz?: string;
  /** Hours of minute documents (default 25, the family's retention). */
  minuteHours?: number;
  /** Days of hour documents (default 32). */
  hourDays?: number;
  /** Days of day documents (default 92 ≈ 3 months; the family keeps 13, but the emulator's storage is small). */
  dayDays?: number;
  /** Nothing before this instant is seeded (the install's collectingSince). */
  since?: number;
}

export interface RollupSeed {
  minute: Record<string, RollMinuteDoc>;
  hour: Record<string, RollHourDoc>;
  day: Record<string, RollDayDoc>;
  totals: TotalsDoc;
  /** The earliest and latest row instants seeded (for meta.collectingSince and assertions). */
  firstRowMs: number;
  lastRowMs: number;
}

/** The default prices a seed uses when none are given: the demo rig's four destinations. */
export const SEED_PRICES: PricesDoc = {
  schemaVersion: 1,
  updatedAt: '2026-01-01T00:00:00.000Z',
  versions: [
    {
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      byOutputId: {
        mrd_siem_prod: { milliCentsPerGb: 250_000, preset: 'splunk_cloud' },
        mrd_analytics: { milliCentsPerGb: 150_000, preset: 'datadog' },
        mrd_archive_s3: { milliCentsPerGb: 3_000, preset: 's3' },
        devnull: { milliCentsPerGb: 0, preset: 'internal' },
      },
    },
  ],
};

type Money = { whpM: number; paidM: number; savedM: number };

/** One flow's minute row at `t`, or undefined when the world has no traffic for it then. */
function minuteRow(world: World, flow: FlowSpec, t: number, prices: PricesDoc): MinuteRow | undefined {
  const m = flowMinute(world, flow, t);
  if (!m.present || !(m.inB > 0 || m.outB > 0)) return undefined;
  const p = effectivePrices(prices, flow.groupId, flow.outputId, t, flow.outputType);
  const money = priceMinute({ inB: m.inB, outB: m.outB }, p.paidMcPerGb, p.whpMcPerGb, p.counterfactual);
  return { t: toIso(t), inB: m.inB, outB: m.outB, inE: m.inE, outE: m.outE, ...money };
}

function emptyHour(t: number): HourRow {
  return { t: toIso(t), inB: 0, outB: 0, whpM: 0, paidM: 0, savedM: 0, samples: 0 };
}

function addRow(h: HourRow, r: MinuteRow): void {
  h.inB += r.inB;
  h.outB += r.outB;
  h.whpM += r.whpM;
  h.paidM += r.paidM;
  h.savedM += r.savedM;
  h.samples += 1;
}

/** Builds the seed. Pure and deterministic: the world is evaluated, never mutated. */
export function seedRollupDocs(opts: RollupSeedOptions): RollupSeed {
  const { world, prices } = opts;
  const tz = opts.tz ?? 'UTC';
  const lastMinute = minuteFloor(opts.at); // exclusive: the current minute is not complete
  const since = opts.since === undefined ? Number.NEGATIVE_INFINITY : minuteFloor(opts.since);
  const minuteStart = Math.max(since, lastMinute - (opts.minuteHours ?? 25) * HOUR_MS);
  const hourStart = Math.max(hourFloor(since === Number.NEGATIVE_INFINITY ? 0 : since), hourFloor(opts.at) - (opts.hourDays ?? 32) * DAY_MS);
  const dayStart = Math.max(utcDayFloor(since === Number.NEGATIVE_INFINITY ? 0 : since), utcDayFloor(opts.at) - (opts.dayDays ?? 92) * DAY_MS);

  // History reaches back past the rig's own start: lift `activeFrom`, keep every other property.
  const flows: FlowSpec[] = world.flows.map((f) => {
    const lifted: FlowSpec = { ...f };
    delete lifted.activeFrom;
    return lifted;
  });
  const keys: FlowKey[] = flows.map(flowKeyOf);

  const minute: Record<string, RollMinuteDoc> = {};
  const hour: Record<string, RollHourDoc> = {};
  const day: Record<string, RollDayDoc> = {};
  let totals: TotalsDoc = { schemaVersion: 1, updatedAt: toIso(opts.at), byDay: {} };
  let firstRowMs = Number.POSITIVE_INFINITY;
  let lastRowMs = Number.NEGATIVE_INFINITY;

  const putMinute = (t: number, rows: Record<FlowKey, MinuteRow>): void => {
    const key = minuteDocKey(t);
    const doc = (minute[key] ??= { schemaVersion: 1, bucketStart: toIso(hourFloor(t)), flows: {} });
    for (const [k, r] of Object.entries(rows)) (doc.flows[k] ??= []).push(r);
  };
  const putHour = (h: number, rows: Record<FlowKey, HourRow>): void => {
    const key = hourDocKey(h);
    const doc = (hour[key] ??= { schemaVersion: 1, day: toIso(h).slice(0, 10), flows: {} });
    for (const [k, r] of Object.entries(rows)) (doc.flows[k] ??= []).push(r);
  };
  const putDay = (d: number, rows: Record<FlowKey, DayRow>): void => {
    const key = dayDocKey(d);
    const doc = (day[key] ??= { schemaVersion: 1, month: toIso(d).slice(0, 7), flows: {} });
    for (const [k, r] of Object.entries(rows)) (doc.flows[k] ??= []).push(r);
  };

  // Hour rows (and, inside the minute window, the minute rows they fold), oldest first.
  const hourRowsByDay = new Map<number, Record<FlowKey, HourRow>[]>();
  const currentHour = hourFloor(opts.at);
  for (let h = hourStart; h <= currentHour; h += HOUR_MS) {
    const hourRows: Record<FlowKey, HourRow> = {};
    const end = Math.min(h + HOUR_MS, lastMinute);
    for (let t = Math.max(h, since); t < end; t += MINUTE_MS) {
      const rows: Record<FlowKey, MinuteRow> = {};
      flows.forEach((f, i) => {
        const r = minuteRow(world, f, t, prices);
        if (!r) return;
        rows[keys[i]] = r;
        addRow((hourRows[keys[i]] ??= emptyHour(h)), r);
      });
      const any = Object.keys(rows).length > 0;
      if (any) {
        firstRowMs = Math.min(firstRowMs, t);
        lastRowMs = Math.max(lastRowMs, t);
        if (t >= minuteStart) putMinute(t, rows);
        totals = addMinuteToTotals(totals, localDayKey(t, tz), aggregateRows(Object.values(rows)), undefined, toIso(opts.at));
      }
    }
    // Only a completed hour is folded, as the sweep does (`h + HOUR_MS <= end`).
    if (Object.keys(hourRows).length > 0 && h + HOUR_MS <= lastMinute) {
      putHour(h, hourRows);
      const d = utcDayFloor(h);
      (hourRowsByDay.get(d) ?? hourRowsByDay.set(d, []).get(d)!).push(hourRows);
    }
  }

  // Day rows: folds of the hour rows for days the hour window covers, a sampled evaluation before that.
  const today = utcDayFloor(opts.at);
  for (let d = dayStart; d < today; d += DAY_MS) {
    const dayRows: Record<FlowKey, DayRow> = {};
    const add = (k: FlowKey, m: Money & { inB: number; outB: number }): void => {
      const row = (dayRows[k] ??= { t: toIso(d), inB: 0, outB: 0, whpM: 0, paidM: 0, savedM: 0 });
      row.inB += m.inB;
      row.outB += m.outB;
      row.whpM += m.whpM;
      row.paidM += m.paidM;
      row.savedM += m.savedM;
    };
    if (d >= hourStart) {
      for (const hourRows of hourRowsByDay.get(d) ?? []) for (const [k, r] of Object.entries(hourRows)) add(k, r);
    } else {
      // Every tenth minute stands for ten: deterministic, and 6 × 144 evaluations a day instead of 8,640.
      for (let t = Math.max(d, since); t < d + DAY_MS; t += 10 * MINUTE_MS) {
        flows.forEach((f, i) => {
          const r = minuteRow(world, f, t, prices);
          if (!r) return;
          add(keys[i], { inB: r.inB * 10, outB: r.outB * 10, whpM: r.whpM * 10, paidM: r.paidM * 10, savedM: r.savedM * 10 });
          firstRowMs = Math.min(firstRowMs, t);
        });
      }
    }
    if (Object.keys(dayRows).length > 0) putDay(d, dayRows);
  }

  if (!Number.isFinite(firstRowMs)) firstRowMs = lastMinute;
  if (!Number.isFinite(lastRowMs)) lastRowMs = lastMinute;
  return { minute, hour, day, totals, firstRowMs, lastRowMs };
}

/** Every document of a seed as `key → JSON`, the way the emulator stores KV values. */
export function seedToKv(seed: RollupSeed): Record<string, string> {
  const out: Record<string, string> = {};
  for (const family of [seed.minute, seed.hour, seed.day]) for (const [k, doc] of Object.entries(family)) out[k] = JSON.stringify(doc);
  out.totals = JSON.stringify(seed.totals);
  return out;
}
