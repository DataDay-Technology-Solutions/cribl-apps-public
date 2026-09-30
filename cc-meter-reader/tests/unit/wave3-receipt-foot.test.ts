// W3-RECEIPT-1: every printed would have paid / paid / saved triple adds up to the dollar (core/format.ts footMoney).
// The video's weekly receipt printed "Saved by Cribl $177,198 · Would have paid $452,147 · Paid $274,948" (452,147 −
// 274,948 = 177,199), and the Receipt bar printed "You paid $958,407" beside $544,974 saved while the Report card
// printed the footed $958,406. Every receipt built from the tour snapshot is checked here: the weekly one (Slack, the
// bell, the Story), today, the last 30 days, month to date, a custom range and a comparison; and the by-reduction /
// by-diversion split sums to the printed saved.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Snapshot, WeeklyReceipt } from '../../core/types.ts';
import { renderAlert } from '../../core/delivery.ts';
import { receiptText, receiptTextForComparison, receiptTextForPeriod, receiptTextForRange } from '../../core/receipt.ts';
import { compareRanges, planRangeReads, resolveRange, sumRange, type RangeDoc, type RangeFigures } from '../../core/range.ts';
import { sampleRollups } from '../../core/sampleRollups.ts';
import { footMoney, fmtDollars } from '../../core/format.ts';
import { fromIso } from '../../core/time.ts';

interface Tour {
  snapshot: Snapshot;
  weeklyReceipt: WeeklyReceipt;
  timezone?: string;
}
const TOUR = JSON.parse(readFileSync(resolve(__dirname, '../../demo/sample/tour.json'), 'utf8')) as Tour;
const SNAP = TOUR.snapshot;
const TZ = 'America/New_York';

/** '$1,503,380' → 1503380 (whole dollars; the receipt's minus sign is U+2212). */
const dollars = (s: string): number => Number(s.replace(/[^0-9−-]/g, '').replace('−', '-'));

/** The printed triple of a receipt: the "Saved by Cribl…" total line and the "Would have paid $X · Paid $Y" segments. */
function printedTriple(text: string, totalLine: RegExp): { whp: number; paid: number; saved: number } {
  const flat = text.replace(/\n/g, ' ');
  const whp = /Would have paid (\$[\d,]+)/i.exec(flat);
  const paid = /Paid (\$[\d,]+)/.exec(flat);
  const total = text.split('\n').find((l) => totalLine.test(l));
  expect(whp, text).not.toBeNull();
  expect(paid, text).not.toBeNull();
  expect(total, text).toBeDefined();
  const saved = /(\$[\d,]+)\s*$/.exec(total!);
  expect(saved, total).not.toBeNull();
  return { whp: dollars(whp![1]), paid: dollars(paid![1]), saved: dollars(saved![1]) };
}

/** "By reduction $X · by diversion $Y" (either case), when the receipt prints the split. */
function printedSplit(text: string): { reduced: number; diverted: number } | undefined {
  const flat = text.replace(/\n/g, ' ');
  const m = /reduction (\$[\d,]+).*?diversion (\$[\d,]+)/i.exec(flat);
  return m ? { reduced: dollars(m[1]), diverted: dollars(m[2]) } : undefined;
}

describe('W3-RECEIPT-1: the weekly receipt adds up (the video bug)', () => {
  it('prints Would have paid $452,147 · Paid $274,949 under Saved by Cribl, last week $177,198', () => {
    const text = receiptText(TOUR.weeklyReceipt);
    expect(text).toMatch(/Saved by Cribl, last week\s+\$177,198/);
    expect(text.replace(/\n/g, ' ')).toContain('Would have paid $452,147 · Paid $274,949');
    expect(text).not.toContain('$274,948');
    const t = printedTriple(text, /^Saved by Cribl, last week/);
    expect(t.whp - t.paid).toBe(t.saved);
  });

  it('the bell line for the weekly receipt prints the same footed triple (paid $274,949, never $274,948)', () => {
    const { line } = renderAlert({ event: 'receipt.weekly', receipt: TOUR.weeklyReceipt } as Parameters<typeof renderAlert>[0]);
    expect(line).toContain('Saved by Cribl $177,198');
    expect(line).toContain('would have paid $452,147');
    expect(line).toContain('paid $274,949');
    expect(line).not.toContain('$274,948');
    const m = /Saved by Cribl (\$[\d,]+) · would have paid (\$[\d,]+) · paid (\$[\d,]+)/.exec(line);
    expect(m, line).not.toBeNull();
    expect(dollars(m![2]) - dollars(m![3])).toBe(dollars(m![1]));
  });

  it('the split of a receipt with a diversion credit sums to the printed saved', () => {
    // The week's own figures with a third of the saving credited by diversion (a price-dependent credit).
    const week: WeeklyReceipt = { ...TOUR.weeklyReceipt, divertedM: Math.round(TOUR.weeklyReceipt.savedM / 3) + 555_555 };
    const text = receiptText(week);
    const t = printedTriple(text, /^Saved by Cribl, last week/);
    const split = printedSplit(text);
    expect(split, text).toBeDefined();
    expect(split!.reduced + split!.diverted).toBe(t.saved);
    expect(t.whp - t.paid).toBe(t.saved);
  });
});

