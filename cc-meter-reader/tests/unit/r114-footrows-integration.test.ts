// tests/unit/r114-footrows-integration.test.ts — final 1.1.4 integration: two footRows cases the property tests found
// only at random, which made a fresh clone's `npm test` fail now and then.
//
// 1. receipt-footrows-paid-floor.test.ts (c) found it at random (seed 1944000778, counterexample [[50000, 50000], [0, 0]]),
// and it was already in 1.1.3: footColumn keeps a saved line under a dollar at its exact amount, and an exact $0.50
// prints "$1". Paid, would have paid − $0.50, then rounds half up to would have paid's own dollar, so Show the math's
// row read "$1 − $1 = $1" (and "$4 − $4 = $1" for $3.50 − $3.00 = $0.50). The row now prints the printed difference,
// and a $0 beside real spend prints '< $1', exactly as footMoney prints the same triple on the formula line.

import { describe, expect, it } from 'vitest';
import { fmtDollars, footMoney, roundToDollarsM } from '../../core/format.ts';
import { footRows } from '../../src/views/Receipt/model.ts';

type Triple = { whpM: number; paidM: number; savedM: number };
const printed = (t: Triple): string[] => [t.whpM, t.paidM, t.savedM].map(fmtDollars);

describe('footRows: a saved line of exactly $0.50 (final 1.1.4)', () => {
  it('$1.00 − $0.50 = $0.50 beside an empty row reads "$1 − < $1 = $1", as footMoney prints it', () => {
    const rows = [
      { whpM: 100_000, paidM: 50_000, savedM: 50_000 },
      { whpM: 0, paidM: 0, savedM: 0 },
    ];
    const total = { whpM: 100_000, paidM: 50_000, savedM: 50_000 };
    const out = footRows(rows, total);
    expect(printed(out[0])).toEqual(['$1', '< $1', '$1']);
    expect(printed(out[0])).toEqual(printed(footMoney(rows[0])));
    expect(printed(out[1])).toEqual(['$0', '$0', '$0']);
  });

  it('$3.50 − $3.00 = $0.50 on one row reads "$4 − $3 = $1", as footMoney prints it', () => {
    const row = { whpM: 350_000, paidM: 300_000, savedM: 50_000 };
    const out = footRows([row], row);
    expect(printed(out[0])).toEqual(['$4', '$3', '$1']);
    expect(printed(out[0])).toEqual(printed(footMoney(row)));
    expect(out[0].savedM).toBeLessThanOrEqual(out[0].whpM);
    expect(out[0].paidM).toBeGreaterThanOrEqual(0);
  });

  it('a saved line just above or below $0.50 is unchanged: its row already adds up as printed', () => {
    for (const savedM of [49_999, 50_001, 70_000]) {
      const row = { whpM: 300_000, paidM: 300_000 - savedM, savedM };
      const [out] = footRows([row], row);
      expect(out.paidM, String(savedM)).toBe(out.whpM - out.savedM);
    }
  });
});

// 2. r1-ui-net-foot.test.ts m10 (about 1 run in 50,000; seeds found 52,063 and 62,623 runs in): a row with exactly $1.00
// of spend beside a row with a fraction of a cent. The footing put the rows' only printed paid dollar on the fraction
// ("$1" paid for 0.001 cents), 6bcdc6d then gave the $1.00 row its dollar, and with no donor that dollar came off the
// saved column. The fraction's row now gives its dollar away and prints '< $1' ("$X − < $1 = $X", footMoney's own form).
describe('footRows: a $1.00 spend beside a fraction of a cent (final 1.1.4)', () => {
  const rowsOf = (spec: { whp: number; keep: number }[]) =>
    spec.map((r) => {
      const paidM = Math.round(r.whp * r.keep);
      return { whpM: r.whp, paidM, savedM: r.whp - paidM };
    });
  const cases = [
    [
      { whp: 221_816_794_651, keep: 4.5082023729238473e-7 },
      { whp: 521_366_253_912, keep: 9.590187248375183e-13 },
      { whp: 42_769_553_912, keep: 0 },
    ],
    [
      { whp: 440_259_261_040, keep: 2.271377546125361e-7 },
      { whp: 506_348_033_255, keep: 9.874631027710479e-13 },
      { whp: 474_004_133_255, keep: 0 },
      { whp: 180_708_922_451, keep: 0 },
    ],
  ];
  for (const [n, spec] of cases.entries()) {
    it(`case ${n + 1}: both columns foot, the $1.00 row prints $1 paid and the fraction prints '< $1'`, () => {
      const rows = rowsOf(spec);
      expect(rows.map((r) => r.paidM).slice(0, 2)).toEqual([100_000, 1]);
      const total = rows.reduce((a, r) => ({ whpM: a.whpM + r.whpM, paidM: a.paidM + r.paidM, savedM: a.savedM + r.savedM }), { whpM: 0, paidM: 0, savedM: 0 });
      const out = footRows(rows, total);
      expect(out.reduce((a, r) => a + r.whpM, 0)).toBe(roundToDollarsM(total.whpM));
      expect(out.reduce((a, r) => a + r.savedM, 0)).toBe(roundToDollarsM(total.savedM));
      expect(fmtDollars(out[0].paidM)).toBe('$1');
      expect(out[0].whpM - out[0].paidM).toBe(out[0].savedM);
      // The fraction's row reads footMoney's unfooted form, "$X − < $1 = $X" (its would have paid footed to the column).
      expect(fmtDollars(out[1].paidM)).toBe('< $1');
      expect(out[1].savedM).toBe(out[1].whpM);
      for (const r of out.slice(2)) expect(fmtDollars(r.paidM)).toBe('$0');
    });
  }
});
