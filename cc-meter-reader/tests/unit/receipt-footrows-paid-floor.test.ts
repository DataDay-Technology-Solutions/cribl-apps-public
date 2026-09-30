// tests/unit/receipt-footrows-paid-floor.test.ts — final 1.1.4, FINDINGS_R4 #1 (major).
//
// Show the math's month-to-date destination rows and each destination's statement (footedMtdRows → footRows) printed
// "Paid $0" beside real spend: $2.25 − $0.67 = $1.57 read "$2 − $0 = $2", while the formula line above read "$2 − $1 = $2"
// and the sentence under the rows read "$2 would have paid − $1 paid = $2 saved". Now the row, the formula line
// (footMoney, hunt r3 #7) and the sentence all print the spend as '< $1': "$2 − < $1 = $2".
// Probe: ops/app-assurance/r4/2 zz-r4m-footrows-paid0.test.ts.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { fmtDollars, footMoney, MC_PER_DOLLAR, roundToDollarsM } from "../../core/format.ts";
import { footedMonth, footedMtdRows, footRows } from "../../src/views/Receipt/model.ts";

type Triple = { whpM: number; paidM: number; savedM: number };
const printed = (t: Triple): string[] => [t.whpM, t.paidM, t.savedM].map(fmtDollars);
const dollars = (s: string): number => Number(s.replace(/[$,]/g, ""));
/** Printed "would have paid − paid = saved" adds up, or an operand reads '< $1' (the unfooted form). */
function readsRight(t: Triple): boolean {
  const p = printed(t);
  if (p.includes("< $1")) return true;
  const [w, pd, s] = p.map(dollars);
  return w - pd === s;
}

describe("footRows (FINDINGS_R4 #1): a row with real spend never prints 'Paid $0'", () => {
  const one = (w: number, p: number, s: number) => {
    const exact = { whpM: w, paidM: p, savedM: s };
    const rows = footedMtdRows([{ key: "default:a", mtdWhpM: w, mtdPaidM: p, mtdSavedM: s }], { ...exact, matches: true });
    return { exact, row: rows.get("default:a")!, line: footMoney(exact) };
  };

  it("(a) the r4 single-row case: the row, the formula line and the statement all read '$2 − < $1 = $2'", () => {
    const { exact, row, line } = one(224_909, 67_489, 157_420);
    expect(printed(row)).toEqual(["$2", "< $1", "$2"]);
    expect(printed(line)).toEqual(printed(row));
    const statement = footedMonth(exact, exact, row)!;
    expect(printed(statement)).toEqual(["$2", "< $1", "$2"]);
  });

  it("(b) $100.30 − $0.70 = $99.60 reads '$100 − < $1 = $100' in the row and the formula line", () => {
    const { row, line } = one(10_030_000, 70_000, 9_960_000);
    expect(printed(row)).toEqual(["$100", "< $1", "$100"]);
    expect(printed(line)).toEqual(printed(row));
  });

  it("a spend of a dollar or more whose row foots to the same dollar takes a dollar of saved to the row with room", () => {
    // Row b: $8.52 − $1.08 = $7.44. The columns foot b's would have paid down to $8 and its saved up to $8, which read
    // "$8 − $0 = $8"; a dollar of b's saved moves to row a, which has $4 of paid to spare.
    const rows = [
      { whpM: 571_000, paidM: 340_000, savedM: 231_000 },
      { whpM: 852_000, paidM: 108_000, savedM: 744_000 },
    ];
    const total = rows.reduce((t, r) => ({ whpM: t.whpM + r.whpM, paidM: t.paidM + r.paidM, savedM: t.savedM + r.savedM }), { whpM: 0, paidM: 0, savedM: 0 });
    const out = footRows(rows, total);
    expect(out.map(printed)).toEqual([
      ["$6", "$3", "$3"],
      ["$8", "$1", "$7"],
    ]);
    for (const r of out) expect(readsRight(r)).toBe(true);
    expect(out.reduce((s, r) => s + r.savedM, 0)).toBe(roundToDollarsM(total.savedM));
    expect(out.reduce((s, r) => s + r.whpM, 0)).toBe(roundToDollarsM(total.whpM));
  });

  it("(c) property: every row reads right, no row with real spend prints $0 paid, and the columns add up to their totals", () => {
    const cents = fc.integer({ min: 0, max: 50_000 }).map((c) => c * 1_000); // $0–$500 in cents
    fc.assert(
      fc.property(fc.array(fc.tuple(cents, cents), { minLength: 1, maxLength: 6 }), (pairs) => {
        const rows = pairs.map(([paidM, savedM]) => ({ whpM: paidM + savedM, paidM, savedM }));
        const total = rows.reduce((t, r) => ({ whpM: t.whpM + r.whpM, paidM: t.paidM + r.paidM, savedM: t.savedM + r.savedM }), { whpM: 0, paidM: 0, savedM: 0 });
        const out = footRows(rows, total);
        for (const [i, r] of out.entries()) {
          if (rows[i].paidM > 0) expect(fmtDollars(r.paidM)).not.toBe("$0");
          expect(readsRight(r)).toBe(true);
          expect(r.paidM).toBeGreaterThanOrEqual(0);
          expect(r.savedM).toBeLessThanOrEqual(r.whpM);
        }
        // Lines of a dollar and more foot to the printed totals (a line under a dollar keeps its own amount, r3 core-7).
        if (rows.every((r) => r.whpM >= MC_PER_DOLLAR)) expect(out.reduce((s, r) => s + r.whpM, 0)).toBe(roundToDollarsM(total.whpM));
        if (rows.every((r) => r.savedM >= MC_PER_DOLLAR)) {
          const sum = out.reduce((s, r) => s + r.savedM, 0);
          // Only when no row had room for a dollar does it come off the column (then by whole dollars).
          expect(Math.abs(sum - roundToDollarsM(total.savedM)) % MC_PER_DOLLAR).toBe(0);
          expect(sum).toBeLessThanOrEqual(roundToDollarsM(total.savedM));
        }
      }),
      { numRuns: 3_000 },
    );
  });
});
