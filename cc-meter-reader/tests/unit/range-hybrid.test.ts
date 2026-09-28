// The custom range's read budget (api-budget F2): the hybrid read plan (core/range.ts planRangeReads with the
// sweep's cursor — the window's own family at the ragged edges, the next coarser one over every folded bucket
// between), the proof that it sums the same money as the single-family plan over consistent history
// (testdata/rollups.ts, the sweep's own fold rules), the refinement that re-reads a coarse bucket with no row
// from the finer family, and the state-layer reader's budget: document counts, the fold-epoch cache, the 429
// backoff, abort, and a failure that stops the queue (src/state/rangeReader.ts).

import { describe, expect, it } from 'vitest';
import {
  RELATIVE_PRESETS,
  planRangeReads,
  refineRangePlan,
  resolveRange,
  sumRange,
  sumRangePlan,
  type RangeDoc,
  type RangeFigures,
  type RangeSpec,
} from '../../core/range.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, hourFloor, minuteFloor, toIso, utcDayFloor } from '../../core/time.ts';
import type { RollDayDoc, RollHourDoc, RollMinuteDoc } from '../../core/types.ts';
import { IMMUTABLE_AFTER_MS, RATE_LIMIT_BACKOFF_MAX_MS, RATE_LIMIT_BACKOFF_MS, createRangeReader, foldEpoch } from '../../src/state/rangeReader.ts';
import type { RollupDocs } from '../../src/state/ports.ts';
import { demoRigWorld } from '../../testdata/gen.ts';
import { SEED_PRICES, seedRollupDocs, type RollupSeed } from '../../testdata/rollups.ts';

const AT = Date.parse('2026-09-26T17:34:56.000Z'); // 12:34:56 PM in Chicago
const T = (iso: string) => Date.parse(iso);
/** The sweep's cursor for the seed: its newest row is the minute before the last whole minute. */
const THROUGH = minuteFloor(AT);
const WORLD = demoRigWorld({ now: AT, seed: 42, historyDays: 2 });

let seeded: RollupSeed | undefined;
const seed = (): RollupSeed => (seeded ??= seedRollupDocs({ world: WORLD, at: AT, prices: SEED_PRICES, tz: 'America/Chicago' }));
const allDocs = (): Record<string, RangeDoc> => {
  const s = seed();
  return { ...s.minute, ...s.hour, ...s.day };
};
/** The documents a plan names, as the store would answer them (null where absent). */
const pick = (docs: Record<string, RangeDoc>, keys: readonly string[]): Record<string, RangeDoc | null> => Object.fromEntries(keys.map((k) => [k, docs[k] ?? null]));

const relative = (hours: number): RangeSpec => ({ kind: 'relative', hours });

// ─── The plan ────────────────────────────────────────────────────────────────

