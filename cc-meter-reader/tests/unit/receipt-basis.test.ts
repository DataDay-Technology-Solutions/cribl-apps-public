// tests/unit/receipt-basis.test.ts — what a forwarded receipt rests on (P0-23) and the Copy receipt's fidelity
// (P1-F04). Every receipt that leaves the app — Copy receipt for a period or a range, and the weekly receipt in the
// bell, Slack, notification targets and ServiceNow — carries a Basis block: one line per priced destination (its
// $/GB and whether that is a preset's typical list price or a price typed in), the counterfactual credits, the
// destinations left out unpriced and how much of the period was metered. The period receipt lists the top savers
// at their current rates (labelled per day), a Net line when a Cribl cost is set, a dated annualized header, and
// never leaves "… .." before an amount.

import { describe, expect, it } from 'vitest';
import type { DestinationFigures, Headline, PricesDoc, Snapshot, TopSaver, TotalsDoc } from '../../core/types.ts';
import { RECEIPT_WIDTH, buildWeeklyReceipt, coverageLine, receiptBasis, receiptText, receiptTextForPeriod, receiptTextForRange } from '../../core/receipt.ts';
import { COVERAGE_SLACK_MIN, appendPriceVersion, computeHeadline, emptyPrices, periodCoverage } from '../../core/pricing.ts';
import { canonicalPayload, servicenowPayload, slackPayload } from '../../core/payloads.ts';
import { renderAlert } from '../../core/delivery.ts';
import type { RangeFigures } from '../../core/range.ts';
import { localDayStartMs } from '../../core/time.ts';

const TZ = 'UTC';
const $ = (dollars: number) => dollars * 100_000;
const SWEEP = '2026-09-24T23:00:00.000Z';

const prices: PricesDoc = appendPriceVersion(
  emptyPrices('x'),
  {
    'default:siem': { milliCentsPerGb: 225_000, preset: 'splunk_cloud' }, // Splunk Cloud's typical list price
    'default:analytics': { milliCentsPerGb: 160_000, preset: 'datadog' }, // a contract rate typed over the Datadog preset
    'default:lake': { milliCentsPerGb: 5_000, preset: 'cribl_lake', counterfactual: { kind: 'other', outputId: 'siem' } },
    'default:archive': { milliCentsPerGb: 2_300, preset: 's3', counterfactual: { kind: 'none' } },
  },
  Date.parse('2026-09-01T00:00:00Z'),
);

function dest(outputId: string, over: Partial<DestinationFigures> = {}): DestinationFigures {
  return {
    groupId: 'default',
    outputId,
    type: 'splunk_hec',
    whpPerDayM: 0,
    paidPerDayM: 0,
    savedPerDayM: 0,
    mtdPaidM: 0,
    mtdSavedM: 0,
    mtdWhpM: 0,
    milliCentsPerGb: 0,
    counterfactual: { kind: 'same' },
    unpriced: false,
    ...over,
  };
}

const destinations: DestinationFigures[] = [
  dest('siem', { milliCentsPerGb: 225_000, mtdWhpM: $(40_000), mtdPaidM: $(16_000), mtdSavedM: $(24_000), whpPerDayM: $(1_600), paidPerDayM: $(640), savedPerDayM: $(960) }),
  dest('analytics', { type: 'datadog', milliCentsPerGb: 160_000, mtdWhpM: $(9_000), mtdPaidM: $(4_000), mtdSavedM: $(5_000), whpPerDayM: $(360), paidPerDayM: $(160), savedPerDayM: $(200) }),
  dest('lake', {
    type: 'cribl_lake',
    milliCentsPerGb: 5_000,
    counterfactual: { kind: 'other', outputId: 'siem' },
    mtdWhpM: $(6_750),
    mtdPaidM: $(150),
    mtdSavedM: $(6_600),
    whpPerDayM: $(270),
    paidPerDayM: $(6),
    savedPerDayM: $(264),
  }),
  dest('archive', { type: 's3', milliCentsPerGb: 2_300, counterfactual: { kind: 'none' }, mtdPaidM: $(30), paidPerDayM: $(1) }),
  dest('hec_unpriced', { type: 'splunk_hec', unpriced: true }),
  dest('webhook_unpriced', { type: 'webhook', unpriced: true }),
  dest('devnull', { type: 'devnull' }), // free, carries no money
];

