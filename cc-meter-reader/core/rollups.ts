// core/rollups.ts — minute → hour → day rollups and the running totals the headline reads (SPEC 4, 7 step 7).
// KV keys are '/'-delimited (DECISIONS D13): roll/min/YYYY-MM-DDTHH · roll/hour/YYYY-MM-DD · roll/day/YYYY-MM.
// Every function returns new objects; inputs are never mutated.

import type {
  DayRow,
  FlowKey,
  HourRow,
  ISO,
  MinuteRow,
  OutputMonthTotals,
  RollDayDoc,
  RollHourDoc,
  RollMinuteDoc,
  TotalsDoc,
} from './types.ts';
import { DAY_MS, HOUR_MS, fromIso, utcDayKey, utcHourKey, utcMonthKey } from './time.ts';
import { ratio } from './pricing.ts';

export const MAX_MINUTE_ROWS = 60;
export const MAX_HOUR_ROWS = 24;
export const MAX_DAY_ROWS = 31;

export const totalsKey = 'totals';
export const MINUTE_PREFIX = 'roll/min/';
export const HOUR_PREFIX = 'roll/hour/';
export const DAY_PREFIX = 'roll/day/';

/** 'roll/min/YYYY-MM-DDTHH' — the UTC hour holding minute `ms`. */
export function minuteDocKey(ms: number): string {
  return `${MINUTE_PREFIX}${utcHourKey(ms)}`;
}
/** 'roll/hour/YYYY-MM-DD' — the UTC day holding hour `ms`. */
export function hourDocKey(ms: number): string {
  return `${HOUR_PREFIX}${utcDayKey(ms)}`;
}
/** 'roll/day/YYYY-MM' — the UTC month holding day `ms`. */
export function dayDocKey(ms: number): string {
  return `${DAY_PREFIX}${utcMonthKey(ms)}`;
}

// ─── Minute rows ─────────────────────────────────────────────────────────────

export function emptyMinuteDoc(bucketStartIso: ISO): RollMinuteDoc {
  return { schemaVersion: 1, bucketStart: bucketStartIso, flows: {} };
}

