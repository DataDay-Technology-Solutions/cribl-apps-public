import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MC_PER_CENT,
  MC_PER_DOLLAR,
  centsToMc,
  fmtBytes,
  fmtDollars,
  fmtDollarsCents,
  fmtDollarsCompact,
  fmtDuration,
  fmtDurationShort,
  fmtGbPerDay,
  footColumn,
  footMoney,
  roundToCentsM,
  roundToDollarsM,
  fmtPct,
  fmtPoints,
  fmtRelative,
  mcToCents,
  mcToDollarInput,
  parseDollarsToMc,
  perYear,
} from "../../core/format.ts";

describe("money", () => {
  it("has the unit constants", () => {
    expect(MC_PER_CENT).toBe(1000);
    expect(MC_PER_DOLLAR).toBe(100_000);
  });
  it("formats whole dollars, half up, with separators", () => {
    expect(fmtDollars(0)).toBe("$0");
    expect(fmtDollars(123_400_000)).toBe("$1,234");
    expect(fmtDollars(50_000)).toBe("$1");
    // Founder-build r2 core-10 (IC-4): a non-zero amount that rounds to $0 never reads "$0".
    expect(fmtDollars(49_999)).toBe("< $1");
    expect(fmtDollars(2_500_000)).toBe("$25");
    expect(fmtDollars(912_500_000)).toBe("$9,125");
    expect(fmtDollars(-1_200_000)).toBe("−$12");
    expect(fmtDollars(-10)).toBe("−< $1");
    expect(fmtDollars(123_456_789_000_00)).toBe("$123,456,789");
    expect(fmtDollars(Number.NaN)).toBe("$0");
  });
  it('r2 core-10 · IC-4: real reducing traffic never prints "$0" (0.4 → "< $1", 0 → "$0", 0.5 → "$1", −0.4 → "−< $1")', () => {
    expect(fmtDollars(40_000)).toBe("< $1"); // $0.40
    expect(fmtDollars(1)).toBe("< $1"); // a thousandth of a cent
    expect(fmtDollars(0)).toBe("$0");
    expect(fmtDollars(-0)).toBe("$0");
    expect(fmtDollars(50_000)).toBe("$1"); // $0.50: half up, unchanged
    expect(fmtDollars(-40_000)).toBe("−< $1");
    expect(fmtDollars(-50_000)).toBe("−$1");
    expect(fmtDollars(Number.POSITIVE_INFINITY)).toBe("$0");
    // Everything else is unchanged: cents, and whole dollars from $0.50 up. (Compact follows since r3 core-8, below.)
    expect(fmtDollarsCents(40_000)).toBe("$0.40");
    expect(fmtDollarsCompact(40_000)).toBe("< $1");
    expect(fmtDollars(149_999)).toBe("$1");
  });
  it("formats cents", () => {
    expect(fmtDollarsCents(123_456_000)).toBe("$1,234.56");
    expect(fmtDollarsCents(180_000)).toBe("$1.80");
    expect(fmtDollarsCents(500)).toBe("$0.01");
    expect(fmtDollarsCents(499)).toBe("$0.00");
    expect(fmtDollarsCents(-150_000)).toBe("−$1.50");
    expect(fmtDollarsCents(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });
  it("formats compact amounts", () => {
    expect(fmtDollarsCompact(95_000_000)).toBe("$950");
    expect(fmtDollarsCompact(9_560_000_000)).toBe("$95.6k");
    expect(fmtDollarsCompact(9_500_000_000)).toBe("$95k");
    expect(fmtDollarsCompact(120_000_000_000)).toBe("$1.2M");
    expect(fmtDollarsCompact(99_996_000_000)).toBe("$1M");
    expect(fmtDollarsCompact(99_960_000)).toBe("$1k");
    expect(fmtDollarsCompact(340_000_000_000_000)).toBe("$3.4B");
    expect(fmtDollarsCompact(-9_560_000_000)).toBe("−$95.6k");
    expect(fmtDollarsCompact(Number.NaN)).toBe("$0");
    expect(fmtDollarsCompact(-10)).toBe("−< $1");
  });
  it("converts cents and computes per-year", () => {
    expect(centsToMc(250)).toBe(250_000);
    expect(mcToCents(180_000)).toBe(180);
    expect(perYear(2_500_000)).toBe(912_500_000);
  });
  it("fmtDollars matches integer arithmetic (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1e13 }), (mc) => {
        const expected = Math.floor((mc + 50_000) / 100_000);
        // R2 core-10 (IC-4): a non-zero amount that rounds to $0 prints '< $1'.
        if (expected === 0 && mc > 0) expect(fmtDollars(mc)).toBe("< $1");
        else expect(fmtDollars(mc).replace(/[$,]/g, "")).toBe(String(expected));
      }),
    );
  });
});

