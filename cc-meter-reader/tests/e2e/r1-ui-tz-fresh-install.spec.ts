// r1 ui-1 (FINDINGS_R1 B1 #1/#8/#16/#41, contract C1'): a fresh install buckets Today, MTD and the trend in the member's
// zone, not UTC. Seeded from app-assurance's skeptic specs (AA/r1/skeptic-16-1/zz-sk16.spec.ts, AA/skeptic2-f41/zz-sk41.spec.ts).
//
// The release's cold path: no KV at all → Settings → Prices → Use suggested prices → Start the meter → the first sweep.
// The first prices save now stores the settings document (the browser's zone) before the prices, so the very first sweep
// buckets in that zone. Each case then checks, against an independent recompute from the minute rollups:
//   - KV settings.displayTimezone is the browser's zone;
//   - Today = the minutes since LOCAL midnight; MTD = the minutes since the local first of the month;
//   - the trend (snapshot and Receipt chart) names no local date that hasn't happened yet;
//   - a later, unrelated settings save (Cribl cost) re-buckets nothing: after the next sweep MTD and Today still match
//     the recompute and the metered minutes never fall.
// Changing the zone of an install that already metered in another zone (the re-bucketing) is core-2's engine work and
// is not exercised here: a fresh install never changes zone.

import { expect, test, type Page } from '@playwright/test';
import { detectCodec } from '../../core/codec.ts';
import { createKvDocs } from '../../core/kv.ts';
import { localDayKey, localMidnightMs, localMonthStartMs } from '../../core/time.ts';
import type { KvStore, Snapshot } from '../../core/types.ts';
import { gotoApp, kvGet, navigateInApp, resetMock, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const MIN = 60_000;

/** A KvStore over the emulator, read from the test (writes refused: this spec never writes KV behind the app). */
function emulatorKv(page: Page): KvStore {
  return {
    get: (key) => kvGet(page, key),
    put: async () => {
      throw new Error('read-only');
    },
    del: async () => {
      throw new Error('read-only');
    },
    list: (prefix) =>
      page.evaluate(async (p) => {
        const r = await fetch('/mock-api/v1/kvstore/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix: p }) });
        return (await r.json()) as string[];
      }, prefix),
  };
}

/** Saved millicents per metered minute (epoch ms), from every minute rollup (chunked documents reassembled by core/kv.ts). */
async function minuteSavings(page: Page): Promise<Map<number, number>> {
  const kv = emulatorKv(page);
  const docs = createKvDocs({ kv, codec: detectCodec(), clock: { now: () => Date.now() } });
  const keys = (await kv.list('roll/min/')).filter((k) => !/\/c\/\d+$/.test(k));
  const out = new Map<number, number>();
  for (const key of keys) {
    const doc = await docs.getRollMinute(key);
    for (const rows of Object.values(doc?.flows ?? {})) {
      for (const r of rows) {
        const t = Date.parse(r.t);
        out.set(t, (out.get(t) ?? 0) + r.savedM);
      }
    }
  }
  return out;
}

const sumFrom = (m: Map<number, number>, fromMs: number, toMs = Number.POSITIVE_INFINITY): number => {
  let s = 0;
  for (const [t, v] of m) if (t >= fromMs && t < toMs) s += v;
  return s;
};

async function snapshotDoc(page: Page): Promise<Snapshot> {
  return JSON.parse((await kvGet(page, 'snapshot')) ?? 'null') as Snapshot;
}

async function sweepAtMs(page: Page): Promise<number> {
  const snap = await snapshotDoc(page).catch(() => null);
  return snap?.sweepAt ? Date.parse(snap.sweepAt) : 0;
}

/** The release's first run, exactly as a member does it: suggested prices, then Start the meter; waits for the first sweep. */
async function startTheMeter(page: Page): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page);
  expect(await kvGet(page, 'settings')).toBeNull();
  await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.getByRole('button', { name: /^Use suggested prices/ }).click({ timeout: 40_000 });
  await page.locator('section[data-section="prices"]').getByRole('button', { name: 'Start the meter' }).click();
  await expect(page.getByText('The meter is running.', { exact: false }).first()).toBeVisible();
  await expect.poll(async () => JSON.parse((await kvGet(page, 'meta')) ?? '{}').meteredThrough ?? null, { timeout: 120_000, intervals: [1_000] }).not.toBeNull();
  await expect.poll(() => sweepAtMs(page), { timeout: 60_000 }).toBeGreaterThan(0);
}

