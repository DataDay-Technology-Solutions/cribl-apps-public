// tests/unit/r3-core-weekly-first-install.test.ts — founder-build r3 core-2 (FINDINGS_R3 #1, major; AA/r3/0 P1 + P6).
//
// A fresh install between Monday 12:00 UTC and Tuesday 12:00 UTC posted a "Weekly receipt" for a week it never
// metered: the first priced sweep back-fills up to a day (D63), so `collectingSince` lands before Monday noon and
// shouldAutoSendWeekly (collectingSince < noon) said yes — "Weekly receipt · Sep 21–27 · Saved by Cribl $147" from
// ~14 h of back-fill at Mon 15:10Z, "$40" from ~4 h on the judge path at 8:10 PM CDT (Tue 01:10Z). Exactly when judges
// install.
//
// Now the first sweep that meters (a priced first run) records its wall time once, `meta.meteringStartedAt`, and the
// automatic receipt goes out only for a week that ended after metering started: a workspace metering during the week
// gets it (with its partial coverage on the bell line), a workspace installed after the week gets nothing for it. A
// workspace upgraded without the field keeps the old rule (collectingSince). Manual sends are unchanged.

import { describe, expect, it } from "vitest";
import { canonicalPayload } from "../../core/payloads.ts";
import { renderAlert } from "../../core/delivery.ts";
import { previousWeek } from "../../core/receipt.ts";
import { CREDIT_STRINGS } from "../../core/strings.ts";
import type { Meta, WeeklyReceipt } from "../../core/types.ts";
import { mondayNoonUtc, runWeeklyReceipt, shouldAutoSendWeekly } from "../../core/weekly.ts";
import { DAY, HOUR, createWorld, rigPrices } from "../integration/harness.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const MON_NOON = Date.UTC(2026, 8, 28, 12); // Monday 28 Sep 2026 12:00 UTC
const MON_1510 = Date.UTC(2026, 8, 28, 15, 10);
const TUE_0110 = Date.UTC(2026, 8, 29, 1, 10); // Mon 8:10 PM CDT: the judge path
const CHICAGO = "America/Chicago";
// The Chicago week Sep 21–27 ends at local Monday midnight: 05:00 UTC.
const CHICAGO_WEEK_END = Date.UTC(2026, 8, 28, 5);

