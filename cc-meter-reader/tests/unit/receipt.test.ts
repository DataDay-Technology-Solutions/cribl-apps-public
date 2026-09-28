import { describe, expect, it } from 'vitest';
import type { Snapshot, WeeklyReceipt } from '../../core/types.ts';
import {
  RECEIPT_WIDTH,
  buildWeeklyReceipt,
  periodCaption,
  previousWeek,
  receiptText,
  receiptTextForPeriod,
  receiptTextForRange,
  trailingWeek,
} from '../../core/receipt.ts';
import type { RangeFigures } from '../../core/range.ts';
import { localDayStartMs } from '../../core/time.ts';

const TZ = 'America/Chicago';
const START = localDayStartMs('2026-09-21', TZ);
const END = localDayStartMs('2026-09-28', TZ);
const $ = (dollars: number) => dollars * 100_000;

/** The SPEC 12.4 example numbers. */
const exampleReceipt = (): WeeklyReceipt =>
  buildWeeklyReceipt({
    periodStartMs: START,
    periodEndMs: END,
    tz: TZ,
    flowSums: {
      'default|a|r1|win_trim|siem': { whpM: $(14_000), paidM: $(4_620), savedM: $(9_380) },
      'default|b|r2|fw_dedupe|siem': { whpM: $(10_000), paidM: $(3_616), savedM: $(6_384) },
      'default|c|r3|mrd_k8s_noise|analytics': { whpM: $(7_000), paidM: $(2_520), savedM: $(4_480) },
      'default|d|r4|mrd_pay_sample|siem': { whpM: $(5_000), paidM: $(2_284), savedM: $(2_716) },
      'default|e|r5|cdn_agg|siem': { whpM: $(2_000), paidM: $(1_153), savedM: $(847) },
      'default|f|r6|passthru|siem': { whpM: $(1_678), paidM: $(1_678), savedM: 0 },
    },
    priorSavedM: Math.round($(23_807) / 1.04),
    openIncidents: [{ type: 'regression', label: 'Payments API sampling' }, { type: 'spike', label: 'x', closedAt: '2026-09-27T00:00:00Z' }],
  });

describe('buildWeeklyReceipt', () => {
  it('rolls flows up to their pipelines, top five, with totals and trend', () => {
    const r = exampleReceipt();
    expect(r.label).toBe('Sep 21–27, 2026');
    expect(r.periodStart).toBe('2026-09-21T05:00:00.000Z');
    expect(r.periodEnd).toBe('2026-09-28T05:00:00.000Z');
    expect(r.lines).toEqual([
      { label: 'Windows trimming', savedM: $(9_380) },
      { label: 'Firewall duplicate suppression', savedM: $(6_384) },
      { label: 'Kubernetes noise filter', savedM: $(4_480) },
      { label: 'Payments API sampling', savedM: $(2_716) },
      { label: 'CDN aggregation', savedM: $(847) },
    ]);
    expect(r.savedM).toBe($(23_807));
    expect(r.whpM).toBe($(39_678));
    expect(r.paidM).toBe($(15_871));
    expect(Math.round(r.ratio * 100)).toBe(60);
    expect(r.trendPct).toBe(4);
    expect(r.openIncidents).toEqual([{ title: 'Savings dropped: Payments API sampling' }]);
  });
  it('sums rows itself, derives the prior week, and merges lines that share a label', () => {
    const day = (d: string, savedM: number) => ({ t: new Date(localDayStartMs(d, TZ) + 3_600_000).toISOString(), whpM: savedM * 2, paidM: savedM, savedM });
    const r = buildWeeklyReceipt({
      periodStartMs: START,
      periodEndMs: END,
      tz: TZ,
      rowsByFlow: {
        'g|a|r1|p1|o': [day('2026-09-15', 100), day('2026-09-22', 300)],
        'g|b|r2|p1|o': [day('2026-09-23', 200)],
        'g|c|r3|-|o': [day('2026-09-23', 50)],
        'g|d|-|-|o': [day('2026-09-24', 25)],
        weird: [day('2026-09-24', 5)],
      },
      labels: { p1: 'Shared pipeline' },
    });
    expect(r.lines).toEqual([
      { label: 'Shared pipeline', savedM: 500 },
      { label: 'R3', savedM: 50 },
      { label: 'Other', savedM: 25 },
      { label: 'Weird', savedM: 5 },
    ]);
    expect(r.priorSavedM).toBe(100);
    expect(r.trendPct).toBe(480);
  });
  it('omits the trend without a prior week and handles an empty week', () => {
    const r = buildWeeklyReceipt({ periodStartMs: START, periodEndMs: END, tz: TZ });
    expect(r).toMatchObject({ lines: [], savedM: 0, whpM: 0, paidM: 0, ratio: 0, openIncidents: [] });
    expect(r.trendPct).toBeUndefined();
    expect(r.priorSavedM).toBeUndefined();
    const zeroPrior = buildWeeklyReceipt({ periodStartMs: START, periodEndMs: END, tz: TZ, priorSavedM: 0 });
    expect(zeroPrior.priorSavedM).toBe(0);
    expect(zeroPrior.trendPct).toBeUndefined();
  });
});

