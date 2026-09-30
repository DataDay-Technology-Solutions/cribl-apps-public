// tests/integration/r2-core-weekly-fresh.test.ts — founder-build r2 core-11 (a): the weekly job on a fresh workspace on
// a Monday afternoon (r1-ui's zero-row spec, a synthetic Monday-15:00-UTC workspace, allow-listed "[meter-reader] weekly
// receipt failed" after it showed once under load).
//
// Cause: the job itself does not fail on a fresh workspace (no rollups, no totals, no prior week: it sends a $0 receipt
// or skips cleanly — the first cases below). What that spec hit is a transient Leader failure: a KV read that timed out
// (the spec fast-forwards a fake clock 10 s at a time while real requests are in flight, so the transport's 25 s timer
// fires under load) surfaces as KvHttpError status 0, which the job logged as an error and returned as one — and an
// automatic send that errors settles the week for the tab, so a Monday blip meant no receipt that week. Now an automatic
// send that meets a transient failure (a timeout or network error, a 5xx) logs a warning and returns skipped
// 'unavailable', so a later tick sends it; a manual send still reports the error to the member who pressed the button.

import { describe, expect, it } from "vitest";
import { KvHttpError } from "../../core/kv.ts";
import { runWeeklyReceipt, sendTestNotification } from "../../core/weekly.ts";
import { defaultBellEndpoint } from "../../core/delivery.ts";
import type { KvStore } from "../../core/types.ts";
import { DAY, createWorld, meteringSince, T0 } from "./harness.ts";

function recordingLogger() {
  const logs: { level: string; msg: string }[] = [];
  return {
    logs,
    logger: {
      info: (msg: string) => void logs.push({ level: "info", msg }),
      warn: (msg: string) => void logs.push({ level: "warn", msg }),
      error: (msg: string, d?: unknown) =>
        void logs.push({
          level: "error",
          msg: `${msg} ${d instanceof Error ? d.message : ""}`,
        }),
    },
  };
}

/** A KV that answers one GET of an hour rollup (or any key matching `when`) with a timeout, `times` times. */
function flakyKv(when: RegExp, status = 0, times = 1) {
  let left = 0;
  return {
    arm: () => void (left = times),
    wrap: (kv: KvStore): KvStore => ({
      ...kv,
      get: async (key) => {
        if (left > 0 && when.test(key)) {
          left--;
          throw new KvHttpError(
            "GET",
            key,
            status,
            status === 0
              ? "timeout: no response from GET within 25000 ms"
              : "Service Unavailable",
          );
        }
        return kv.get(key);
      },
    }),
  };
}