describe("r3 core-2 · shouldAutoSendWeekly: a week metering never reached sends nothing", () => {
  const backFilled = (nowMs: number, reachMs = DAY) => ({ collectingSince: iso(nowMs - reachMs), meteringStartedAt: iso(nowMs) });

  it("a first install at Mon 15:10Z (a day back-filled): no receipt for last week", () => {
    const m = backFilled(MON_1510);
    expect(Date.parse(m.collectingSince)).toBeLessThan(MON_NOON); // the old rule's trigger
    expect(shouldAutoSendWeekly(m, MON_1510 + 60_000)).toBe(false);
    expect(shouldAutoSendWeekly(m, MON_1510 + 60_000, { timeZone: CHICAGO })).toBe(false);
    // … and not later in the week either (the late-send window covers the whole week).
    expect(shouldAutoSendWeekly(m, MON_NOON + 5 * DAY)).toBe(false);
  });

  it("the judge path at Tue 01:10Z (Mon 8:10 PM CDT): no receipt", () => {
    const m = backFilled(TUE_0110);
    expect(shouldAutoSendWeekly(m, TUE_0110 + 3 * 60_000)).toBe(false);
    expect(shouldAutoSendWeekly(m, TUE_0110 + 3 * 60_000, { timeZone: CHICAGO })).toBe(false);
  });

  it("the next Monday, the week it did meter is sent", () => {
    const m = backFilled(MON_1510);
    expect(shouldAutoSendWeekly(m, MON_NOON + 7 * DAY + 60_000)).toBe(true);
  });

  it("a workspace metering since the prior Sunday gets last week's receipt", () => {
    const sunday = Date.UTC(2026, 8, 27, 9);
    expect(shouldAutoSendWeekly({ collectingSince: iso(sunday - DAY), meteringStartedAt: iso(sunday) }, MON_NOON + 60_000)).toBe(true);
    expect(shouldAutoSendWeekly({ collectingSince: iso(sunday - DAY), meteringStartedAt: iso(sunday) }, MON_NOON + 60_000, { timeZone: CHICAGO })).toBe(true);
  });

  it("a workspace that started mid-week gets its partial week", () => {
    const wednesday = Date.UTC(2026, 8, 23, 14);
    expect(shouldAutoSendWeekly({ collectingSince: iso(wednesday - DAY), meteringStartedAt: iso(wednesday) }, MON_NOON + 60_000)).toBe(true);
  });

  it("with the zone known, the week ends at local Monday midnight; without it, no zone's week ends after Monday noon UTC", () => {
    expect(previousWeek(MON_NOON, CHICAGO).endMs).toBe(CHICAGO_WEEK_END);
    // Metering began Monday 06:00 UTC: after Chicago's week ended (05:00 UTC), before Monday noon UTC.
    const m = { collectingSince: iso(Date.UTC(2026, 8, 27, 6)), meteringStartedAt: iso(Date.UTC(2026, 8, 28, 6)) };
    expect(shouldAutoSendWeekly(m, MON_NOON + 60_000, { timeZone: CHICAGO })).toBe(false);
    expect(shouldAutoSendWeekly(m, MON_NOON + 60_000, { timeZone: "Asia/Tokyo" })).toBe(false); // Tokyo's week ended Sun 15:00 UTC
    expect(shouldAutoSendWeekly(m, MON_NOON + 60_000, { timeZone: "Pacific/Honolulu" })).toBe(true); // Honolulu's ends Mon 10:00 UTC
    // Zone-free: it may be due (runWeeklyReceipt, which knows the zone, decides).
    expect(shouldAutoSendWeekly(m, MON_NOON + 60_000)).toBe(true);
  });

  it("no meteringStartedAt (a workspace upgraded from 1.1.x): today's rule, collectingSince before Monday noon", () => {
    expect(shouldAutoSendWeekly({ collectingSince: iso(MON_1510 - DAY) }, MON_1510 + 60_000)).toBe(true);
    expect(shouldAutoSendWeekly({ collectingSince: iso(MON_NOON + 1) }, MON_1510)).toBe(false);
  });

  it("already sent this week stays sent", () => {
    const m = { collectingSince: iso(MON_NOON - 30 * DAY), meteringStartedAt: iso(MON_NOON - 30 * DAY), lastWeeklySentAt: iso(MON_NOON + HOUR) };
    expect(shouldAutoSendWeekly(m, MON_NOON + 2 * HOUR)).toBe(false);
  });
});

describe("r3 core-2 · the sweep records when metering started, once", () => {
  it("a priced first run stamps meteringStartedAt with its own time; later sweeps keep it", async () => {
    const w = await createWorld({ start: MON_1510 });
    await w.sweep();
    const first = (await w.meta())!;
    expect(first.meteringStartedAt).toBe(iso(MON_1510));
    expect(Date.parse(first.collectingSince)).toBeLessThan(MON_1510); // back-filled
    await w.sweepMinutes(3);
    expect((await w.meta())!.meteringStartedAt).toBe(iso(MON_1510));
  });

  it("an unpriced sweep does not stamp it; the first priced one does", async () => {
    const w = await createWorld({ bare: true, start: MON_1510 });
    await w.sweep();
    const unpriced = await w.meta();
    expect(unpriced).not.toBeNull();
    expect(unpriced!.meteringStartedAt).toBeUndefined();
    w.advance(5 * 60_000);
    await w.docs.putPrices(rigPrices(w.now()));
    await w.sweep();
    expect((await w.meta())!.meteringStartedAt).toBe(iso(w.now()));
  });

  it("a workspace upgraded without the field (already metering) is never stamped: it keeps the old rule", async () => {
    const w = await createWorld({ start: MON_1510 });
    await w.sweep();
    const m = (await w.meta())!;
    const upgraded: Meta = { ...m };
    delete upgraded.meteringStartedAt;
    await w.docs.putMeta(upgraded);
    await w.sweepMinutes(2);
    expect((await w.meta())!.meteringStartedAt).toBeUndefined();
  });
});

