// tests/unit/r3-core-gap-after-since.test.ts — founder-build r3 core-5 (FINDINGS_R3 #3, major: the landing figure;
// AA/r3/2 zz-r3m-gap-after-since.test.ts, gap-after-since.f8953da.out.txt).
//
// r2 core-5 (R2 #7) stopped a metering gap BEFORE the first priced minute from inflating the annualized run rate by
// inferring the priced-since day's empty minutes: the day keeps the minutes from `since` to its end (or the cursor),
// capped at what it metered. When metering stopped soon AFTER the first priced minute (the tab closed; the catch-up
// reaches back only so far), that cap is the whole day's metered count, so the empty pre-traffic minutes stayed in the
// basis and the landing figure (Annualized, since r2 ui-2) read 0.754× the true rate, 0.477× at +34 h, 0.681× at +58 h.
//
// Now nothing is inferred: the sweep records, for the priced-since day, the metered minutes before the first priced
// minute (Snapshot.pricedSinceEmptyMinutes, carried with pricedSince), and the basis leaves exactly those out. A
// snapshot without the count (an older one, or a zone change since it was taken) keeps r2's arithmetic.

import { describe, expect, it } from "vitest";
import { appendPriceVersion, computeHeadline, emptyPrices } from "../../core/pricing.ts";
import type { CriblHttp, HttpResult, TotalsDoc } from "../../core/types.ts";
import { HOUR, MINUTE, T0, createWorld } from "../integration/harness.ts";

const SAVED = 100_000; // $1 saved per traffic minute
const RATE = 525_600 * SAVED; // the true annual rate: $1 a minute
const day = (trafficMinutes: number, meteredMinutes: number) => ({ whpM: trafficMinutes * 2 * SAVED, paidM: trafficMinutes * SAVED, savedM: trafficMinutes * SAVED, minutes: meteredMinutes });
const totalsOf = (byDay: Record<string, ReturnType<typeof day>>): TotalsDoc => ({ schemaVersion: 1, updatedAt: "", byDay }) as TotalsDoc;

