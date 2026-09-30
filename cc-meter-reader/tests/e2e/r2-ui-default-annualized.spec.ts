// r2 ui-2 (founder-build round 2, named item (a), contract C6): a new install opens the Receipt on the annualized run
// rate. The release's cold path, exactly as a member does it: no KV → Settings → Prices → Use suggested prices → Start the
// meter → the first sweep → the Receipt with no ?period=.
//
// The honesty check the flip rests on (round-2.md §ui-2): the landing figure is a year projected from the traffic, so it
// must stay near the traffic's own rate, and say it is a projection while under a day.
//   (i)   traffic that began 15 minutes before the install (the Leader keeps only those 15 minutes): Annualized, the
//         Projection pill, "projected from the last 15 minutes of traffic", within 0.5×–2× of the traffic's own rate;
//   (ii)  a day or more of history: Annualized, no pill;
//   (iii) a 30-minute metering gap before the first priced minute: still within 0.5×–2×. This one needs core-5
//         (FINDINGS_R2 #7, core/pricing.ts emptyBefore); it runs only once core's fix is present on the branch (checked
//         against core's own computeHeadline with the r2/4 probe case) and says so when it skips.
//   (iv)  founder-build r3 core-5 (FINDINGS_R3 #3): a gap AFTER the first priced minute (the tab closed ten minutes
//         after Start and came back two days later): the recorded empty minutes leave the basis, so the landing figure
//         stays near the traffic's own rate (r2's inference kept them in: 0.48–0.75×, 0.13× here).
// Round 3 tightened the honesty band from 0.5×–2× to 0.9×–1.1× (r3 core-5: the basis is counted, never inferred).
//
// The stored 'mtd' of an older first save is never migrated (ruling 5): tests/unit/settings.test.ts covers it.

import { expect, test, type Page } from '@playwright/test';
import { detectCodec } from '../../core/codec.ts';
import { fmtDollars } from '../../core/format.ts';
import { createKvDocs } from '../../core/kv.ts';
import { computeHeadline } from '../../core/pricing.ts';
import type { KvStore, Snapshot, TotalsDoc } from '../../core/types.ts';
import { gotoApp, kvGet, mockControl, navigateInApp, resetMock, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const MIN = 60_000;
const MINUTES_PER_YEAR = 525_600;

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

/** Per metered minute (epoch ms): saved and would-have-paid millicents, from every minute rollup. */
async function minuteMoney(page: Page): Promise<Map<number, { savedM: number; whpM: number }>> {
  const kv = emulatorKv(page);
  const docs = createKvDocs({ kv, codec: detectCodec(), clock: { now: () => Date.now() } });
  const keys = (await kv.list('roll/min/')).filter((k) => !/\/c\/\d+$/.test(k));
  const out = new Map<number, { savedM: number; whpM: number }>();
  for (const key of keys) {
    const doc = await docs.getRollMinute(key);
    for (const rows of Object.values(doc?.flows ?? {})) {
      for (const r of rows) {
        const t = Date.parse(r.t);
        const cur = out.get(t) ?? { savedM: 0, whpM: 0 };
        out.set(t, { savedM: cur.savedM + r.savedM, whpM: cur.whpM + r.whpM });
      }
    }
  }
  return out;
}

/** The traffic's own yearly rate: saved per minute that carried priced traffic × 525,600. */
async function trafficRateM(page: Page): Promise<{ rateM: number; minutes: number }> {
  const money = await minuteMoney(page);
  let saved = 0;
  let minutes = 0;
  for (const m of money.values()) {
    if (m.whpM <= 0) continue;
    saved += m.savedM;
    minutes++;
  }
  return { rateM: minutes > 0 ? (saved / minutes) * MINUTES_PER_YEAR : 0, minutes };
}

async function snapshotDoc(page: Page): Promise<Snapshot> {
  return JSON.parse((await kvGet(page, 'snapshot')) ?? 'null') as Snapshot;
}

async function sweepAtMs(page: Page): Promise<number> {
  const snap = await snapshotDoc(page).catch(() => null);
  return snap?.sweepAt ? Date.parse(snap.sweepAt) : 0;
}

/** The release's first run with the Leader keeping `retentionHours` of metrics: suggested prices, then Start the meter. */
async function startTheMeter(page: Page, retentionHours?: number): Promise<void> {
  await gotoApp(page, '/first-run');
  await resetMock(page, retentionHours !== undefined ? { options: { retentionHours } } : {});
  expect(await kvGet(page, 'settings')).toBeNull();
  await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);
  await page.getByRole('button', { name: /^Use suggested prices/ }).click({ timeout: 40_000 });
  await page.locator('section[data-section="prices"]').getByRole('button', { name: 'Start the meter' }).click();
  await expect(page.getByText('The meter is running.', { exact: false }).first()).toBeVisible();
  await expect.poll(async () => JSON.parse((await kvGet(page, 'meta')) ?? '{}').meteredThrough ?? null, { timeout: 120_000, intervals: [1_000] }).not.toBeNull();
  await expect.poll(() => sweepAtMs(page), { timeout: 60_000 }).toBeGreaterThan(0);
}