const topSavers: TopSaver[] = [
  ['Windows event trimming', 610],
  ['Palo Alto traffic aggregation', 420],
  ['CrowdStrike FDR duplicate suppression', 264],
  ['Kubernetes noise filter', 200],
  ['Payments API sampling', 150],
  ['A sixth saver that never shows', 10],
].map(([label, dollars], i) => ({ objectKey: `route:default:r${i}`, label: label as string, savedPerDayM: $(dollars as number), ratio: 0.5, groupId: 'default', pipelineId: `p${i}` }));

// Sep 24 23:00 UTC: 33,480 minutes of September have passed; metering covered 27,540 of them (an install on the 5th).
const headline: Headline = {
  todayM: $(1_300),
  mtdM: $(35_600),
  d30M: $(35_600),
  annualizedM: $(482_000),
  annualizedFromDays: 19,
  whpMtdM: $(55_750),
  paidMtdM: $(20_150),
  ratioMtd: 35_600 / 55_750,
  whpTodayM: $(2_100),
  paidTodayM: $(800),
  whp30dM: $(55_750),
  paid30dM: $(20_150),
  netMtdM: $(35_600) - $(18_700),
  paybackX: 35_600 / 18_700,
  minutesMtd: 27_540,
  expectedMinutesMtd: 33_480,
  minutesToday: 1_380,
  expectedMinutesToday: 1_380,
  minutes30d: 27_540,
  expectedMinutes30d: 43_200,
};

const snapshot = {
  sweepAt: SWEEP,
  headline,
  topSavers,
  destinations,
  unpricedOutputIds: ['hec_unpriced', 'webhook_unpriced'],
  incidents: [],
} as unknown as Snapshot;

const linesOf = (text: string) => text.split('\n');
/** Every receipt ends with the builder's sign-off (core/receipt.ts receiptSignOff): a blank line, the centred signature. */
const SIGN_OFF = ['', '         Meter Reader by Steve Koelpin'];
/** The receipt's lines before its sign-off (which must be there). */
const bodyOf = (text: string) => {
  const lines = linesOf(text);
  expect(lines.slice(-2), 'the receipt ends with the sign-off').toEqual(SIGN_OFF);
  return lines.slice(0, -2);
};
const basisOf = (text: string) => {
  const lines = bodyOf(text);
  const at = lines.indexOf('Basis');
  return at < 0 ? [] : lines.slice(at + 1);
};

describe('P0-23 · Copy receipt carries its basis', () => {
  const text = receiptTextForPeriod('month to date', snapshot, { period: 'mtd', tz: TZ, prices, criblCostCentsPerMonth: 1_870_000 });

  it('lists every destination that carried money, its $/GB and where the price comes from', () => {
    const basis = basisOf(text);
    expect(basis.slice(0, 6)).toEqual([
      'SIEM: $2.25/GB, Splunk Cloud typical list',
      'Analytics: $1.60/GB, custom price',
      'Lake: $0.05/GB, Cribl Lake typical list;',
      "  credited at SIEM's $2.25/GB: $6,750",
      'Archive: $0.023/GB, Amazon S3 typical list;',
      '  never counted as savings',
    ]);
  });

  it('says how many destinations are unpriced and excluded, and how much of the month was metered', () => {
    const basis = basisOf(text);
    expect(basis).toContain('2 destinations unpriced, excluded');
    expect(basis).toContain('Metered 27,540 of 33,480 minutes (82%)');
    expect(basis[basis.length - 1]).toBe('Metered 27,540 of 33,480 minutes (82%)');
  });

  it('stays inside 48 columns', () => {
    for (const line of linesOf(text)) expect(line.length, line).toBeLessThanOrEqual(RECEIPT_WIDTH);
  });

  it('a range receipt carries the same block from its own sums and coverage', () => {
    const figures: RangeFigures = {
      fromMs: Date.parse('2026-09-24T10:00:00Z'),
      toMs: Date.parse('2026-09-24T14:00:00Z'),
      granularity: 'minute',
      savedM: $(160),
      whpM: $(267),
      paidM: $(107),
      ratio: 0.6,
      rows: 400,
      minutesMetered: 236,
      expectedMinutes: 240,
      byFlow: { 'default|a|r|p|siem': { whpM: $(267), paidM: $(107), savedM: $(160) } },
      byOutput: { 'default:siem': { whpM: $(267), paidM: $(107), savedM: $(160) } },
      docsRead: 4,
      docsMissing: 0,
    };
    const range = receiptTextForRange(figures, { tz: TZ, destinations, prices });
    expect(basisOf(range)).toEqual(['SIEM: $2.25/GB, Splunk Cloud typical list', '2 destinations unpriced, excluded', 'Metered 236 of 240 minutes (98%)']);
    // Without the snapshot's destinations (older callers) the block is left out rather than guessed.
    expect(receiptTextForRange(figures, { tz: TZ })).not.toContain('Basis');
  });
});

