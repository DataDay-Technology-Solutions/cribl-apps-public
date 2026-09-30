// core/rezone.ts — re-buckets the running totals when the zone they are kept in changes (founder-build r1 core-2,
// FINDINGS_R1 B1, contract C1').
//
// The totals (`TotalsDoc`) key each metered minute by its local day and month in one IANA zone, recorded since this
// change as `totals.zone`. A settings-less install used to meter in UTC while the screens labelled the figures in the
// browser's zone, and the first settings save relabelled the totals instead of re-bucketing them. When the sweep's zone
// differs from the totals' zone, `rezoneTotals` re-buckets the current month (and the days since collecting began)
// into the new zone:
//
//   · Re-bucketing starts at the OLD zone's midnight at or before max(collecting since, the earlier of the new zone's
//     month start and its trend's first day, 29 local days back) — within the 32 days the hour rollups keep.
//     Day keys before it are kept whole (they are the old zone's days; nothing is counted twice or lost, because every
//     minute before that midnight sits in a kept key and every minute after it is re-bucketed).
//   · Each old day from there on is split at the new zone's midnights into pieces. A piece's money is the stored rows
//     over it (roll/min where the sweep holds them, roll/hour otherwise; an hour split by a non-whole-hour offset
//     without minute rows is split by time). The old day's exact figures stay the ground truth: the rows' shortfall or
//     excess goes to its largest piece, so the money is conserved to the millicent, and its metered minutes are
//     shared out by the metered span each piece covers (collecting since → cursor, less the recorded gaps), largest
//     remainder, so the minute count is conserved too and never falls.
//   · The new month's per-destination totals are rebuilt from the same rows; month keys after it (a month that has not
//     started in the new zone) are dropped.
// Pure and deterministic: the sweep reads the rows and writes the result.

import type { FlowKey, HourRow, MeteringGap, MinuteRow, OutputMonthTotals, TotalsDoc } from './types.ts';
import { parseFlowKey } from './flows.ts';
import { MINUTE_MS, addDaysToKey, canonicalZoneName, fromIso, hourFloor, isValidTimeZone, localDayKey, localDayStartMs, localMidnightMs, localMonthKey, localMonthStartMs, utcDayKey } from './time.ts';

type Money = { whpM: number; paidM: number; savedM: number };

/**
 * Founder-build r2 core-4 (FINDINGS_R2 #4, contract C1''): the zone a sweep (and the weekly job) meters in — the stored
 * settings' zone, else the zone the totals were kept in, else the runtime's own default (the tab's browser zone), else
 * UTC. A settings-less workspace's first rezone writes `totals.zone`, so every later tab, the runner and the backend
 * follow it instead of re-bucketing the totals into their own zone every sweep (at most one rezone).
 *
 * Totals kept in UTC are the zone-less default (what 1.1.0 wrote, and what a runtime without a zone — the runner, the
 * backend, a UTC browser — records), so they yield to the first runtime that brings another zone: an upgraded
 * workspace the runner swept first still lands in the member's zone. Every other recorded zone holds.
 */
export function resolveMeterZone(
  storedSettings: { displayTimezone?: unknown } | null | undefined,
  totals: Pick<TotalsDoc, 'zone'> | null | undefined,
  defaultTimeZone?: string,
): string {
  const valid = (z: unknown): z is string => typeof z === 'string' && z !== '' && isValidTimeZone(z);
  if (valid(storedSettings?.displayTimezone)) return canonicalZoneName(storedSettings.displayTimezone);
  const kept = valid(totals?.zone) ? canonicalZoneName(totals.zone) : undefined;
  if (kept && kept !== 'UTC') return kept;
  return valid(defaultTimeZone) ? canonicalZoneName(defaultTimeZone) : 'UTC';
}
type DayTotals = TotalsDoc['byDay'][string];

const HOUR_MS = 60 * MINUTE_MS;

/** Stored money over one stretch: a UTC minute (a roll/min row set) or a UTC hour (a roll/hour row set). */
export interface MoneyBucket {
  startMs: number;
  spanMs: number;
  total: Money;
  /** `${groupId}:${outputId}` → money */
  byOutput: Record<string, Money>;
}