describe("r3 core-5 · the basis leaves out exactly the recorded empty minutes (computeHeadline)", () => {
  it("case 1: day 1 metered 00:00–08:30, traffic from 08:00, the tab closed at 08:30, back on day 3: ratio 1.00 (was 0.754)", () => {
    const collecting = Date.UTC(2026, 9, 5, 0, 0);
    const pricedSince = Date.UTC(2026, 9, 5, 8, 0);
    const now = Date.UTC(2026, 9, 7, 10, 0);
    const totals = totalsOf({ "2026-10-05": day(30, 510), "2026-10-06": day(840, 840), "2026-10-07": day(600, 600) });
    const h = computeHeadline(totals, now, "UTC", collecting, undefined, now, { pricedSinceMs: pricedSince, emptyMinutesBeforePriced: 480 });
    expect(h.annualizedM / RATE).toBeCloseTo(1, 2);
    // Without the count: r2's arithmetic (the residue this item fixes), kept as the fallback.
    const fallback = computeHeadline(totals, now, "UTC", collecting, undefined, now, { pricedSinceMs: pricedSince });
    expect(fallback.annualizedM / RATE).toBeLessThan(0.8);
  });

  for (const nowH of [34, 58]) {
    it(`case 2: 720 empty minutes, traffic from 12:00, the tab closed 12:30, now +${nowH} h: ratio 1.00 (was ${nowH === 34 ? "0.477" : "0.681"})`, () => {
      const collecting = Date.UTC(2026, 9, 5, 0, 0);
      const pricedSince = Date.UTC(2026, 9, 5, 12, 0);
      const now = collecting + nowH * HOUR;
      const byDay: Record<string, ReturnType<typeof day>> = { "2026-10-05": day(30, 750) };
      if (nowH === 34) byDay["2026-10-06"] = day(600, 600);
      else {
        byDay["2026-10-06"] = day(840, 840);
        byDay["2026-10-07"] = day(600, 600);
      }
      const h = computeHeadline(totalsOf(byDay), now, "UTC", collecting, undefined, now, { pricedSinceMs: pricedSince, emptyMinutesBeforePriced: 720 });
      expect(h.annualizedM / RATE).toBeCloseTo(1, 2);
    });
  }

  it("R2 #7's gap-before case (day 2 metered 10:00–24:00, traffic from 11:00): 60 empty minutes recorded → ratio 1.00", () => {
    const collecting = Date.UTC(2026, 9, 5, 9, 0);
    const pricedSince = Date.UTC(2026, 9, 6, 11, 0);
    const now = Date.UTC(2026, 9, 7, 10, 0);
    const totals = totalsOf({ "2026-10-05": day(0, 5), "2026-10-06": day(780, 840), "2026-10-07": day(600, 600) });
    const h = computeHeadline(totals, now, "UTC", collecting, undefined, now, { pricedSinceMs: pricedSince, emptyMinutesBeforePriced: 60 });
    expect(h.annualizedM / RATE).toBeCloseTo(1, 2);
  });

  it("R2 #7's clamp case (metered 10:00–10:30, traffic from 10:05): 5 empty minutes → ratio 1.00, from 25 minutes", () => {
    const collecting = Date.UTC(2026, 9, 5, 9, 0);
    const pricedSince = Date.UTC(2026, 9, 6, 10, 5);
    const now = Date.UTC(2026, 9, 6, 10, 30);
    const totals = totalsOf({ "2026-10-05": day(0, 5), "2026-10-06": day(25, 30) });
    const h = computeHeadline(totals, now, "UTC", collecting, undefined, now, { pricedSinceMs: pricedSince, emptyMinutesBeforePriced: 5 });
    expect(h.annualizedM / RATE).toBeCloseTo(1, 2);
    expect(h.annualizedFromDays).toBeCloseTo(25 / 1440, 6);
  });

  it("a count larger than the day (a stale or foreign document) never empties the basis: the first priced minute stays", () => {
    const collecting = Date.UTC(2026, 9, 5, 9, 0);
    const pricedSince = Date.UTC(2026, 9, 6, 10, 5);
    const now = Date.UTC(2026, 9, 6, 10, 30);
    const h = computeHeadline(totalsOf({ "2026-10-06": day(25, 30) }), now, "UTC", collecting, undefined, now, { pricedSinceMs: pricedSince, emptyMinutesBeforePriced: 9_999 });
    expect(h.annualizedM).toBeGreaterThan(0);
    expect(Number.isFinite(h.annualizedM)).toBe(true);
  });

  it("control: traffic from collecting (no empty minutes): unchanged", () => {
    const since = Date.UTC(2026, 9, 6, 9, 0);
    const now = Date.UTC(2026, 9, 6, 12, 0);
    const h = computeHeadline(totalsOf({ "2026-10-06": day(180, 180) }), now, "UTC", since, undefined, now, { pricedSinceMs: since, emptyMinutesBeforePriced: 0 });
    expect(h.annualizedM).toBe(RATE);
  });
});

// ─── End to end: the sweep records the count ──────────────────────────────────