describe('receiptText', () => {
  it('renders the SPEC 12.4 layout at 48 columns', () => {
    const text = receiptText(exampleReceipt());
    const lines = text.split('\n');
    expect(lines).toEqual([
      'Meter Reader — weekly receipt    Sep 21–27, 2026',
      'Windows trimming ......................   $9,380',
      'Firewall duplicate suppression ........   $6,384',
      'Kubernetes noise filter ...............   $4,480',
      'Payments API sampling .................   $2,716',
      'CDN aggregation .......................     $847',
      '------------------------------------------------',
      'Saved by Cribl, last week                $23,807',
      'Would have paid $39,678 · Paid $15,871',
      '60% saved',
      'vs. prior week: +4%',
      'Open alerts: 1',
      '  Savings dropped: Payments API sampling',
      '',
      // The builder's sign-off, centred where a till prints its thank-you (core/strings.ts CREDIT_STRINGS).
      '         Meter Reader by Steve Koelpin',
    ]);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(RECEIPT_WIDTH);
    // amounts right-aligned in one column
    expect(new Set(lines.slice(1, 6).map((l) => l.length))).toEqual(new Set([48]));
  });
  it('handles long labels, big amounts, negative trends, long headers and no alerts', () => {
    const r: WeeklyReceipt = {
      periodStart: '',
      periodEnd: '',
      label: 'Dec 28, 2026–Jan 3, 2027',
      lines: [{ label: 'An extremely long pipeline label that cannot possibly fit', savedM: $(1_234_567) }],
      savedM: $(12_345_678),
      whpM: $(20_000_000),
      paidM: $(7_654_322),
      ratio: 0.617,
      trendPct: -12,
      openIncidents: [],
    };
    const lines = receiptText(r).split('\n');
    expect(lines[0]).toBe('Meter Reader — weekly receipt');
    expect(lines[1]).toBe('Dec 28, 2026–Jan 3, 2027'.padStart(48));
    // P1-F04: a truncated label leaves at least four leader dots (never '… ..' before the amount).
    expect(lines[2]).toMatch(/^An extremely long pipeline la… \.{4} {3}\$1,234,567$/);
    expect(lines[2]).toHaveLength(48);
    expect(lines).toContain('vs. prior week: −12%');
    // The body ends with the alerts; the builder's sign-off closes every receipt, centred on its width.
    expect(lines.slice(-3)).toEqual(['Open alerts: none', '', '         Meter Reader by Steve Koelpin']);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(RECEIPT_WIDTH);
    expect(receiptText({ ...r, trendPct: 0 })).toContain('vs. prior week: 0%');
  });
});