describe('W3-RECEIPT-1: the period receipts from the tour snapshot add up', () => {
  for (const [period, label, total] of [
    ['today', 'today', /^Saved by Cribl, today/],
    ['30d', 'last 30 days', /^Saved by Cribl, last 30 days/],
    ['mtd', 'month to date', /^Saved by Cribl, month to date/],
  ] as const) {
    it(`${label}: printed would have paid − printed paid = printed saved`, () => {
      const text = receiptTextForPeriod(label, SNAP, { period, tz: TZ });
      const t = printedTriple(text, total);
      expect(t.whp - t.paid, text).toBe(t.saved);
      const split = printedSplit(text);
      if (split) expect(split.reduced + split.diverted, text).toBe(t.saved);
    });
  }

  it('month to date agrees with the Report card: $1,503,380 − $958,406 = $544,974, with the split summing to it', () => {
    const text = receiptTextForPeriod('month to date', SNAP, { period: 'mtd', tz: TZ });
    const t = printedTriple(text, /^Saved by Cribl, month to date/);
    expect(t).toEqual({ whp: 1_503_380, paid: 958_406, saved: 544_974 });
    // The tour's month has a diversion credit, so the split line prints and foots.
    expect(SNAP.headline.divertedMtdM).toBeGreaterThan(0);
    const split = printedSplit(text);
    expect(split, text).toBeDefined();
    expect(split!.reduced + split!.diverted).toBe(544_974);
    const shown = footMoney({ whpM: SNAP.headline.whpMtdM, paidM: SNAP.headline.paidMtdM, savedM: SNAP.headline.mtdM });
    expect(fmtDollars(shown.paidM)).toBe('$958,406');
  });
});

describe('W3-RECEIPT-1: the range and comparison receipts from the tour snapshot add up', () => {
  const s = sampleRollups(SNAP, TZ);
  const now = s.toMs + 35_000;
  const since = fromIso(SNAP.collectingSince);

  async function readRange(fromMs: number, toMs: number): Promise<RangeFigures> {
    const plan = planRangeReads(fromMs, toMs, now);
    const docs: Record<string, RangeDoc | null> = {};
    for (const key of plan.keys) docs[key] = plan.granularity === 'minute' ? await s.readMinute(key) : plan.granularity === 'hour' ? await s.readHour(key) : await s.readDay(key);
    return sumRange(docs, plan.granularity, plan.window.fromMs, plan.window.toMs);
  }

  it('a custom range (the last 7 days) prints a triple that adds up, and its split sums to its saved', async () => {
    const r = resolveRange({ kind: 'relative', hours: 7 * 24 }, now, since);
    const figures = await readRange(r.fromMs, r.toMs);
    expect(figures.savedM).toBeGreaterThan(0);
    const text = receiptTextForRange(figures, { tz: TZ, nowMs: now, destinations: SNAP.destinations });
    const t = printedTriple(text, /^Saved(?: by Cribl)?/);
    expect(t.whp - t.paid, text).toBe(t.saved);
    const split = printedSplit(text);
    if (split) expect(split.reduced + split.diverted, text).toBe(t.saved);
  });

  it('a comparison (the last 24 hours against the 24 before) prints each window’s triple adding up', async () => {
    // Two whole-hour windows of the same length, both fully metered: the comparison sums them (basis 'sum').
    const H = 3_600_000;
    const end = Math.floor(s.toMs / H) * H - H;
    const current = await readRange(end - 24 * H, end);
    const baseline = await readRange(end - 48 * H, end - 24 * H);
    const cmp = compareRanges(current, baseline);
    expect(cmp.basis).toBe('sum');
    const text = receiptTextForComparison(cmp, { tz: TZ, nowMs: now, baselineName: 'Previous period' });
    const lines = text.split('\n');
    for (const [name, f] of [
      ['This range', cmp.current],
      ['Previous period', cmp.baseline],
    ] as const) {
      const i = lines.findIndex((l) => l.startsWith(`${name}: would have paid`));
      expect(i, text).toBeGreaterThanOrEqual(0);
      const whp = dollars(/(\$[\d,]+)/.exec(lines[i])![1]);
      const paid = dollars(/paid (\$[\d,]+)/.exec(lines[i + 1])![1]);
      const savedLine = lines.find((l) => l.toLowerCase().startsWith(`saved by cribl, ${name.toLowerCase()}`));
      expect(savedLine, text).toBeDefined();
      const saved = dollars(/(\$[\d,]+)\s*$/.exec(savedLine!)![1]);
      expect(saved).toBe(dollars(fmtDollars(f.savedM)));
      expect(whp - paid, text).toBe(saved);
    }
  });
});

