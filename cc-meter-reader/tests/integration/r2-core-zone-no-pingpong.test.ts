// tests/integration/r2-core-zone-no-pingpong.test.ts — founder-build r2 core-4, the engine half of FINDINGS_R2 #4
// (contract C1''; probes AA/r2/1/zone-pingpong.test.ts and AA/r2/0/B1-zone-thrash.txt).
//
// A settings-less workspace (upgraded from 1.1.0, or a fresh install before its first save) was bucketed in whatever
// zone the sweeping runtime brought: a New York tab re-bucketed the totals into New York, the Los Angeles tab's next
// sweep back into Los Angeles, the UTC runner into UTC — every sweep (11 of 11), todayM flipping 24,559,145 ↔
// 21,311,236 m¢. Now the sweep and the weekly job resolve the zone as settings.displayTimezone → totals.zone →
// defaultTimeZone → UTC: the first rezone writes totals.zone, and every later tab, the runner and the backend follow it.

import { describe, expect, it } from "vitest";
import type { Snapshot, TotalsDoc } from "../../core/types.ts";
import { runWeeklyReceipt } from "../../core/weekly.ts";
import { resolveMeterZone } from "../../core/rezone.ts";
import { localDayKey } from "../../core/time.ts";
import { DAY, MINUTE, createWorld, rigPrices, type World } from "./harness.ts";

const START = Date.UTC(2026, 8, 29, 2, 30, 20); // Mon 10:30 PM EDT = 7:30 PM PDT = Tue 02:30 UTC
const NY = { defaultTimeZone: "America/New_York", owner: "tab-ny" };
const LA = { defaultTimeZone: "America/Los_Angeles", owner: "tab-la" };
const RUNNER = { owner: "runner:studio:4242", runtime: "backend" as const }; // no defaultTimeZone: the runner's UTC

type Extra = typeof NY | typeof LA | typeof RUNNER;

async function alternate(w: World, minutes: number, order: [string, Extra][]) {
  const rows: {
    who: string;
    zone?: string;
    totalsZone?: string;
    todayM: number;
    rebucketed: number;
    minutesToday: number;
  }[] = [];
  for (let m = 0; m < minutes; m++) {
    const [who, extra] = order[m % order.length];
    w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
    const before = w.logs.length;
    const r = await w.sweep(
      who === "runner" ? "scheduled" : "ui",
      extra as never,
    );
    expect(r.error).toBeUndefined();
    const rebucketed = w.logs
      .slice(before)
      .filter((l) => /re-bucketed/.test(l.msg)).length;
    const snap = (await w.docs.getSnapshot()) as Snapshot;
    const totals = (await w.docs.getTotals()) as TotalsDoc;
    rows.push({
      who,
      zone: snap.zone,
      totalsZone: totals.zone,
      todayM: snap.headline.todayM,
      minutesToday: snap.headline.minutesToday ?? 0,
      rebucketed,
    });
  }
  return rows;
}