describe("r2 core-11 (a) · the weekly job on a fresh Monday workspace", () => {
  it("T0 is a Monday afternoon (the automatic window is open)", () => {
    expect(new Date(T0).getUTCDay()).toBe(1);
    expect(new Date(T0).getUTCHours()).toBeGreaterThanOrEqual(12);
  });

  for (const bare of [false, true]) {
    it(`a fresh workspace (${bare ? "prices only" : "settings and prices"}) sends or skips cleanly: no error, nothing logged as one`, async () => {
      const w = await createWorld({
        bare,
        options: { notificationApis: true },
      });
      if (bare) {
        const { rigPrices } = await import("./harness.ts");
        await w.docs.putPrices(rigPrices(w.now()));
      }
      await w.sweep();
      await w.sweepMinutes(2);
      const { logs, logger } = recordingLogger();
      const r = await runWeeklyReceipt({ ...w.deps, logger }, { mode: "ui" });
      expect(r.error).toBeUndefined();
      expect(logs.filter((l) => l.level === "error")).toEqual([]);
      // Founder-build r3 core-2 (D83): a workspace installed this Monday afternoon metered none of last week — no receipt.
      expect(r.skipped).toBe("not_metered");
      expect(r.receipt).toBeUndefined();
      // One that has been metering since before last week (with nothing to show for it) gets last week's $0 receipt.
      await meteringSince(w, T0 - 8 * DAY);
      const metered = await runWeeklyReceipt({ ...w.deps, logger }, { mode: "ui" });
      expect(metered.error).toBeUndefined();
      expect(logs.filter((l) => l.level === "error")).toEqual([]);
      // The bell (on by default) takes it: last week's receipt, $0 on a workspace that metered nothing last week.
      expect(metered.receipt?.savedM).toBe(0);
    }, 60_000);
  }

  for (const [what, when, status] of [
    ["a timed-out hour-rollup read", /^roll\/hour\//, 0],
    ["a timed-out settings read", /^settings$/, 0],
    ["a 503 on the totals", /^totals$/, 503],
  ] as const) {
    it(`an automatic send that meets ${what} is skipped as unavailable (a warning), and the next tick sends it`, async () => {
      const flaky = flakyKv(when, status);
      const w = await createWorld({
        options: { notificationApis: true },
        wrapKv: flaky.wrap,
      });
      await w.sweep();
      await w.sweepMinutes(2);
      await meteringSince(w, T0 - 8 * DAY); // r3 core-2: a workspace that metered last week
      flaky.arm();
      const first = recordingLogger();
      const r = await runWeeklyReceipt(
        { ...w.deps, logger: first.logger },
        { mode: "ui" },
      );
      expect(r.skipped).toBe("unavailable");
      expect(r.error).toMatch(/HTTP (0|503)/);
      expect(first.logs.filter((l) => l.level === "error")).toEqual([]);
      expect(
        first.logs.some(
          (l) => l.level === "warn" && /weekly receipt/.test(l.msg),
        ),
      ).toBe(true);
      // The lock is released: the retry runs.
      w.advance(30_000);
      const second = recordingLogger();
      const again = await runWeeklyReceipt(
        { ...w.deps, logger: second.logger },
        { mode: "ui" },
      );
      expect(again.skipped).toBeUndefined();
      expect(again.error).toBeUndefined();
      expect(again.sent).toBeGreaterThan(0);
      expect(second.logs.filter((l) => l.level === "error")).toEqual([]);
    }, 60_000);
  }

  it('a manual send ("Send now") still reports a transient failure to the member as an error', async () => {
    const flaky = flakyKv(/^roll\/hour\//);
    const w = await createWorld({
      options: { notificationApis: true },
      wrapKv: flaky.wrap,
    });
    await w.sweep();
    flaky.arm();
    const r = await runWeeklyReceipt(w.deps, { mode: "manual" });
    expect(r.skipped).toBeUndefined();
    expect(r.error).toMatch(/HTTP 0/);
  }, 60_000);

  it("a real defect is still an error (not retried as unavailable)", async () => {
    const flaky = flakyKv(/^roll\/hour\//, 400);
    const w = await createWorld({
      options: { notificationApis: true },
      wrapKv: flaky.wrap,
    });
    await w.sweep();
    await meteringSince(w, T0 - 8 * DAY); // r3 core-2: a workspace that metered last week
    flaky.arm();
    const { logs, logger } = recordingLogger();
    const r = await runWeeklyReceipt({ ...w.deps, logger }, { mode: "ui" });
    expect(r.skipped).toBeUndefined();
    expect(r.error).toMatch(/HTTP 400/);
    expect(logs.some((l) => l.level === "error")).toBe(true);
  }, 60_000);

  // R2 core-11 (c), IC-11 verify, end to end: "Send test" to the default bell lands one info message with neutral names.
  it("IC-11: a test to the Cribl bell posts one info message naming the neutral sample", async () => {
    const w = await createWorld({ options: { notificationApis: true } });
    await w.sweep();
    // The bell is implicit (not in settings.notifications): Settings passes its endpoint, as here.
    const r = await sendTestNotification(w.deps, {
      endpoint: defaultBellEndpoint(),
    });
    expect(r.status).toBeGreaterThanOrEqual(200);
    expect(r.status).toBeLessThan(300);
    const bell = w.em.bell().filter((m) => /test/i.test(m.title));
    expect(bell).toHaveLength(1);
    expect(bell[0].severity).toBe("info");
    expect(bell[0].title).toBe("Test: Savings dropped: Example pipeline");
    expect(`${bell[0].title} ${bell[0].text}`).not.toMatch(/mrd_|Payments API/);
  }, 60_000);
});
