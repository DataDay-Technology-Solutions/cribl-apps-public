// "Compare with…" on a custom range (P2-W13, core/range.ts): the ?vs= form, the two windows a comparison reads
// (aligned like with like, the deploy's bucket left out of a commit's before and after, refusals decided before
// any read), compareRanges' sums, delta and basis over seeded history (testdata/rollups.ts, the sweep's own
// arithmetic), and the receipt's per-pipeline change lines and copied text (core/receipt.ts).

import { describe, expect, it } from 'vitest';
import {
  COMPARE_DOC_CAP,
  commitAfterWindow,
  commitAtMs,
  compareRanges,
  findCommit,
  formatCompareParam,
  granularityFor,
  parseCompareParam,
  perDayAtRate,
  planComparison,
  planRangeReads,
  resolveRange,
  sumRange,
  sumRangePlan,
  type ComparisonPlan,
  type ComparisonRefusal,
  type CompareSpec,
  type RangeDoc,
  type RangeFigures,
  type RangeSpec,
} from '../../core/range.ts';
import { RECEIPT_WIDTH, comparisonLines, receiptTextForComparison } from '../../core/receipt.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, hourFloor, minuteFloor, toIso, utcDayFloor } from '../../core/time.ts';
import { demoRigWorld } from '../../testdata/gen.ts';
import { SEED_PRICES, seedRollupDocs, type RollupSeed } from '../../testdata/rollups.ts';

const AT = Date.parse('2026-09-26T17:34:56.000Z'); // 12:34:56 PM in Chicago
const CAP = minuteFloor(AT);
const THROUGH = CAP;
const SINCE = AT - 40 * DAY_MS;
const WORLD = demoRigWorld({ now: AT, seed: 42, historyDays: 2 });
const PREV: CompareSpec = { kind: 'prev' };
const WEEK: CompareSpec = { kind: 'week' };

let seeded: RollupSeed | undefined;
const seed = (): RollupSeed => (seeded ??= seedRollupDocs({ world: WORLD, at: AT, prices: SEED_PRICES, tz: 'America/Chicago' }));
const allDocs = (): Record<string, RangeDoc> => {
  const s = seed();
  return { ...s.minute, ...s.hour, ...s.day };
};

const relative = (hours: number): RangeSpec => ({ kind: 'relative', hours });
const iso = (w: { fromMs: number; toMs: number }) => [toIso(w.fromMs), toIso(w.toMs)];

function ok(r: ComparisonPlan | ComparisonRefusal): ComparisonPlan {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
}

/** What the reader returns for a window: resolve, the hybrid plan with the cursor, the sum over the seeded documents. */
function readWindow(w: { fromMs: number; toMs: number }, since = SINCE): RangeFigures {
  const r = resolveRange({ kind: 'absolute', fromMs: w.fromMs, toMs: w.toMs }, AT, since);
  const plan = planRangeReads(r.fromMs, r.toMs, AT, THROUGH);
  const docs = allDocs();
  return sumRangePlan(Object.fromEntries(plan.keys.map((k) => [k, docs[k] ?? null])), plan);
}

describe('?vs= — the comparison in the URL', () => {
  it('parses prev, week and a commit hash, and round-trips', () => {
    expect(parseCompareParam('prev')).toEqual({ kind: 'prev' });
    expect(parseCompareParam('week')).toEqual({ kind: 'week' });
    expect(parseCompareParam('A1F3C9E')).toEqual({ kind: 'commit', hash: 'a1f3c9e' });
    for (const raw of ['prev', 'week', 'a1f3c9e', '805b12c0d9e1f2a3b4c5d6e7f8091a2b3c4d5e6f']) expect(formatCompareParam(parseCompareParam(raw) as CompareSpec)).toBe(raw);
  });

  it('refuses anything else: short or non-hex hashes, other words, nothing', () => {
    for (const raw of ['', 'previous', 'a1f3c9', 'zzzzzzz', 'a1f3c9e-', null]) expect(parseCompareParam(raw)).toBeUndefined();
  });

  it('finds a commit by an abbreviated hash (either may be the prefix) and dates it by its deploy, else its commit', () => {
    const timeline = [
      { hash: '805b12c0d9e1f2a3', committedAt: '2026-09-26T15:00:00.000Z', deployedAt: '2026-09-26T15:02:30.000Z' },
      { hash: 'a1f3c9e', committedAt: '2026-09-25T09:00:00.000Z' },
    ];
    expect(findCommit(timeline, '805b12c')?.hash).toBe('805b12c0d9e1f2a3');
    expect(findCommit(timeline, 'a1f3c9e77')?.hash).toBe('a1f3c9e');
    expect(findCommit(timeline, 'deadbee')).toBeUndefined();
    expect(commitAtMs(timeline[0])).toBe(Date.parse('2026-09-26T15:02:30.000Z'));
    expect(commitAtMs(timeline[1])).toBe(Date.parse('2026-09-25T09:00:00.000Z'));
  });

  it('proposes the 24 h after a deploy, or up to the last whole minute', () => {
    expect(iso(commitAfterWindow(Date.parse('2026-09-24T10:20:30Z'), AT)!)).toEqual(['2026-09-24T10:20:00.000Z', '2026-09-25T10:20:00.000Z']);
    expect(iso(commitAfterWindow(Date.parse('2026-09-26T10:20:30Z'), AT)!)).toEqual(['2026-09-26T10:20:00.000Z', toIso(CAP)]);
    expect(commitAfterWindow(AT, AT)).toBeUndefined();
  });
});

