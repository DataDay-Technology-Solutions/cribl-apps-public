// tests/unit/r3-core-tiny-footrows.test.ts — founder-build r3 core-7 (FINDINGS_R3 #10, minor; IC-4 residue; AA/r3/2
// zz-r3m-tiny-footrows.test.ts, tiny-footrows.f8953da.out.txt).
//
// r2 core-10 made every whole-dollar field print a real amount under half a dollar as "< $1", never "$0". Show the
// math's month-to-date destination rows and each destination's statement print through footedMtdRows → footRows →
// core/format.ts footColumn, which had no such guard: on a tiny workspace they read "$1 − $1 = $0" and "$0 − $0 = $0"
// while the sentence under them and the hero read "< $1". footColumn now gives a line the footing left at $0 its
// exact amount back; a line of a dollar and more foots as before.

import { describe, expect, it } from "vitest";
import { fmtDollars, footMoney } from "../../core/format.ts";
import { footedMonth, footedMtdRows, mtdReconciliation } from "../../src/views/Receipt/model.ts";

/** A printed row, and the fields that print "$0" while their exact amount is not zero. */
function zeros(printed: { whpM: number; paidM: number; savedM: number }, exact: { whpM: number; paidM: number; savedM: number }): string[] {
  return (["whpM", "paidM", "savedM"] as const).filter((k) => fmtDollars(printed[k]) === "$0" && exact[k] !== 0);
}

describe("r3 core-7 · #10: Show the math's rows and the destination statement never print $0 beside real money", () => {
  // Two priced destinations at the r2-core-small-money scale (≈ $0.30 a day saved in all).
  const rows = [
    { key: "default:mrd_siem_prod", mtdWhpM: 52_000, mtdPaidM: 26_000, mtdSavedM: 26_000 },
    { key: "default:mrd_analytics", mtdWhpM: 9_000, mtdPaidM: 4_500, mtdSavedM: 4_500 },
  ];
  const heroSaved = 30_500;

  it("the drawer rows and each statement: no field reads $0 (were '$1 − $1 = $0' and '$0 − $0 = $0')", () => {
    const rec = mtdReconciliation(rows as never, heroSaved);
    expect(rec.matches).toBe(true);
    const footed = footedMtdRows(rows, rec);
    const out: string[] = [];
    for (const r of rows) {
      const exact = { whpM: r.mtdWhpM, paidM: r.mtdPaidM, savedM: r.mtdSavedM };
      const drawer = footed.get(r.key)!;
      const statement = footedMonth(exact, exact, drawer)!;
      for (const [where, printed] of [
        ["drawer", drawer],
        ["statement", statement],
      ] as const) {
        const bad = zeros(printed, exact);
        if (bad.length) out.push(`${r.key} ${where}: ${fmtDollars(printed.whpM)} − ${fmtDollars(printed.paidM)} = ${fmtDollars(printed.savedM)} (${bad.join(", ")})`);
      }
      // Saved never prints more than a dollar off its exact amount, and a sub-dollar saving reads "< $1" as the hero does.
      expect(fmtDollars(drawer.savedM)).toBe(fmtDollars(r.mtdSavedM));
    }
    expect(out).toEqual([]);
  });

  it("the rows and the sentence under them agree: the sentence's saved reads as the hero ('< $1')", () => {
    const rec = mtdReconciliation(rows as never, heroSaved);
    const sentence = footMoney({ whpM: rec.whpM, paidM: rec.paidM, savedM: rec.savedM });
    expect(fmtDollars(sentence.savedM)).toBe(fmtDollars(heroSaved));
    expect(fmtDollars(sentence.savedM)).toBe("< $1");
    for (const f of footedMtdRows(rows, rec).values()) expect(fmtDollars(f.savedM)).toBe("< $1");
  });

  it("control: dollar-sized rows foot to the dollar exactly as before ($5,809 − $4,409 = $1,400)", () => {
    const big = [
      { key: "a", mtdWhpM: 580_940_000, mtdPaidM: 440_890_000, mtdSavedM: 140_050_000 },
      { key: "b", mtdWhpM: 120_460_000, mtdPaidM: 60_230_000, mtdSavedM: 60_230_000 },
    ];
    const rec = mtdReconciliation(big as never, 140_050_000 + 60_230_000);
    const footed = footedMtdRows(big, rec);
    let whp = 0;
    let saved = 0;
    for (const f of footed.values()) {
      expect(f.whpM % 100_000).toBe(0);
      expect(f.savedM % 100_000).toBe(0);
      expect(f.whpM - f.paidM).toBe(f.savedM);
      whp += f.whpM;
      saved += f.savedM;
    }
    const total = footMoney({ whpM: rec.whpM, paidM: rec.paidM, savedM: rec.savedM });
    expect([whp, saved]).toEqual([total.whpM, total.savedM]);
  });
});