describe("r3 core-2 · the automatic receipt (runWeeklyReceipt) skips a week metering never reached", () => {
  for (const [name, start] of [
    ["the cold path at Mon 15:10Z", MON_1510],
    ["the judge path at Tue 01:10Z", TUE_0110],
  ] as const) {
    it(`${name}: skipped 'not_metered', nothing reaches the bell or a webhook`, async () => {
      const w = await createWorld({ start, options: { notificationApis: true }, settings: (s) => void (s.displayTimezone = CHICAGO) });
      await w.sweep();
      await w.sweepMinutes(3);
      const bellBefore = w.em.bell().length;
      const sinkBefore = w.em.sink().length;
      const r = await runWeeklyReceipt(w.deps, { mode: "ui" });
      expect(r.skipped).toBe("not_metered");
      expect(r.error).toBeUndefined();
      expect(w.em.bell().length).toBe(bellBefore);
      expect(w.em.sink().length).toBe(sinkBefore);
      expect((await w.meta())!.lastWeeklySentAt).toBeUndefined();
      // The member can still send one by hand ("Weekly receipt now" covers the seven days before today).
      const manual = await runWeeklyReceipt(w.deps, { mode: "manual" });
      expect(manual.skipped).toBeUndefined();
      expect(manual.sent).toBeGreaterThan(0);
    }, 60_000);
  }

  it("a workspace metering since mid-week gets its partial week, and the bell line names the coverage", async () => {
    const w = await createWorld({ options: { notificationApis: true } });
    await w.sweep();
    await w.sweepMinutes(2);
    const m = (await w.meta())!;
    const wednesday = Date.UTC(2026, 8, 23, 14);
    await w.docs.putMeta({ ...m, meteringStartedAt: iso(wednesday), collectingSince: iso(wednesday) });
    const r = await runWeeklyReceipt(w.deps, { mode: "ui" });
    expect(r.skipped).toBeUndefined();
    expect(r.sent).toBeGreaterThan(0);
    const bell = w.em.bell().find((b) => b.title.startsWith("Weekly receipt"));
    expect(bell).toBeDefined();
    const cov = r.receipt!.basis!.coverage!;
    expect(cov.metered).toBeLessThan(cov.expected);
    expect(bell!.text).toMatch(/ · metered (\d+%|under 1%) of the week · /);
    expect(bell!.text.endsWith(` · ${CREDIT_STRINGS.signature}`)).toBe(true);
  }, 60_000);
});

describe("r3 core-2 · the bell line carries a partial week's coverage", () => {
  const receipt = (metered: number, expected: number): WeeklyReceipt =>
    ({
      periodStart: iso(Date.UTC(2026, 8, 21)),
      periodEnd: iso(Date.UTC(2026, 8, 28)),
      label: "Sep 21–27, 2026",
      tz: "UTC",
      savedM: 4_000_000,
      whpM: 8_000_000,
      paidM: 4_000_000,
      ratio: 0.5,
      lines: [],
      openIncidents: [],
      basis: { prices: [], unpricedCount: 0, coverage: { unit: "minutes", metered, expected } },
    }) as unknown as WeeklyReceipt;
  const line = (r: WeeklyReceipt) => renderAlert(canonicalPayload("receipt.weekly", { receipt: r, workspace: "w", linkBase: "" })).line;

  it("a whole week: the line is unchanged", () => {
    expect(line(receipt(10_080, 10_080))).toBe(`Saved by Cribl $40 · would have paid $80 · paid $40 · 50% saved · ${CREDIT_STRINGS.signature}`);
  });

  it("a partial week: '· metered 71% of the week' before the signature (floored, never 100% while a minute is missing)", () => {
    expect(line(receipt(7_200, 10_080))).toBe(`Saved by Cribl $40 · would have paid $80 · paid $40 · 50% saved · metered 71% of the week · ${CREDIT_STRINGS.signature}`);
    expect(line(receipt(10_079, 10_080))).toContain("· metered 99% of the week ·");
    expect(line(receipt(30, 10_080))).toContain("· metered under 1% of the week ·");
  });

  it("an older receipt without coverage: unchanged", () => {
    const r = receipt(1, 2);
    delete (r as { basis?: unknown }).basis;
    expect(line(r)).toBe(`Saved by Cribl $40 · would have paid $80 · paid $40 · 50% saved · ${CREDIT_STRINGS.signature}`);
  });
});

void mondayNoonUtc;
