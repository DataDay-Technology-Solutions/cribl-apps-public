// tests/unit/r3-core-heartbeat-final4xx.test.ts — founder-build r3 core-4 (FINDINGS_R3 #6, major; AA/r3/3
// zz-r33-heartbeat-final4xx.test.ts, heartbeat-final4xx.round1-f8953da.out.txt).
//
// R2 core-3 let a delivery fail-streak age out after two reminder cadences with no new failure, so a fixed receiver
// with nothing left to send turns healthy. But a webhook that answers a FINAL 4xx (a 404: the hook was deleted) to
// every post is never retried once its incident closes — two posts per incident (open, close) — so its streak aged
// out between incidents on wall-clock silence and never reached 3: `deliveryOk` stayed true through 6 failures and 0
// successes (r1, c53f9fc, turned false at the 3rd). Now a streak that holds a final failure (a 4xx no retry can fix;
// 429, a receiver's throttle, is not one) clears only on evidence of health — a later 2xx to that endpoint, or its
// removal or disablement — never on silence. A retryable streak (a timeout, a 5xx, a 429) keeps r2's age-out.
//
// Real sweeps (the harness, bell on) against a webhook answering 404 to every incident post; each SweepResult fed to
// the runner's heartbeatFor exactly as sweepOnce carries its state (carryDeliveryState).

import { describe, expect, it } from "vitest";
import type { SweepResult } from "../../core/sweep.ts";
import type { WebhookSender } from "../../core/types.ts";
import { breakTrim, restoreTrim } from "../../core/demo/levers.ts";
import { DELIVERY_FAIL_STREAK_UNHEALTHY, carryDeliveryState, heartbeatFor, type DeliveryStreakState } from "../../scripts/runner.ts";
import { SINK_ENDPOINT, createWorld } from "../integration/harness.ts";

const MIN = 60_000;

interface Carried {
  streaks: Record<string, number>;
  state: DeliveryStreakState;
}

/** One incident on a fresh world: the sink answers `status` to every incident post (open, then close). */
async function incidentCycle(status: number, carried: Carried, trace: string[], openMinutes = 25) {
  const w = await createWorld({ options: { notificationApis: true } });
  const real = w.deps.webhook;
  let armed = false;
  const sender: WebhookSender = {
    post: async (url, body, to) => {
      const j = JSON.parse(body) as { event: string; incident?: { id: string } };
      if (url === SINK_ENDPOINT.url && armed && j.incident?.id) {
        trace.push(`  post ${new Date(w.now()).toISOString()} ${j.event} -> ${status}`);
        return { status };
      }
      return real.post(url, body, to);
    },
  };
  await w.sweep();
  await w.sweepMinutes(3, { webhook: sender });
  armed = true;
  let { streaks, state } = carried;
  const oks: boolean[] = [];
  const feed = (rs: SweepResult[]) => {
    for (const r of rs) {
      const at = r.attempts?.length ? Date.parse(r.attempts[r.attempts.length - 1].at) : w.now();
      const hb = heartbeatFor(r, 0, at, {}, streaks, state);
      streaks = hb.deliveryFailStreak as Record<string, number>;
      state = carryDeliveryState(hb);
      oks.push(hb.deliveryOk as boolean);
      if (r.attempts?.length) trace.push(`  hb deliveryOk=${hb.deliveryOk} streaks=${JSON.stringify(streaks)}`);
    }
  };
  expect((await breakTrim(w.lever, { pipelineId: "mrd_pay_sample" })).ok).toBe(true);
  feed(await w.sweepMinutes(openMinutes, { webhook: sender }));
  expect((await restoreTrim(w.lever, { pipelineId: "mrd_pay_sample" })).ok).toBe(true);
  feed(await w.sweepMinutes(45, { webhook: sender }));
  // Idle for two cadences and more (the runner sweeps every minute; nothing to deliver).
  const idle: boolean[] = [];
  for (const after of [121, 600]) {
    const idleAt = w.now() + after * MIN;
    const hb = heartbeatFor({ ...(await w.sweep()), attempts: undefined }, 0, idleAt, {}, streaks, state);
    idle.push(hb.deliveryOk as boolean);
    trace.push(`  idle +${after} min deliveryOk=${hb.deliveryOk} streaks=${JSON.stringify(hb.deliveryFailStreak)}`);
    streaks = hb.deliveryFailStreak as Record<string, number>;
    state = carryDeliveryState(hb);
  }
  return { carried: { streaks, state }, oks, idle, w, sender };
}

