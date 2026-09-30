// r1 integrator (contract C1', FINDINGS_R1 B1 #1/#8/#16/#41): the zone-change half, which needs core-2's engine, the
// ui-1 Receipt and the H4 wire in src/state/runtime.ts together, so it runs only after the core → ui merge.
// Seeded from app-assurance's skeptic specs (AA/r1/skeptic-16-1/zz-sk16.spec.ts, AA/skeptic2-f41/zz-sk41.spec.ts).
//
// The upgrade path: a workspace metered by 1.1.0 has prices and no settings document, so its totals were bucketed in
// UTC. The next tab (1.1.1) opens in the member's zone with no settings document either, so it passes the browser's
// zone as the sweep's `defaultTimeZone` (H4); core re-buckets the current month and the trend from the rollups before
// it adds a minute (core/rezone.ts). Afterwards Today and MTD must equal an independent recompute from the minute
// rollups in the member's zone, the trend must name no local day that has not happened, the Receipt must print no
// future date, and a later sweep must never lower the metered minutes.
//
// How the UTC workspace is made: tab A runs in a UTC browser (Start the meter, then metering across the member's
// month end), then its emulator state (localStorage `mr-mock:*`, the emulated Leader's storage) moves to tab B in the
// member's zone WITHOUT the settings document, which is exactly what 1.1.0 left behind. The totals carry A's zone
// (UTC), the same as a legacy document without a zone.

import { expect, test, type Browser, type Page } from '@playwright/test';
import { detectCodec } from '../../core/codec.ts';
import { createKvDocs } from '../../core/kv.ts';
import { localDayKey, localMidnightMs, localMonthStartMs } from '../../core/time.ts';
import type { KvStore, Snapshot } from '../../core/types.ts';
import { gotoApp, kvGet, navigateInApp, resetMock, trackConsoleErrors, waitForHydration } from './helpers/index.ts';

const MIN = 60_000;
const SEED_FLAG = 'r1-int-tz-upgrade-seeded';

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

/** Saved millicents per metered minute (epoch ms), from every minute rollup. */
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

/**
 * Moves the faked clock (Leader and app together) until the meter has swept through `target`. The wall clock jumps
 * with setSystemTime (no timer fires), then short fast-forwards fire the meter loop's next tick. No single jump is
 * longer than 15 s, and the next one waits for the sweep to land, so a request in flight never sees its 25 s timeout
 * pass inside a jump (a harness artifact that a 5-minute fastForward produces).
 */
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

/** Today and MTD in the snapshot match the recompute from the minute rollups, in `tz`. */
async function expectLocalBuckets(page: Page, tz: string): Promise<{ snap: Snapshot; perMinute: Map<number, number> }> {
  const snap = await snapshotDoc(page);
  const sweepMs = Date.parse(snap.sweepAt);
  const perMinute = await minuteSavings(page);
  const h = snap.headline;
  expect(h.todayM, `todayM in ${tz}`).toBe(sumFrom(perMinute, localMidnightMs(sweepMs, tz)));
  expect(h.mtdM, `mtdM in ${tz}`).toBe(sumFrom(perMinute, localMonthStartMs(sweepMs, tz)));
  const todayKey = localDayKey(sweepMs, tz);
  for (const p of snap.trend ?? []) expect(p.day <= todayKey, `trend day ${p.day} is after ${todayKey} in ${tz}`).toBe(true);
  return { snap, perMinute };
}

/** Everything the emulated Leader holds, minus the settings document (a 1.1.0 install never wrote one). */
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

const cases = [
  // Metered 10 PM Sep 30 → 1:30 AM Oct 1 CDT (03:00–06:30Z): UTC put all of it in October; Chicago puts 2 h in September.
  { tag: 'Chicago, month end', tz: 'America/Chicago', from: '2026-10-01T03:00:00Z', to: '2026-10-01T06:30:00Z', future: /^Oct 2$/ },
  // Metered 10 PM Sep 30 → 1:30 AM Oct 1 PDT (05:00–08:30Z).
  { tag: 'Los Angeles, month end', tz: 'America/Los_Angeles', from: '2026-10-01T05:00:00Z', to: '2026-10-01T08:30:00Z', future: /^Oct 2$/ },
] as const;