export interface RezonePlan {
  fromZone: string;
  toZone: string;
  /** the old zone's midnight at or before max(collecting since, the new month's start or the trend's first day): re-bucketed from here */
  startMs: number;
  /** exclusive: the totals' cursor (every minute before it is in the totals) */
  endMs: number;
  /** the UTC hours in [startMs, endMs) whose rows the re-bucketing needs */
  hours: number[];
  /** the UTC days (roll/hour documents) holding those hours */
  utcDays: string[];
  newMonthStartMs: number;
  newMonthKey: string;
}

/**
 * What a change from `fromZone` to `toZone` must re-bucket, or undefined when nothing does (the same zone). A plan
 * whose `hours` is empty only relabels the zone (nothing metered in the span).
 */
export function rezonePlan(fromZone: string, toZone: string, nowMs: number, endMs: number, collectingSinceMs: number): RezonePlan | undefined {
  if (fromZone === toZone) return undefined;
  const newMonthStartMs = localMonthStartMs(nowMs, toZone);
  const newMonthKey = localMonthKey(nowMs, toZone);
  // The current month and the trend's 30 local days (the hour rollups keep 32 days), from where collecting began.
  const trendStartMs = localDayStartMs(addDaysToKey(localDayKey(nowMs, toZone), -29), toZone);
  const covers = Math.min(newMonthStartMs, trendStartMs);
  const from = Math.max(covers, Number.isFinite(collectingSinceMs) ? collectingSinceMs : covers);
  const end = Number.isFinite(endMs) ? endMs : Number.NaN;
  if (!(end > from)) return { fromZone, toZone, startMs: from, endMs: Number.isFinite(end) ? end : from, hours: [], utcDays: [], newMonthStartMs, newMonthKey };
  const startMs = localMidnightMs(from, fromZone);
  const hours: number[] = [];
  for (let h = hourFloor(startMs); h < end; h += HOUR_MS) hours.push(h);
  return { fromZone, toZone, startMs, endMs: end, hours, utcDays: [...new Set(hours.map((h) => utcDayKey(h)))], newMonthStartMs, newMonthKey };
}

/**
 * Founder-build r2 core-4 (FINDINGS_R2 #11): the UTC hours of `plan` that a cut falls inside — an old-zone or new-zone
 * local midnight (the new month's start included) that is not on the hour, as in a +5:30, +5:45 or −2:30 zone. Their
 * money splits exactly only from minute rows, so the sweep reads their minute documents while they are kept; a time
 * split stays only for an hour whose minute rows are gone. Whole-hour zones have none.
 */
export function rezoneStraddleHours(plan: RezonePlan): number[] {
  const hours = new Set(plan.hours);
  const out = new Set<number>();
  for (const zone of [plan.fromZone, plan.toZone]) {
    let m = localMidnightMs(plan.startMs, zone);
    for (let guard = 0; guard < 400 && m <= plan.endMs; guard++) {
      if (m >= plan.startMs && m % HOUR_MS !== 0) {
        const h = hourFloor(m);
        if (hours.has(h)) out.add(h);
      }
      m = localDayStartMs(addDaysToKey(localDayKey(m, zone), 1), zone);
    }
  }
  return [...out].sort((a, b) => a - b);
}

const zero = (): Money => ({ whpM: 0, paidM: 0, savedM: 0 });
const addScaled = (acc: Money, m: Money, f: number): void => {
  acc.whpM += m.whpM * f;
  acc.paidM += m.paidM * f;
  acc.savedM += m.savedM * f;
};
const roundMoney = (m: Money): Money => ({ whpM: Math.round(m.whpM), paidM: Math.round(m.paidM), savedM: Math.round(m.savedM) });

/** `${groupId}:${outputId}` of a flow key (the per-destination totals' key), or undefined. */
function outputKeyOf(flowKey: FlowKey): string | undefined {
  const p = parseFlowKey(flowKey);
  return p && p.outputId !== '-' ? `${p.groupId}:${p.outputId}` : undefined;
}