describe('planRangeReads with the sweep cursor', () => {
  it('24 h: minute rows at the two ragged edges, hour rows between — 4 documents instead of 25', () => {
    const r = resolveRange(relative(24), AT);
    const single = planRangeReads(r.fromMs, r.toMs, AT);
    const hybrid = planRangeReads(r.fromMs, r.toMs, AT, THROUGH);
    expect(single.keys).toHaveLength(25);
    expect(hybrid.granularity).toBe('minute');
    expect(hybrid.window).toEqual(single.window);
    expect(hybrid.segments.map((s) => [s.family, toIso(s.fromMs), toIso(s.toMs), s.keys])).toEqual([
      ['minute', '2026-09-25T17:34:00.000Z', '2026-09-25T18:00:00.000Z', ['roll/min/2026-09-25T17']],
      ['hour', '2026-09-25T18:00:00.000Z', '2026-09-26T17:00:00.000Z', ['roll/hour/2026-09-25', 'roll/hour/2026-09-26']],
      ['minute', '2026-09-26T17:00:00.000Z', '2026-09-26T17:34:00.000Z', ['roll/min/2026-09-26T17']],
    ]);
    expect(hybrid.keys).toEqual(['roll/min/2026-09-25T17', 'roll/hour/2026-09-25', 'roll/hour/2026-09-26', 'roll/min/2026-09-26T17']);
  });

  it('30 days: hour rows at the edges, day rows between — 4 documents instead of 31, the window unchanged', () => {
    const r = resolveRange(relative(30 * 24), AT);
    const single = planRangeReads(r.fromMs, r.toMs, AT);
    const hybrid = planRangeReads(r.fromMs, r.toMs, AT, THROUGH);
    expect(single.keys).toHaveLength(31);
    expect(hybrid.granularity).toBe('hour');
    expect(hybrid.window).toEqual(single.window);
    expect(hybrid.segments.map((s) => [s.family, toIso(s.fromMs), toIso(s.toMs), s.keys])).toEqual([
      ['hour', '2026-08-27T17:00:00.000Z', '2026-08-28T00:00:00.000Z', ['roll/hour/2026-08-27']],
      ['day', '2026-08-28T00:00:00.000Z', '2026-09-26T00:00:00.000Z', ['roll/day/2026-08', 'roll/day/2026-09']],
      ['hour', '2026-09-26T00:00:00.000Z', '2026-09-26T17:00:00.000Z', ['roll/hour/2026-09-26']],
    ]);
    expect(hybrid.keys).toHaveLength(4);
  });

  it('every quick pick reads at most four documents; 1 h has nothing whole to fold and stays single-family', () => {
    const counts = Object.fromEntries(
      RELATIVE_PRESETS.map((p) => {
        const r = resolveRange(relative(p.hours), AT);
        return [p.key, [planRangeReads(r.fromMs, r.toMs, AT).keys.length, planRangeReads(r.fromMs, r.toMs, AT, THROUGH).keys.length]];
      }),
    );
    expect(counts).toEqual({ '1h': [2, 2], '6h': [7, 3], '24h': [25, 4], '7d': [8, 3], '30d': [31, 4] });
    const oneHour = resolveRange(relative(1), AT);
    expect(planRangeReads(oneHour.fromMs, oneHour.toMs, AT, THROUGH).segments).toHaveLength(1);
  });

  it('reads an hour the sweep has not folded yet from its minutes, never as a missing hour row', () => {
    // The cursor lags: the 16:00 hour has ended by the clock, but the sweep that folds it has not run.
    const r = resolveRange(relative(24), AT);
    const lagging = planRangeReads(r.fromMs, r.toMs, AT, T('2026-09-26T16:59:00Z'));
    expect(lagging.segments.at(-2)).toMatchObject({ family: 'hour', toMs: T('2026-09-26T16:00Z') });
    expect(lagging.segments.at(-1)).toMatchObject({ family: 'minute', fromMs: T('2026-09-26T16:00Z'), keys: ['roll/min/2026-09-26T16', 'roll/min/2026-09-26T17'] });
    expect(lagging.keys).toHaveLength(5);
    // …and just after midnight UTC, yesterday is read from its hour document until its day row is folded.
    const at = T('2026-09-26T00:10:30Z');
    const month = resolveRange(relative(30 * 24), at);
    const beforeFold = planRangeReads(month.fromMs, month.toMs, at, T('2026-09-25T23:59:00Z'));
    expect(beforeFold.segments.at(-1)).toMatchObject({ family: 'hour', fromMs: T('2026-09-25T00:00Z'), keys: ['roll/hour/2026-09-25'] });
    const afterFold = planRangeReads(month.fromMs, month.toMs, at, T('2026-09-26T00:10:00Z'));
    expect(afterFold.segments.at(-1)).toMatchObject({ family: 'day', toMs: T('2026-09-26T00:00Z') });
  });

  it('stays single-family without a cursor, at day precision, and when the hybrid would not read fewer', () => {
    const r = resolveRange(relative(24), AT);
    expect(planRangeReads(r.fromMs, r.toMs, AT, Number.NaN).segments).toHaveLength(1);
    const days = resolveRange({ kind: 'absolute', fromMs: T('2026-06-01T00:00Z'), toMs: T('2026-07-15T00:00Z') }, AT);
    const plan = planRangeReads(days.fromMs, days.toMs, AT, THROUGH);
    expect(plan.granularity).toBe('day');
    expect(plan.segments).toEqual([{ family: 'day', ...plan.window, keys: plan.keys }]);
    // Two ragged hours with one whole hour between: the hybrid would read 3 documents (two minute docs and the
    // day's hour doc), the same as the three minute docs, so the exact single-family plan stays.
    const short = planRangeReads(T('2026-09-26T14:30Z'), T('2026-09-26T16:10Z'), AT, THROUGH);
    expect(short.keys).toEqual(['roll/min/2026-09-26T14', 'roll/min/2026-09-26T15', 'roll/min/2026-09-26T16']);
    expect(short.segments).toHaveLength(1);
  });
});