const GID = "default";
const items = (x: unknown[]): HttpResult => ({ ok: true, status: 200, json: { count: x.length, items: x } }) as HttpResult;
/** One HEC Source whose traffic began `sinceMin` minutes before T0: 30 MB a minute in, half dropped, to a $2.25/GB destination. */
function newTraffic(sinceMin: number): (inner: CriblHttp) => CriblHttp {
  const trafficFrom = Math.floor(T0 / MINUTE) * MINUTE - sinceMin * MINUTE;
  return (inner) => ({
    async request(method, path, body, o) {
      if (method === "GET" && /\/products\/stream\/groups(\?|$)/.test(path)) return items([{ id: GID, type: "stream" }]);
      if (method === "GET" && path.startsWith(`/m/${GID}/system/inputs`)) return items([{ id: "in_hec_new", type: "splunk_hec", disabled: false }]);
      if (method === "GET" && path.startsWith(`/m/${GID}/system/outputs`)) return items([{ id: "splunk_prod", type: "splunk_hec" }, { id: "devnull", type: "devnull" }, { id: "default", type: "default", defaultId: "devnull" }]);
      if (method === "GET" && path.startsWith(`/m/${GID}/pipelines`)) return items([{ id: "drop_half", conf: { functions: [{ id: "drop", filter: "Math.random() < 0.5" }] } }]);
      if (method === "GET" && path.startsWith(`/m/${GID}/routes`))
        return items([{ id: "default", routes: [{ id: "r_new", name: "new", filter: "__inputId=='splunk_hec:in_hec_new'", pipeline: "drop_half", output: "splunk_prod", final: true }] }]);
      if (method === "POST" && path.includes("/system/metrics/query")) {
        const b = body as { earliest: number; latest: number };
        const rows: Record<string, unknown>[] = [];
        for (let m = Math.max(b.earliest * (b.earliest < 1e12 ? 1000 : 1), trafficFrom); m < b.latest * (b.latest < 1e12 ? 1000 : 1); m += MINUTE) {
          const s = m / 1000;
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, input: "splunk_hec:in_hec_new", inB: 30_000_000, inE: 3000 });
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, output: "splunk_hec:splunk_prod", outB: 15_000_000, outE: 1500 });
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, route: "r_new", name: "new", inB: 30_000_000, outB: 15_000_000, inE: 3000, outE: 1500 });
        }
        return { ok: true, status: 200, json: { results: rows, info: { timeWindowSeconds: 60 } } } as HttpResult;
      }
      return inner.request(method, path, body, o);
    },
  });
}
// 15 MB a minute saved × $2.25/GB = 3,375 m¢ a minute.
const TRUE_RATE_M = 3_375 * 525_600;

async function install(sinceMin: number) {
  const w = await createWorld({ bare: true, wrapHttp: newTraffic(sinceMin), sweep: { firstRunReachMs: undefined } });
  await w.docs.putPrices(appendPriceVersion(emptyPrices(""), { splunk_prod: { milliCentsPerGb: 225_000 } } as never, w.now()));
  const r = await w.sweep("ui");
  expect(r.error).toBeUndefined();
  return w;
}

describe("r3 core-5 · end to end: the first run records the empty minutes, and a later gap no longer drags the landing figure", () => {
  it("traffic from 30 minutes before the install: the snapshot records the since-day's metered minutes before it", async () => {
    const w = await install(30);
    const s = (await w.docs.getSnapshot())!;
    const pricedSince = Date.parse(s.pricedSince!);
    expect(pricedSince).toBe(Math.floor(T0 / MINUTE) * MINUTE - 30 * MINUTE);
    const dayStart = Date.UTC(2026, 8, 28);
    const collecting = Date.parse(s.collectingSince);
    const expected = Math.round((pricedSince - Math.max(dayStart, collecting)) / MINUTE);
    expect(s.pricedSinceEmptyMinutes).toBe(expected);
    expect(s.headline.annualizedM / TRUE_RATE_M).toBeCloseTo(1, 2);
    // Carried unchanged by the next sweeps.
    await w.sweepMinutes(3);
    expect((await w.docs.getSnapshot())!.pricedSinceEmptyMinutes).toBe(expected);
  }, 180_000);

  it("the tab closes right after the install and comes back 58 h later (a recorded gap after the first priced minute): 1.00 ± 0.01 (was 0.84)", async () => {
    const w = await install(30);
    w.advance(58 * HOUR);
    for (let i = 0; i < 6; i++) {
      const r = await w.sweep("ui");
      expect(r.error).toBeUndefined();
      if (!r.catchUpRemainingMinutes) break;
      w.advance(MINUTE);
    }
    const meta = (await w.docs.getMeta())!;
    expect(meta.gaps?.length ?? 0).toBeGreaterThan(0); // the stretch older than the backfill reach, never metered
    const s = (await w.docs.getSnapshot())!;
    expect(s.headline.annualizedM / TRUE_RATE_M).toBeGreaterThan(0.99);
    expect(s.headline.annualizedM / TRUE_RATE_M).toBeLessThan(1.01);
  }, 300_000);
});