/** Buckets from one roll/min document's rows (one bucket per minute that has rows). */
export function minuteBuckets(flows: Record<FlowKey, MinuteRow[]> | undefined): MoneyBucket[] {
  const byMinute = new Map<number, MoneyBucket>();
  for (const [key, rows] of Object.entries(flows ?? {})) {
    const out = outputKeyOf(key);
    for (const r of rows ?? []) {
      const t = fromIso(r.t);
      if (!Number.isFinite(t)) continue;
      const b = byMinute.get(t) ?? { startMs: t, spanMs: MINUTE_MS, total: zero(), byOutput: {} };
      addScaled(b.total, r, 1);
      if (out) addScaled((b.byOutput[out] ??= zero()), r, 1);
      byMinute.set(t, b);
    }
  }
  return [...byMinute.values()];
}

/** Buckets from one roll/hour document's rows for the hours in `hours` (one bucket per hour that has rows). */
export function hourBuckets(flows: Record<FlowKey, HourRow[]> | undefined, hours: ReadonlySet<number>): MoneyBucket[] {
  const byHour = new Map<number, MoneyBucket>();
  for (const [key, rows] of Object.entries(flows ?? {})) {
    const out = outputKeyOf(key);
    for (const r of rows ?? []) {
      const t = fromIso(r.t);
      if (!Number.isFinite(t) || !hours.has(t)) continue;
      const b = byHour.get(t) ?? { startMs: t, spanMs: HOUR_MS, total: zero(), byOutput: {} };
      addScaled(b.total, r, 1);
      if (out) addScaled((b.byOutput[out] ??= zero()), r, 1);
      byHour.set(t, b);
    }
  }
  return [...byHour.values()];
}

/**
 * Money of the buckets over [a, b), a bucket straddling an edge counted by the share of its span inside. A bucket's
 * span is first clipped to what was metered, [since, end): an hour that metering began or stopped inside holds only
 * those minutes' money.
 */
function moneyOver(buckets: readonly MoneyBucket[], a: number, b: number, span: { sinceMs: number; endMs: number }, output?: string): Money {
  const acc = zero();
  for (const k of buckets) {
    const ks = Math.max(k.startMs, Number.isFinite(span.sinceMs) ? span.sinceMs : k.startMs);
    const ke = Math.min(k.startMs + k.spanMs, span.endMs);
    if (!(ke > ks)) continue;
    const lo = Math.max(a, ks);
    const hi = Math.min(b, ke);
    if (!(hi > lo)) continue;
    const m = output === undefined ? k.total : k.byOutput[output];
    if (m) addScaled(acc, m, (hi - lo) / (ke - ks));
  }
  return acc;
}

/** Whole metered minutes in [a, b): inside [since, end), less the recorded gaps. */
export function meteredMinutes(a: number, b: number, sinceMs: number, endMs: number, gaps: readonly Pick<MeteringGap, 'from' | 'to'>[] = []): number {
  const lo = Math.max(a, Number.isFinite(sinceMs) ? sinceMs : a);
  const hi = Math.min(b, endMs);
  if (!(hi > lo)) return 0;
  let ms = hi - lo;
  for (const g of gaps) {
    const gl = Math.max(lo, fromIso(g.from));
    const gh = Math.min(hi, fromIso(g.to));
    if (gh > gl) ms -= gh - gl;
  }
  return Math.max(0, Math.round(ms / MINUTE_MS));
}

/** Shares `total` (an integer) by `weights`, largest remainder; all to the first when every weight is 0. */
function share(total: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (weights.length === 0) return [];
  if (!(sum > 0)) return weights.map((_, i) => (i === 0 ? total : 0));
  const exact = weights.map((w) => (Math.max(0, w) / sum) * total);
  const out = exact.map((x) => Math.floor(x));
  let left = total - out.reduce((s, x) => s + x, 0);
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((p, q) => q.r - p.r || p.i - q.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] += 1;
    left--;
  }
  return out;
}

export interface RezoneRows {
  buckets: readonly MoneyBucket[];
  collectingSinceMs: number;
  gaps?: readonly Pick<MeteringGap, 'from' | 'to'>[];
}