describe("r3 core-4 · #6: a webhook answering a final 4xx to every post turns the heartbeat unhealthy, and it stays so", () => {
  it("three short incidents spaced by idle hours: false at the 3rd failed post, and false through idle hours after it", async () => {
    const trace: string[] = [];
    let carried: Carried = { streaks: {}, state: {} };
    const everFalse: boolean[] = [];
    let lastIdle: boolean[] = [];
    for (let k = 1; k <= 3; k++) {
      trace.push(`incident cycle ${k}`);
      const r = await incidentCycle(404, carried, trace);
      carried = r.carried;
      everFalse.push(r.oks.some((ok) => !ok));
      lastIdle = r.idle;
    }
    // Cycle 1: 2 failed posts (open, close); cycle 2: the 3rd failure turns it false.
    expect(everFalse, trace.join("\n")).toEqual([false, true, true]);
    expect(lastIdle, trace.join("\n")).toEqual([false, false]);
    expect(carried.streaks[SINK_ENDPOINT.id]).toBeGreaterThanOrEqual(DELIVERY_FAIL_STREAK_UNHEALTHY);
    expect(carried.state.final?.[SINK_ENDPOINT.id]).toBe(true);
  }, 900_000);

  it("one 2xx to that endpoint turns it healthy again (evidence), and clears the sticky mark", async () => {
    const trace: string[] = [];
    let carried: Carried = { streaks: {}, state: {} };
    for (let k = 1; k <= 2; k++) carried = (await incidentCycle(404, carried, trace)).carried;
    const at = Date.parse("2026-09-29T10:00:00Z");
    const stillBad = heartbeatFor({ calls: 1, ms: 1, minutesProcessed: 1, opened: 0, closed: 0, notified: 0, snapshotBytes: 1 } as SweepResult, 0, at, {}, carried.streaks, carried.state);
    expect(stillBad.deliveryOk).toBe(false);
    const ok = heartbeatFor(
      { calls: 1, ms: 1, minutesProcessed: 1, opened: 0, closed: 0, notified: 1, snapshotBytes: 1, attempts: [{ endpointId: SINK_ENDPOINT.id, event: "incident.opened", incidentId: "inc_new", status: 200, attempt: 1, at: new Date(at + MIN).toISOString(), kind: "notify" }] } as SweepResult,
      0,
      at + MIN,
      {},
      carried.streaks,
      carried.state,
    );
    expect(ok.deliveryOk).toBe(true);
    expect((ok.deliveryFailStreak as Record<string, number>)[SINK_ENDPOINT.id]).toBe(0);
    expect(carryDeliveryState(ok).final?.[SINK_ENDPOINT.id]).toBeUndefined();
  }, 900_000);

  it("removing (or disabling) the endpoint turns it healthy on the next sweep", async () => {
    const trace: string[] = [];
    let carried: Carried = { streaks: {}, state: {} };
    for (let k = 1; k <= 2; k++) carried = (await incidentCycle(404, carried, trace)).carried;
    const at = Date.parse("2026-09-29T10:00:00Z");
    const base = { calls: 1, ms: 1, minutesProcessed: 1, opened: 0, closed: 0, notified: 0, snapshotBytes: 1 } as SweepResult;
    expect(heartbeatFor({ ...base, deliveryEndpoints: [SINK_ENDPOINT.id, "cribl-bell"] }, 0, at, {}, carried.streaks, carried.state).deliveryOk).toBe(false);
    const hb = heartbeatFor({ ...base, deliveryEndpoints: ["cribl-bell"] }, 0, at, {}, carried.streaks, carried.state);
    expect(hb.deliveryOk).toBe(true);
    expect(hb.deliveryFailStreak).not.toHaveProperty(SINK_ENDPOINT.id);
    expect(carryDeliveryState(hb).final ?? {}).toEqual({});
  }, 900_000);
});

describe("r3 core-4 · what stays sticky and what ages out (unit)", () => {
  const base = { calls: 20, ms: 900, minutesProcessed: 1, backfilledMinutes: 0, opened: 0, closed: 0, notified: 0, snapshotBytes: 1, deliveryEndpoints: ["hook", "cribl-bell"], deliveryReminderMinutes: 60 } as SweepResult;
  const fail = (status: number, at: string, incidentId = "inc_x") =>
    ({ ...base, attempts: [{ endpointId: "hook", incidentId, event: "incident.opened", status, at, attempt: 1, kind: "notify" }] }) as SweepResult;

  function run(status: number): { beats: boolean[]; state: DeliveryStreakState } {
    let streaks: Record<string, number> = {};
    let state: DeliveryStreakState = {};
    for (const at of ["2026-09-28T20:00:00Z", "2026-09-28T20:30:00Z", "2026-09-28T21:00:00Z"]) {
      const hb = heartbeatFor(fail(status, at, `inc_${at}`), 0, Date.parse(at), {}, streaks, state);
      streaks = hb.deliveryFailStreak as Record<string, number>;
      state = carryDeliveryState(hb);
    }
    const beats: boolean[] = [];
    for (let m = 1; m <= 6 * 60; m++) {
      const hb = heartbeatFor(base, 0, Date.parse("2026-09-28T21:00:00Z") + m * MIN, {}, streaks, state);
      streaks = hb.deliveryFailStreak as Record<string, number>;
      state = carryDeliveryState(hb);
      beats.push(hb.deliveryOk as boolean);
    }
    return { beats, state };
  }

  for (const status of [404, 400, 401, 403, 410]) {
    it(`a ${status} streak is sticky: false through six idle hours`, () => {
      const { beats, state } = run(status);
      expect(beats.every((ok) => ok === false)).toBe(true);
      expect(state.final?.hook).toBe(true);
    });
  }

  for (const status of [0, 500, 503, 429]) {
    it(`a ${status} streak (retryable, or a receiver's throttle) keeps r2's age-out: healthy two cadences after the last failure`, () => {
      const { beats, state } = run(status);
      expect(beats[118]).toBe(false); // +119 min
      expect(beats[119]).toBe(true); // +120 min
      expect(beats[359]).toBe(true);
      expect(state.final?.hook).toBeUndefined();
    });
  }

  it("a final failure then a retryable one in the same streak: still sticky (no 2xx came since the final one)", () => {
    let streaks: Record<string, number> = {};
    let state: DeliveryStreakState = {};
    for (const [status, at] of [
      [404, "2026-09-28T20:00:00Z"],
      [503, "2026-09-28T20:30:00Z"],
      [503, "2026-09-28T21:00:00Z"],
    ] as const) {
      const hb = heartbeatFor(fail(status, at, `inc_${at}`), 0, Date.parse(at), {}, streaks, state);
      streaks = hb.deliveryFailStreak as Record<string, number>;
      state = carryDeliveryState(hb);
    }
    const hb = heartbeatFor(base, 0, Date.parse("2026-09-29T03:00:00Z"), {}, streaks, state);
    expect(hb.deliveryOk).toBe(false);
  });
});
