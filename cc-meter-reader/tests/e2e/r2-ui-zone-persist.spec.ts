// r2 ui-3 (founder-build round 2, FINDINGS_R2 #4 UI half, contract C1''): a Los Angeles tab on a New York-zoned,
// settings-less workspace reads New York days, and stores that zone once, so the workspace never re-buckets.
//
// How the workspace is made (as r1-int-tz-upgrade makes its UTC one): tab A, a New York browser, starts the meter and
// meters past New York's midnight; its emulator state (localStorage `mr-mock:*`) moves to tab B in Los Angeles WITHOUT
// the settings document. The totals and the snapshot carry New York (core's totals zone, r1 core-2). At 12:40 AM New
// York it is still 9:40 PM the day before in Los Angeles, so a Receipt in the tab's own zone would name yesterday.
//
// Before ui-3, tab B swept with its own zone as the default (H4) and re-bucketed the month into Los Angeles, and a New
// York tab moved it back on its next sweep (FINDINGS_R2 #4: 11 of 11 sweeps re-bucketed). Now tab B stores
// settings.displayTimezone = the workspace's zone before its first sweep, and its Receipt reads settings ?? snapshot.zone
// ?? the browser's zone.

import { expect, test, type Browser, type Page } from '@playwright/test';
import { detectCodec } from '../../core/codec.ts';
import { createKvDocs } from '../../core/kv.ts';
import { formatLocalMonthDay, localDayKey, localMidnightMs } from '../../core/time.ts';
import type { KvStore, Snapshot } from '../../core/types.ts';
import { gotoApp, kvGet, navigateInApp, resetMock, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const MIN = 60_000;
const SEED_FLAG = 'r2-ui-zone-persist-seeded';
const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

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

const sumFrom = (m: Map<number, number>, fromMs: number): number => {
  let s = 0;
  for (const [t, v] of m) if (t >= fromMs) s += v;
  return s;
};

async function snapshotDoc(page: Page): Promise<Snapshot> {
  return JSON.parse((await kvGet(page, 'snapshot')) ?? 'null') as Snapshot;
}

async function sweepAtMs(page: Page): Promise<number> {
  const snap = await snapshotDoc(page).catch(() => null);
  return snap?.sweepAt ? Date.parse(snap.sweepAt) : 0;
}

async function meteredThrough(page: Page): Promise<number> {
  const meta = JSON.parse((await kvGet(page, 'meta')) ?? '{}') as { meteredThrough?: string };
  return meta.meteredThrough ? Date.parse(meta.meteredThrough) : 0;
}

/** Moves the faked clock until the meter has swept through `target` (as r1-int-tz-upgrade's runUntil). */
async function runUntil(page: Page, target: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const through = await meteredThrough(page);
    if (through >= target - 2 * MIN) return;
    const now = await page.evaluate(() => Date.now());
    if (now < target) await page.clock.setSystemTime(Math.min(now + 5 * MIN, target));
    for (let k = 0; k < 4; k++) {
      await page.clock.fastForward(15_000);
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && (await meteredThrough(page)) <= through) await page.waitForTimeout(250);
      if ((await meteredThrough(page)) > through) break;
    }
  }
  throw new Error(`the meter never swept through ${new Date(target).toISOString()}`);
}

async function leaderStateWithoutSettings(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k === null || !k.startsWith('mr-mock:')) continue;
      if (/^mr-mock:kve?:settings(\/|$)/.test(k)) continue;
      out[k] = localStorage.getItem(k) ?? '';
    }
    return out;
  });
}

async function openInZone(browser: Browser, baseURL: string, tz: string, state: Record<string, string>) {
  const context = await browser.newContext({ baseURL, timezoneId: tz, locale: 'en-US', colorScheme: 'light', serviceWorkers: 'allow', viewport: { width: 1440, height: 900 } });
  await context.addInitScript(
    ({ entries, flag }) => {
      try {
        if (localStorage.getItem(flag)) return;
        localStorage.clear();
        for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
        localStorage.setItem(flag, '1');
      } catch {
        /* the spec fails on its own checks if the state did not arrive */
      }
    },
    { entries: state, flag: SEED_FLAG },
  );
  return { context, page: await context.newPage() };
}