/** Inserts `row` into rows sorted by t, replacing a row with the same t; keeps the newest `cap`. */
function upsertSorted<R extends { t: ISO }>(rows: R[] | undefined, row: R, cap: number): R[] {
  const out = (rows ?? []).filter((r) => r.t !== row.t);
  const tRow = fromIso(row.t);
  let i = out.length;
  while (i > 0 && fromIso(out[i - 1].t) > tRow) i--;
  out.splice(i, 0, row);
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** The stored row for (flowKey, t) in a minute document, if any (for the late-minute rewrite). */
export function findMinuteRow(doc: RollMinuteDoc | null | undefined, flowKey: FlowKey, t: ISO): MinuteRow | undefined {
  return doc?.flows[flowKey]?.find((r) => r.t === t);
}

/**
 * Upserts one flow's minute row: a row with the same `t` is replaced (late data, SPEC 7 step 2),
 * rows stay sorted by time, at most 60 per flow.
 */
export function upsertMinuteRow(doc: RollMinuteDoc | null | undefined, bucketStartIso: ISO, flowKey: FlowKey, row: MinuteRow): RollMinuteDoc {
  const base = doc ?? emptyMinuteDoc(bucketStartIso);
  return { ...base, flows: { ...base.flows, [flowKey]: upsertSorted(base.flows[flowKey], row, MAX_MINUTE_ROWS) } };
}

/** Batch form of upsertMinuteRow for a whole sweep (one copy of the document, not one per flow). */
export function upsertMinuteRows(doc: RollMinuteDoc | null | undefined, bucketStartIso: ISO, rows: Record<FlowKey, MinuteRow>): RollMinuteDoc {
  const base = doc ?? emptyMinuteDoc(bucketStartIso);
  const flows = { ...base.flows };
  for (const [key, row] of Object.entries(rows)) flows[key] = upsertSorted(flows[key], row, MAX_MINUTE_ROWS);
  return { ...base, flows };
}

// ─── Hour and day folds ──────────────────────────────────────────────────────

/** Folds a minute document into one HourRow per flow (t = the hour's start, samples = minute rows). */
export function foldHourRows(minuteDoc: RollMinuteDoc): Record<FlowKey, HourRow> {
  const out: Record<FlowKey, HourRow> = {};
  const t = minuteDoc.bucketStart;
  for (const [key, rows] of Object.entries(minuteDoc.flows)) {
    const h: HourRow = { t, inB: 0, outB: 0, whpM: 0, paidM: 0, savedM: 0, samples: 0 };
    for (const r of rows) {
      h.inB += r.inB;
      h.outB += r.outB;
      h.whpM += r.whpM;
      h.paidM += r.paidM;
      h.savedM += r.savedM;
      h.samples += 1;
    }
    out[key] = h;
  }
  return out;
}

/** Upserts hour rows into the day's hour document ('YYYY-MM-DD'); ≤ 24 rows per flow. */
export function upsertHourRows(hourDoc: RollHourDoc | null | undefined, dayKey: string, rows: Record<FlowKey, HourRow>): RollHourDoc {
  const base: RollHourDoc = hourDoc ?? { schemaVersion: 1, day: dayKey, flows: {} };
  const flows = { ...base.flows };
  for (const [key, row] of Object.entries(rows)) flows[key] = upsertSorted(flows[key], row, MAX_HOUR_ROWS);
  return { ...base, flows };
}

/** Folds an hour document into one DayRow per flow (t = the UTC day's start). */
export function foldDayRows(hourDoc: RollHourDoc): Record<FlowKey, DayRow> {
  const out: Record<FlowKey, DayRow> = {};
  const t = `${hourDoc.day}T00:00:00.000Z`;
  for (const [key, rows] of Object.entries(hourDoc.flows)) {
    const d: DayRow = { t, inB: 0, outB: 0, whpM: 0, paidM: 0, savedM: 0 };
    for (const r of rows) {
      d.inB += r.inB;
      d.outB += r.outB;
      d.whpM += r.whpM;
      d.paidM += r.paidM;
      d.savedM += r.savedM;
    }
    out[key] = d;
  }
  return out;
}

/** Upserts day rows into the month's day document ('YYYY-MM'); ≤ 31 rows per flow. */
export function upsertDayRows(dayDoc: RollDayDoc | null | undefined, monthKey: string, rows: Record<FlowKey, DayRow>): RollDayDoc {
  const base: RollDayDoc = dayDoc ?? { schemaVersion: 1, month: monthKey, flows: {} };
  const flows = { ...base.flows };
  for (const [key, row] of Object.entries(rows)) flows[key] = upsertSorted(flows[key], row, MAX_DAY_ROWS);
  return { ...base, flows };
}

// ─── Retention ───────────────────────────────────────────────────────────────

const MIN_KEY = /^roll\/min\/(\d{4}-\d{2}-\d{2}T\d{2})$/;
const HOUR_KEY = /^roll\/hour\/(\d{4}-\d{2}-\d{2})$/;
const DAY_KEY = /^roll\/day\/(\d{4})-(\d{2})$/;
const INCIDENT_KEY = /^incidents\/(\d{4}-\d{2}-\d{2})$/;

/** SPEC 4: minute documents are kept 25 h (core-7 may keep them shorter on a large estate: minuteRetentionHours). */
export const MINUTE_RETENTION_MS = 25 * HOUR_MS;
/** Core-7 (M11): the minute documents may hold about this many keys (a document plus its chunks, per UTC hour)… */
export const MINUTE_KEY_BUDGET = 400;
/** …but are never kept under this many hours (the snapshot's hour, late rewrites, folds and a short catch-up need them). */
export const MIN_MINUTE_RETENTION_HOURS = 6;

/**
 * Core-7 (M11, #43; DECISIONS text in founder-build OUT/r1-core.md): how many hours of minute documents the store keeps.
 * 25 h (SPEC 4) while a document is at most ~16 keys; on a larger estate, as many hours as MINUTE_KEY_BUDGET keys allow
 * (the largest minute document's size, with its chunks), never under MIN_MINUTE_RETENTION_HOURS. At the 2,000-flow
 * preset a document is ~52 keys: 7 h instead of 25 h (~1,350 keys, over the App KV's 1,000-key cap).
 */
export function minuteRetentionHours(keys: readonly string[], chunks: Readonly<Record<string, readonly number[]>>): number {
  let perDoc = 1;
  for (const k of keys) if (MIN_KEY.test(k)) perDoc = Math.max(perDoc, 1 + (chunks[k]?.length ?? 0));
  const hours = Math.floor(MINUTE_KEY_BUDGET / perDoc);
  return Math.max(MIN_MINUTE_RETENTION_HOURS, Math.min(MINUTE_RETENTION_MS / HOUR_MS, hours));
}

/** The instant a dated key's bucket starts (oldest-first deletes); NaN for any other key. */
export function datedKeyStartMs(key: string): number {
  let m = MIN_KEY.exec(key);
  if (m) return fromIso(`${m[1]}:00:00.000Z`);
  m = HOUR_KEY.exec(key);
  if (m) return fromIso(`${m[1]}T00:00:00.000Z`);
  m = DAY_KEY.exec(key);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1);
  m = INCIDENT_KEY.exec(key);
  return m ? fromIso(`${m[1]}T00:00:00.000Z`) : Number.NaN;
}

