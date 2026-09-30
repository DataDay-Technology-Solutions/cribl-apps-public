// r1 ui-8 (FINDINGS_R1 m9 #19, m10 #20, m12 #24): printed money adds up (D53's footing rule).
//   m9:  Net after Cribl prints as round(saved) − round(cost), so "$597,932 − $220,546 = $377,386", never "$377,387".
//   m10: the month-to-date destination rows foot to the "These rows add up to …" sentence, column by column.
//   m12: a static (annualized) figure is whole dollars rounded half-up everywhere, the presenter's wheels included:
//        813,684,161,149 m¢ reads $8,136,842 (it was floored to $8,136,841 on the wheels and the hero's aside).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fmtDollars, roundToDollarsM } from '../../core/format.ts';
import { printedNetM, footRows } from '../../src/views/Receipt/model.ts';
import { staticFigureM } from '../../src/components/Meter/meterMath.ts';

// r2 core-10 (IC-4): '< $1' is a non-zero amount under half a dollar, $0 in whole-dollar arithmetic.
const dollars = (text: string): number => (text.includes('<') ? 0 : Number(text.replace(/[^0-9]/g, '')) * (text.includes('−') || text.includes('-') ? -1 : 1));

describe('m9: the net foots with the saved and the cost as printed', () => {
  it('the reported case: $597,932 − $220,546 prints $377,386', () => {
    // saved 597,931.60 → $597,932; cost 220,545.52 → $220,546; exact net 377,386.08 → $377,386 (was the case that read 387).
    const savedM = 59_793_160_000;
    const costM = 22_054_552_000;
    expect(fmtDollars(printedNetM(savedM - costM, costM))).toBe('$377,386');
  });

  it('random triples: printed saved − printed cost = printed net, to the dollar', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5_000_000_000_000 }), fc.integer({ min: 1, max: 1_000_000_000_000 }), (savedM, costM) => {
        const net = printedNetM(savedM - costM, costM);
        expect(dollars(fmtDollars(savedM)) - dollars(fmtDollars(costM))).toBe(dollars(fmtDollars(net)));
        expect(net).toBe(roundToDollarsM(savedM) - roundToDollarsM(costM));
      }),
      { numRuns: 2_000 },
    );
  });
});

describe('m10: destination rows foot to their column totals', () => {
  it('every column sums to the sentence, and every row foots (would have paid − paid = saved)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ whp: fc.integer({ min: 0, max: 900_000_000_000 }), keep: fc.double({ min: 0, max: 1, noNaN: true }) }), { minLength: 1, maxLength: 9 }),
        (spec) => {
          const rows = spec.map((r) => {
            const paidM = Math.round(r.whp * r.keep);
            return { whpM: r.whp, paidM, savedM: r.whp - paidM };
          });
          const total = rows.reduce((a, r) => ({ whpM: a.whpM + r.whpM, paidM: a.paidM + r.paidM, savedM: a.savedM + r.savedM }), { whpM: 0, paidM: 0, savedM: 0 });
          const printed = footRows(rows, total);
          const sum = (k: 'whpM' | 'paidM' | 'savedM') => printed.reduce((a, r) => a + r[k], 0);
          // Founder-build r3 core-7 (FINDINGS_R3 #10): a line under a dollar keeps its exact amount (it prints '< $1',
          // or '$1' from $0.50), so only columns of whole-dollar lines foot to the dollar; a row never prints $0 beside it.
          const whole = rows.every((r) => [r.whpM, r.savedM].every((v) => v === 0 || v >= 100_000));
          // Final 1.1.4 (FINDINGS_R4 #1): a row whose would have paid and saved foot to the same dollar prints its real
          // spend '< $1' ("$2 − < $1 = $2", as the formula line above the rows does), never "Paid $0"; such a row is the
          // unfooted form, and the paid column then foots only as printed.
          const underPaid = (r: { paidM: number }): boolean => fmtDollars(r.paidM) === '< $1';
          if (whole) {
            expect(sum('whpM')).toBe(roundToDollarsM(total.whpM));
            expect(sum('savedM')).toBe(roundToDollarsM(total.savedM));
            if (!printed.some(underPaid)) expect(sum('paidM')).toBe(roundToDollarsM(total.whpM) - roundToDollarsM(total.savedM));
          }
          printed.forEach((r, i) => {
            if (rows[i].paidM > 0) expect(fmtDollars(r.paidM)).not.toBe('$0');
            if (underPaid(r) && r.whpM === r.savedM) expect(rows[i].paidM).toBeGreaterThan(0);
            else expect(r.whpM - r.paidM).toBe(r.savedM);
            expect(r.paidM).toBeGreaterThanOrEqual(0);
            for (const k of ['whpM', 'savedM'] as const) if (rows[i][k] > 0 && rows[i][k] < 100_000) expect(r[k]).toBe(rows[i][k]);
          });
        },
      ),
      { numRuns: 1_000 },
    );
  });
});

describe('m12: a static figure is whole dollars, rounded half-up', () => {
  it('813,684,161,149 m¢ shows $8,136,842 (never the floored $8,136,841)', () => {
    expect(staticFigureM(813_684_161_149)).toBe(813_684_200_000);
    expect(fmtDollars(staticFigureM(813_684_161_149))).toBe('$8,136,842');
    expect(staticFigureM(813_684_149_999)).toBe(813_684_100_000);
    expect(staticFigureM(0)).toBe(0);
  });
});