test.describe('ui-3: a settings-less workspace keeps the zone it was metered in', () => {
  test.use({ timezoneId: NY });

  test('a Los Angeles tab on a New York-zoned, settings-less workspace stores New York once and labels New York days', async ({ page, browser, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium' && testInfo.project.name !== 'firefox' && testInfo.project.name !== 'webkit', 'desktop engines only: two browser contexts');
    test.setTimeout(420_000);
    // 11:50 PM Sep 27 → 12:30 AM Sep 28 in New York (03:50–04:30Z); still Sep 27 evening in Los Angeles.
    const fromMs = Date.parse('2026-09-28T03:50:00Z');
    const toMs = Date.parse('2026-09-28T04:30:00Z');

    // ── Tab A, New York: Start the meter and meter past New York's midnight. ──
    const errorsA = trackConsoleErrors(page, [/Outdated Optimize Dep/]);
    await page.clock.install({ time: new Date(fromMs) });
    await gotoApp(page, '/first-run');
    await resetMock(page);
    await page.goto('/settings/prices', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    await page.getByRole('button', { name: /^Use suggested prices/ }).click({ timeout: 40_000 });
    await page.locator('section[data-section="prices"]').getByRole('button', { name: 'Start the meter' }).click();
    await expect(page.getByText('The meter is running.', { exact: false }).first()).toBeVisible();
    await runUntil(page, toMs);
    const a = await snapshotDoc(page);
    expect(a.zone, 'tab A metered in New York').toBe(NY);
    expect(errorsA()).toEqual([]);
    const state = await leaderStateWithoutSettings(page);
    await page.close();

    // ── Tab B, Los Angeles, no settings document. ──
    const b = await openInZone(browser, baseURL ?? '', LA, state);
    try {
      const pageB = b.page;
      const errorsB = trackConsoleErrors(pageB, [/Outdated Optimize Dep/]);
      const reopenMs = toMs + 10 * MIN;
      await pageB.clock.install({ time: new Date(reopenMs) });
      await gotoApp(pageB, '/');
      // The first sweep in this tab (it catches up the 10 minutes).
      await expect.poll(() => sweepAtMs(pageB), { timeout: 120_000, intervals: [1_000] }).toBeGreaterThanOrEqual(reopenMs - 2 * MIN);
      // Stored once, with the workspace's zone, not the tab's.
      await expect.poll(async () => JSON.parse((await kvGet(pageB, 'settings')) ?? '{}').displayTimezone ?? null, { timeout: 30_000 }).toBe(NY);
      const first = await snapshotDoc(pageB);
      expect(first.zone, 'no re-bucket into the tab\'s zone').toBe(NY);
      // Today is New York's (since 12:00 AM), not Los Angeles' (since 9:00 PM the day before … a day of minutes).
      const perMinute = await minuteSavings(pageB);
      expect(first.headline.todayM).toBe(sumFrom(perMinute, localMidnightMs(Date.parse(first.sweepAt), NY)));
      const nyToday = localDayKey(Date.parse(first.sweepAt), NY);
      expect(localDayKey(Date.parse(first.sweepAt), LA) < nyToday, 'the case discriminates: LA is still on the day before').toBe(true);
      expect((first.trend ?? []).map((p) => p.day)).toContain(nyToday);

      // The Receipt labels New York's day: "This week so far" began at 12:00 AM Monday Sep 28 in New York, a day that
      // has not begun in Los Angeles (whose week would still be the one before).
      await navigateInApp(pageB, '/?period=today');
      await expect(pageB.getByTestId('receipt-hero')).toBeVisible({ timeout: 30_000 });
      const label = formatLocalMonthDay(localMidnightMs(Date.parse(first.sweepAt), NY) + 12 * 3_600_000, NY);
      expect(label).toBe('Sep 28');
      const lines = (await pageB.getByRole('main').innerText()).split('\n').map((l) => l.trim());
      expect(lines.filter((l) => l.startsWith(`${label}, 12:00 AM`)), `the Receipt's week begins at New York's ${label}, 12:00 AM`).toHaveLength(1);
      await expect(pageB.getByTestId('hero-caption')).toContainText('today');

      // A later sweep stays in New York; the settings document is not written again.
      const settingsAt = JSON.parse((await kvGet(pageB, 'settings')) ?? '{}').updatedAt;
      const before = Date.parse(first.sweepAt);
      await pageB.clock.fastForward(2 * MIN);
      await expect.poll(() => sweepAtMs(pageB), { timeout: 60_000 }).toBeGreaterThan(before);
      const second = await snapshotDoc(pageB);
      expect(second.zone).toBe(NY);
      expect(second.headline.todayM).toBeGreaterThanOrEqual(first.headline.todayM);
      expect(JSON.parse((await kvGet(pageB, 'settings')) ?? '{}').updatedAt).toBe(settingsAt);
      expect(errorsB()).toEqual([]);
    } finally {
      await b.context.close();
    }
  });
});