for (const c of cases) {
  test.describe(`an upgraded settings-less workspace is re-bucketed into the member's zone: ${c.tag}`, () => {
    test.use({ timezoneId: 'UTC' });

    test(`UTC totals from a prices-only install read local in ${c.tz} after the next sweep`, async ({ page, browser, baseURL }, testInfo) => {
      test.skip(testInfo.project.name !== 'chromium' && testInfo.project.name !== 'firefox' && testInfo.project.name !== 'webkit', 'desktop engines only: two browser contexts per case');
      test.setTimeout(420_000);
      const fromMs = Date.parse(c.from);
      const toMs = Date.parse(c.to);

      // ── Tab A, a UTC browser: Start the meter and meter across the member's month end. ──
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
      // Control: tab A bucketed in UTC, so its month to date holds every minute since the UTC first of the month.
      const a = await expectLocalBuckets(page, 'UTC');
      const utcMtd = a.snap.headline.mtdM;
      const localMonthStart = localMonthStartMs(toMs, c.tz);
      const localMtdNow = sumFrom(a.perMinute, localMonthStart);
      // The case must discriminate: the minutes before the member's midnight saved money that UTC counted in October.
      expect(utcMtd, 'the fixture meters money before the local month start').toBeGreaterThan(localMtdNow);
      expect(errorsA()).toEqual([]);
      const state = await leaderStateWithoutSettings(page);
      expect(Object.keys(state).some((k) => k.startsWith('mr-mock:kv:totals')), 'the totals travel with the state').toBe(true);
      await page.close();

      // ── Tab B, the member's zone, the upgraded build, no settings document. ──
      const b = await openInZone(browser, baseURL ?? '', c.tz, state);
      try {
        const pageB = b.page;
        const errorsB = trackConsoleErrors(pageB, [/Outdated Optimize Dep/]);
        const reopenMs = toMs + 10 * MIN;
        await pageB.clock.install({ time: new Date(reopenMs) });
        await gotoApp(pageB, '/');
        expect(await kvGet(pageB, 'settings'), 'a 1.1.0 install has no settings document').toBeNull();
        // The first sweep in this tab (it catches up the 10 minutes, then re-buckets).
        await expect.poll(() => sweepAtMs(pageB), { timeout: 120_000, intervals: [1_000] }).toBeGreaterThanOrEqual(reopenMs - 2 * MIN);
        const first = await expectLocalBuckets(pageB, c.tz);
        expect(first.snap.headline.mtdM, 'September minutes left October').toBeLessThan(sumFrom(first.perMinute, Date.parse('2026-10-01T00:00:00Z')));
        expect(first.snap.zone, 'the snapshot names the zone its totals are in').toBe(c.tz);
        // The trend keeps the member's September 30 (the minutes before local midnight) and names no future day.
        expect((first.snap.trend ?? []).map((p) => p.day)).toContain('2026-09-30');

        // The Receipt prints no local date that has not happened.
        await navigateInApp(pageB, '/?period=mtd');
        await expect(pageB.getByTestId('receipt-hero')).toBeVisible({ timeout: 30_000 });
        const lines = (await pageB.getByRole('main').innerText()).split('\n').map((l) => l.trim());
        expect(lines.filter((l) => c.future.test(l)), 'a chart label for a day that has not happened locally').toEqual([]);

        // A later sweep re-buckets nothing again: the figures stay local and the metered minutes never fall.
        const before = Date.parse(first.snap.sweepAt);
        await pageB.clock.fastForward(2 * MIN);
        await expect.poll(() => sweepAtMs(pageB), { timeout: 60_000 }).toBeGreaterThan(before);
        const second = await expectLocalBuckets(pageB, c.tz);
        expect(second.snap.headline.mtdM).toBeGreaterThanOrEqual(first.snap.headline.mtdM);
        expect(second.snap.headline.minutesMtd ?? 0).toBeGreaterThanOrEqual(first.snap.headline.minutesMtd ?? 0);
        expect(errorsB()).toEqual([]);
      } finally {
        await b.context.close();
      }
    });
  });
}
