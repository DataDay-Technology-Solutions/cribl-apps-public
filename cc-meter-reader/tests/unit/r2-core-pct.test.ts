// tests/unit/r2-core-pct.test.ts — founder-build r2 core-9: BO-11 (one change prints one percentage) and BO-10's
// regression test (AA/extra/fuzz results/examples.json EX5, EX6; fuzz F15/F15b, RT4).
//
// BO-11: the weekly receipt's trend and the Receipt's week card rounded a signed change with Math.round (−0.5 → "0%",
// +0.5 → "+1%", −87.5 → "−87%") while the comparison printed it through fmtPct, half up on the magnitude ("−1%",
// "−88%"). Now trendPct and changePct round half up on the magnitude too (their number type is unchanged).
// BO-10 (fixed in r1 ui-8): the comparison's Change is printed current − printed baseline (EX5: +$2,346).

import { describe, expect, it } from "vitest";
import {
  buildWeeklyReceipt,
  receiptText,
  receiptTextForComparison,
} from "../../core/receipt.ts";
import { compareRanges, type RangeFigures } from "../../core/range.ts";
import { changePct } from "../../core/goal.ts";
import { makeFlowKey } from "../../core/flows.ts";

const KEY = makeFlowKey("default", "pay", "r_pay", "mrd_pay_sample", "siem");
const WEEK = Date.UTC(2026, 8, 21, 4);
const DAY = 86_400_000;
const rf = (saved: number, fromMs: number): RangeFigures =>
  ({
    fromMs,
    toMs: fromMs + 7 * DAY,
    granularity: "hour",
    savedM: saved,
    whpM: saved * 2,
    paidM: saved,
    ratio: 0.5,
    rows: 1,
    minutesMetered: 10_080,
    expectedMinutes: 10_080,
    byFlow: { [KEY]: { whpM: saved * 2, paidM: saved, savedM: saved } },
    byOutput: {
      "default:siem": { whpM: saved * 2, paidM: saved, savedM: saved },
    },
    docsRead: 1,
    docsMissing: 0,
  }) as RangeFigures;

/** The three surfaces' percentages for one week-over-week change. */
function surfaces(cur: number, prior: number) {
  const r = buildWeeklyReceipt({
    periodStartMs: WEEK,
    periodEndMs: WEEK + 7 * DAY,
    tz: "UTC",
    flowSums: { [KEY]: { whpM: cur * 2, paidM: cur, savedM: cur } },
    priorSavedM: prior,
  });
  const weekly = /vs\. prior week: (\S+)%/.exec(receiptText(r))![1];
  const pct = changePct(cur, prior)!;
  const card = `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct)}`; // src/views/Receipt/Sections.tsx:342
  const cmp = compareRanges(rf(cur, WEEK), rf(prior, WEEK - 7 * DAY));
  const change = receiptTextForComparison(cmp, {
    tz: "UTC",
    nowMs: WEEK + 7 * DAY,
    baselineName: "Previous period",
  })
    .split("\n")
    .find((l) => l.startsWith("Change"))!;
  const comparison = /\(([^)]+)%\)/.exec(change)![1];
  return { weekly, card, comparison, trendPct: r.trendPct, pct };
}

describe("r2 core-9 · BO-11: one change, one percentage on every surface", () => {
  it.each([
    ["−0.5 % (EX6: $199,000 vs $200,000)", 199_000 * 1e5, 200_000 * 1e5, "−1"],
    ["+0.5 %", 201_000 * 1e5, 200_000 * 1e5, "+1"],
    ["−87.5 % (1 vs 8)", 1e5, 8e5, "−88"],
    ["+87.5 %", 15e5, 8e5, "+88"],
    ["+4 %", 104e5, 100e5, "+4"],
    ["0 %", 100e5, 100e5, ""],
  ])(
    "%s: the weekly receipt, the week card and the comparison print the same",
    (_name, cur, prior, want) => {
      const s = surfaces(cur, prior);
      expect(s.weekly).toBe(want === "" ? "0" : want);
      expect(s.card).toBe(want === "" ? "0" : want);
      expect(s.comparison === "0" ? "0" : s.comparison).toBe(
        want === "" ? "0" : want,
      );
      expect(s.trendPct).toBe(s.pct);
      expect(Object.is(s.pct, -0)).toBe(false);
    },
  );

  it("changePct keeps its type: a number, undefined without a base", () => {
    expect(changePct(116, 100)).toBe(16);
    expect(changePct(5, 0)).toBeUndefined();
    expect(changePct(Number.NaN, 10)).toBeUndefined();
    expect(changePct(99.5, 100)).toBe(-1);
    expect(changePct(100.5, 100)).toBe(1);
  });
});

describe("r2 core-9 · BO-10 (fixed in r1): the comparison’s Change is printed current − printed baseline", () => {
  it("EX5: $12,345.60 vs $10,000.40 prints Change +$2,346", () => {
    const cmp = compareRanges(
      rf(1_234_560_000, WEEK),
      rf(1_000_040_000, WEEK - 7 * DAY),
    );
    const text = receiptTextForComparison(cmp, {
      tz: "UTC",
      nowMs: WEEK + 7 * DAY,
      baselineName: "Previous period",
    });
    expect(text).toMatch(/Saved by Cribl, this range +\$12,346$/m);
    expect(text).toMatch(/Saved by Cribl, previous period +\$10,000$/m);
    expect(text).toMatch(/^Change +\+\$2,346 \(\+23%\)$/m);
  });
});
