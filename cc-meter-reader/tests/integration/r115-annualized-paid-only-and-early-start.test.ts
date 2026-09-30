// tests/integration/r115-annualized-paid-only-and-early-start.test.ts — 1.1.5, end to end through the sweep: the two
// annualized-figure traps a 1.1.4 hardening pass found off the README path (HARDENING_1.1.4 A1, A2). The unit half,
// with the arithmetic, is tests/unit/r115-pricedsince.test.ts.
//
// A1. DevNull priced, its counterfactual set to "Nowhere (archive-only data)": the annualized "You paid" read about
//     $321,851 a year and grew every sweep, for about $2,717 a year of real spend.
// A2. Start the meter before any traffic exists, then build the Datagen: the annualized figure read up to 3× the truth
//     for its first minutes, and its caption counted fewer minutes than were metered.

import { describe, expect, it } from 'vitest';
import type { CriblHttp, HttpResult, Snapshot } from '../../core/types.ts';
import { appendPriceVersion, emptyPrices } from '../../core/pricing.ts';
import { HOUR, MINUTE, T0, createWorld, type World } from './harness.ts';

const GID = 'default';
const MINUTES_PER_YEAR = 525_600;
const items = (x: unknown[]): HttpResult => ({ ok: true, status: 200, json: { count: x.length, items: x } }) as HttpResult;
const T0_MIN = Math.floor(T0 / MINUTE) * MINUTE;

/**
 * A fresh workspace whose README Datagen (30 MB a minute in, half dropped, to devnull:devnull on a Final route) exists
 * and sends from `trafficFrom` on. Before that the workspace has no Source and no route: nothing to meter.
 */
function datagenFrom(trafficFrom: number, now: () => number): (inner: CriblHttp) => CriblHttp {
  return (inner) => ({
    async request(method, path, body, o) {
      const built = now() >= trafficFrom;
      if (method === 'GET' && /\/products\/stream\/groups(\?|$)/.test(path)) return items([{ id: GID, type: 'stream' }]);
      if (method === 'GET' && path.startsWith(`/m/${GID}/system/inputs`)) return items(built ? [{ id: 'in_datagen_test', type: 'datagen', disabled: false }] : []);
      if (method === 'GET' && path.startsWith(`/m/${GID}/system/outputs`)) return items([{ id: 'devnull', type: 'devnull' }, { id: 'default', type: 'default', defaultId: 'devnull' }]);
      if (method === 'GET' && path.startsWith(`/m/${GID}/pipelines`)) return items(built ? [{ id: 'drop_half', conf: { functions: [{ id: 'drop', filter: 'Math.random() < 0.5' }] } }] : []);
      if (method === 'GET' && path.startsWith(`/m/${GID}/routes`))
        return items([
          { id: 'default', routes: built ? [{ id: 'r_new', name: 'new', filter: "__inputId=='datagen:in_datagen_test'", pipeline: 'drop_half', output: 'devnull', final: true }] : [] },
        ]);
      if (method === 'POST' && path.includes('/system/metrics/query')) {
        const b = body as { earliest: number; latest: number };
        const rows: Record<string, unknown>[] = [];
        const from = Math.max(b.earliest * (b.earliest < 1e12 ? 1000 : 1), trafficFrom);
        for (let m = from; m < b.latest * (b.latest < 1e12 ? 1000 : 1); m += MINUTE) {
          const s = m / 1000;
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, input: 'datagen:in_datagen_test', inB: 30_000_000, inE: 3000 });
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, output: 'devnull:devnull', outB: 15_000_000, outE: 1500 });
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, route: 'r_new', name: 'new', inB: 30_000_000, outB: 15_000_000, inE: 3000, outE: 1500 });
        }
        return { ok: true, status: 200, json: { results: rows, info: { timeWindowSeconds: 60 } } } as HttpResult;
      }
      return inner.request(method, path, body, o);
    },
  });
}

// 15 MB a minute × $2.25/GB = 3,375 m¢ a minute — saved under This destination, paid under Nowhere — × 525,600 =
// $17,739 a year: the steady truth of both scenarios.
const PER_MIN_M = 3_375;
const RATE_M = PER_MIN_M * MINUTES_PER_YEAR;

async function world(trafficFrom: number, kind: 'same' | 'none'): Promise<World> {
  let clock = (): number => T0;
  const w = await createWorld({ bare: true, wrapHttp: datagenFrom(trafficFrom, () => clock()), sweep: { firstRunReachMs: undefined } });
  clock = w.now;
  // Start the meter: DevNull priced by hand, with This destination or Nowhere as its counterfactual.
  await w.docs.putPrices(appendPriceVersion(emptyPrices(''), { devnull: { milliCentsPerGb: 225_000, counterfactual: { kind } } } as never, w.now()));
  const r = await w.sweep('ui');
  expect(r.error).toBeUndefined();
  return w;
}

const snap = async (w: World): Promise<Snapshot> => (await w.docs.getSnapshot())!;
/** The caption's minutes: "projected from the last N minutes of traffic". */
const captionMinutes = (s: Snapshot): number => Math.round(s.headline.annualizedFromDays * 1440);
const pricedMinutes = (s: Snapshot): number => Math.round((Date.parse(s.windowEnd) - Date.parse(s.pricedSince!)) / MINUTE);