/**
 * Keys past retention (SPEC 4): minute docs older than 25 h, hour docs older than 32 days,
 * day docs older than 13 months, incident docs older than 31 days. Anchored patterns, so chunk
 * keys (`<key>/c/<n>`, owned by kv.del) and every other key are never returned.
 */
export function expiredKeys(allKeys: string[], nowMs: number, opts: { minuteRetentionMs?: number } = {}): string[] {
  // Founder-build r1 core-7 (M11): the minute documents' retention can be sized to the estate (core/sweep.ts).
  const minuteRetentionMs = opts.minuteRetentionMs ?? MINUTE_RETENTION_MS;
  const out: string[] = [];
  const now = new Date(nowMs);
  const nowMonthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  for (const key of allKeys) {
    let m = MIN_KEY.exec(key);
    if (m) {
      const start = fromIso(`${m[1]}:00:00.000Z`);
      if (nowMs - start > minuteRetentionMs) out.push(key);
      continue;
    }
    m = HOUR_KEY.exec(key);
    if (m) {
      if (nowMs - fromIso(`${m[1]}T00:00:00.000Z`) > 32 * DAY_MS) out.push(key);
      continue;
    }
    m = DAY_KEY.exec(key);
    if (m) {
      const idx = Number(m[1]) * 12 + (Number(m[2]) - 1);
      if (nowMonthIndex - idx >= 13) out.push(key);
      continue;
    }
    m = INCIDENT_KEY.exec(key);
    if (m && nowMs - fromIso(`${m[1]}T00:00:00.000Z`) > 31 * DAY_MS) out.push(key);
  }
  return out;
}

// ─── Running totals ──────────────────────────────────────────────────────────

export function emptyTotals(nowIso: ISO): TotalsDoc {
  return { schemaVersion: 1, updatedAt: nowIso, byDay: {} };
}

type Money = { whpM: number; paidM: number; savedM: number };

/**
 * Adds one minute (the workspace-wide aggregate of every flow's row for that minute) to the local
 * day's totals. For the late-minute rewrite, pass the aggregate previously added for the same
 * minute as `replacedRow`: it is subtracted first and the minute is not counted twice, so the
 * totals always equal the sum of the stored rows.
 */
export function addMinuteToTotals(totals: TotalsDoc | null | undefined, localDay: string, row: Money & { t?: ISO }, replacedRow?: Money, nowIso?: ISO): TotalsDoc {
  const base = totals ?? emptyTotals(nowIso ?? row.t ?? '');
  const prev = base.byDay[localDay] ?? { whpM: 0, paidM: 0, savedM: 0, minutes: 0 };
  const next = {
    whpM: prev.whpM + row.whpM - (replacedRow?.whpM ?? 0),
    paidM: prev.paidM + row.paidM - (replacedRow?.paidM ?? 0),
    savedM: prev.savedM + row.savedM - (replacedRow?.savedM ?? 0),
    minutes: prev.minutes + (replacedRow ? 0 : 1),
  };
  return { ...base, updatedAt: nowIso ?? base.updatedAt, byDay: { ...base.byDay, [localDay]: next } };
}

/**
 * Adds one output's minute money to its month-to-date totals (local month 'YYYY-MM', key
 * `${groupId}:${outputId}`). Same late-minute contract as addMinuteToTotals.
 */
export function addOutputMinuteToTotals(
  totals: TotalsDoc | null | undefined,
  localMonth: string,
  outputKey: string,
  row: Money,
  replacedRow?: Money,
): TotalsDoc {
  const base = totals ?? emptyTotals('');
  const months = { ...(base.byOutputMonth ?? {}) };
  const month = { ...(months[localMonth] ?? {}) };
  const prev: OutputMonthTotals = month[outputKey] ?? { whpM: 0, paidM: 0, savedM: 0 };
  month[outputKey] = {
    whpM: prev.whpM + row.whpM - (replacedRow?.whpM ?? 0),
    paidM: prev.paidM + row.paidM - (replacedRow?.paidM ?? 0),
    savedM: prev.savedM + row.savedM - (replacedRow?.savedM ?? 0),
  };
  months[localMonth] = month;
  return { ...base, byOutputMonth: months };
}

/** Month-to-date totals of one output (zeros when none recorded). */
export function outputMonthTotals(totals: TotalsDoc | null | undefined, localMonth: string, outputKey: string): OutputMonthTotals {
  return totals?.byOutputMonth?.[localMonth]?.[outputKey] ?? { whpM: 0, paidM: 0, savedM: 0 };
}