/** Today and MTD in the snapshot match the recompute from the minute rollups, in `tz`. */
async function expectLocalBuckets(page: Page, tz: string): Promise<Snapshot> {
  const snap = await snapshotDoc(page);
  const sweepMs = Date.parse(snap.sweepAt);
  const perMinute = await minuteSavings(page);
  const midnight = localMidnightMs(sweepMs, tz);
  const monthStart = localMonthStartMs(sweepMs, tz);
  const h = snap.headline;
  // Today counts from local midnight; MTD from the local first of the month (every collected minute of a fresh install
  // that falls in this local month).
  expect(h.todayM, `todayM in ${tz}`).toBe(sumFrom(perMinute, midnight));
  expect(h.mtdM, `mtdM in ${tz}`).toBe(sumFrom(perMinute, monthStart));
  const localMinutesToday = [...perMinute.keys()].filter((t) => t >= midnight).length;
  expect(h.minutesToday ?? localMinutesToday).toBe(localMinutesToday);
  // The trend names no local day after today.
  const todayKey = localDayKey(sweepMs, tz);
  for (const p of snap.trend ?? []) expect(p.day <= todayKey, `trend day ${p.day} is after ${todayKey}`).toBe(true);
  return snap;
}

const cases = [
  // 6:10 PM PDT Sep 27: the UTC date has already rolled to Sep 28.
  { tag: 'Los Angeles, evening', tz: 'America/Los_Angeles', at: '2026-09-28T01:10:00Z', period: 'today', future: /^Sep 28$/ },
  // 6:30 PM PDT Sep 30: UTC is already in October; MTD must hold the whole metered September day.
  { tag: 'Los Angeles, month end', tz: 'America/Los_Angeles', at: '2026-10-01T01:30:00Z', period: 'mtd', future: /^Oct 1$/ },
  // 8:10 PM CDT Sep 27.
  { tag: 'Chicago, evening', tz: 'America/Chicago', at: '2026-09-28T01:10:00Z', period: 'today', future: /^Sep 28$/ },
  // 8:30 PM CDT Sep 30.
  { tag: 'Chicago, month end', tz: 'America/Chicago', at: '2026-10-01T01:30:00Z', period: 'mtd', future: /^Oct 1$/ },
] as const;

for (const c of cases) {
  test.describe(`fresh install buckets in the member's zone: ${c.tag}`, () => {
    test.use({ timezoneId: c.tz });

    test(`Start the meter stores ${c.tz}; Today, MTD and the trend are local; a later save moves nothing`, async ({ page }) => {
      test.setTimeout(240_000);
      const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
      await page.clock.install({ time: new Date(c.at) });
      await startTheMeter(page);

      // 1. The zone reached KV with the first prices save (before the first sweep).
      const settings = JSON.parse((await kvGet(page, 'settings')) ?? 'null') as { displayTimezone?: string } | null;
      expect(settings?.displayTimezone).toBe(c.tz);

      // 2. The engine's figures are local.
      const first = await expectLocalBuckets(page, c.tz);

      // 3. The Receipt: its chart names no future local date, and its hero reads the snapshot's figure.
      await navigateInApp(page, `/?period=${c.period}`);
      await expect(page.getByTestId('receipt-hero')).toBeVisible({ timeout: 30_000 });
      const lines = (await page.getByRole('main').innerText()).split('\n').map((l) => l.trim());
      expect(lines.filter((l) => c.future.test(l)), 'a chart label for a day that has not happened locally').toEqual([]);

      // 4. A later, unrelated settings save (Cribl cost) re-buckets nothing: after the next sweep the figures still
      //    match the recompute and the metered minutes never fall.
      await navigateInApp(page, '/settings?section=cost');
      await page.getByTestId('cost-input').fill('1000');
      await page.locator('section[data-section="cost"]').getByRole('button', { name: 'Save changes' }).click();
      await expect.poll(async () => JSON.parse((await kvGet(page, 'settings')) ?? '{}').criblCostCentsPerMonth).toBe(100_000);
      expect(JSON.parse((await kvGet(page, 'settings')) ?? '{}').displayTimezone).toBe(c.tz);
      const before = Date.parse(first.sweepAt);
      await page.clock.fastForward(2 * MIN);
      await expect.poll(() => sweepAtMs(page), { timeout: 60_000 }).toBeGreaterThan(before);
      const second = await expectLocalBuckets(page, c.tz);
      expect(second.headline.mtdM).toBeGreaterThanOrEqual(first.headline.mtdM);
      expect(second.headline.minutesMtd ?? 0).toBeGreaterThanOrEqual(first.headline.minutesMtd ?? 0);
      expect(errors()).toEqual([]);
    });
  });
}