/** The totals re-bucketed into `plan.toZone` (see the header), carrying `zone: plan.toZone`. */
export function rezoneTotals(totals: TotalsDoc, plan: RezonePlan, rows: RezoneRows): TotalsDoc {
  const { fromZone, toZone, startMs, endMs } = plan;
  if (plan.hours.length === 0) return { ...totals, zone: toZone };
  const firstOldKey = localDayKey(startMs, fromZone);
  const metered = { sinceMs: rows.collectingSinceMs, endMs };
  const byDay: Record<string, DayTotals> = {};
  const add = (key: string, d: DayTotals): void => {
    const p = byDay[key] ?? { whpM: 0, paidM: 0, savedM: 0, minutes: 0 };
    byDay[key] = { whpM: p.whpM + d.whpM, paidM: p.paidM + d.paidM, savedM: p.savedM + d.savedM, minutes: p.minutes + d.minutes };
  };
  const moved: [string, DayTotals][] = [];
  for (const [key, d] of Object.entries(totals.byDay ?? {})) {
    if (key < firstOldKey) {
      add(key, d);
      continue;
    }
    moved.push([key, d]);
  }
  for (const [key, d] of moved.sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const dayStart = localDayStartMs(key, fromZone);
    const dayEnd = localDayStartMs(addDaysToKey(key, 1), fromZone);
    const a = Math.max(dayStart, startMs);
    const b = Math.min(dayEnd, endMs);
    if (!(b > a)) {
      // A key with no span before the cursor (it cannot hold minutes, but if it does, they stay counted once).
      add(localDayKey(Math.min(Math.max(dayStart, startMs), endMs - 1), toZone), d);
      continue;
    }
    // Cut the old day at the new zone's midnights.
    const cuts = [a];
    let m = localMidnightMs(a, toZone);
    for (let guard = 0; guard < 4; guard++) {
      m = localDayStartMs(addDaysToKey(localDayKey(m, toZone), 1), toZone);
      if (m >= b) break;
      if (m > a) cuts.push(m);
    }
    cuts.push(b);
    const pieces = cuts.slice(0, -1).map((p0, i) => ({ p0, p1: cuts[i + 1] }));
    const expected = pieces.map((p) => meteredMinutes(p.p0, p.p1, rows.collectingSinceMs, endMs, rows.gaps));
    const minutes = share(d.minutes, expected.some((x) => x > 0) ? expected : pieces.map((p) => p.p1 - p.p0));
    const money = pieces.map((p) => roundMoney(moneyOver(rows.buckets, p.p0, p.p1, metered)));
    // The old day's own figures are exact: the rows' shortfall (or excess) goes to its largest piece.
    let largest = 0;
    for (let i = 1; i < pieces.length; i++) {
      const w = (x: number): number => (expected[x] > 0 ? expected[x] : 0) * 1e9 + (pieces[x].p1 - pieces[x].p0);
      if (w(i) > w(largest)) largest = i;
    }
    for (const f of ['whpM', 'paidM', 'savedM'] as const) {
      const rest = d[f] - money.reduce((s, x) => s + x[f], 0);
      money[largest][f] += rest;
    }
    pieces.forEach((p, i) => {
      // A piece before collecting began (or in a gap) holds nothing: it makes no day key (no empty trend day).
      if (minutes[i] === 0 && money[i].whpM === 0 && money[i].paidM === 0 && money[i].savedM === 0) return;
      add(localDayKey(p.p0, toZone), { ...money[i], minutes: minutes[i] });
    });
  }

  const out: TotalsDoc = { ...totals, byDay, zone: toZone };
  if (totals.byOutputMonth) {
    const months: NonNullable<TotalsDoc['byOutputMonth']> = {};
    for (const [mk, v] of Object.entries(totals.byOutputMonth)) if (mk < plan.newMonthKey) months[mk] = v;
    // The new month, from the rows over it (a month that has not begun in the new zone is dropped).
    const outputs = new Set<string>();
    for (const k of rows.buckets) for (const o of Object.keys(k.byOutput)) outputs.add(o);
    for (const o of Object.keys(totals.byOutputMonth[plan.newMonthKey] ?? {})) outputs.add(o);
    const month: Record<string, OutputMonthTotals> = {};
    const from = Math.max(plan.newMonthStartMs, startMs);
    for (const o of [...outputs].sort()) month[o] = roundMoney(moneyOver(rows.buckets, from, endMs, metered, o));
    if (Object.keys(month).length > 0) months[plan.newMonthKey] = month;
    out.byOutputMonth = months;
  }
  return out;
}