describe('planComparison — the two windows, like with like', () => {
  it('1 h vs the previous hour: both minute-exact, adjacent, nothing moved', () => {
    const p = ok(planComparison(relative(1), PREV, { nowMs: AT, collectingSinceMs: SINCE, foldedThroughMs: THROUGH }));
    expect(p.alignedTo).toBe('minute');
    expect(p.realigned).toBe(false);
    expect(iso(p.current)).toEqual([toIso(CAP - HOUR_MS), toIso(CAP)]);
    expect(iso(p.baseline)).toEqual([toIso(CAP - 2 * HOUR_MS), toIso(CAP - HOUR_MS)]);
  });

  it('24 h vs the 24 h before: the older day is in hour rows, so both are whole hours, 24 each, and the current one moved', () => {
    const p = ok(planComparison(relative(24), PREV, { nowMs: AT, collectingSinceMs: SINCE, foldedThroughMs: THROUGH }));
    const end = hourFloor(CAP);
    expect(p.alignedTo).toBe('hour');
    expect(p.realigned).toBe(true);
    expect(iso(p.current)).toEqual([toIso(end - 24 * HOUR_MS), toIso(end)]);
    expect(iso(p.baseline)).toEqual([toIso(end - 48 * HOUR_MS), toIso(end - 24 * HOUR_MS)]);
    expect(p.reads).toBeLessThanOrEqual(8);
  });

  it('7 days vs the previous 7: the window the range alone sums (whole hours), the baseline right before it', () => {
    const p = ok(planComparison(relative(7 * 24), PREV, { nowMs: AT, collectingSinceMs: SINCE, foldedThroughMs: THROUGH }));
    const end = hourFloor(CAP);
    expect(p.alignedTo).toBe('hour');
    expect(p.realigned).toBe(false);
    expect(iso(p.current)).toEqual([toIso(end - 7 * DAY_MS), toIso(end)]);
    expect(iso(p.baseline)).toEqual([toIso(end - 14 * DAY_MS), toIso(end - 7 * DAY_MS)]);
    expect(p.baselineClipped).toBe(false);
  });

  it('30 days vs the previous 30: the baseline is in day rows, so both are 30 whole UTC days; one before collecting is clipped', () => {
    const p = ok(planComparison(relative(30 * 24), PREV, { nowMs: AT, collectingSinceMs: SINCE, foldedThroughMs: THROUGH }));
    const end = utcDayFloor(CAP);
    expect(p.alignedTo).toBe('day');
    expect(iso(p.current)).toEqual([toIso(end - 30 * DAY_MS), toIso(end)]);
    expect(iso(p.baseline)).toEqual([toIso(end - 60 * DAY_MS), toIso(end - 30 * DAY_MS)]);
    expect(p.baselineClipped).toBe(true); // collecting began 40 days ago
    expect(granularityFor(p.baseline.fromMs, AT)).toBe('day');
  });

  it('6 h vs a week earlier: the same six whole hours, seven days back', () => {
    const p = ok(planComparison(relative(6), WEEK, { nowMs: AT, collectingSinceMs: SINCE, foldedThroughMs: THROUGH }));
    expect(p.alignedTo).toBe('hour');
    expect(p.baseline.fromMs).toBe(p.current.fromMs - 7 * DAY_MS);
    expect(p.baseline.toMs).toBe(p.current.toMs - 7 * DAY_MS);
    expect(p.current.toMs - p.current.fromMs).toBe(6 * HOUR_MS);
  });

  it('a commit: the hour of the deploy belongs to neither side; before and after are the same whole hours', () => {
    const d = Date.parse('2026-09-24T11:20:30.000Z');
    const after = commitAfterWindow(d, AT)!;
    const p = ok(planComparison({ kind: 'absolute', ...after }, { kind: 'commit', hash: 'a1f3c9e' }, { nowMs: AT, collectingSinceMs: SINCE, foldedThroughMs: THROUGH, commit: { hash: 'a1f3c9e', atMs: d } }));
    expect(p.alignedTo).toBe('hour');
    expect(iso(p.current)).toEqual(['2026-09-24T12:00:00.000Z', '2026-09-25T11:00:00.000Z']);
    expect(iso(p.baseline)).toEqual(['2026-09-23T12:00:00.000Z', '2026-09-24T11:00:00.000Z']);
    expect(iso(p.gap!)).toEqual(['2026-09-24T11:00:00.000Z', '2026-09-24T12:00:00.000Z']);
    expect(p.commit).toEqual({ hash: 'a1f3c9e', atMs: d });
  });

  it('a recent commit (deployed on a whole minute an hour ago): minute-exact halves meeting at the deploy, no gap', () => {
    const d = CAP - HOUR_MS;
    const after = commitAfterWindow(d, AT)!;
    const p = ok(planComparison({ kind: 'absolute', ...after }, { kind: 'commit', hash: 'a1f3c9e' }, { nowMs: AT, collectingSinceMs: SINCE, commit: { hash: 'a1f3c9e', atMs: d } }));
    expect(p.alignedTo).toBe('minute');
    expect(iso(p.current)).toEqual([toIso(d), toIso(CAP)]);
    expect(iso(p.baseline)).toEqual([toIso(d - HOUR_MS), toIso(d)]);
    expect(p.gap).toBeUndefined();
  });

  it('refuses before reading anything, and says why', () => {
    const ctx = { nowMs: AT, collectingSinceMs: SINCE, foldedThroughMs: THROUGH };
    const reason = (spec: RangeSpec, vs: CompareSpec, over: Partial<typeof ctx> & { commit?: { hash: string; atMs: number }; docCap?: number } = {}) => {
      const r = planComparison(spec, vs, { ...ctx, ...over });
      return r.ok ? 'ok' : r.reason;
    };
    expect(reason(relative(30 * 24), WEEK)).toBe('week-too-long');
    expect(reason({ kind: 'absolute', fromMs: AT + DAY_MS, toMs: AT + 2 * DAY_MS }, PREV)).toBe('future');
    expect(reason(relative(7 * 24), { kind: 'commit', hash: 'deadbee' })).toBe('no-commit');
    // The range starts two days before the deploy: it holds time from before the change.
    expect(reason(relative(7 * 24), { kind: 'commit', hash: 'a1f3c9e' }, { commit: { hash: 'a1f3c9e', atMs: AT - 2 * DAY_MS } })).toBe('overlap');
    // Collecting began 20 days ago: the 30 days before the last 30 were never metered.
    expect(reason(relative(30 * 24), PREV, { collectingSinceMs: AT - 20 * DAY_MS })).toBe('before-collecting');
    // A 30-minute window 30 hours back compares in whole hours, and holds none.
    const d = AT - 30 * HOUR_MS;
    expect(reason({ kind: 'absolute', fromMs: minuteFloor(d), toMs: minuteFloor(d) + 30 * MINUTE_MS }, { kind: 'commit', hash: 'a1f3c9e' }, { commit: { hash: 'a1f3c9e', atMs: d } })).toBe('too-short');
    const capped = planComparison(relative(7 * 24), PREV, { ...ctx, docCap: 3 });
    expect(capped).toMatchObject({ ok: false, reason: 'too-many-reads', cap: 3 });
    expect((capped as ComparisonRefusal).reads).toBeGreaterThan(3);
  });

  it('every quick pick against the previous period stays within the cap, with and without the sweep cursor', () => {
    for (const hours of [1, 6, 24, 7 * 24, 30 * 24]) {
      for (const through of [THROUGH, undefined]) {
        const p = ok(planComparison(relative(hours), PREV, { nowMs: AT, collectingSinceMs: SINCE, foldedThroughMs: through }));
        expect(p.reads).toBeLessThanOrEqual(COMPARE_DOC_CAP);
        // Same length, disjoint, the baseline first.
        expect(p.current.toMs - p.current.fromMs).toBe(p.baseline.toMs - p.baseline.fromMs);
        expect(p.baseline.toMs).toBeLessThanOrEqual(p.current.fromMs);
      }
    }
  });
});