/** The Receipt with no ?period=: the landing period, its caption and pill. */
async function openReceipt(page: Page): Promise<void> {
  await navigateInApp(page, '/');
  await expect(page.getByTestId('receipt-hero')).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).searchParams.get('period')).toBeNull();
}

async function expectHeroNearTraffic(page: Page): Promise<number> {
  const snap = await snapshotDoc(page);
  const { rateM, minutes } = await trafficRateM(page);
  expect(minutes, 'minutes that carried priced traffic').toBeGreaterThan(0);
  const heroM = snap.headline.annualizedM;
  const ratio = heroM / rateM;
  expect(ratio, `hero ${fmtDollars(heroM)} a year vs the traffic's own ${fmtDollars(rateM)} (${minutes} traffic minutes)`).toBeGreaterThanOrEqual(0.9);
  expect(ratio).toBeLessThanOrEqual(1.1);
  await expect(page.locator('[data-testid="receipt-hero"] [data-callout="saved"]')).toHaveText(fmtDollars(heroM));
  return ratio;
}

/** core-5 (FINDINGS_R2 #7) is present when core's own headline keeps the r2/4 probe's gap case near the true rate. */
function core5Present(): boolean {
  const saved = 100_000;
  const totals: TotalsDoc = {
    schemaVersion: 1,
    updatedAt: '',
    byDay: {
      '2026-10-05': { whpM: 0, paidM: 0, savedM: 0, minutes: 5 },
      '2026-10-06': { whpM: 25 * 2 * saved, paidM: 25 * saved, savedM: 25 * saved, minutes: 30 },
    },
  };
  const now = Date.UTC(2026, 9, 6, 10, 30);
  const h = computeHeadline(totals, now, 'UTC', Date.UTC(2026, 9, 5, 9, 0), undefined, now, { pricedSinceMs: Date.UTC(2026, 9, 6, 10, 5) });
  return h.annualizedM / (saved * MINUTES_PER_YEAR) < 1.05;
}