// ─── The money ───────────────────────────────────────────────────────────────

/** The figures that must not move when the plan goes hybrid. */
function money(f: RangeFigures) {
  return { fromMs: f.fromMs, toMs: f.toMs, granularity: f.granularity, savedM: f.savedM, whpM: f.whpM, paidM: f.paidM, byFlow: f.byFlow, byOutput: f.byOutput, minutesMetered: f.minutesMetered, ratePerDayM: f.ratePerDayM };
}

describe('sumRangePlan: the hybrid read sums the same money as the single-family one', () => {
  const specs: RangeSpec[] = [
    ...RELATIVE_PRESETS.map((p) => relative(p.hours)),
    relative(2),
    relative(13),
    relative(3 * 24),
    relative(29 * 24 + 5),
    // Exact windows at minute and hour precision, ragged and aligned, across midnight UTC and a month end.
    { kind: 'absolute', fromMs: T('2026-09-25T19:07Z'), toMs: T('2026-09-26T09:53Z') },
    { kind: 'absolute', fromMs: T('2026-09-26T00:00Z'), toMs: T('2026-09-26T12:00Z') },
    { kind: 'absolute', fromMs: T('2026-09-10T05:30Z'), toMs: T('2026-09-17T22:10Z') },
    { kind: 'absolute', fromMs: T('2026-08-28T13:00Z'), toMs: T('2026-09-03T02:00Z') },
    { kind: 'absolute', fromMs: T('2026-09-01T00:00Z'), toMs: T('2026-09-08T00:00Z') },
  ];

  for (const spec of specs) {
    const name = spec.kind === 'relative' ? `last ${spec.hours} h` : `${toIso(spec.fromMs)} → ${toIso(spec.toMs)}`;
    it(`${name}: identical money, window and minutes metered, from at most 5 documents`, () => {
      const docs = allDocs();
      const r = resolveRange(spec, AT);
      const single = planRangeReads(r.fromMs, r.toMs, AT);
      const hybrid = planRangeReads(r.fromMs, r.toMs, AT, THROUGH);
      const a = sumRange(pick(docs, single.keys), single.granularity, single.window.fromMs, single.window.toMs);
      const b = sumRangePlan(pick(docs, hybrid.keys), hybrid);
      expect(a.rows).toBeGreaterThan(0);
      expect(money(b)).toEqual(money(a));
      expect(b.docsMissing).toBe(0);
      expect(hybrid.keys.length).toBeLessThanOrEqual(Math.min(5, single.keys.length));
      const read = [...new Set(hybrid.segments.map((seg) => seg.family))];
      if (read.length === 1 && read[0] === hybrid.granularity) expect(b.families).toBeUndefined();
      else expect(b.families).toEqual(read);
    });
  }
});

describe('a window of whole coarse buckets', () => {
  it('reads the coarse rows alone and names that family, so the math never says hour rows for day rows', () => {
    const docs = allDocs();
    // Seven whole UTC days at hour precision: no ragged edge, so only the month's day document is read.
    const days = resolveRange({ kind: 'absolute', fromMs: T('2026-09-01T00:00Z'), toMs: T('2026-09-08T00:00Z') }, AT);
    const plan = planRangeReads(days.fromMs, days.toMs, AT, THROUGH);
    expect(plan.granularity).toBe('hour');
    expect(plan.keys).toEqual(['roll/day/2026-09']);
    const f = sumRangePlan(pick(docs, plan.keys), plan);
    expect(f.families).toEqual(['day']);
    const single = planRangeReads(days.fromMs, days.toMs, AT);
    expect(money(f)).toEqual(money(sumRange(pick(docs, single.keys), single.granularity, single.window.fromMs, single.window.toMs)));
    // Twelve whole hours at minute precision: the day's hour document alone.
    const hours = resolveRange({ kind: 'absolute', fromMs: T('2026-09-26T00:00Z'), toMs: T('2026-09-26T12:00Z') }, AT);
    const hourPlan = planRangeReads(hours.fromMs, hours.toMs, AT, THROUGH);
    expect(hourPlan.keys).toEqual(['roll/hour/2026-09-26']);
    expect(sumRangePlan(pick(docs, hourPlan.keys), hourPlan).families).toEqual(['hour']);
    // Read from its own family, a window names nothing.
    expect(sumRange(pick(docs, single.keys), single.granularity, single.window.fromMs, single.window.toMs).families).toBeUndefined();
  });
});

