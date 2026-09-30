// tests/unit/report-totals-under-dollar.test.ts — final 1.1.4, follows 5a29a5f (hunt r3 #7).
//
// footMoney now prints a spend under a dollar as '< $1' when would have paid and saved print the same dollar, using a
// display figure ($0.49999) for $0.50–$0.99. The Report card's destination totals row sums the rows' printed figures,
// so three rows of $2.30 − $0.70 = $1.60 a day would have totalled paid $1.49997 ("$1") against a real $2.10 ("$2").
// A printed figure under a dollar now adds its exact amount to the totals, which is what it summed before 5a29a5f.

import { describe, expect, it } from "vitest";
import { buildReportCard } from "../../core/report.ts";
import { fmtDollars, MC_PER_DOLLAR } from "../../core/format.ts";
import type { Snapshot } from "../../core/types.ts";
import { sampleInput } from "./report-fixture.ts";

function cardWith(rows: { whpPerDayM: number; paidPerDayM: number; savedPerDayM: number }[]) {
  const input = sampleInput();
  const base = input.snapshot.destinations[0];
  const destinations = rows.map((r, i) => ({ ...base, outputId: `band_${i}`, unpriced: false, ...r }));
  const snapshot: Snapshot = { ...input.snapshot, destinations };
  return buildReportCard({ ...input, snapshot });
}

describe("Report card: the destination totals row counts a '< $1' figure at its exact amount", () => {
  const band = { whpPerDayM: 230_000, paidPerDayM: 70_000, savedPerDayM: 160_000 };

  it("three rows of $2.30 − $0.70 = $1.60: each row reads '$2 − < $1 = $2', the totals' paid reads $2 (exact $2.10)", () => {
    const card = cardWith([band, band, band]);
    const priced = card.destinations.rows.filter((r) => r.outputId.startsWith("band_"));
    expect(priced).toHaveLength(3);
    for (const r of priced) expect([r.shown.whpM, r.shown.paidM, r.shown.savedM].map(fmtDollars)).toEqual(["$2", "< $1", "$2"]);
    expect(fmtDollars(card.destinations.totals.paidM)).toBe("$2");
    expect(card.destinations.totals.paidM).toBe(3 * 70_000);
  });

  it("one such row: the totals row reads as the row does ('$2 − < $1 = $2')", () => {
    const t = cardWith([band]).destinations.totals;
    expect([t.whpM, t.paidM, t.savedM].map(fmtDollars)).toEqual(["$2", "< $1", "$2"]);
  });

  it("control: whole-dollar rows still total the sums of their printed figures", () => {
    const card = cardWith([
      { whpPerDayM: 1_500_000, paidPerDayM: 600_000, savedPerDayM: 900_000 },
      { whpPerDayM: 2_540_000, paidPerDayM: 1_270_000, savedPerDayM: 1_270_000 },
    ]);
    const priced = card.destinations.rows.filter((r) => r.outputId.startsWith("band_"));
    const sum = (k: "whpM" | "paidM" | "savedM") => priced.reduce((s, r) => s + r.shown[k], 0);
    expect(card.destinations.totals).toEqual({ whpM: sum("whpM"), paidM: sum("paidM"), savedM: sum("savedM") });
    expect(sum("paidM") % MC_PER_DOLLAR).toBe(0);
  });
});