describe('compareRanges over seeded history', () => {
  it('7 days vs the previous 7: both sums from their own rows, the signed delta and its share of the baseline', () => {
    const p = ok(planComparison(relative(7 * 24), PREV, { nowMs: AT, collectingSinceMs: SINCE, foldedThroughMs: THROUGH }));
    const current = readWindow(p.current);
    const baseline = readWindow(p.baseline);
    const cmp = compareRanges(current, baseline);
    expect(cmp.basis).toBe('sum');
    expect(current.rows).toBeGreaterThan(0);
    expect(baseline.rows).toBeGreaterThan(0);
    // The hybrid read sums what a single-family read of the same window sums.
    const hours = seed().hour;
    expect(current.savedM).toBe(sumRange(hours, 'hour', p.current.fromMs, p.current.toMs).savedM);
    expect(baseline.savedM).toBe(sumRange(hours, 'hour', p.baseline.fromMs, p.baseline.toMs).savedM);
    expect(cmp.currentM).toBe(current.savedM);
    expect(cmp.baselineM).toBe(baseline.savedM);
    expect(cmp.deltaM).toBe(current.savedM - baseline.savedM);
    expect(cmp.pct).toBeCloseTo((current.savedM - baseline.savedM) / baseline.savedM, 12);
    expect(cmp.direction).toBe(cmp.deltaM >= 50_000 ? 'up' : cmp.deltaM <= -50_000 ? 'down' : 'flat');
  });

  it('30 days vs the 30 before, when collecting began 40 days ago: compared per day at each window\'s rate', () => {
    const p = ok(planComparison(relative(30 * 24), PREV, { nowMs: AT, collectingSinceMs: SINCE, foldedThroughMs: THROUGH }));
    const current = readWindow(p.current);
    const baseline = readWindow(p.baseline);
    const cmp = compareRanges(current, baseline);
    expect(cmp.basis).toBe('rate');
    expect(cmp.currentM).toBe(current.ratePerDayM);
    expect(cmp.baselineM).toBe(baseline.ratePerDayM);
    expect(cmp.deltaM).toBe((current.ratePerDayM ?? 0) - (baseline.ratePerDayM ?? 0));
    expect(baseline.savedM).toBeLessThan(current.savedM); // fewer days metered: the sums are not like for like
  });

  it('a baseline with nothing metered has no delta and no percentage (never a share of zero)', () => {
    const current = readWindow({ fromMs: hourFloor(CAP) - 6 * HOUR_MS, toMs: hourFloor(CAP) });
    const empty = sumRange({}, 'hour', hourFloor(CAP) - 12 * HOUR_MS, hourFloor(CAP) - 6 * HOUR_MS);
    const cmp = compareRanges(current, empty);
    expect(cmp).toMatchObject({ basis: 'none', deltaM: 0, direction: 'flat' });
    expect(cmp.pct).toBeUndefined();
    expect(comparisonLines(cmp)).toEqual([]);
  });

  it('per-day scaling follows the rate rule: minutes metered × 1,440, or days metered', () => {
    expect(perDayAtRate({ granularity: 'hour', minutesMetered: 720, daysMetered: undefined }, 1_000_000)).toBe(2_000_000);
    expect(perDayAtRate({ granularity: 'day', minutesMetered: undefined, daysMetered: 4 }, 1_000_000)).toBe(250_000);
    expect(perDayAtRate({ granularity: 'minute', minutesMetered: 0, daysMetered: undefined }, 1_000_000)).toBeUndefined();
  });
});