// ─── Refinement ──────────────────────────────────────────────────────────────

describe('refineRangePlan', () => {
  it('re-reads a day the sweep never folded from its hour document, so the hole never reads as zero', () => {
    const docs = allDocs();
    // Day 2026-09-12 has hour rows but no day row: its last hour was never folded (a > 24 h outage across its end).
    const month = structuredClone(docs['roll/day/2026-09']) as RollDayDoc;
    for (const rows of Object.values(month.flows)) rows.splice(0, rows.length, ...rows.filter((row) => !row.t.startsWith('2026-09-12')));
    const broken: Record<string, RangeDoc> = { ...docs, 'roll/day/2026-09': month };
    const r = resolveRange(relative(30 * 24), AT);
    const single = planRangeReads(r.fromMs, r.toMs, AT);
    const plan = planRangeReads(r.fromMs, r.toMs, AT, THROUGH);
    const naive = sumRangePlan(pick(broken, plan.keys), plan);
    const refined = refineRangePlan(plan, pick(broken, plan.keys));
    if (!refined) throw new Error('expected a refined plan');
    expect(refined.keys).toHaveLength(5);
    expect(refined.keys).toContain('roll/hour/2026-09-12');
    expect(refined.segments.map((s) => [s.family, toIso(s.fromMs).slice(0, 13), toIso(s.toMs).slice(0, 13)])).toEqual([
      ['hour', '2026-08-27T17', '2026-08-28T00'],
      ['day', '2026-08-28T00', '2026-09-12T00'],
      ['hour', '2026-09-12T00', '2026-09-13T00'],
      ['day', '2026-09-13T00', '2026-09-26T00'],
      ['hour', '2026-09-26T00', '2026-09-26T17'],
    ]);
    const exact = sumRange(pick(docs, single.keys), single.granularity, single.window.fromMs, single.window.toMs);
    expect(naive.savedM).toBeLessThan(exact.savedM); // without the refinement a day would silently read as zero
    expect(money(sumRangePlan(pick(broken, refined.keys), refined))).toEqual(money(exact));
  });

  it('leaves a plan whose every coarse bucket has a row alone, and never touches a single-family plan', () => {
    const docs = allDocs();
    const r = resolveRange(relative(24), AT);
    const plan = planRangeReads(r.fromMs, r.toMs, AT, THROUGH);
    expect(refineRangePlan(plan, pick(docs, plan.keys))).toBeUndefined();
    const single = planRangeReads(r.fromMs, r.toMs, AT);
    expect(refineRangePlan(single, {})).toBeUndefined();
  });

  it('an hour with no row at all is read from its minute document (the fine edge and the hole merge into one stretch)', () => {
    const docs = allDocs();
    const today = structuredClone(docs['roll/hour/2026-09-26']) as RollHourDoc;
    for (const rows of Object.values(today.flows)) rows.splice(0, rows.length, ...rows.filter((row) => row.t !== '2026-09-26T16:00:00.000Z'));
    const r = resolveRange(relative(6), AT);
    const plan = planRangeReads(r.fromMs, r.toMs, AT, THROUGH);
    const refined = refineRangePlan(plan, pick({ ...docs, 'roll/hour/2026-09-26': today }, plan.keys));
    if (!refined) throw new Error('expected a refined plan');
    expect(refined.segments.at(-1)).toMatchObject({ family: 'minute', fromMs: T('2026-09-26T16:00Z'), keys: ['roll/min/2026-09-26T16', 'roll/min/2026-09-26T17'] });
  });
});

// ─── The reader ──────────────────────────────────────────────────────────────

interface Fake extends RollupDocs {
  reads: string[];
  inFlight: number;
  /** Answer the next matching reads with this HTTP status. */
  failNext?: { pattern: RegExp; status: number; times: number };
}