/** Keeps the newest `keepDays` local days and the newest 13 output months. */
export function pruneTotals(totals: TotalsDoc, keepDays = 400): TotalsDoc {
  const days = Object.keys(totals.byDay).sort().reverse();
  const out: TotalsDoc = { ...totals, byDay: {} };
  for (const k of days.slice(0, Math.max(0, keepDays))) out.byDay[k] = totals.byDay[k];
  if (totals.byOutputMonth) {
    const months = Object.keys(totals.byOutputMonth).sort().reverse().slice(0, 13);
    out.byOutputMonth = {};
    for (const m of months) out.byOutputMonth[m] = totals.byOutputMonth[m];
  }
  return out;
}

/** Sums money columns of rows whose t falls in [startMs, endMs), per flow (weekly receipt, Copy receipt). */
export function sumFlowRows(
  rowsByFlow: Record<FlowKey, { t: ISO; whpM: number; paidM: number; savedM: number }[]>,
  startMs: number,
  endMs: number,
): Record<FlowKey, Money> {
  const out: Record<FlowKey, Money> = {};
  for (const [key, rows] of Object.entries(rowsByFlow)) {
    let acc: Money | undefined;
    for (const r of rows) {
      const t = fromIso(r.t);
      if (!(t >= startMs && t < endMs)) continue;
      acc ??= { whpM: 0, paidM: 0, savedM: 0 };
      acc.whpM += r.whpM;
      acc.paidM += r.paidM;
      acc.savedM += r.savedM;
    }
    if (acc) out[key] = acc;
  }
  return out;
}

/**
 * Pools several flows' minute rows into one series sorted by t, summing rows that share a minute.
 * The snapshot uses it for a route's history across the pipelines it ran through: Apply the pack
 * swaps the route's pipeline, which changes its FlowKey but not the traffic. The sweep's late-minute
 * rewrite keeps one flow set per minute, so a shared minute is rare; summing it keeps the pooled
 * series equal to the stored rows (the same invariant the totals keep). Inputs are not mutated.
 */
export function poolMinuteRows(lists: Iterable<readonly MinuteRow[] | null | undefined>): MinuteRow[] {
  const byMinute = new Map<ISO, MinuteRow>();
  for (const rows of lists) {
    for (const r of rows ?? []) {
      const acc = byMinute.get(r.t);
      if (!acc) {
        byMinute.set(r.t, { ...r });
        continue;
      }
      acc.inB += r.inB;
      acc.outB += r.outB;
      acc.inE += r.inE;
      acc.outE += r.outE;
      acc.whpM += r.whpM;
      acc.paidM += r.paidM;
      acc.savedM += r.savedM;
    }
  }
  return [...byMinute.values()].sort((a, b) => fromIso(a.t) - fromIso(b.t));
}

/** Merges several rollup documents' flows (e.g. the hour docs of a week) into one rows-by-flow map. */
export function mergeRowsByFlow<R extends { t: ISO }>(docs: ({ flows: Record<FlowKey, R[]> } | null | undefined)[]): Record<FlowKey, R[]> {
  const out: Record<FlowKey, R[]> = {};
  for (const d of docs) {
    if (!d) continue;
    for (const [key, rows] of Object.entries(d.flows)) (out[key] ??= []).push(...rows);
  }
  for (const rows of Object.values(out)) rows.sort((a, b) => fromIso(a.t) - fromIso(b.t));
  return out;
}

/**
 * Downsamples rows (sorted or not) to at most `points` values. Each point is the savings ratio of
 * its bucket (Σ saved / Σ would-have-paid), or the bucket's Σ savedM with metric 'savedM'.
 * The newest rows always land in the last bucket.
 */
export function sparkline(rows: { t: ISO; whpM: number; savedM: number }[], points: number, metric: 'ratio' | 'savedM' = 'ratio'): number[] {
  const n = Math.max(0, Math.floor(points));
  if (n === 0 || rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) => fromIso(a.t) - fromIso(b.t));
  const buckets = Math.min(n, sorted.length);
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor((b * sorted.length) / buckets);
    const to = Math.floor(((b + 1) * sorted.length) / buckets);
    let whp = 0;
    let saved = 0;
    for (let i = from; i < to; i++) {
      whp += sorted[i].whpM;
      saved += sorted[i].savedM;
    }
    out.push(metric === 'savedM' ? saved : ratio(saved, whp));
  }
  return out;
}

/** Aggregates one minute's rows across flows (the argument addMinuteToTotals expects). */
export function aggregateRows(rows: Iterable<Money>): Money {
  const acc = { whpM: 0, paidM: 0, savedM: 0 };
  for (const r of rows) {
    acc.whpM += r.whpM;
    acc.paidM += r.paidM;
    acc.savedM += r.savedM;
  }
  return acc;
}

