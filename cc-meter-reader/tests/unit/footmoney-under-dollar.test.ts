// tests/unit/footmoney-under-dollar.test.ts — final 1.1.4, hunt r3 #7 (major). The synthesis dropped it because the second
// skeptic checked dev, which lacks round1; both skeptics reproduced it on round1 5cab036.
//
// Show the math's formula line, the receipt bar, the Ledger and every other footMoney figure printed "$2 − $1 = $2"
// and "$100 − $1 = $100": r3 core-7 gave a spend its exact amount back when would have paid and saved print the same
// dollar, and fmtDollars prints $0.50–$0.99 as "$1" (54,636 of 1,279,421 small-money triples did not add up).
// That spend now prints '< $1': "$2 − < $1 = $2". Probe: ops/app-assurance/r4/2 zz-r4m-footmoney-gap.test.ts.

import { describe, expect, it } from "vitest";
import { fmtDollars, footColumn, footMoney, shownUnderOneDollar } from "../../core/format.ts";

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

describe("footMoney (hunt r3 #7): the printed triple adds up unless an operand reads '< $1'", () => {
  it("the finding's cases read '< $1' paid, not '$1'", () => {
    expect(printed(footMoney({ whpM: 230_000, paidM: 70_000, savedM: 160_000 }))).toEqual(["$2", "< $1", "$2"]);
    expect(printed(footMoney({ whpM: 10_030_000, paidM: 70_000, savedM: 9_960_000 }))).toEqual(["$100", "< $1", "$100"]);
    expect(printed(footMoney({ whpM: 100_000, paidM: 50_000, savedM: 50_000 }))).toEqual(["$1", "< $1", "$1"]);
    expect(printed(footMoney({ whpM: 224_909, paidM: 67_489, savedM: 157_420 }))).toEqual(["$2", "< $1", "$2"]);
  });

  it("controls: triples that foot to the dollar are unchanged; zero stays $0; cents are unchanged", () => {
    expect(footMoney({ whpM: 180_000, paidM: 54_000, savedM: 126_000 })).toEqual({ whpM: 200_000, paidM: 100_000, savedM: 100_000 });
    expect(footMoney({ whpM: 300_000, paidM: 90_000, savedM: 210_000 })).toEqual({ whpM: 300_000, paidM: 100_000, savedM: 200_000 });
    expect(footMoney({ whpM: 200_000, paidM: 0, savedM: 200_000 }).paidM).toBe(0);
    // A spend under half a dollar keeps its exact amount, as before.
    expect(footMoney({ whpM: 140_000, paidM: 40_000, savedM: 100_000 }).paidM).toBe(40_000);
    expect(footMoney({ whpM: 230_000, paidM: 70_000, savedM: 160_000 }, "cents")).toEqual({ whpM: 230_000, paidM: 70_000, savedM: 160_000 });
  });

  it("the probe's sweep: no printed triple fails to add up without a '< $1' operand, and real spend never prints $0", () => {
    const bad: string[] = [];
    let checked = 0;
    // paid $0.01–$2.99 in 1-cent steps, saved $0.50–$300 in 7-cent steps: the small-money band.
    for (let paid = 1_000; paid < 300_000; paid += 1_000)
      for (let saved = 50_000; saved < 30_000_000; saved += 7_000) {
        checked++;
        const f = footMoney({ whpM: paid + saved, paidM: paid, savedM: saved });
        if (!readsRight(f) || fmtDollars(f.paidM) === "$0") bad.push(`${paid + saved}/${paid}/${saved} → ${printed(f).join(" | ")}`);
      }
    expect(checked).toBe(1_279_421);
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("shownUnderOneDollar: prints '< $1' for every real amount under a dollar; passes a dollar and more through", () => {
    for (const mc of [1, 30_000, 49_999, 50_000, 70_000, 99_999]) expect(fmtDollars(shownUnderOneDollar(mc))).toBe("< $1");
    expect(shownUnderOneDollar(30_000)).toBe(30_000);
    expect(shownUnderOneDollar(0)).toBe(0);
    expect(shownUnderOneDollar(100_000)).toBe(100_000);
    expect(shownUnderOneDollar(-70_000)).toBe(-49_999);
  });

  it("footColumn under a '< $1' total (the Prices card's Paid): a line under a dollar prints '< $1', never '$1'", () => {
    const shown = footMoney({ whpM: 230_000, paidM: 70_000, savedM: 160_000 });
    expect(footColumn([70_000], shown.paidM).map(fmtDollars)).toEqual(["< $1"]);
    expect(footColumn([40_000, 30_000], shown.paidM).map(fmtDollars)).toEqual(["< $1", "< $1"]);
    // Under a total of a dollar and more, lines under a dollar keep their exact amounts as before (r3 core-7).
    expect(footColumn([52_000, 9_000], 61_000)).toEqual([52_000, 9_000]);
    expect(footColumn([60_000, 60_000], 120_000)).toEqual([60_000, 60_000]);
  });
});