test.describe('ui-2: a new install opens the Receipt on the annualized run rate', () => {
  test.use({ timezoneId: 'America/Chicago' });

  test('(i) traffic that began 15 minutes before the install: Annualized, the Projection pill, near the traffic\'s own rate', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
    await page.clock.install({ time: new Date('2026-09-28T15:10:00Z') });
    await startTheMeter(page, 0.25);
    // The first save stored the new default with the zone (r1 ui-1).
    expect(JSON.parse((await kvGet(page, 'settings')) ?? '{}').headlinePeriodDefault).toBe('annualized');
    await openReceipt(page);
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'annualized');
    await expect(page.getByRole('radio', { name: 'Annualized' })).toBeChecked();
    await expect(page.getByTestId('hero-projection')).toHaveText('Projection');
    await expect(page.getByTestId('hero-caption')).toHaveText(
      /^annualized run rate, projected from the last 1[3-6] minutes of traffic · settles after the first full day$/,
    );
    await expectHeroNearTraffic(page);
    // Choosing MTD still wins, and the pill goes with it.
    await page.getByRole('radio', { name: 'MTD' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('period')).toBe('mtd');
    await expect(page.getByTestId('hero-projection')).toHaveCount(0);
    expect(errors()).toEqual([]);
  });

  test('(ii) a day or more of history: Annualized, no Projection pill', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
    await page.clock.install({ time: new Date('2026-09-28T15:10:00Z') });
    await startTheMeter(page);
    // The first sweep back-fills up to a day; a few more minutes put it past a whole day either way.
    const first = await sweepAtMs(page);
    await page.clock.fastForward(3 * MIN);
    await expect.poll(() => sweepAtMs(page), { timeout: 60_000 }).toBeGreaterThan(first);
    const snap = await snapshotDoc(page);
    expect(snap.headline.annualizedFromDays).toBeGreaterThanOrEqual(1);
    await openReceipt(page);
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'annualized');
    await expect(page.getByTestId('hero-projection')).toHaveCount(0);
    await expect(page.getByTestId('hero-caption')).toHaveText(/^annualized run rate, from the last \d+ days?$/);
    await expectHeroNearTraffic(page);
    expect(errors()).toEqual([]);
  });

  test('(iii) a 30-minute metering gap before the first priced minute: still near the traffic\'s own rate (needs core-5)', async ({ page }) => {
    // Runs by itself once core-5 is merged (core5Present flips); MR_RUN_GAP_CASE=1 forces it (the integrator's check).
    test.skip(!core5Present() && !process.env.MR_RUN_GAP_CASE, 'needs core-5 (FINDINGS_R2 #7, core/pricing.ts emptyBefore) — runs once core\'s fix is merged');
    test.setTimeout(300_000);
    const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/, /never metered/]);
    // 10:00 AM Chicago. The first run meters with the Leader answering no rows (a day of minutes, nothing priced).
    await page.clock.install({ time: new Date('2026-09-28T15:00:30Z') });
    await gotoApp(page, '/first-run');
    await resetMock(page);
    await mockControl(page, { action: 'fault', method: 'POST', path: '/system/metrics/query', status: 200, body: { results: [], metrics: {}, info: { timeWindowSeconds: 60 } }, times: -1 });
    await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await page.getByRole('button', { name: /^Use suggested prices/ }).click({ timeout: 40_000 });
    await page.locator('section[data-section="prices"]').getByRole('button', { name: 'Start the meter' }).click();
    await expect.poll(async () => JSON.parse((await kvGet(page, 'meta')) ?? '{}').meteredThrough ?? null, { timeout: 120_000, intervals: [1_000] }).not.toBeNull();
    await expect.poll(() => sweepAtMs(page), { timeout: 60_000 }).toBeGreaterThan(0);
    const firstSnap = await snapshotDoc(page);
    expect(firstSnap.headline.whpMtdM, 'the first run priced nothing').toBe(0);
    // The tab sleeps 35 minutes; the first 30 of them are recorded as never metered (older than the Leader keeps, P1-E04),
    // then the Leader answers again with traffic.
    await page.goto('about:blank');
    await page.clock.fastForward(35 * MIN);
    await gotoApp(page, '/first-run');
    await mockControl(page, { action: 'clearFaults' });
    const meta = JSON.parse((await kvGet(page, 'meta')) ?? '{}') as { meteredThrough: string; gaps?: unknown[] };
    const gapFrom = Date.parse(meta.meteredThrough);
    const gapTo = gapFrom + 30 * MIN;
    const nowIso = new Date(await page.evaluate(() => Date.now())).toISOString();
    await page.evaluate(
      async (doc) => {
        const r = await fetch('/mock-api/v1/kvstore/meta', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(doc) });
        if (r.status >= 300) throw new Error(`PUT meta → ${r.status}`);
      },
      { ...meta, meteredThrough: new Date(gapTo).toISOString(), gaps: [...(meta.gaps ?? []), { from: new Date(gapFrom).toISOString(), to: new Date(gapTo).toISOString(), minutes: 30, recordedAt: nowIso }] },
    );
    await gotoApp(page, '/');
    const before = await sweepAtMs(page);
    await page.clock.fastForward(MIN);
    await expect.poll(() => sweepAtMs(page), { timeout: 60_000 }).toBeGreaterThan(before);
    await openReceipt(page);
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'annualized');
    await expectHeroNearTraffic(page);
    expect(errors()).toEqual([]);
  });

  test('(iv) a gap after the first priced minute (the tab closed soon after Start, back two days later): still near the traffic\'s own rate', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = trackConsoleErrors(page, [/Outdated Optimize Dep/, /never metered/]);
    // 10:10 AM Chicago; the Leader keeps 15 minutes of metrics, so the first run meters a day of empty minutes before them.
    await page.clock.install({ time: new Date('2026-09-28T15:10:00Z') });
    await startTheMeter(page, 0.25);
    const first = await snapshotDoc(page);
    expect(first.pricedSinceEmptyMinutes, "the first run records the day's empty minutes before the first priced one").toBeGreaterThan(500);
    // Ten more minutes of metering, then the tab closes.
    for (let i = 0; i < 10; i++) {
      const before = await sweepAtMs(page);
      await page.clock.fastForward(MIN);
      await expect.poll(() => sweepAtMs(page), { timeout: 60_000 }).toBeGreaterThan(before);
    }
    // The traffic's own money so far (its minute rollups expire while the tab is closed).
    const early = [...(await minuteMoney(page)).values()].filter((m) => m.whpM > 0);
    await page.goto('about:blank');
    // Two days later. All but the last 10 minutes is older than the catch-up reaches: recorded as never metered.
    await page.clock.fastForward(50 * 60 * MIN);
    await gotoApp(page, '/first-run');
    const meta = JSON.parse((await kvGet(page, 'meta')) ?? '{}') as { meteredThrough: string; gaps?: unknown[] };
    const nowMs = await page.evaluate(() => Date.now());
    const gapFrom = Date.parse(meta.meteredThrough);
    const gapTo = Math.floor((nowMs - 10 * MIN) / MIN) * MIN;
    await page.evaluate(
      async (doc) => {
        const r = await fetch('/mock-api/v1/kvstore/meta', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(doc) });
        if (r.status >= 300) throw new Error(`PUT meta → ${r.status}`);
      },
      {
        ...meta,
        meteredThrough: new Date(gapTo).toISOString(),
        gaps: [...(meta.gaps ?? []), { from: new Date(gapFrom).toISOString(), to: new Date(gapTo).toISOString(), minutes: Math.round((gapTo - gapFrom) / MIN), recordedAt: new Date(nowMs).toISOString() }],
      },
    );
    await gotoApp(page, '/');
    const before = await sweepAtMs(page);
    await page.clock.fastForward(MIN);
    await expect.poll(() => sweepAtMs(page), { timeout: 60_000 }).toBeGreaterThan(before);
    const snap = await snapshotDoc(page);
    expect(snap.pricedSince).toBe(first.pricedSince);
    expect(snap.pricedSinceEmptyMinutes).toBe(first.pricedSinceEmptyMinutes);
    // The traffic's own rate over every minute that carried priced traffic: before the gap and after it.
    const late = [...(await minuteMoney(page)).entries()].filter(([t, m]) => t >= gapTo - MIN && m.whpM > 0).map(([, m]) => m);
    const traffic = [...early, ...late];
    const rateM = (traffic.reduce((a, m) => a + m.savedM, 0) / traffic.length) * MINUTES_PER_YEAR;
    const ratio = snap.headline.annualizedM / rateM;
    expect(ratio, `hero ${fmtDollars(snap.headline.annualizedM)} a year vs the traffic's own ${fmtDollars(rateM)} (${early.length} + ${late.length} traffic minutes)`).toBeGreaterThanOrEqual(0.9);
    expect(ratio).toBeLessThanOrEqual(1.1);
    await openReceipt(page);
    await expect(page.locator('.mr-receipt-view')).toHaveAttribute('data-period', 'annualized');
    await expect(page.locator('[data-testid="receipt-hero"] [data-callout="saved"]')).toHaveText(fmtDollars(snap.headline.annualizedM));
    expect(errors()).toEqual([]);
  });
});