describe("r2 core-4 · a settings-less workspace settles in one zone (C1’’)", () => {
  it("fresh install: NY tab first, then NY, LA and a UTC runner alternate for 12 minutes → no rezone, one zone, todayM never falls", async () => {
    const w = await createWorld({
      start: START,
      bare: true,
      sweep: { firstRunReachMs: undefined },
    });
    await w.docs.putPrices(rigPrices(START - 2 * DAY));
    const first = await w.sweep("ui", NY as never);
    expect(first.error).toBeUndefined();
    expect((await w.docs.getTotals())?.zone).toBe("America/New_York");
    const rows = await alternate(w, 12, [
      ["ny", NY],
      ["la", LA],
      ["runner", RUNNER],
    ]);
    expect(rows.reduce((s, r) => s + r.rebucketed, 0)).toBe(0);
    expect(new Set(rows.map((r) => r.zone))).toEqual(
      new Set(["America/New_York"]),
    );
    expect(new Set(rows.map((r) => r.totalsZone))).toEqual(
      new Set(["America/New_York"]),
    );
    for (let k = 1; k < rows.length; k++)
      expect(rows[k].todayM).toBeGreaterThanOrEqual(rows[k - 1].todayM);
    // No settings document is written by the engine (persisting one is the tab's, ui-3).
    expect(await w.docs.getSettings()).toBeNull();
  }, 300_000);

  it("a 1.1.0-upgraded workspace (UTC totals, no zone recorded): exactly one rezone, into the first tab’s zone, then it holds", async () => {
    const w = await createWorld({
      start: START,
      bare: true,
      sweep: { firstRunReachMs: undefined },
    });
    await w.docs.putPrices(rigPrices(START - 2 * DAY));
    // 1.1.0 metered in UTC and recorded no zone.
    expect((await w.sweep("scheduled", RUNNER as never)).error).toBeUndefined();
    const t0 = (await w.docs.getTotals()) as TotalsDoc;
    expect(t0.zone).toBe("UTC");
    const legacy = { ...t0 };
    delete legacy.zone;
    await w.docs.putTotals(legacy);
    const rows = await alternate(w, 12, [
      ["ny", NY],
      ["la", LA],
      ["runner", RUNNER],
    ]);
    expect(rows.reduce((s, r) => s + r.rebucketed, 0)).toBeLessThanOrEqual(1);
    expect(rows[0].rebucketed).toBe(1);
    expect(new Set(rows.map((r) => r.zone))).toEqual(
      new Set(["America/New_York"]),
    );
    for (let k = 1; k < rows.length; k++)
      expect(rows[k].todayM).toBeGreaterThanOrEqual(rows[k - 1].todayM);
  }, 300_000);

  it("the runner swept first (UTC recorded, no settings): the first NY tab re-buckets once, then LA and the runner follow NY", async () => {
    const w = await createWorld({
      start: START,
      bare: true,
      sweep: { firstRunReachMs: undefined },
    });
    await w.docs.putPrices(rigPrices(START - 2 * DAY));
    expect((await w.sweep("scheduled", RUNNER as never)).error).toBeUndefined();
    expect((await w.docs.getTotals())?.zone).toBe("UTC");
    const rows = await alternate(w, 12, [
      ["ny", NY],
      ["la", LA],
      ["runner", RUNNER],
    ]);
    expect(rows.map((r) => r.rebucketed)).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(new Set(rows.map((r) => r.zone))).toEqual(
      new Set(["America/New_York"]),
    );
    for (let k = 1; k < rows.length; k++)
      expect(rows[k].todayM).toBeGreaterThanOrEqual(rows[k - 1].todayM);
  }, 300_000);

  it("resolveMeterZone: settings → totals.zone (UTC yields) → defaultTimeZone → UTC", () => {
    expect(
      resolveMeterZone(
        { displayTimezone: "Asia/Kolkata" },
        { zone: "America/New_York" },
        "America/Los_Angeles",
      ),
    ).toBe("Asia/Kolkata");
    expect(
      resolveMeterZone(
        null,
        { zone: "America/New_York" },
        "America/Los_Angeles",
      ),
    ).toBe("America/New_York");
    expect(resolveMeterZone(null, { zone: "UTC" }, "America/Los_Angeles")).toBe(
      "America/Los_Angeles",
    );
    expect(resolveMeterZone(null, {}, "America/Los_Angeles")).toBe(
      "America/Los_Angeles",
    );
    expect(resolveMeterZone(null, null, undefined)).toBe("UTC");
    expect(
      resolveMeterZone(
        { displayTimezone: "Not/AZone" },
        { zone: "Bad/Zone" },
        "Also/Bad",
      ),
    ).toBe("UTC");
    expect(
      resolveMeterZone(
        { displayTimezone: "UTC" },
        { zone: "America/New_York" },
        "America/Los_Angeles",
      ),
    ).toBe("UTC");
  });

  it("a stored settings zone still wins over the totals’ zone (and re-buckets once)", async () => {
    const w = await createWorld({
      start: START,
      bare: true,
      sweep: { firstRunReachMs: undefined },
    });
    await w.docs.putPrices(rigPrices(START - 2 * DAY));
    expect((await w.sweep("ui", NY as never)).error).toBeUndefined();
    const { defaultSettings } = await import("../../core/settings.ts");
    await w.docs.putSettings(
      defaultSettings(new Date(w.now()).toISOString(), "America/Los_Angeles"),
    );
    const rows = await alternate(w, 6, [
      ["ny", NY],
      ["runner", RUNNER],
    ]);
    expect(rows.reduce((s, r) => s + r.rebucketed, 0)).toBe(1);
    expect(new Set(rows.map((r) => r.zone))).toEqual(
      new Set(["America/Los_Angeles"]),
    );
  }, 300_000);

  it("the weekly job follows the totals’ zone on a settings-less workspace: the UTC runner reports the NY week", async () => {
    const w = await createWorld({
      start: START,
      bare: true,
      sweep: { firstRunReachMs: undefined },
    });
    await w.docs.putPrices(rigPrices(START - 2 * DAY));
    expect((await w.sweep("ui", NY as never)).error).toBeUndefined();
    await alternate(w, 3, [["ny", NY]]);
    const res = await runWeeklyReceipt(
      {
        ...w.deps,
        ...RUNNER,
        envWebhooks: [
          {
            id: "ep_w",
            name: "w",
            url: "https://webhook.site/x",
            host: "webhook.site",
            format: "generic",
            minSeverity: "medium",
            weeklyReceipt: true,
            enabled: true,
            channel: "webhook",
          },
        ],
      },
      { mode: "manual" },
    );
    expect(res.error).toBeUndefined();
    const receipt = res.receipt!;
    // The trailing week ends at the start of "today" in New York (Mon Sep 28, 10:3x PM EDT → Sep 28 00:00 EDT = 04:00Z);
    // in UTC it would end at Sep 29 00:00Z.
    const end = Date.parse(receipt.periodEnd);
    expect(localDayKey(end, "America/New_York")).toBe("2026-09-28");
    expect(new Date(end).toISOString()).toBe("2026-09-28T04:00:00.000Z");
  }, 300_000);
});