describe("r3 core-8 · #18 (H6): the compact formatter never prints $0 for real money", () => {
  it("a non-zero amount that rounds to $0 prints '< $1' ('−< $1' below zero); exact zero stays '$0'", () => {
    for (const mc of [15_000, 30_000, 40_000, 49_000, 1]) {
      expect(fmtDollarsCompact(mc), `${mc} m¢`).not.toBe("$0");
      expect(fmtDollarsCompact(mc)).toBe("< $1");
    }
    expect(fmtDollarsCompact(-49_000)).toBe("−< $1");
    expect(fmtDollarsCompact(0)).toBe("$0");
    expect(fmtDollarsCompact(-0)).toBe("$0");
    // From half a dollar up: unchanged.
    expect(fmtDollarsCompact(50_000)).toBe("$1");
    expect(fmtDollarsCompact(95_000_000)).toBe("$950");
    expect(fmtDollarsCompact(9_560_000_000)).toBe("$95.6k");
  });
  it("prints what fmtDollars prints under a thousand dollars (D82: one rule for both)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -99_949_999, max: 99_949_999 }), (mc) => {
        expect(fmtDollarsCompact(mc)).toBe(fmtDollars(mc));
      }),
    );
  });
});

describe("ratios", () => {
  it("formats percentages and points", () => {
    expect(fmtPct(0.6)).toBe("60%");
    expect(fmtPct(0.605)).toBe("61%");
    expect(fmtPct(0)).toBe("0%");
    expect(fmtPct(-0.04)).toBe("−4%");
    expect(fmtPct(Number.NaN)).toBe("0%");
    expect(fmtPoints(0.25)).toBe("25 points");
    expect(fmtPoints(0.01)).toBe("1 point");
    expect(fmtPoints(-0.25)).toBe("−25 points");
    expect(fmtPoints(Number.NaN)).toBe("0 points");
  });
});

describe("bytes and durations", () => {
  it("formats decimal bytes with one decimal", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(-5)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1_000)).toBe("1.0 KB");
    expect(fmtBytes(12_345_678_901)).toBe("12.3 GB");
    expect(fmtBytes(999_960_000)).toBe("1.0 GB");
    expect(fmtBytes(450e9)).toBe("450.0 GB");
    expect(fmtBytes(1.25e12)).toBe("1.3 TB");
    expect(fmtBytes(5e18)).toBe("5000.0 PB");
    expect(fmtGbPerDay(12e9)).toBe("12.0 GB/day");
  });
  it("formats durations", () => {
    expect(fmtDuration(171)).toBe("2:51");
    expect(fmtDuration(3723)).toBe("1:02:03");
    expect(fmtDuration(0)).toBe("0:00");
    expect(fmtDuration(-4)).toBe("0:00");
    expect(fmtDuration(59.6)).toBe("1:00");
  });
  it("formats relative time", () => {
    expect(fmtRelative(500)).toBe("just now");
    expect(fmtRelative(12_000)).toBe("12 s ago");
    expect(fmtRelative(3 * 60_000 + 5_000)).toBe("3 min ago");
    expect(fmtRelative(5 * 3_600_000)).toBe("5 h ago");
    expect(fmtRelative(3 * 86_400_000)).toBe("3 d ago");
    expect(fmtRelative(Number.NaN)).toBe("just now");
  });
});