describe('periods', () => {
  it('finds the previous Monday–Sunday week and the trailing seven days', () => {
    const monday = Date.parse('2026-09-28T12:00:00Z'); // Monday 7 AM CDT
    expect(previousWeek(monday, TZ)).toEqual({ startMs: START, endMs: END });
    const sunday = Date.parse('2026-09-27T12:00:00Z');
    expect(previousWeek(sunday, TZ)).toEqual({ startMs: localDayStartMs('2026-09-14', TZ), endMs: localDayStartMs('2026-09-21', TZ) });
    expect(trailingWeek(sunday, TZ)).toEqual({ startMs: localDayStartMs('2026-09-20', TZ), endMs: localDayStartMs('2026-09-27', TZ) });
  });
  it('names periods with the Meter captions', () => {
    expect(periodCaption('mtd')).toBe('month to date');
    expect(periodCaption('annualized')).toBe('annualized run rate');
  });
});

describe('receiptTextForPeriod', () => {
  const snap = {
    sweepAt: '2026-09-26T17:00:00.000Z',
    headline: {
      todayM: $(900),
      mtdM: $(23_807),
      d30M: $(27_000),
      annualizedM: $(328_500),
      annualizedFromDays: 5,
      whpMtdM: $(39_678),
      paidMtdM: $(15_871),
      ratioMtd: 0.6,
      whpTodayM: $(1_500),
      paidTodayM: $(600),
      whp30dM: $(45_000),
      paid30dM: $(18_000),
    },
    incidents: [
      { type: 'regression', label: 'Payments API sampling', closedAt: undefined },
      { type: 'spike', label: 'Old', closedAt: '2026-09-26T00:00:00Z' },
    ],
  } as unknown as Snapshot;

  it('renders month to date by default, with lines only when given', () => {
    const text = receiptTextForPeriod('month to date', snap, { tz: TZ });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Meter Reader — receipt            Sep 1–26, 2026');
    expect(lines[0]).toHaveLength(48);
    expect(lines[1]).toBe('-'.repeat(48));
    expect(lines[2]).toBe('Saved by Cribl, month to date            $23,807');
    expect(lines[2]).toHaveLength(48);
    expect(lines[3]).toBe('Would have paid $39,678 · Paid $15,871');
    expect(lines[4]).toBe('60% saved');
    expect(lines[5]).toBe('Open alerts: 1');
    const withLines = receiptTextForPeriod('month to date', snap, {
      tz: TZ,
      lines: [
        { label: 'B', savedM: $(10) },
        { label: 'A', savedM: $(20) },
        { label: 'Z', savedM: 0 },
      ],
    }).split('\n');
    expect(withLines[1]).toMatch(/^A \.+ +\$20$/);
    expect(withLines[2]).toMatch(/^B \.+ +\$10$/);
    expect(withLines[3]).toBe('-'.repeat(48));
  });
  it('renders today, the last 30 days and the annualized run rate', () => {
    expect(receiptTextForPeriod('today', snap, { tz: TZ })).toContain('Saved by Cribl, today');
    expect(receiptTextForPeriod('today', snap, { tz: TZ }).split('\n')[0]).toMatch(/Sep 26, 2026$/);
    const d30 = receiptTextForPeriod('last 30 days', snap, { tz: TZ });
    expect(d30.split('\n')[0]).toMatch(/Aug 28–Sep 26, 2026$/);
    expect(d30).toContain('Would have paid $45,000 · Paid $18,000\n60% saved');
    const ann = receiptTextForPeriod('annualized run rate', snap, { tz: TZ });
    expect(ann).toContain('$328,500');
    expect(ann).toContain('60% saved · annualized from the last 5 days');
    // P1-F04: the header dates the run rate instead of printing the literal 'run rate'.
    expect(ann.split('\n')[0]).toBe('Meter Reader — receipt        as of Sep 26, 2026');
    const oneDay = receiptTextForPeriod('', { ...snap, headline: { ...snap.headline, annualizedFromDays: 1 } } as Snapshot, { period: 'annualized' });
    expect(oneDay).toContain('from the last 1 day');
    expect(oneDay).toContain('Saved by Cribl, annualized run rate');
    const partial = receiptTextForPeriod('annualized', { ...snap, headline: { ...snap.headline, annualizedFromDays: 0.2 } } as Snapshot);
    expect(partial).toContain('annualized from today so far');
  });
  it('falls back to month to date for unknown labels and bad timestamps', () => {
    const text = receiptTextForPeriod('this quarter', { ...snap, sweepAt: 'bad', incidents: undefined } as unknown as Snapshot);
    expect(text).toContain('Saved by Cribl, this quarter');
    expect(text).toContain('$23,807');
    expect(text).toContain('Open alerts: none');
  });
  it('keeps a short alert list on one line', () => {
    const short = { ...snap, incidents: [{ type: 'spike', label: 'Payments API' }] } as unknown as Snapshot;
    expect(receiptTextForPeriod('today', short)).toContain('Open alerts: 1 (Cost spike: Payments API)');
  });
});

