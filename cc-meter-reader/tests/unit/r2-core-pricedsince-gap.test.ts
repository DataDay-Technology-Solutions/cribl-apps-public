// tests/unit/r2-core-pricedsince-gap.test.ts — founder-build r2 core-5, FINDINGS_R2 #7 (AA/r2/4 zz-f4-pricedsince-gap.test.ts;
// a prerequisite of ui-2's flip to the annualized landing screen).
//
// r1 core-6 (#42) annualized the run rate over the minutes since the first priced minute, removing the first day's
// minutes before it by wall clock. A metering gap before that minute (a tab closed overnight: the catch-up reached back
// one day) meant those minutes were never metered, so the subtraction removed minutes that were never counted and the
// rate rose 1.77×; in the clamp case (metered 10:00–10:30, traffic from 10:05) the floor of 1 minute made it 25×. Now only
// the first day's metered minutes before `since` leave the basis: the day keeps the minutes from `since` to its end (or
// the cursor), at most what it metered, and never fewer than the minutes that carried traffic.

import { describe, expect, it } from "vitest";
import { computeHeadline } from "../../core/pricing.ts";
import type { TotalsDoc } from "../../core/types.ts";

const MIN = 60_000;
const SAVED = 100_000; // $1 saved per traffic minute
const RATE = 525_600 * SAVED; // the true annual rate: $1 a minute

const day = (trafficMinutes: number, meteredMinutes: number) => ({
  whpM: trafficMinutes * 2 * SAVED,
  paidM: trafficMinutes * SAVED,
  savedM: trafficMinutes * SAVED,
  minutes: meteredMinutes,
});

describe("r2 core-5 · a metering gap before the first priced minute does not inflate the run rate", () => {
  const collecting = Date.UTC(2026, 9, 5, 9, 0); // day 1 09:00: install, no priced traffic yet

  it("gap case (day 2 metered 10:00–24:00, traffic from 11:00): ratio < 1.05 (was 1.77)", () => {
    const pricedSince = Date.UTC(2026, 9, 6, 11, 0);
    const now = Date.UTC(2026, 9, 7, 10, 0);
    const totals: TotalsDoc = {
      schemaVersion: 1,
      updatedAt: "",
      byDay: {
        "2026-10-05": day(0, 5),
        "2026-10-06": day(780, 840),
        "2026-10-07": day(600, 600),
      },
    };
    const h = computeHeadline(totals, now, "UTC", collecting, undefined, now, {
      pricedSinceMs: pricedSince,
    });
    expect(h.annualizedM / RATE).toBeLessThan(1.05);
    expect(h.annualizedM / RATE).toBeGreaterThan(0.95);
  });

  it("clamp case (metered 10:00–10:30, traffic from 10:05): ratio < 1.05 (was 25)", () => {
    const pricedSince = Date.UTC(2026, 9, 6, 10, 5);
    const now = Date.UTC(2026, 9, 6, 10, 30);
    const totals: TotalsDoc = {
      schemaVersion: 1,
      updatedAt: "",
      byDay: { "2026-10-05": day(0, 5), "2026-10-06": day(25, 30) },
    };
    const h = computeHeadline(totals, now, "UTC", collecting, undefined, now, {
      pricedSinceMs: pricedSince,
    });
    expect(h.annualizedM / RATE).toBeLessThan(1.05);
    expect(h.annualizedM / RATE).toBeGreaterThan(0.95);
    expect(h.annualizedFromDays).toBeCloseTo(25 / 1440, 6);
  });

  it("control (day 2 metered whole, no gap): ratio exactly 1.00, unchanged", () => {
    const pricedSince = Date.UTC(2026, 9, 6, 11, 0);
    const now = Date.UTC(2026, 9, 7, 10, 0);
    const totals: TotalsDoc = {
      schemaVersion: 1,
      updatedAt: "",
      byDay: {
        "2026-10-05": day(0, 5),
        "2026-10-06": day(780, 1440),
        "2026-10-07": day(600, 600),
      },
    };
    const h = computeHeadline(totals, now, "UTC", collecting, undefined, now, {
      pricedSinceMs: pricedSince,
    });
    expect(h.annualizedM).toBe(RATE);
  });

  it("control (traffic from the day’s first metered minute, same day as collecting began): unchanged", () => {
    const since = Date.UTC(2026, 9, 6, 9, 0);
    const now = Date.UTC(2026, 9, 6, 12, 0);
    const totals: TotalsDoc = {
      schemaVersion: 1,
      updatedAt: "",
      byDay: { "2026-10-06": day(180, 180) },
    };
    const h = computeHeadline(totals, now, "UTC", since, undefined, now, {
      pricedSinceMs: since,
    });
    expect(h.annualizedM).toBe(RATE);
  });

  it("the first day’s traffic minutes run to the cursor, not to the wall clock (a sweep not yet run)", () => {
    const pricedSince = Date.UTC(2026, 9, 6, 10, 5);
    const through = Date.UTC(2026, 9, 6, 10, 30);
    const now = Date.UTC(2026, 9, 6, 10, 34);
    const totals: TotalsDoc = {
      schemaVersion: 1,
      updatedAt: "",
      byDay: { "2026-10-05": day(0, 5), "2026-10-06": day(25, 30) },
    };
    const h = computeHeadline(
      totals,
      now,
      "UTC",
      collecting,
      undefined,
      through,
      { pricedSinceMs: pricedSince },
    );
    expect(h.annualizedM / RATE).toBeCloseTo(1, 2);
  });

  it("a gap after the first priced minute leaves the rate conservative (never above the true rate)", () => {
    const pricedSince = Date.UTC(2026, 9, 6, 11, 0);
    const now = Date.UTC(2026, 9, 7, 10, 0);
    // Day 2 metered 10:00–14:00 and 16:00–24:00 (a two-hour gap after the traffic began): 720 metered minutes, 660 with traffic.
    const totals: TotalsDoc = {
      schemaVersion: 1,
      updatedAt: "",
      byDay: {
        "2026-10-05": day(0, 5),
        "2026-10-06": day(660, 720),
        "2026-10-07": day(600, 600),
      },
    };
    const h = computeHeadline(totals, now, "UTC", collecting, undefined, now, {
      pricedSinceMs: pricedSince,
    });
    expect(h.annualizedM / RATE).toBeLessThanOrEqual(1.0000001);
    expect(h.annualizedM / RATE).toBeGreaterThan(0.9);
    void MIN;
  });
});