describe("parseDollarsToMc", () => {
  it("accepts dollars with up to three decimals", () => {
    expect(parseDollarsToMc("$2.50")).toEqual({ ok: true, value: 250_000 });
    expect(parseDollarsToMc("0.023")).toEqual({ ok: true, value: 2_300 });
    expect(parseDollarsToMc("  $ 1,234.5 ")).toEqual({
      ok: true,
      value: 123_450_000,
    });
    expect(parseDollarsToMc(".5")).toEqual({ ok: true, value: 50_000 });
    expect(parseDollarsToMc("3.")).toEqual({ ok: true, value: 300_000 });
    expect(parseDollarsToMc("0")).toEqual({ ok: true, value: 0 });
  });
  it("rejects negatives, blanks, junk, bad separators and extra decimals", () => {
    for (const bad of [
      "",
      "   ",
      "-1",
      "−1",
      "$-2",
      "-$2",
      "abc",
      "1,23",
      ".",
      "1.2.3",
      "+5",
      "NaN",
      "1e3",
    ]) {
      expect(parseDollarsToMc(bad).ok, bad).toBe(false);
    }
    expect(parseDollarsToMc("0.0231")).toEqual({
      ok: false,
      error: "use at most 3 decimal places",
    });
    expect(parseDollarsToMc("99999999999999999")).toEqual({
      ok: false,
      error: "is too large",
    });
    expect(parseDollarsToMc(undefined as unknown as string).ok).toBe(false);
  });
  it("round-trips through mcToDollarInput (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        (hundredthsOfCent) => {
          const mc = hundredthsOfCent * 100; // 3-decimal dollar granularity
          const r = parseDollarsToMc(mcToDollarInput(mc));
          expect(r).toEqual({ ok: true, value: mc });
        },
      ),
    );
    expect(mcToDollarInput(250_000)).toBe("2.50");
    expect(mcToDollarInput(2_300)).toBe("0.023");
    expect(mcToDollarInput(0)).toBe("0.00");
  });
});

describe("fmtDurationShort (a duration a reader never takes for a clock time)", () => {
  // Each number is joined to its unit by a no-break space: '3 min 19' never wraps away from its 's' (rules round).
  const nb = (s: string): string => s.replace(/(\d) /g, "$1\u00a0");
  it("words, largest two units", () => {
    expect(fmtDurationShort(45)).toBe(nb("45 s"));
    expect(fmtDurationShort(120)).toBe(nb("2 min"));
    expect(fmtDurationShort(95)).toBe(nb("1 min 35 s"));
    expect(fmtDurationShort(3600)).toBe(nb("1 h"));
    expect(fmtDurationShort(3900)).toBe(nb("1 h 5 min"));
    expect(fmtDurationShort(2 * 86_400 + 3 * 3600 + 59)).toBe(nb("2 d 3 h"));
    expect(fmtDurationShort(86_400)).toBe(nb("1 d"));
  });
  it("a number never breaks from its unit; the parts may break between them", () => {
    expect(fmtDurationShort(199)).toBe("3\u00a0min 19\u00a0s");
    expect(fmtDurationShort(199).split(" ")).toEqual([
      "3\u00a0min",
      "19\u00a0s",
    ]);
  });
  it("nothing negative, NaN or fractional leaks through", () => {
    expect(fmtDurationShort(-5)).toBe(nb("0 s"));
    expect(fmtDurationShort(Number.NaN)).toBe(nb("0 s"));
    expect(fmtDurationShort(59.6)).toBe(nb("1 min"));
  });
});

