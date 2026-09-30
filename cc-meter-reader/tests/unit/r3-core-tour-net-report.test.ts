// tests/unit/r3-core-tour-net-report.test.ts — founder-build r3 core-6 (FINDINGS_R3 #4, major; AA/r3/2
// zz-r3m-tour-net-report.test.ts, tour-net-report.f8953da.out.txt).
//
// On the tour the Receipt's month-to-date Net after Cribl holds still ($391,970, payback 2.735×) while the Report card's
// drifted with the wall clock: $392,889 at 14:00Z, $392,775 at 14:20Z, $389,636 at 23:30Z, $388,380 at 03:10Z, and on
// 10/01 $9,346 against the Receipt's $8,770 ("Every $1 of Cribl saved $3.73" against 3.19×). r2 ui-12 gave the Receipt's
// netFigures a frozen span for the sample (the whole days before today plus today's recorded minutes, D49), while
// core/report.ts still prorated Cribl's cost to the rebased sweepAt, which follows the wall clock. Now a sample report
// ends the span where the recording's savings end — local midnight + headline.minutesToday — as netFigures does. A live
// report is unchanged.

import { describe, expect, it } from "vitest";
import { buildReportCard, type ReportInput } from "../../core/report.ts";
import { fmtDollars } from "../../core/format.ts";
import { meteredSpan, netOfCribl } from "../../core/net.ts";
import { fromIso, localMonthStartMs } from "../../core/time.ts";
import type { Snapshot } from "../../core/types.ts";
import { TOUR_FIXTURE } from "../../src/tour/fixture.ts";
import { planRebase, rebaseHeadline, rebaseValue } from "../../src/tour/rebase.ts";
import { netFigures } from "../../src/views/Receipt/model.ts";
import { receiptNetLine } from "../../src/views/Receipt/text.ts";
import { COPY, liveInput, LIVE_TZ } from "./report-fixture.ts";

const doc = TOUR_FIXTURE;
const zone = doc.timezone || "UTC";
const cost = doc.settings.criblCostCentsPerMonth!;
const anchor = fromIso(doc.anchor ?? doc.generatedAt);

/** The tour's snapshot as the App shows it at `wallMs` (src/tour: rebased to the wall clock). */
function tourSnapshotAt(wallMs: number): Snapshot {
  const plan = planRebase(anchor, wallMs, zone);
  const moved = rebaseValue(doc.snapshot, plan);
  return plan.dayShift === 0 ? moved : rebaseHeadline(moved, zone, cost);
}

function reportAt(snap: Snapshot, wallMs: number) {
  return buildReportCard({
    snapshot: snap,
    prices: doc.prices,
    settings: doc.settings,
    period: { kind: "mtd" },
    nowMs: wallMs,
    tz: zone,
    copy: COPY,
    source: "sample",
    appVersion: "v",
    workspace: "w",
  } as ReportInput);
}

describe("r3 core-6 · #4: on the tour, the Report card's month-to-date net and payback equal the Receipt's", () => {
  expect(cost).toBeGreaterThan(0);
  for (const wall of ["2026-09-28T14:00:00Z", "2026-09-28T14:20:00Z", "2026-09-28T23:30:00Z", "2026-09-29T03:10:00Z", "2026-10-01T15:00:00Z"]) {
    it(`at ${wall}: Net after Cribl, its cost and the payback agree to the dollar`, () => {
      const w = Date.parse(wall);
      const snap = tourSnapshotAt(w);
      const nb = netFigures(snap, "mtd", cost, zone, { frozen: true })!;
      const line = receiptNetLine(nb, undefined, false)!;
      const card = reportAt(snap, w);
      const period = card.cribl!.period!;
      expect(fmtDollars(period.netM)).toBe(fmtDollars(line.netM));
      expect(fmtDollars(period.costM)).toBe(fmtDollars(nb.costM));
      expect(period.paybackX).toBeCloseTo(nb.paybackX!, 9);
      // The ROI tile prints the same net.
      const roi = card.kpis.find((k) => k.label === COPY.kpi.roi)!;
      expect(roi.lines.join(" · ")).toContain(fmtDollars(line.netM));
    });
  }

  it("the Report holds still while the clock moves within the day (the recording's savings do)", () => {
    const nets = ["2026-09-28T14:00:00Z", "2026-09-28T14:20:00Z", "2026-09-28T23:30:00Z"].map((wall) => reportAt(tourSnapshotAt(Date.parse(wall)), Date.parse(wall)).cribl!.period!.netM);
    expect(new Set(nets).size).toBe(1);
  });

  it("live control: a live report still prorates the cost to the sweep (unchanged)", () => {
    const input = liveInput({ kind: "mtd" }, { criblCostCentsPerMonth: 2_345_600 });
    const card = buildReportCard(input);
    const sweepMs = fromIso(input.snapshot.sweepAt);
    const span = meteredSpan(localMonthStartMs(sweepMs, LIVE_TZ), sweepMs, fromIso(input.snapshot.collectingSince));
    const expected = netOfCribl(input.snapshot.headline.mtdM, span.minutes, 2_345_600)!;
    expect(card.cribl!.period!.costM).toBe(expected.costM);
  });
});