// Founder-build r2 core-9, BO-9 (AA/extra/fuzz FUZZ.md §4, results/examples.json EX4; fuzz RT2 57,546 of 300,000): the
// item lines of the weekly receipt (the bell, targets, Slack, ServiceNow) and the range "Copy receipt" were each rounded
// on their own, so $109.50 + $2.50 printed "$110" and "$3" above "Saved by Cribl, last week $112". Now the printed lines
// are footed to the printed total (core/format.ts footColumn, D53), with an "Other" line for the savers beyond the five.
describe('r2 core-9 · BO-9: the item lines add up to the total they are printed above', () => {
  const PAY = 'default|pay|r_pay|mrd_pay_sample|siem';
  const WIN = 'default|win|r_win|win_xml_pack|siem';
  const week = { periodStartMs: Date.UTC(2026, 8, 21, 4), periodEndMs: Date.UTC(2026, 8, 28, 4), tz: 'America/New_York' };
  /** The dollar amounts of the item lines (the dot-leader lines) and of the total line. */
  // R2 core-10 (IC-4): '< $1' is a non-zero amount under half a dollar; it counts as $0 in whole-dollar sums.
  const amount = (s: string): number => (/< \$1\s*$/.test(s) ? 0 : dollars(/(\$[\d,]+)[^$]*$/.exec(s)![1]));
  function printed(text: string, totalLine: RegExp): { items: number[]; total: number } {
    const lines = text.split('\n');
    const items = lines.filter((l) => / \.{2,} *\S*\$[\d,]+/.test(l)).map(amount);
    const total = lines.find((l) => totalLine.test(l))!;
    return { items, total: amount(total) };
  }

  it('EX4: $109.50 + $2.50 print $110 + $2 under $112', async () => {
    const { buildWeeklyReceipt } = await import('../../core/receipt.ts');
    const r = buildWeeklyReceipt({ ...week, flowSums: { [PAY]: { whpM: 10_950_000, paidM: 0, savedM: 10_950_000 }, [WIN]: { whpM: 250_000, paidM: 0, savedM: 250_000 } } });
    const text = receiptText(r);
    expect(text).toMatch(/Payments API sampling \.+ +\$110$/m);
    expect(text).toMatch(/Windows XML pack \.+ +\$2$/m);
    expect(text).toMatch(/Saved by Cribl, last week +\$112$/m);
    const p = printed(text, /^Saved by Cribl, last week/);
    expect(p.items.reduce((a, b) => a + b, 0)).toBe(p.total);
    // The receipt's data is unchanged (the JSON a webhook receives keeps the exact amounts).
    expect(r.lines.map((l) => l.savedM)).toEqual([10_950_000, 250_000]);
  });

  it('more than five savers: an "Other" line carries the rest, and every line adds up (property)', async () => {
    const { buildWeeklyReceipt } = await import('../../core/receipt.ts');
    const fc = await import('fast-check');
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 5_000_000_000 }), { minLength: 1, maxLength: 12 }), (amounts) => {
        const flowSums = Object.fromEntries(amounts.map((m, i) => [`default|in${i}|r${i}|p${i}|siem`, { whpM: m * 2, paidM: m, savedM: m }]));
        const r = buildWeeklyReceipt({ ...week, flowSums });
        const text = receiptText(r);
        const p = printed(text, /^Saved by Cribl, last week/);
        expect(p.total).toBe(amount(fmtDollars(amounts.reduce((a, b) => a + b, 0))));
        expect(p.items.reduce((a, b) => a + b, 0)).toBe(p.total);
        const other = text.split('\n').filter((l) => /^Other \.+/.test(l));
        expect(other).toHaveLength(amounts.length > 5 && amount(fmtDollars(amounts.slice().sort((a, b) => b - a).slice(5).reduce((a, b) => a + b, 0))) > 0 ? 1 : 0);
        // IC-4: a line that saved something never reads "$0".
        for (const l of text.split('\n').filter((x) => / \.{2,}/.test(x))) expect(l).not.toMatch(/ \$0$/);
      }),
      { numRuns: 400, seed: 20260928 },
    );
  });

  it('the range "Copy receipt" foots its lines too', async () => {
    const { receiptTextForRange } = await import('../../core/receipt.ts');
    const byFlow = { [PAY]: { whpM: 21_900_000, paidM: 10_950_000, savedM: 10_950_000 }, [WIN]: { whpM: 500_000, paidM: 250_000, savedM: 250_000 } };
    const figures: RangeFigures = {
      fromMs: week.periodStartMs,
      toMs: week.periodEndMs,
      granularity: 'hour',
      savedM: 11_200_000,
      whpM: 22_400_000,
      paidM: 11_200_000,
      ratio: 0.5,
      rows: 2,
      minutesMetered: 10_080,
      expectedMinutes: 10_080,
      byFlow,
      byOutput: { 'default:siem': { whpM: 22_400_000, paidM: 11_200_000, savedM: 11_200_000 } },
      docsRead: 1,
      docsMissing: 0,
    } as RangeFigures;
    const text = receiptTextForRange(figures, { tz: 'UTC', nowMs: week.periodEndMs });
    const p = printed(text, /^Saved by Cribl/);
    expect(p.total).toBe(112);
    expect(p.items).toEqual([110, 2]);
  });
});
