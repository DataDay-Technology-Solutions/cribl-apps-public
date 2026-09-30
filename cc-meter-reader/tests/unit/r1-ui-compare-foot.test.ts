// r1 ui-8 (FINDINGS_R1 m11, #23): a comparison's Change is the difference of the two figures as printed:
// "$169,136 → $183,131 · +$13,995", never "+$13,994" (the change was formatted from the exact delta).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fmtDollars } from '../../core/format.ts';
import { compareRanges, printedDeltaM, type RangeFigures } from '../../core/range.ts';
import { deltaText, fromToText } from '../../src/views/Receipt/compareText.ts';
import { receiptTextForComparison } from '../../core/receipt.ts';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-09-20T05:00:00Z');

function figures(savedM: number, fromMs: number): RangeFigures {
  return {
    fromMs,
    toMs: fromMs + 7 * 24 * HOUR,
    savedM,
    whpM: savedM * 2,
    paidM: savedM,
    ratio: 0.5,
    rows: 168,
    flows: 1,
    granularity: 'hour',
    minutesMetered: 7 * 1440,
    expectedMinutes: 7 * 1440,
    docsRead: 8,
    docsMissing: 0,
    byFlow: { 'default|in|r|p|out': { whpM: savedM * 2, paidM: savedM, savedM } },
  } as unknown as RangeFigures;
}

// r2 core-10 (IC-4): '< $1' is a non-zero amount under half a dollar, $0 in whole-dollar arithmetic.
const n = (text: string): number => (text.includes('<') ? 0 : Number(text.replace(/[^0-9]/g, '')) * (/[−-]\$/.test(text) ? -1 : 1));

describe('m11: the change foots with the two figures as printed', () => {
  it('the reported shape: a baseline that rounds up and a current that rounds down print a change that foots', () => {
    // baseline $169,135.50 prints $169,136; current $183,130.49 prints $183,130; the exact change $13,994.99 printed
    // +$13,995 beside them (a dollar off); the printed change is $183,130 − $169,136 = +$13,994.
    const cmp = compareRanges(figures(18_313_049_000, T0), figures(16_913_550_000, T0 - 7 * 24 * HOUR));
    expect(fmtDollars(cmp.currentM)).toBe('$183,130');
    expect(fmtDollars(cmp.baselineM)).toBe('$169,136');
    expect(printedDeltaM(cmp)).toBe(13_994 * 100_000);
    expect(deltaText(cmp)).toMatch(/^\+\$13,994/);
    expect(fromToText(cmp)).toBe('$169,136 → $183,130');
  });

  it('random windows: to − from as printed = the printed change, on the hero and in Copy receipt', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50_000_000_000_000 }), fc.integer({ min: 1, max: 50_000_000_000_000 }), (cur, base) => {
        const cmp = compareRanges(figures(cur, T0), figures(base, T0 - 7 * 24 * HOUR));
        const change = n(deltaText(cmp).split(' ')[0]);
        const [from, to] = fromToText(cmp).split(' → ').map(n);
        if (cmp.direction !== 'flat') expect(to - from).toBe(change);
        const text = receiptTextForComparison(cmp, { tz: 'UTC', nowMs: T0 + 8 * 24 * HOUR, labels: {}, openIncidents: [], baselineName: 'Previous 7 days', currentName: 'This range' });
        const line = text.split('\n').find((l) => l.startsWith('Change'));
        if (line) expect(n(line.replace(/\(.*\)/, ''))).toBe(n(fmtDollars(printedDeltaM(cmp))) );
      }),
      { numRuns: 500 },
    );
  });
});
