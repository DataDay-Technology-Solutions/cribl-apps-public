// tests/unit/r2-core-range-retention.test.ts — founder-build r2 core-11 (b), r1's H8 carry: on a large estate the sweep keeps
// minute documents for fewer than 25 hours (meta.minuteRetentionHours, r1 core-7 / M11: 6 h at 2,000 flows), but a custom
// range planned the minute family for anything inside the last 24 h, so a range reaching past the retention read expired
// minute documents (holes) instead of the hour rollups that hold those hours. Now the minute family is planned only within
// the retention (less the hour that may be expiring); beyond it the hour family (or a hybrid) is read.

import { describe, expect, it } from "vitest";
import {
  MINUTE_REACH_MS,
  granularityFor,
  minuteReachMs,
  planComparison,
  planRangeReads,
} from "../../core/range.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 28, 15, 0, 20);
const anchor = Math.floor(NOW / 60_000) * 60_000;
const folded = Math.floor(NOW / 60_000) * 60_000 - 60_000;

describe("r2 core-11 (b) · the minute family only within the minute retention", () => {
  it("the reach: 24 h at the default 25 h retention; (retention − 1) h under it", () => {
    expect(minuteReachMs(undefined)).toBe(MINUTE_REACH_MS);
    expect(minuteReachMs(25)).toBe(24 * HOUR);
    expect(minuteReachMs(6)).toBe(5 * HOUR);
    expect(minuteReachMs(1)).toBe(HOUR); // never under an hour
    expect(minuteReachMs(Number.NaN)).toBe(MINUTE_REACH_MS);
  });

  it("a 10-hour range with 6 h of minute documents is read from the hour rollups, never from expired minute documents", () => {
    const from = anchor - 10 * HOUR;
    const plan = planRangeReads(from, anchor, NOW, folded, {
      minuteRetentionHours: 6,
    });
    expect(plan.granularity).toBe("hour");
    for (const k of plan.keys) {
      const m = /^roll\/min\/(\d{4}-\d{2}-\d{2}T\d{2})$/.exec(k);
      if (m)
        expect(Date.parse(`${m[1]}:00:00Z`)).toBeGreaterThanOrEqual(
          anchor - 6 * HOUR,
        );
    }
    expect(granularityFor(from, NOW, 6)).toBe("hour");
  });

  it("the same range with the default retention still reads minute-exact (unchanged)", () => {
    const from = anchor - 10 * HOUR;
    expect(planRangeReads(from, anchor, NOW, folded).granularity).toBe(
      "minute",
    );
    expect(
      planRangeReads(from, anchor, NOW, folded, { minuteRetentionHours: 25 })
        .granularity,
    ).toBe("minute");
    expect(granularityFor(from, NOW)).toBe("minute");
  });

  it("a range inside the retention stays minute-exact", () => {
    const from = anchor - 4 * HOUR - 17 * 60_000;
    const plan = planRangeReads(from, anchor, NOW, folded, {
      minuteRetentionHours: 6,
    });
    expect(plan.granularity).toBe("minute");
    expect(plan.window.fromMs).toBe(from);
  });

  it("a comparison plans each window with the same rule", () => {
    const spec = {
      kind: "absolute" as const,
      fromMs: anchor - 8 * HOUR,
      toMs: anchor,
    };
    const short = planComparison(
      spec,
      { kind: "prev" },
      {
        nowMs: NOW,
        foldedThroughMs: folded,
        collectingSinceMs: NOW - 10 * 86_400_000,
        minuteRetentionHours: 6,
      },
    );
    const long = planComparison(
      spec,
      { kind: "prev" },
      {
        nowMs: NOW,
        foldedThroughMs: folded,
        collectingSinceMs: NOW - 10 * 86_400_000,
      },
    );
    expect(short.ok && long.ok).toBe(true);
    if (short.ok && long.ok) {
      // With the default retention the current window reads minute-exact; with 6 h it aligns to whole hours.
      expect(long.alignedTo).toBe("minute");
      expect(short.alignedTo).toBe("hour");
    }
  });
});