describe("rounding that foots", () => {
  it("roundToDollarsM / roundToCentsM round exactly as the formatters print", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e12, max: 1e12 }), (mc) => {
        // R2 core-10 (IC-4): whole dollars round a sub-dollar amount to $0, which prints '$0'; the exact amount prints
        // '< $1' (footMoney keeps such an amount exact, so a footed figure prints '< $1' too).
        if (mc !== 0 && roundToDollarsM(mc) === 0)
          expect([fmtDollars(roundToDollarsM(mc)), fmtDollars(mc)]).toEqual([
            "$0",
            mc < 0 ? "−< $1" : "< $1",
          ]);
        else expect(fmtDollars(roundToDollarsM(mc))).toBe(fmtDollars(mc));
        expect(fmtDollarsCents(roundToCentsM(mc))).toBe(fmtDollarsCents(mc));
        expect(Math.abs(roundToDollarsM(mc)) % MC_PER_DOLLAR).toBe(0);
        expect(Math.abs(roundToCentsM(mc)) % MC_PER_CENT).toBe(0);
      }),
    );
    expect(roundToDollarsM(Number.NaN)).toBe(0);
    expect(roundToCentsM(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("footMoney: when the exact figures add up, the printed ones do too (paid is the difference)", () => {
    // $1,503,379.87 − $958,406.19 = $544,973.68: rounded separately they print $1,503,380 − $958,406 ≠ $544,974.
    const m = {
      whpM: 150_337_987_000,
      paidM: 95_840_619_000,
      savedM: 54_497_368_000,
    };
    expect(footMoney(m)).toEqual({
      whpM: 150_338_000_000,
      paidM: 95_840_600_000,
      savedM: 54_497_400_000,
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e12 }),
        fc.integer({ min: 0, max: 1e12 }),
        (paid, saved) => {
          const f = footMoney({
            whpM: paid + saved,
            paidM: paid,
            savedM: saved,
          });
          // R3 core-7 (#9): the printed triple foots unless an operand prints "< $1" (then it is the unfooted form: each
          // figure its own rounding), and real spend never prints "$0".
          const printed = [f.whpM, f.paidM, f.savedM].map(fmtDollars);
          if (!printed.includes("< $1")) expect(f.whpM - f.paidM).toBe(f.savedM);
          if (paid > 0) expect(fmtDollars(f.paidM)).not.toBe("$0");
          expect(fmtDollars(f.whpM)).toBe(fmtDollars(paid + saved));
          expect(fmtDollars(f.savedM)).toBe(fmtDollars(saved));
          expect(Math.abs(f.paidM - paid)).toBeLessThanOrEqual(MC_PER_DOLLAR);
          const c = footMoney(
            { whpM: paid + saved, paidM: paid, savedM: saved },
            "cents",
          );
          expect(c.whpM - c.paidM).toBe(c.savedM);
        },
      ),
    );
  });

  it('r2 core-10 · IC-4: footMoney keeps a non-zero figure under half a dollar exact, so it prints "< $1", never "$0"', () => {
    const f = footMoney({ whpM: 77_000, paidM: 47_000, savedM: 30_000 }); // $0.77 − $0.47 = $0.30
    expect(fmtDollars(f.savedM)).toBe("< $1");
    expect(fmtDollars(f.whpM)).toBe("$1");
    // R3 core-7 (#9): an operand under a dollar prints the unfooted form, each figure its own ("$1 − < $1 = < $1"), not
    // a paid footed up to "$1" ($0.70) beside a real $0.47.
    expect(f.paidM).toBe(47_000);
    expect(fmtDollars(f.paidM)).toBe("< $1");
    const tiny = footMoney({ whpM: 40_000, paidM: 20_000, savedM: 20_000 });
    expect([tiny.whpM, tiny.paidM, tiny.savedM].map(fmtDollars)).toEqual([
      "< $1",
      "< $1",
      "< $1",
    ]);
    // Exactly zero stays "$0"; cents mode is unchanged.
    expect(fmtDollars(footMoney({ whpM: 0, paidM: 0, savedM: 0 }).savedM)).toBe(
      "$0",
    );
    expect(
      footMoney({ whpM: 40_000, paidM: 20_000, savedM: 20_000 }, "cents"),
    ).toEqual({ whpM: 40_000, paidM: 20_000, savedM: 20_000 });
  });

  it('r3 core-7 · #9: "You paid $0" never prints beside real spend (footing kept paid at $0 while it was $0.49–$0.70)', () => {
    // [would have paid, paid, saved] in millicents → printed [would have paid, paid, saved].
    const table: [number, number, number, string[]][] = [
      // was "$2 − $0 = $2", then (r3 core-7) "$2 − $1 = $2", which breaks the property above (no "< $1" operand, yet it
      // does not add up); final 1.1.4 (FINDINGS_R4 hunt r3 #7): the $0.70 spend prints "< $1"
      [230_000, 70_000, 160_000, ["$2", "< $1", "$2"]],
      [100_000, 49_000, 51_000, ["$1", "< $1", "$1"]], // was "$1 − $0 = $1"
      [130_000, 90_000, 40_000, ["$1", "$1", "< $1"]], // saved "< $1": unfooted, paid its own $0.90 → "$1"
      [150_000, 60_000, 90_000, ["$2", "$1", "$1"]], // foots, nothing under a dollar: unchanged
      [60_000, 15_000, 45_000, ["$1", "< $1", "< $1"]],
      [40_000, 10_000, 30_000, ["< $1", "< $1", "< $1"]],
      [140_000, 40_000, 100_000, ["$1", "< $1", "$1"]], // was "$1 − $0 = $1"
    ];
    for (const [whpM, paidM, savedM, printed] of table) {
      const f = footMoney({ whpM, paidM, savedM });
      expect([f.whpM, f.paidM, f.savedM].map(fmtDollars), `${whpM}/${paidM}/${savedM}`).toEqual(printed);
      expect(fmtDollars(f.paidM)).not.toBe("$0");
    }
    // Exactly zero paid still prints "$0" (nothing was paid).
    expect(fmtDollars(footMoney({ whpM: 200_000, paidM: 0, savedM: 200_000 }).paidM)).toBe("$0");
    // Cents are unchanged.
    expect(footMoney({ whpM: 230_000, paidM: 70_000, savedM: 160_000 }, "cents")).toEqual({ whpM: 230_000, paidM: 70_000, savedM: 160_000 });
  });

  it("r3 core-7 · #10: footColumn never turns a real line into $0 (\"$1 − $1 = $0\" rows); lines of a dollar and more foot as before", () => {
    // Every line under a dollar keeps its exact amount: tiny destinations print "< $1" (or "$1" from $0.50 up).
    expect(footColumn([26_000, 4_500], 30_500)).toEqual([26_000, 4_500]);
    expect(footColumn([52_000, 9_000], 61_000)).toEqual([52_000, 9_000]);
    expect(footColumn([52_000, 9_000], 61_000).map(fmtDollars)).toEqual(["$1", "< $1"]);
    // Footing would have moved the second $0.60 to $0: it keeps its amount (the unfooted rows, never "$1 + $0").
    expect(footColumn([60_000, 60_000], 120_000)).toEqual([60_000, 60_000]);
    expect(footColumn([60_000, 30_000], 90_000).map(fmtDollars)).toEqual(["$1", "< $1"]);
    // A row derived from two such lines keeps its real amount: $0.90 − $0.63 = $0.27 ("< $1"), never "$1 − $1 = $0".
    const [whp] = footColumn([89_965], 89_965);
    const [saved] = footColumn([62_877], 62_877);
    expect(fmtDollars(whp - saved)).toBe("< $1");
    // Whole-dollar lines foot exactly as before: $110.40 + $2.40 → "$110 + $2" under "$113" becomes "$111 + $2".
    expect(footColumn([11_040_000, 240_000], 11_280_000)).toEqual([11_100_000, 200_000]);
    // Exact zeros stay $0.
    expect(footColumn([0, 150_000], 150_000)).toEqual([0, 200_000]);
  });

  it("footMoney: a real gap (paid for, saving nothing) is not papered over", () => {
    expect(footMoney({ whpM: 0, paidM: 300_000, savedM: 0 })).toEqual({
      whpM: 0,
      paidM: 300_000,
      savedM: 0,
    });
    expect(
      footMoney({ whpM: 1_000_000, paidM: 700_000, savedM: 400_000 }),
    ).toEqual({ whpM: 1_000_000, paidM: 700_000, savedM: 400_000 });
  });
});