describe('the receipt of a comparison', () => {
  const figures = (fromMs: number, toMs: number, byFlow: Record<string, number>, extra: Partial<RangeFigures> = {}): RangeFigures => {
    const flows = Object.fromEntries(Object.entries(byFlow).map(([k, saved]) => [k, { whpM: saved * 2, paidM: saved, savedM: saved }]));
    const savedM = Object.values(byFlow).reduce((s, n) => s + n, 0);
    return {
      fromMs,
      toMs,
      granularity: 'hour',
      savedM,
      whpM: savedM * 2,
      paidM: savedM,
      ratio: 0.5,
      rows: 10,
      minutesMetered: (toMs - fromMs) / MINUTE_MS,
      expectedMinutes: (toMs - fromMs) / MINUTE_MS,
      byFlow: flows,
      byOutput: {},
      docsRead: 2,
      docsMissing: 0,
      ratePerDayM: Math.round((savedM * DAY_MS) / (toMs - fromMs)),
      ...extra,
    };
  };
  const end = Date.parse('2026-09-26T19:00:00.000Z');
  // Flow keys: group|input|route|pipeline|output (core/flows.ts) — lines roll up per pipeline.
  const cur = figures(end - 7 * DAY_MS, end, { 'default|in_win|r1|win_trim|splunk': 134_000_000, 'default|in_pay|r2|pay_sample|splunk': 121_200_000, 'default|in_fw|r3|fw_agg|s3': 5_000_000 });
  const base = figures(end - 14 * DAY_MS, end - 7 * DAY_MS, { 'default|in_win|r1|win_trim|splunk': 122_000_000, 'default|in_pay|r2|pay_sample|splunk': 130_700_000, 'default|in_fw|r3|fw_agg|s3': 5_000_000 });

  it('lines carry both windows and the change, biggest change first', () => {
    const cmp = compareRanges(cur, base);
    expect(cmp.basis).toBe('sum');
    const lines = comparisonLines(cmp, { win_trim: 'Windows event trimming', pay_sample: 'Payments API sampling' });
    expect(lines.map((l) => [l.label, l.currentM, l.baselineM, l.deltaM])).toEqual([
      ['Windows event trimming', 134_000_000, 122_000_000, 12_000_000],
      ['Payments API sampling', 121_200_000, 130_700_000, -9_500_000],
      [expect.any(String), 5_000_000, 5_000_000, 0],
    ]);
  });

  it('Copy receipt carries both windows, both totals, the signed change and both summaries, within 48 characters', () => {
    const cmp = compareRanges(cur, base);
    const text = receiptTextForComparison(cmp, { tz: 'America/Chicago', labels: { win_trim: 'Windows event trimming', pay_sample: 'Payments API sampling' }, baselineName: 'Previous period' });
    const lines = text.split('\n');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(RECEIPT_WIDTH);
    expect(text).toContain('Sep 19, 2:00 PM–Sep 26, 2:00 PM');
    expect(text).toContain('Sep 12, 2:00 PM–Sep 19, 2:00 PM');
    expect(lines.slice(0, 3)).toEqual(['Meter Reader — receipt comparison', 'This range       Sep 19, 2:00 PM–Sep 26, 2:00 PM', 'Previous period  Sep 12, 2:00 PM–Sep 19, 2:00 PM']);
    expect(text).toMatch(/Windows event trimming \.+ +\$1,340 +\+\$120/);
    expect(text).toMatch(/Payments API sampling \.+ +\$1,212 +−\$95/);
    expect(text).toMatch(/Saved by Cribl, this range +\$2,602/);
    expect(text).toMatch(/Saved by Cribl, previous period +\$2,577/);
    expect(text).toMatch(/Change +\+\$25 \(\+1%\)/);
    expect(text).toContain('This range: would have paid $5,204\n  paid $2,602 · 50% saved');
    expect(text).toContain('Previous period: would have paid $5,154\n  paid $2,577 · 50% saved');
    expect(text).toContain('Open alerts: none');
  });

  it('on a per-day basis the totals and change are a day at each rate, and the receipt says so', () => {
    const shortBase = figures(end - 14 * DAY_MS, end - 7 * DAY_MS, { 'default|in_win|r1|win_trim|splunk': 61_000_000 }, { minutesMetered: 3.5 * 1440 });
    const cmp = compareRanges(cur, shortBase);
    expect(cmp.basis).toBe('rate');
    const text = receiptTextForComparison(cmp, { tz: 'UTC', baselineName: 'Before 805b12c', currentName: 'After 805b12c' });
    expect(text).toContain("Compared per day, at each window's own rate:");
    expect(text).toMatch(/Saved by Cribl, after 805b12c +\$\d[\d,]* a day/);
    expect(text).toMatch(/Change +\+\$\d[\d,]* a day \(\+\d+%\)/);
    for (const l of text.split('\n')) expect(l.length).toBeLessThanOrEqual(RECEIPT_WIDTH);
  });

  it('a baseline with nothing metered prints as not metered, never as $0 (review W2)', () => {
    const empty = figures(end - 14 * DAY_MS, end - 7 * DAY_MS, {}, { rows: 0, minutesMetered: 0 });
    const cmp = compareRanges(cur, empty);
    expect(cmp.basis).toBe('none');
    const text = receiptTextForComparison(cmp, { tz: 'UTC', baselineName: 'The previous 30 days' });
    expect(text).toMatch(/Saved by Cribl, the previous 30 days\s+not metered/);
    expect(text).toContain('Nothing was metered to compare with.');
    expect(text).not.toMatch(/previous 30 days: would have paid/);
    expect(text).not.toMatch(/the previous 30 days +\$0/);
    expect(text).toContain('This range: would have paid');
  });
});