describe('receiptTextForRange', () => {
  const figures: RangeFigures = {
    fromMs: Date.parse('2026-09-26T15:00:00Z'),
    toMs: Date.parse('2026-09-26T19:00:00Z'),
    granularity: 'minute',
    savedM: $(3_870),
    whpM: $(6_450),
    paidM: $(2_580),
    ratio: 0.6,
    rows: 480,
    minutesMetered: 240,
    expectedMinutes: 240,
    byFlow: {
      'default|a|r1|mrd_pay_sample|siem': { whpM: $(3_000), paidM: $(1_788), savedM: $(1_212) },
      'default|b|r2|mrd_k8s_noise|analytics': { whpM: $(2_000), paidM: $(500), savedM: $(1_500) },
      'default|c|r3|win_trim|siem': { whpM: $(1_450), paidM: $(292), savedM: $(1_158) },
    },
    byOutput: {},
    docsRead: 5,
    docsMissing: 0,
    ratePerDayM: $(23_220),
  };
  it('renders the window in words, exact per-pipeline lines, the totals and the rate', () => {
    const text = receiptTextForRange(figures, { tz: TZ, openIncidents: [{ type: 'regression', label: 'Payments API sampling' }] });
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Meter Reader — receipt +Sep 26, 10:00 AM–2:00 PM$/);
    expect(lines[1]).toMatch(/^Kubernetes noise filter \.+ +\$1,500$/);
    expect(lines[2]).toMatch(/^Payments API sampling \.+ +\$1,212$/);
    expect(lines[3]).toMatch(/^Windows trimming \.+ +\$1,158$/);
    expect(lines[4]).toBe('-'.repeat(48));
    expect(text).toContain('Saved by Cribl, Sep 26, 10:00 AM–2:00 PM');
    expect(text).toContain('$3,870');
    expect(text).toContain('Would have paid $6,450 · Paid $2,580 · 60% saved');
    expect(text).toContain('≈ $23,220 a day at this rate');
    // The one-line form would be 56 columns, so the alert wraps under a count line.
    expect(text).toContain('Open alerts: 1\n  Savings dropped: Payments API sampling');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(RECEIPT_WIDTH);
  });
  it('drops the window from the total line when it would not fit beside the amount (the header still carries it)', () => {
    // A cross-day window at day granularity: 'Saved by Cribl, Aug 21, 7:00 PM–Aug 24, 7:00 PM' + '  $785' is 51 columns.
    const long: RangeFigures = { ...figures, fromMs: Date.parse('2026-08-22T00:00:00Z'), toMs: Date.parse('2026-08-25T00:00:00Z'), granularity: 'day', savedM: $(785), minutesMetered: undefined, daysMetered: 3 };
    const text = receiptTextForRange(long, { tz: TZ });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Meter Reader — receipt');
    expect(lines[1]).toMatch(/^ +Aug 21, 7:00 PM–Aug 24, 7:00 PM$/);
    expect(text).toMatch(/^Saved by Cribl +\$785$/m);
    expect(text).not.toContain('Saved by Cribl, Aug');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(RECEIPT_WIDTH);
  });
  it('omits the rate line when nothing was metered, and says no alerts are open', () => {
    const empty: RangeFigures = { ...figures, savedM: 0, whpM: 0, paidM: 0, ratio: 0, rows: 0, byFlow: {}, minutesMetered: 0 };
    delete empty.ratePerDayM;
    const text = receiptTextForRange(empty, { tz: TZ });
    expect(text).not.toContain('a day at this rate');
    expect(text).toContain('Open alerts: none');
    expect(text.split('\n')[1]).toBe('-'.repeat(48));
  });
});
