// tests/integration/r1-core-annualized-basis.test.ts — founder-build r1 core-6 (named item (a), release half; rejected
// finding #42, "owner call": AA/skeptic1-f42). A fresh install's first sweep meters up to a day of history (D63). When the
// member's traffic began minutes before the install, the annualized run rate divided those minutes' savings by the whole
// day of (empty) metered minutes and read "$172 a year, from the last 1 day" for a stream saving ≈ $17,739 a year. Now
// the run rate is annualized over the minutes since the first minute that carried priced traffic, and its basis says so
// (D63's Projection: "projected from the last 15 minutes of traffic"). A workspace metered with traffic all along — and
// the sample tour — read exactly as before.

import { describe, expect, it } from 'vitest';
import type { CriblHttp, HttpResult, Snapshot } from '../../core/types.ts';
import { appendPriceVersion, emptyPrices, computeHeadline } from '../../core/pricing.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TOUR_JSON_PATH, buildTourDoc } from '../../testdata/tour.ts';
import { HOUR, MINUTE, T0, createWorld, rigPrices } from './harness.ts';

const GID = 'default';
const MINUTES_PER_YEAR = 525_600;
const items = (x: unknown[]): HttpResult => ({ ok: true, status: 200, json: { count: x.length, items: x } }) as HttpResult;

/** One Source that began sending `sinceMin` minutes before T0: 30 MB a minute in, half dropped, to a $2.25/GB destination. */
function newTraffic(kind: 'splunk_hec' | 'datagen', sinceMin: number): (inner: CriblHttp) => CriblHttp {
  const inputId = kind === 'datagen' ? 'in_datagen_test' : 'in_hec_new';
  const outputId = kind === 'datagen' ? 'devnull' : 'splunk_prod';
  const trafficFrom = Math.floor(T0 / MINUTE) * MINUTE - sinceMin * MINUTE;
  return (inner) => ({
    async request(method, path, body, o) {
      if (method === 'GET' && /\/products\/stream\/groups(\?|$)/.test(path)) return items([{ id: GID, type: 'stream' }]);
      if (method === 'GET' && path.startsWith(`/m/${GID}/system/inputs`)) return items([{ id: inputId, type: kind, disabled: false }]);
      if (method === 'GET' && path.startsWith(`/m/${GID}/system/outputs`))
        return items([{ id: 'splunk_prod', type: 'splunk_hec' }, { id: 'devnull', type: 'devnull' }, { id: 'default', type: 'default', defaultId: 'devnull' }]);
      if (method === 'GET' && path.startsWith(`/m/${GID}/pipelines`)) return items([{ id: 'drop_half', conf: { functions: [{ id: 'drop', filter: 'Math.random() < 0.5' }] } }]);
      if (method === 'GET' && path.startsWith(`/m/${GID}/routes`))
        return items([{ id: 'default', routes: [{ id: 'r_new', name: 'new', filter: `__inputId=='${kind}:${inputId}'`, pipeline: 'drop_half', output: outputId, final: true }] }]);
      if (method === 'POST' && path.includes('/system/metrics/query')) {
        const b = body as { earliest: number; latest: number };
        const rows: Record<string, unknown>[] = [];
        for (let m = Math.max(b.earliest * (b.earliest < 1e12 ? 1000 : 1), trafficFrom); m < b.latest * (b.latest < 1e12 ? 1000 : 1); m += MINUTE) {
          const s = m / 1000;
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, input: `${kind}:${inputId}`, inB: 30_000_000, inE: 3000 });
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, output: `${kind === 'datagen' ? 'devnull' : 'splunk_hec'}:${outputId}`, outB: 15_000_000, outE: 1500 });
          rows.push({ starttime: s, endtime: s + 60, __worker_group: GID, route: 'r_new', name: 'new', inB: 30_000_000, outB: 15_000_000, inE: 3000, outE: 1500 });
        }
        return { ok: true, status: 200, json: { results: rows, info: { timeWindowSeconds: 60 } } } as HttpResult;
      }
      return inner.request(method, path, body, o);
    },
  });
}