describe('the words of a comparison (src/views/Receipt/compareText.ts)', () => {
  const fig = (savedM: number, whpM: number, extra: Partial<RangeFigures> = {}): RangeFigures =>
    ({ fromMs: 0, toMs: 7 * DAY_MS, granularity: 'hour', savedM, whpM, paidM: whpM - savedM, ratio: savedM / whpM, rows: 5, minutesMetered: 7 * 1440, expectedMinutes: 7 * 1440, byFlow: {}, byOutput: {}, docsRead: 1, docsMissing: 0, ratePerDayM: Math.round(savedM / 7), ...extra }) as RangeFigures;

  it('names the windows: the previous 24 h (never "1 day"), a week earlier, before and after a commit', async () => {
    const { compareNames } = await import('../../src/views/Receipt/compareText.ts');
    expect(compareNames(PREV, { fromMs: 0, toMs: DAY_MS })).toMatchObject({ name: 'the previous 24 h', eyebrow: 'Compared with the previous 24 h', currentRow: 'This range', baselineRow: 'The previous 24 h' });
    expect(compareNames(PREV, { fromMs: 0, toMs: 7 * DAY_MS }).name).toBe('the previous 7 days');
    expect(compareNames(WEEK, { fromMs: 0, toMs: 6 * HOUR_MS })).toMatchObject({ name: 'the same window a week earlier', baselineRow: 'A week earlier' });
    expect(compareNames({ kind: 'commit', hash: '805b12c0d9e1' }, { fromMs: 0, toMs: DAY_MS })).toMatchObject({ name: 'the time before 805b12c', currentRow: 'After 805b12c', baselineRow: 'Before 805b12c' });
  });

  it('the change, its basis and the saved share: dollars and share can move apart', async () => {
    const { deltaText, fromToText, pctBasisText, shareLineText } = await import('../../src/views/Receipt/compareText.ts');
    const cmp = compareRanges(fig(2_261_100_000, 5_269_400_000), fig(2_526_500_000, 6_511_600_000));
    expect(fromToText(cmp)).toBe('$25,265 → $22,611');
    expect(deltaText(cmp)).toBe('−$2,654 (−11%)');
    expect(pctBasisText(cmp, 'the time before 4d1a70c')).toBe('of what the time before 4d1a70c saved');
    expect(shareLineText(cmp)).toBe('Share of dollars saved 39% → 43% (+4 points)');
    const flat = compareRanges(fig(100_000_000, 200_000_000), fig(100_020_000, 200_000_000));
    expect(deltaText(flat)).toBe('No change');
    expect(shareLineText(flat)).toBe('Share of dollars saved 50% → 50% (0 points)');
    // The points are the printed percentages' difference (review W2: 37.56% → 40.35% printed "38% → 40% (+3 points)").
    const tour = compareRanges(fig(3_457_600_000, 8_568_200_000), fig(2_568_200_000, 6_836_700_000));
    expect(shareLineText(tour)).toBe('Share of dollars saved 38% → 40% (+2 points)');
  });

  it('refusals in one sentence each', async () => {
    const { refusalText } = await import('../../src/views/Receipt/compareText.ts');
    expect(refusalText({ ok: false, vs: { kind: 'commit', hash: 'deadbeef' }, reason: 'no-commit' }, 'UTC')).toBe('Commit deadbee is not in the recent change timeline.');
    expect(refusalText({ ok: false, vs: PREV, reason: 'too-many-reads', reads: 40, cap: 33 }, 'UTC')).toBe(
      'Comparing would read 40 history documents, more than the 33 one range may read. Pick a shorter range.',
    );
    expect(refusalText({ ok: false, vs: PREV, reason: 'before-collecting' }, 'UTC', Date.parse('2026-09-06T21:41:00Z'), AT)).toBe('Nothing was metered before Sep 6, so there is nothing to compare with.');
  });
});