function fakeRollups(docs: Record<string, RangeDoc>, delayMs = 1): Fake {
  const self: Fake = {
    reads: [],
    inFlight: 0,
    readMinute: (key) => read(key) as Promise<RollMinuteDoc | null>,
    readHour: (key) => read(key) as Promise<RollHourDoc | null>,
    readDay: (key) => read(key) as Promise<RollDayDoc | null>,
  };
  async function read(key: string): Promise<RangeDoc | null> {
    self.reads.push(key);
    self.inFlight++;
    await new Promise((r) => setTimeout(r, delayMs));
    self.inFlight--;
    const f = self.failNext;
    if (f && f.times > 0 && f.pattern.test(key)) {
      f.times--;
      throw Object.assign(new Error(`KV GET ${key} failed: HTTP ${f.status}`), { status: f.status });
    }
    return structuredClone(docs[key] ?? null);
  }
  return self;
}

describe('foldEpoch', () => {
  it('is the hour boundary of the last fold, once the rewrite sweep after it is behind', () => {
    expect(foldEpoch(undefined)).toBeUndefined();
    expect(foldEpoch(Number.NaN)).toBeUndefined();
    expect(foldEpoch(T('2026-09-26T17:00Z'))).toBeUndefined();
    expect(foldEpoch(T('2026-09-26T17:01Z'))).toBeUndefined();
    expect(foldEpoch(T('2026-09-26T17:00Z') + IMMUTABLE_AFTER_MS)).toBe(T('2026-09-26T17:00Z'));
    expect(foldEpoch(T('2026-09-26T17:59Z'))).toBe(T('2026-09-26T17:00Z'));
  });
});

describe('the reader with the sweep cursor', () => {
  it('30 days: 4 documents on the first read, none on a refresh inside the fold epoch, the same money as reading all 31', async () => {
    const docs = allDocs();
    const rollups = fakeRollups(docs);
    let now = AT;
    const reader = createRangeReader({ rollups, now: () => now });
    const first = await reader.read(relative(30 * 24), undefined, THROUGH);
    if (!first.ok) throw new Error('read failed');
    expect(rollups.reads).toHaveLength(4);
    expect(first.planned).toBe(4);
    const single = planRangeReads(first.resolved.fromMs, first.resolved.toMs, AT);
    expect(money(first.figures)).toEqual(money(sumRange(pick(docs, single.keys), 'hour', single.window.fromMs, single.window.toMs)));
    // The next sweeps inside the same epoch: nothing folds, nothing is re-read.
    for (let m = 1; m <= 3; m++) {
      now = AT + m * MINUTE_MS;
      const again = await reader.read(relative(30 * 24), undefined, THROUGH + m * MINUTE_MS);
      if (!again.ok) throw new Error('read failed');
      expect(again.cached).toBe(4);
    }
    expect(rollups.reads).toHaveLength(4);
  });

  it('crossing an hour boundary re-reads the documents that fold, then caches them for the new epoch', async () => {
    const rollups = fakeRollups(allDocs());
    let now = T('2026-09-26T17:58:30Z');
    let through = T('2026-09-26T17:58:00Z');
    const reader = createRangeReader({ rollups, now: () => now });
    await reader.read(relative(30 * 24), undefined, through);
    const perSweep: string[][] = [];
    for (let m = 1; m <= 5; m++) {
      now += MINUTE_MS;
      through += MINUTE_MS;
      const before = rollups.reads.length;
      await reader.read(relative(30 * 24), undefined, through);
      perSweep.push(rollups.reads.slice(before));
    }
    // 17:59 same epoch · 18:00 and 18:01 the fold and its rewrite (today's hour doc and this month's day doc are
    // re-read) · 18:02 the new epoch caches them · 18:03 nothing.
    expect(perSweep).toEqual([[], ['roll/day/2026-09', 'roll/hour/2026-09-26'], ['roll/day/2026-09', 'roll/hour/2026-09-26'], ['roll/day/2026-09', 'roll/hour/2026-09-26'], []]);
  });

  it('24 h: 4 documents, then only the current hour’s minute document on each sweep', async () => {
    const rollups = fakeRollups(allDocs());
    let now = AT;
    const reader = createRangeReader({ rollups, now: () => now });
    await reader.read(relative(24), undefined, THROUGH);
    expect(rollups.reads).toHaveLength(4);
    now += MINUTE_MS;
    await reader.read(relative(24), undefined, THROUGH + MINUTE_MS);
    expect(rollups.reads.slice(4)).toEqual(['roll/min/2026-09-26T17']);
  });

  it('a lagging runner: a bucket the clock calls finished is not cached until the sweep has moved past it too', async () => {
    const rollups = fakeRollups(allDocs());
    // 18:05 by the clock, but the runner is behind: its cursor is still 17:58, so the 17:00 hour's last minutes
    // (and the fold that re-runs with them) are yet to be written.
    let now = T('2026-09-26T18:05:30Z');
    let through = T('2026-09-26T17:58:00Z');
    const reader = createRangeReader({ rollups, now: () => now });
    await reader.read(relative(24), undefined, through);
    expect(rollups.reads).toContain('roll/min/2026-09-26T17');
    const count = (key: string) => rollups.reads.filter((k) => k === key).length;
    // The next sweep lands (17:59): the 17:00 minute document is read again, not served from the cache.
    now += MINUTE_MS;
    through += MINUTE_MS;
    await reader.read(relative(24), undefined, through);
    expect(count('roll/min/2026-09-26T17')).toBe(2);
    // The cursor passes 18:02 (the rewrite of 17:59 and its fold are behind): read once more, then cached.
    now += 3 * MINUTE_MS;
    through = T('2026-09-26T18:02:00Z');
    await reader.read(relative(24), undefined, through);
    expect(count('roll/min/2026-09-26T17')).toBe(3);
    now += MINUTE_MS;
    through += MINUTE_MS;
    await reader.read(relative(24), undefined, through);
    expect(count('roll/min/2026-09-26T17')).toBe(3);
  });

  it('a hole in the coarse rows costs one more read, not the single-family plan', async () => {
    const docs = allDocs();
    const month = structuredClone(docs['roll/day/2026-09']) as RollDayDoc;
    for (const rows of Object.values(month.flows)) rows.splice(0, rows.length, ...rows.filter((row) => !row.t.startsWith('2026-09-12')));
    const rollups = fakeRollups({ ...docs, 'roll/day/2026-09': month });
    const reader = createRangeReader({ rollups, now: () => AT });
    const r = await reader.read(relative(30 * 24), undefined, THROUGH);
    if (!r.ok) throw new Error('read failed');
    expect(rollups.reads).toHaveLength(5);
    expect(rollups.reads.at(-1)).toBe('roll/hour/2026-09-12');
    expect(r.planned).toBe(5);
    const single = planRangeReads(r.resolved.fromMs, r.resolved.toMs, AT);
    expect(r.figures.savedM).toBe(sumRange(pick(docs, single.keys), 'hour', single.window.fromMs, single.window.toMs).savedM);
  });
});