describe('P0-23 · the weekly receipt (bell, Slack, targets, ServiceNow) carries the same basis', () => {
  const START = localDayStartMs('2026-09-14', TZ);
  const END = localDayStartMs('2026-09-21', TZ);
  const weekly = buildWeeklyReceipt({
    periodStartMs: START,
    periodEndMs: END,
    tz: TZ,
    flowSums: {
      'default|win|r1|win_trim|siem': { whpM: $(10_000), paidM: $(4_000), savedM: $(6_000) },
      'default|k8s|r2|k8s_noise|analytics': { whpM: $(2_000), paidM: $(900), savedM: $(1_100) },
      'default|dns|r3|dns_lake|lake': { whpM: $(1_500), paidM: $(35), savedM: $(1_465) },
    },
    basis: { prices, destinations, coverage: { unit: 'minutes', metered: 9_000, expected: 10_080 } },
  });

  it('builds the basis from the week’s own sums, credits included', () => {
    expect(weekly.basis).toEqual({
      prices: [
        { label: 'SIEM', milliCentsPerGb: 225_000, source: 'preset', presetLabel: 'Splunk Cloud' },
        { label: 'Analytics', milliCentsPerGb: 160_000, source: 'custom' },
        { label: 'Lake', milliCentsPerGb: 5_000, source: 'preset', presetLabel: 'Cribl Lake', creditedAt: { label: 'SIEM', milliCentsPerGb: 225_000, whpM: $(1_500) } },
      ],
      unpricedCount: 2,
      coverage: { unit: 'minutes', metered: 9_000, expected: 10_080 },
    });
  });

  it('prints it under the receipt, in every channel that forwards the text', () => {
    const text = receiptText(weekly);
    expect(basisOf(text)).toEqual([
      'SIEM: $2.25/GB, Splunk Cloud typical list',
      'Analytics: $1.60/GB, custom price',
      'Lake: $0.05/GB, Cribl Lake typical list;',
      "  credited at SIEM's $2.25/GB: $1,500",
      '2 destinations unpriced, excluded',
      'Metered 9,000 of 10,080 minutes (89%)',
    ]);
    for (const line of linesOf(text)) expect(line.length, line).toBeLessThanOrEqual(RECEIPT_WIDTH);
    const canonical = canonicalPayload('receipt.weekly', { receipt: weekly, workspace: 'w', linkBase: '', sentAt: SWEEP });
    expect(renderAlert(canonical).text).toContain('Metered 9,000 of 10,080 minutes (89%)');
    expect(JSON.stringify(slackPayload(canonical).blocks)).toContain('2 destinations unpriced, excluded');
    expect(servicenowPayload(canonical).description).toContain('Basis');
    // The generic webhook's JSON carries the structured basis too.
    expect(canonical.receipt?.basis?.unpricedCount).toBe(2);
  });

  it('links to its week on the Receipt: whole on its own line, and a Slack button', () => {
    const linked = buildWeeklyReceipt({
      periodStartMs: START,
      periodEndMs: END,
      tz: TZ,
      flowSums: { 'default|win|r1|win_trim|siem': { whpM: $(10_000), paidM: $(4_000), savedM: $(6_000) } },
      linkBase: 'https://acme.cribl.cloud/apps/a/meter-reader/',
    });
    expect(linked.link).toBe(`https://acme.cribl.cloud/apps/a/meter-reader/?range=${new Date(START).toISOString().slice(0, 16)}Z..${new Date(END).toISOString().slice(0, 16)}Z`);
    const lines = bodyOf(receiptText(linked));
    expect(lines.slice(-2)).toEqual(['Open this week on the Receipt:', linked.link]);
    const slack = slackPayload(canonicalPayload('receipt.weekly', { receipt: linked, workspace: 'w', linkBase: '', sentAt: SWEEP }));
    expect(slack.blocks.at(-1)).toEqual({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open the Receipt' }, url: linked.link, action_id: 'open_receipt' }] });
    // Without a link base nothing is linked (and no button).
    expect(weekly.link).toBeUndefined();
    expect(slackPayload(canonicalPayload('receipt.weekly', { receipt: weekly, workspace: 'w', linkBase: '', sentAt: SWEEP })).blocks.some((b) => b.type === 'actions')).toBe(false);
  });

  it('an older receipt without a basis renders exactly as before', () => {
    const { basis: _drop, ...bare } = weekly;
    expect(receiptText(bare)).not.toContain('Basis');
  });
});

describe('P0-23 · coverage', () => {
  it('the headline counts metered minutes against the minutes each period has held', () => {
    // Collecting since Sep 25 00:00 UTC; evaluated Sep 26 00:30 with the sweep metered through 00:30.
    const totals: TotalsDoc = {
      schemaVersion: 1,
      updatedAt: '',
      byDay: {
        '2026-09-25': { whpM: 3, paidM: 1, savedM: 2, minutes: 1_440 },
        '2026-09-26': { whpM: 3, paidM: 1, savedM: 2, minutes: 28 },
      },
    };
    const now = Date.parse('2026-09-26T00:30:25Z');
    const h = computeHeadline(totals, now, TZ, Date.parse('2026-09-25T00:00:00Z'), undefined, Date.parse('2026-09-26T00:30:00Z'));
    expect(h).toMatchObject({ minutesMtd: 1_468, expectedMinutesMtd: 36_030, minutesToday: 28, expectedMinutesToday: 30 });
    expect(periodCoverage(h, 'mtd')).toMatchObject({ metered: 1_468, expected: 36_030, complete: false });
    // Two minutes short today is inside the settle/hold slack: today reads complete.
    expect(periodCoverage(h, 'today')).toMatchObject({ complete: true });
    expect(COVERAGE_SLACK_MIN).toBeGreaterThanOrEqual(2);
    // An older headline without the fields has no coverage to state.
    expect(periodCoverage({ ...h, minutesMtd: undefined }, 'mtd')).toBeUndefined();
  });

  it('never rounds a partial period up to 100%', () => {
    expect(coverageLine({ unit: 'minutes', metered: 34_559, expected: 34_560 })).toBe('Metered 34,559 of 34,560 minutes (99%)');
    expect(coverageLine({ unit: 'minutes', metered: 34_560, expected: 34_560 })).toBe('Metered 34,560 of 34,560 minutes (100%)');
    expect(coverageLine({ unit: 'days', metered: 6, expected: 7 })).toBe('Metered 6 of 7 days (85%)');
    expect(coverageLine({ unit: 'minutes', metered: 60, expected: 10_080 })).toBe('Metered 60 of 10,080 minutes (under 1%)');
    expect(coverageLine({ unit: 'minutes', metered: 0, expected: 10_080 })).toBe('Metered 0 of 10,080 minutes (0%)');
  });

  it('a receipt basis without money or prices still says what it excluded', () => {
    const b = receiptBasis({ byOutput: {}, destinations, atMs: 0 });
    expect(b).toEqual({ prices: [], unpricedCount: 2 });
  });
});

describe('P1-F04 · Copy receipt fidelity', () => {
  it('month to date lists the top five savers at their current rates, per day, and the Net line', () => {
    const text = receiptTextForPeriod('month to date', snapshot, { period: 'mtd', tz: TZ, prices, criblCostCentsPerMonth: 1_870_000 });
    const lines = linesOf(text);
    expect(lines[0]).toBe('Meter Reader — receipt            Sep 1–24, 2026');
    expect(lines[1]).toBe('Top savers, per day at current rates');
    expect(lines.slice(2, 7)).toEqual([
      'Windows event trimming ...............  $610/day',
      'Palo Alto traffic aggregation ........  $420/day',
      'CrowdStrike FDR duplicate suppre… ....  $264/day',
      'Kubernetes noise filter ..............  $200/day',
      'Payments API sampling ................  $150/day',
    ]);
    expect(lines[7]).toBe('-'.repeat(RECEIPT_WIDTH));
    expect(text).not.toContain('A sixth saver');
    // D49: the cost over the minutes metered this month, as the hero reads it (Sep 1 00:00 → Sep 24 23:00 UTC is
    // 34,500 minutes: $18,700 × 12 ÷ 525,600 × 34,500 = $14,729), not the headline's figure from the sweep.
    expect(text).toContain('Net after Cribl $20,871 · Paid for itself 2.4×');
  });

  it('no line leaves "… .." (or "... ..") before an amount: at least four leader dots', () => {
    const long = { ...snapshot, topSavers: [{ ...topSavers[0], label: 'An extraordinarily long pipeline label that cannot fit in a receipt' }] } as Snapshot;
    for (const period of ['mtd', 'today', '30d', 'annualized'] as const) {
      const text = receiptTextForPeriod('', long, { period, tz: TZ });
      expect(text).not.toMatch(/… \.\.(?!\.)/);
      expect(text).not.toContain('... ..');
      for (const line of linesOf(text).filter((l) => l.includes('/day'))) expect(line).toMatch(/ \.{4,} +\$/);
    }
  });

  it('dates the annualized header and states its net per year; no Net line without a Cribl cost', () => {
    const ann = receiptTextForPeriod('annualized run rate', snapshot, { period: 'annualized', tz: TZ, criblCostCentsPerMonth: 1_870_000 });
    expect(linesOf(ann)[0]).toBe('Meter Reader — receipt        as of Sep 24, 2026');
    expect(ann).toContain('Net after Cribl $257,600 a year');
    expect(ann).toContain('Paid for itself 2.1×');
    expect(receiptTextForPeriod('', snapshot, { period: 'annualized', tz: TZ })).not.toContain('Net after Cribl');
    // The cost cleared since the sweep: the hero shows no net, so neither does the receipt.
    expect(receiptTextForPeriod('', snapshot, { period: 'mtd', tz: TZ, criblCostCentsPerMonth: 0 })).not.toContain('Net after Cribl');
    // Today and the last 30 days never print a net line (the hero shows none).
    expect(receiptTextForPeriod('', snapshot, { period: 'today', tz: TZ, criblCostCentsPerMonth: 1_870_000 })).not.toContain('Net after Cribl');
  });

  it('mirrors the hero: a Cribl cost cleared since the sweep prints no Net line, though the headline still has one', () => {
    expect(snapshot.headline.netMtdM).toBeDefined();
    expect(receiptTextForPeriod('', snapshot, { period: 'mtd', tz: TZ, criblCostCentsPerMonth: undefined })).not.toContain('Net after Cribl');
    expect(receiptTextForPeriod('', snapshot, { period: 'mtd', tz: TZ })).toContain('Net after Cribl');
  });

  it('given the period’s own lines, prints them as sums (no per-day header)', () => {
    const text = receiptTextForPeriod('', snapshot, { period: 'mtd', tz: TZ, lines: [{ label: 'Windows event trimming', savedM: $(18_000) }] });
    expect(text).not.toContain('per day at current rates');
    expect(linesOf(text)[1]).toMatch(/^Windows event trimming \.+ +\$18,000$/);
  });
});

describe('P0-23 · the weekly send (core/weekly.ts) builds the basis from the stored prices, snapshot and totals', () => {
  it('"Weekly receipt now" carries the Basis block with the week’s coverage', async () => {
    const { createWorld, DAY } = await import('../integration/harness.ts');
    const { runWeeklyReceipt } = await import('../../core/weekly.ts');
    const w = await createWorld();
    await w.sweep(); // a snapshot, totals and a day of prices behind it
    w.advance(DAY);
    const r = await runWeeklyReceipt(w.deps, { mode: 'manual' });
    expect(r.error).toBeUndefined();
    expect(r.receipt?.basis).toBeDefined();
    expect(r.receipt!.basis!.coverage).toMatchObject({ unit: 'minutes', expected: 7 * 1_440 });
    expect(r.text).toContain('\nBasis\n');
    // A day-old world metered a sliver of the week: the share reads 'under 1%' rather than rounding to 0%.
    expect(r.text).toMatch(/Metered [\d,]+ of 10,080 minutes \((\d+%|under 1%)\)/);
    // The receipt links to its week on the Receipt (a custom range), whole on its own line.
    expect(r.receipt!.link).toMatch(/\/\?range=\d{4}-\d\d-\d\dT\d\d:\d\dZ\.\.\d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
    expect(r.text!.split('\n')).toContain(r.receipt!.link);
  });
});
