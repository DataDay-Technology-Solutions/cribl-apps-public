// tests/unit/r2-core-rezone-halfhour.test.ts — founder-build r2 core-4, FINDINGS_R2 #11 (AA/r2/5/tz,
// OUT/skeptic1-r2f5-tz-kolkata, OUT/skeptic2-r2f5-tz-kolkata).
//
// A zone change into a non-whole-hour zone cuts one UTC hour at the new local midnight (Kolkata: 18:30Z). The sweep
// re-bucketed from the minute rows it happened to hold and the hour rollups for the rest, so an hour already folded
// into roll/hour was split by time although its minute document was still kept (25 h): Today in Kolkata read
// 1,751,081 m¢ against 1,750,707 m¢ recomputed (+374), and −262,698 m¢ with a spike in the second half-hour. Now an
// hour that holds a cut (an old or new local midnight off the hour) is re-bucketed from its minute rows whenever they
// are kept; the time split stays only for an hour whose minute rows are gone.

import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../core/types.ts";
import { breakTrim, restoreTrim } from "../../core/demo/levers.ts";
import { rezonePlan, rezoneStraddleHours } from "../../core/rezone.ts";
import { localMidnightMs, localMonthStartMs } from "../../core/time.ts";
import {
  HOUR,
  MINUTE,
  createWorld,
  type World,
} from "../integration/harness.ts";

/** Saved millicents per stored minute (every roll/min row, summed over flows). */
async function minuteMoney(w: World): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const keys = (await w.kv.list("roll/min/")).filter(
    (k) => !/\/c\/\d+$/.test(k),
  );
  for (const k of keys) {
    const doc = await w.docs.getRollMinute(k);
    for (const rows of Object.values(doc?.flows ?? {}))
      for (const r of rows) {
        const t = Date.parse(r.t);
        out.set(t, (out.get(t) ?? 0) + r.savedM);
      }
  }
  return out;
}
const sumFrom = (m: Map<number, number>, from: number): number =>
  [...m].reduce((s, [t, v]) => (t >= from ? s + v : s), 0);

/**
 * Meters in UTC (the settings' zone) from an hour before `zone`'s local midnight `midnightMs`
 * to 3.5 h after, with a trim broken for 15 minutes just after the midnight (so the two halves of the cut hour differ),
 * then changes the settings' display timezone to `zone` and sweeps once (the rezone). Returns the snapshot and the recompute.
 */
async function scenario(zone: string, midnightMs: number) {
  const hour = Math.floor(midnightMs / HOUR) * HOUR;
  const start = hour - HOUR + 20_000;
  // Settings in UTC (demo on, so the levers run); the member later changes the display timezone.
  const w = await createWorld({ start });
  const RUNNER = { owner: "runner:studio:1", runtime: "backend" as const };
  expect((await w.sweep("scheduled", RUNNER as never)).error).toBeUndefined();
  const tick = async (untilMs: number) => {
    while (w.now() < untilMs) {
      w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
      const r = await w.sweep("scheduled", RUNNER as never);
      expect(r.error).toBeUndefined();
    }
  };
  await tick(midnightMs + 5 * MINUTE);
  expect((await breakTrim(w.lever, { pipelineId: "mrd_pay_sample" })).ok).toBe(
    true,
  );
  await tick(midnightMs + 20 * MINUTE);
  expect(
    (await restoreTrim(w.lever, { pipelineId: "mrd_pay_sample" })).ok,
  ).toBe(true);
  // Far enough that the cut hour is folded and outside the sweep's own minute reads (the snapshot's last 60 minutes).
  await tick(hour + 3 * HOUR + 30 * MINUTE);
  const zoneBefore = (await w.docs.getTotals())?.zone;
  await w.putSettings((st) => void (st.displayTimezone = zone));
  w.set(Math.floor(w.now() / MINUTE) * MINUTE + MINUTE + 20_000);
  const before = w.logs.length;
  const r = await w.sweep("scheduled", RUNNER as never);
  expect(r.error).toBeUndefined();
  expect(w.logs.slice(before).some((l) => /re-bucketed/.test(l.msg))).toBe(
    true,
  );
  const snap = (await w.docs.getSnapshot()) as Snapshot;
  const perMinute = await minuteMoney(w);
  return { w, snap, perMinute, zoneBefore, hour };
}

describe("r2 core-4 · #11: a rezone into a half-hour zone uses the cut hour’s minute rows", () => {
  const cases = [
    // Sep 28 local midnight in each zone, in UTC.
    { zone: "Asia/Kolkata", midnight: Date.UTC(2026, 8, 27, 18, 30) }, // +5:30
    { zone: "Asia/Kathmandu", midnight: Date.UTC(2026, 8, 27, 18, 15) }, // +5:45
    { zone: "America/St_Johns", midnight: Date.UTC(2026, 8, 28, 2, 30) }, // NDT −2:30
    { zone: "Pacific/Auckland", midnight: Date.UTC(2026, 8, 27, 11, 0) }, // NZDT +13 (whole hour: the control)
  ];
  for (const c of cases) {
    it(`${c.zone}: Today and MTD equal a direct recompute from the minute rows, to the millicent`, async () => {
      const { snap, perMinute, zoneBefore, w } = await scenario(
        c.zone,
        c.midnight,
      );
      expect(zoneBefore).toBe("UTC");
      expect(snap.zone).toBe(c.zone);
      const sweepMs = Date.parse(snap.sweepAt);
      expect(localMidnightMs(sweepMs, c.zone)).toBe(c.midnight);
      expect(snap.headline.todayM).toBe(
        sumFrom(perMinute, localMidnightMs(sweepMs, c.zone)),
      );
      expect(snap.headline.mtdM).toBe(
        sumFrom(perMinute, localMonthStartMs(sweepMs, c.zone)),
      );
      // Every day key holds exactly its own local day's minutes' money (the one before midnight included).
      const totals = (await w.docs.getTotals())!;
      const before = sumFrom(perMinute, 0) - sumFrom(perMinute, c.midnight);
      const prevKey = Object.keys(totals.byDay).sort()[0];
      expect(totals.byDay[prevKey].savedM).toBe(before);
    }, 300_000);
  }

  it("rezoneStraddleHours lists the hours a cut falls inside (off the hour) and nothing for whole-hour zones", () => {
    const now = Date.UTC(2026, 8, 28, 21, 50, 20);
    const since = Date.UTC(2026, 8, 27, 17, 0);
    const kol = rezonePlan("UTC", "Asia/Kolkata", now, now - 20_000, since)!;
    expect(
      rezoneStraddleHours(kol).map((h) => new Date(h).toISOString()),
    ).toEqual(["2026-09-27T18:00:00.000Z", "2026-09-28T18:00:00.000Z"]);
    const back = rezonePlan("Asia/Kolkata", "UTC", now, now - 20_000, since)!;
    // Kolkata → UTC starts at Kolkata's midnight (Sep 26 18:30Z), itself off the hour.
    expect(
      rezoneStraddleHours(back).map((h) => new Date(h).toISOString()),
    ).toEqual([
      "2026-09-26T18:00:00.000Z",
      "2026-09-27T18:00:00.000Z",
      "2026-09-28T18:00:00.000Z",
    ]);
    const ny = rezonePlan("UTC", "America/New_York", now, now - 20_000, since)!;
    expect(rezoneStraddleHours(ny)).toEqual([]);
  });
});
