// tests/unit/r2-core-report-net.test.ts — founder-build r2 core-7, FINDINGS_R2 #8 (contract C4; probe
// AA/r2/2/zz-r2m-net-report.test.ts, evidence net-report.txt).
//
// The Receipt prints Net after Cribl as the saved figure as printed minus the cost as printed (r1 ui-8, m9; D53's
// footing rule) and the Report card printed the exact net, so 414 of 1,012 Cribl costs read $1 apart (tour MTD $537,069
// on the Receipt, $537,068 on the Report; live run rate $680,247 vs $680,248). Now the Report prints
// round(saved) − round(cost) in whole dollars too: the same arithmetic, no cross-lane import in core.

import { describe, expect, it } from "vitest";
import { buildReportCard, type ReportInput } from "../../core/report.ts";
import { fmtDollars, roundToDollarsM } from "../../core/format.ts";
import { netFigures, printedNetM } from "../../src/views/Receipt/model.ts";
import { receiptNetLine } from "../../src/views/Receipt/text.ts";
import {
  liveInput,
  LIVE_TZ,
  sampleInput,
  TOUR,
  TOUR_TZ,
} from "./report-fixture.ts";

describe("r2 core-7 · #8: Net after Cribl prints the same on the Receipt and the Report card", () => {
  it("0 of 1,012 Cribl costs disagree (month to date and the run rate, live and tour)", () => {
    const rows: string[] = [];
    let diff = 0;
    let total = 0;
    for (let cents = 1_000_000; cents <= 5_000_000; cents += 7_919) {
      for (const [name, input, tz] of [
        [
          "live",
          liveInput({ kind: "mtd" }, { criblCostCentsPerMonth: cents }),
          LIVE_TZ,
        ],
        [
          "tour",
          sampleInput(
            { kind: "mtd" },
            { settings: { ...TOUR.settings, criblCostCentsPerMonth: cents } },
          ),
          TOUR_TZ,
        ],
      ] as const) {
        const card = buildReportCard(input as ReportInput);
        // The Receipt freezes the sample's span (r2 ui-12: `{ frozen: source === 'sample' }`); the Report follows it (r3 core-6).
        const n = netFigures(input.snapshot, "mtd", cents, tz, { frozen: name === "tour" });
        if (!n || !card.cribl?.period) continue;
        total++;
        const receipt = fmtDollars(receiptNetLine(n, undefined, false)!.netM);
        const report = fmtDollars(card.cribl.period.netM);
        const a = netFigures(input.snapshot, "annualized", cents, tz);
        const receiptY = a ? fmtDollars(printedNetM(a.netM, a.costM)) : "";
        const reportY = fmtDollars(card.cribl.runRate.netM);
        if (receipt !== report || receiptY !== reportY) {
          diff++;
          if (rows.length < 8)
            rows.push(
              `${name} ${cents}c: MTD ${receipt} vs ${report} | run rate ${receiptY} vs ${reportY}`,
            );
        }
      }
    }
    expect(total).toBe(1_012);
    expect(rows).toEqual([]);
    expect(diff).toBe(0);
  });

  it("the printed net is whole dollars and equals printed saved − printed cost", () => {
    const card = buildReportCard(
      liveInput({ kind: "mtd" }, { criblCostCentsPerMonth: 1_023_757 }),
    );
    const p = card.cribl!.period!;
    expect(p.netM % 100_000).toBe(0);
    expect(card.cribl!.runRate.netM % 100_000).toBe(0);
    expect(card.cribl!.runRate.monthlyNetM % 100_000).toBe(0);
    expect(p.netM).toBe(
      roundToDollarsM(card.headline.savedM) - roundToDollarsM(p.costM),
    );
  });
});
