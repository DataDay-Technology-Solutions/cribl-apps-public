// tests/unit/r3-core-heartbeat-restart.test.ts — founder-build r3 core-4 (FINDINGS_R3 #15, minor; AA/r3/3
// zz-r33-heartbeat-restart.test.ts and AA/r3/4 zz-r3f4-heartbeat-legacy.test.ts).
//
// A runner restarted from a heartbeat file written before r2 (a streak, no deliveryLastFailAt) restored `since` from
// the file's `at`, but sweepOnce threaded only { lastFailAt, reminderMinutes } to the next sweep, so the streak lost
// its only clock after one sweep and never aged out: deliveryOk false 4 hours later with nothing attempted. Now the
// restore stamps each streak's missing lastFailAt with the file's `at` (deliveryStateFromHeartbeat), heartbeatFor
// does the same from `since` (so its own state is self-contained), and sweepOnce carries everything the heartbeat
// holds (carryDeliveryState), the sticky final-4xx mark included (core-4 #6), so a restart keeps it.

import { describe, expect, it } from "vitest";
import type { SweepResult } from "../../core/sweep.ts";
import { carryDeliveryState, deliveryStateFromHeartbeat, heartbeatFor, type DeliveryStreakState } from "../../scripts/runner.ts";

const MIN = 60_000;
const base = { calls: 20, ms: 900, minutesProcessed: 1, backfilledMinutes: 0, opened: 0, closed: 0, notified: 0, snapshotBytes: 1, deliveryEndpoints: ["demo-webhook", "cribl-bell"], deliveryReminderMinutes: 60 } as SweepResult;

/** The runner's loop from a restored state: one heartbeat a minute, the state carried exactly as sweepOnce carries it. */
function loop(restored: { streaks: Record<string, number>; state: DeliveryStreakState }, t0: number, minutes: number, r: SweepResult = base): boolean[] {
  let streaks = restored.streaks;
  let state = restored.state;
  const oks: boolean[] = [];
  for (let m = 1; m <= minutes; m++) {
    const hb = heartbeatFor(r, 0, t0 + m * MIN, {}, streaks, state);
    streaks = hb.deliveryFailStreak as Record<string, number>;
    state = carryDeliveryState(hb);
    oks.push(hb.deliveryOk as boolean);
  }
  return oks;
}

describe("r3 core-4 · #15: a streak restored from a pre-r2 heartbeat file ages out", () => {
  const legacy = { at: "2026-09-28T22:00:00Z", ok: true, lockedStreak: 0, deliveryOk: false, deliveryFailStreak: { "demo-webhook": 3 } };

  it("the restore stamps the streak's missing lastFailAt with the file's time", () => {
    const r = deliveryStateFromHeartbeat(legacy);
    expect(r.streaks).toEqual({ "demo-webhook": 3 });
    expect(r.state.lastFailAt).toEqual({ "demo-webhook": "2026-09-28T22:00:00.000Z" });
    expect(r.state.since).toBe("2026-09-28T22:00:00Z");
  });

  it("the runner's loop from that restore: unhealthy until two cadences after the file, healthy from then on", () => {
    const oks = loop(deliveryStateFromHeartbeat(legacy), Date.parse(legacy.at), 240);
    expect(oks[118]).toBe(false); // +119 min
    expect(oks[119]).toBe(true); // +120 min
    expect(oks[239]).toBe(true);
  });

  it("the AA/r3/3 probe: sweeps without deliveryEndpoints, 4 h after the restart the streak has aged out", () => {
    const noEndpoints = { calls: 20, ms: 900, minutesProcessed: 1, opened: 0, closed: 0, notified: 0 } as unknown as SweepResult;
    const oks = loop(deliveryStateFromHeartbeat(legacy), Date.parse("2026-09-28T22:00:00Z"), 240, noEndpoints);
    expect(oks[239]).toBe(true);
  });

  it("the AA/r3/4 probe, verbatim: the old loop (state { lastFailAt, reminderMinutes } only, `since` on the first sweep) ages out too", () => {
    const oldAt = Date.parse("2026-09-28T22:00:00Z");
    let streaks: Record<string, number> = { "demo-webhook": 3 };
    let state: DeliveryStreakState = { lastFailAt: {}, since: new Date(oldAt).toISOString() };
    const oks: boolean[] = [];
    for (let m = 1; m <= 180; m++) {
      const hb = heartbeatFor(base, 0, oldAt + m * MIN, {}, streaks, state);
      streaks = hb.deliveryFailStreak as Record<string, number>;
      state = { lastFailAt: hb.deliveryLastFailAt as Record<string, string>, reminderMinutes: hb.deliveryReminderMinutes as number };
      oks.push(hb.deliveryOk as boolean);
    }
    expect(oks[119]).toBe(true);
    expect(oks[179]).toBe(true);
  });

  it("a heartbeat file with a sticky final-4xx streak keeps it across a restart (false through idle hours)", () => {
    const sticky = {
      at: "2026-09-28T22:00:00Z",
      ok: true,
      lockedStreak: 0,
      deliveryOk: false,
      deliveryFailStreak: { "demo-webhook": 3 },
      deliveryLastFailAt: { "demo-webhook": "2026-09-28T21:30:00.000Z" },
      deliveryFinal: { "demo-webhook": true },
      deliveryReminderMinutes: 60,
    };
    const restored = deliveryStateFromHeartbeat(sticky);
    expect(restored.state.final).toEqual({ "demo-webhook": true });
    expect(loop(restored, Date.parse(sticky.at), 360).every((ok) => ok === false)).toBe(true);
  });

  it("a file the runner cannot read (or none) restores nothing", () => {
    expect(deliveryStateFromHeartbeat(null)).toEqual({ streaks: {}, state: {} });
    expect(deliveryStateFromHeartbeat({ at: "not a date", deliveryFailStreak: { x: "3" } })).toEqual({ streaks: {}, state: { lastFailAt: {} } });
  });
});