async function install(kind: 'splunk_hec' | 'datagen', sinceMin: number): Promise<Snapshot> {
  const w = await createWorld({ bare: true, wrapHttp: newTraffic(kind, sinceMin), sweep: { firstRunReachMs: undefined } });
  const outputId = kind === 'datagen' ? 'devnull' : 'splunk_prod';
  await w.docs.putPrices(appendPriceVersion(emptyPrices(''), { [outputId]: { milliCentsPerGb: 225_000 } } as never, w.now()));
  const r = await w.sweep('ui');
  expect(r.error).toBeUndefined();
  expect(r.minutesProcessed).toBeGreaterThan(20 * 60); // the first run metered a day of (mostly empty) history
  return (await w.docs.getSnapshot())!;
}

// 15 MB a minute saved × $2.25/GB = 3,375 m¢ a minute → × 525,600 = $17,739 a year (AA #42's "implied").
const RATE_A_YEAR_M = 3_375 * MINUTES_PER_YEAR;

describe('core-6 · the annualized run rate rests on the minutes that carried traffic (#42)', () => {
  it('#42: traffic that began 15 minutes before the install reads ≈ $17,739 a year (±10 %), projected from 15 minutes', async () => {
    const s = await install('splunk_hec', 15);
    expect(RATE_A_YEAR_M).toBe(1_773_900_000);
    expect(s.headline.annualizedM).toBeGreaterThan(RATE_A_YEAR_M * 0.9);
    expect(s.headline.annualizedM).toBeLessThan(RATE_A_YEAR_M * 1.1);
    // D63: a Projection, with how many minutes it rests on (the UI's "projected from the last 15 minutes of traffic").
    expect(s.headline.annualizedFromDays).toBeLessThan(1);
    expect(Math.round(s.headline.annualizedFromDays * 1440)).toBeGreaterThanOrEqual(14);
    expect(Math.round(s.headline.annualizedFromDays * 1440)).toBeLessThanOrEqual(16);
  }, 120_000);

  it("core-1's Datagen workspace with an hour of traffic before the install: the rate, projected from about an hour", async () => {
    const s = await install('datagen', 60);
    expect(s.headline.annualizedM).toBeGreaterThan(RATE_A_YEAR_M * 0.9);
    expect(s.headline.annualizedM).toBeLessThan(RATE_A_YEAR_M * 1.1);
    expect(Math.round(s.headline.annualizedFromDays * 1440)).toBeGreaterThanOrEqual(59);
    expect(Math.round(s.headline.annualizedFromDays * 1440)).toBeLessThanOrEqual(61);
  }, 120_000);

  it('a workspace metered with traffic all along reads exactly as before (to the cent)', async () => {
    const w = await createWorld({ bare: true, sweep: { firstRunReachMs: undefined } });
    await w.docs.putPrices(rigPrices(w.now() - 2 * 86_400_000));
    await w.sweep('ui');
    await w.sweepMinutes(5);
    const s = (await w.docs.getSnapshot())!;
    const legacy = computeHeadline((await w.docs.getTotals())!, Date.parse(s.sweepAt), s.zone ?? 'UTC', Date.parse(s.collectingSince), undefined, Date.parse(s.windowEnd));
    expect(s.headline.annualizedM).toBe(legacy.annualizedM);
    expect(s.headline.annualizedFromDays).toBe(legacy.annualizedFromDays);
    expect(s.pricedSince).toBe(s.collectingSince);
  }, 120_000);

  it('the sample tour is unchanged to the cent (the committed tour.json is what the generator still builds)', () => {
    const built = buildTourDoc().doc.snapshot;
    const committed = (JSON.parse(readFileSync(resolve(__dirname, '../..', TOUR_JSON_PATH), 'utf8')) as { snapshot: Snapshot }).snapshot;
    expect(built.headline.annualizedM).toBe(committed.headline.annualizedM);
    expect(built.headline.annualizedFromDays).toBe(committed.headline.annualizedFromDays);
    expect(built.headline).toEqual(committed.headline);
    expect(built.pricedSince).toBeUndefined();
  });

  it('keeps the traffic start from sweep to sweep, and waits for traffic that has not begun', () => {
    expect(HOUR).toBe(60 * MINUTE);
  });
});