describe('1.1.5 A1 · "Nowhere" (archive-only data): the annualized You paid is the real spend, and holds', () => {
  it('two hours of traffic before Start: You paid ≈ $17,739 a year from the first sweep, flat across sweeps and hours', async () => {
    const trafficFrom = T0_MIN - 2 * HOUR;
    const w = await world(trafficFrom, 'none');
    const first = await snap(w);
    expect(first.pricedSince).toBe(new Date(trafficFrom).toISOString());
    expect(first.headline.annualizedM).toBe(0);
    expect(first.headline.annualizedWhpM).toBe(0);
    expect(first.headline.annualizedPaidM! / RATE_M).toBeGreaterThan(0.98); // 1.1.4: 121× ($321,851 for $2,717)
    expect(first.headline.annualizedPaidM! / RATE_M).toBeLessThan(1.02);
    expect(captionMinutes(first)).toBe(pricedMinutes(first));

    // Fifteen more sweeps: the start stands and the figure does not grow (1.1.4: +$2.75K a sweep).
    for (const r of await w.sweepMinutes(15)) expect(r.error).toBeUndefined();
    const later = await snap(w);
    expect(later.pricedSince).toBe(first.pricedSince);
    expect(later.pricedSinceEmptyMinutes).toBe(first.pricedSinceEmptyMinutes);
    expect(later.headline.annualizedPaidM! / first.headline.annualizedPaidM!).toBeGreaterThan(0.999);
    expect(later.headline.annualizedPaidM! / first.headline.annualizedPaidM!).toBeLessThan(1.001);
    expect(captionMinutes(later)).toBe(pricedMinutes(later));

    // Three hours on, the traffic's start has left the minute rows the sweep reads; the start still stands.
    w.advance(3 * HOUR);
    for (let i = 0; i < 12; i++) {
      const r = await w.sweep('ui');
      expect(r.error).toBeUndefined();
      if (!r.catchUpRemainingMinutes) break;
      w.advance(MINUTE);
    }
    const hoursOn = await snap(w);
    expect(hoursOn.pricedSince).toBe(first.pricedSince);
    expect(hoursOn.headline.annualizedPaidM! / RATE_M).toBeGreaterThan(0.98);
    expect(hoursOn.headline.annualizedPaidM! / RATE_M).toBeLessThan(1.02);
  }, 300_000);
});

describe('1.1.5 A2 · Start the meter before any traffic: right from the first priced sweep', () => {
  it('traffic 5 minutes after Start: within 2% of the truth at every sweep, the caption counting every traffic minute', async () => {
    const trafficFrom = T0_MIN + 5 * MINUTE;
    const w = await world(trafficFrom, 'same');
    const start = await snap(w);
    expect(start.headline.annualizedM).toBe(0);

    // Sweep each minute until the workspace's first priced sweep (the inventory learns the new Datagen), then on.
    let firstPriced: Snapshot | undefined;
    const readings: { windowEnd: string; ratio: number; caption: number; priced: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const [r] = await w.sweepMinutes(1);
      expect(r.error).toBeUndefined();
      const s = await snap(w);
      if (!firstPriced && s.headline.whp30dM > 0) firstPriced = s;
      if (!firstPriced) {
        expect(s.headline.annualizedM).toBe(0);
        continue;
      }
      readings.push({ windowEnd: s.windowEnd, ratio: s.headline.annualizedM / RATE_M, caption: captionMinutes(s), priced: pricedMinutes(s) });
      if (readings.length >= 15) break;
    }
    expect(firstPriced, 'the Datagen was never metered').toBeDefined();
    expect(Date.parse(firstPriced!.pricedSince!)).toBeGreaterThanOrEqual(trafficFrom);
    // The trap's own shape: the first priced sweep rewrote the minute before its window, and that minute is where priced
    // traffic began (1.1.4 set pricedSince to the window's end and read 2× here).
    expect(pricedMinutes(firstPriced!)).toBe(2);
    expect(readings.length).toBeGreaterThanOrEqual(10);
    for (const x of readings) {
      expect(x.ratio, `annualized ÷ truth at ${x.windowEnd}`).toBeGreaterThan(0.98); // 1.1.4: 2×, 3×, … 1.19× at 13 minutes
      expect(x.ratio, `annualized ÷ truth at ${x.windowEnd}`).toBeLessThan(1.02);
      expect(x.caption, `caption minutes at ${x.windowEnd}`).toBe(x.priced);
    }
    // The caption grows a minute a sweep from the first priced sweep's own count.
    expect(readings.at(-1)!.caption - readings[0].caption).toBe(readings.length - 1);
  }, 300_000);

  it('control: traffic already flowing when the meter starts reads the truth, as in 1.1.4', async () => {
    const w = await world(T0_MIN - 2 * HOUR, 'same');
    const s = await snap(w);
    expect(s.pricedSince).toBe(new Date(T0_MIN - 2 * HOUR).toISOString());
    expect(s.headline.annualizedM / RATE_M).toBeGreaterThan(0.98);
    expect(s.headline.annualizedM / RATE_M).toBeLessThan(1.02);
    for (const r of await w.sweepMinutes(5)) expect(r.error).toBeUndefined();
    const later = await snap(w);
    expect(later.pricedSince).toBe(s.pricedSince);
    expect(later.headline.annualizedM / RATE_M).toBeGreaterThan(0.98);
    expect(later.headline.annualizedM / RATE_M).toBeLessThan(1.02);
  }, 300_000);
});