describe('the reader under the API budget', () => {
  it('a 429 stops the plan, holds every read (no GET) for the backoff, doubles on a repeat and resets on success', async () => {
    const rollups = fakeRollups(allDocs());
    let now = AT;
    const reader = createRangeReader({ rollups, now: () => now, concurrency: 1 });
    rollups.failNext = { pattern: /roll\/hour\/2026-09-25/, status: 429, times: 1 };
    const first = await reader.read(relative(24), undefined, THROUGH);
    expect(first).toMatchObject({ ok: false, reason: 'rate-limited', retryAtMs: AT + RATE_LIMIT_BACKOFF_MS });
    // One at a time: the head minute doc, then the 429 — the two after it were never requested.
    expect(rollups.reads).toEqual(['roll/min/2026-09-25T17', 'roll/hour/2026-09-25']);
    now = AT + RATE_LIMIT_BACKOFF_MS - 1;
    const held = await reader.read(relative(6), undefined, THROUGH);
    expect(held).toMatchObject({ ok: false, reason: 'rate-limited', retryAtMs: AT + RATE_LIMIT_BACKOFF_MS });
    expect(rollups.reads).toHaveLength(2);
    // After the window: read again; a second 429 in a row doubles the hold.
    now = AT + RATE_LIMIT_BACKOFF_MS;
    rollups.failNext = { pattern: /roll\/hour/, status: 429, times: 1 };
    const second = await reader.read(relative(24), undefined, THROUGH);
    expect(second).toMatchObject({ ok: false, reason: 'rate-limited', retryAtMs: now + 2 * RATE_LIMIT_BACKOFF_MS });
    now += 2 * RATE_LIMIT_BACKOFF_MS;
    const ok = await reader.read(relative(24), undefined, THROUGH);
    expect(ok.ok).toBe(true);
    // The head minute doc was cached by the first attempt: a retry never re-fires what already landed.
    expect(rollups.reads.filter((k) => k === 'roll/min/2026-09-25T17')).toHaveLength(1);
    rollups.failNext = { pattern: /roll\/min\/2026-09-26T17/, status: 429, times: 1 };
    const third = await reader.read(relative(24), undefined, THROUGH);
    expect(third).toMatchObject({ ok: false, reason: 'rate-limited', retryAtMs: now + RATE_LIMIT_BACKOFF_MS }); // reset after the success
  });

  it('the backoff is capped', async () => {
    const rollups = fakeRollups(allDocs());
    let now = AT;
    const reader = createRangeReader({ rollups, now: () => now });
    let last: unknown;
    for (let i = 0; i < 12; i++) {
      rollups.failNext = { pattern: /roll/, status: 429, times: 1 };
      last = await reader.read(relative(1), undefined, THROUGH);
      now = (last as { retryAtMs: number }).retryAtMs;
    }
    const prev = now;
    rollups.failNext = { pattern: /roll/, status: 429, times: 1 };
    last = await reader.read(relative(1), undefined, THROUGH);
    expect((last as { retryAtMs: number }).retryAtMs - prev).toBe(RATE_LIMIT_BACKOFF_MAX_MS);
  });

  it('an aborted read starts no further GETs and says so', async () => {
    const rollups = fakeRollups(allDocs(), 5);
    const reader = createRangeReader({ rollups, now: () => AT, concurrency: 1 });
    const controller = new AbortController();
    const pending = reader.read(relative(24), undefined, undefined, controller.signal); // single-family: 25 docs, one at a time
    await new Promise((r) => setTimeout(r, 12));
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: 'aborted' });
    const started = rollups.reads.length;
    expect(started).toBeGreaterThan(0);
    expect(started).toBeLessThan(5);
    await new Promise((r) => setTimeout(r, 30));
    expect(rollups.reads).toHaveLength(started);
    // Already aborted: nothing at all.
    expect(await reader.read(relative(24), undefined, undefined, controller.signal)).toEqual({ ok: false, reason: 'aborted' });
    expect(rollups.reads).toHaveLength(started);
  });

  it('a failed read stops the queue: no document is requested after the failure', async () => {
    const rollups = fakeRollups(allDocs());
    const reader = createRangeReader({ rollups, now: () => AT, concurrency: 1 });
    rollups.failNext = { pattern: /roll\/min\/2026-09-25T20/, status: 503, times: 1 };
    const r = await reader.read(relative(24)); // single-family, oldest first: 17, 18, 19, 20 ✗
    expect(r).toMatchObject({ ok: false, reason: 'error', error: { kind: 'server' } });
    expect(rollups.reads).toEqual(['roll/min/2026-09-25T17', 'roll/min/2026-09-25T18', 'roll/min/2026-09-25T19', 'roll/min/2026-09-25T20']);
  });

  it('never holds more than the concurrency in flight', async () => {
    const rollups = fakeRollups(allDocs(), 3);
    let max = 0;
    const tick = setInterval(() => (max = Math.max(max, rollups.inFlight)), 0);
    const reader = createRangeReader({ rollups, now: () => AT });
    await reader.read(relative(24));
    clearInterval(tick);
    expect(max).toBeLessThanOrEqual(4);
    expect(rollups.reads).toHaveLength(25);
  });
});

// A sanity check on the fixture itself: the seed's hour and day rows fold its minutes and hours (the premise).
describe('the seeded history the proofs run on', () => {
  it('has a day row for every whole UTC day inside the hour window, and hour rows through the last whole hour', () => {
    const s = seed();
    const month = s.day['roll/day/2026-09'];
    const days = new Set(Object.values(month.flows).flatMap((rows) => rows.map((r) => r.t.slice(0, 10))));
    for (let d = T('2026-09-01T00:00Z'); d < utcDayFloor(AT); d += DAY_MS) expect(days.has(toIso(d).slice(0, 10)), toIso(d)).toBe(true);
    const today = s.hour['roll/hour/2026-09-26'];
    const hours = new Set(Object.values(today.flows).flatMap((rows) => rows.map((r) => r.t)));
    expect(hours.has(toIso(hourFloor(AT) - HOUR_MS))).toBe(true);
    expect(hours.has(toIso(hourFloor(AT)))).toBe(false);
  });
});
